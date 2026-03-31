/**
 * Pipeline — The orchestration engine (v2: Adaptive).
 *
 * Key insight from benchmarks:
 * - NTK's value is COST efficiency (cheap model routing), not raw token reduction.
 * - Over-compression of executor outputs destroys quality.
 * - Simple tasks should bypass most pipeline phases.
 *
 * v2 changes:
 * - Adaptive depth: classify → route to direct/light/standard/full
 * - Report = raw executor outputs + brief summary (no Planner rewrite)
 * - Verify only for standard/full depth
 */

import type {
  NTKConfig,
  Phase,
  PipelineState,
  AgentContext,
  Message,
  TokenReport,
  TokenUsage,
  AgentType,
} from '../core/protocol.js';
import { createMessage } from '../core/protocol.js';
import { LLMClient } from '../core/llm.js';
import { Router } from '../core/router.js';
import { Compressor } from '../core/compressor.js';
import { Planner, type PlannerInstruction } from '../agents/planner.js';
import { Scout } from '../agents/scout.js';
import { Summarizer } from '../agents/summarizer.js';
import { Executor } from '../agents/executor.js';
import { Verifier } from '../agents/verifier.js';
import { detectLocale, CLASSIFIER_PROMPT, PIPELINE_STRINGS, type Locale } from '../core/prompts.js';

export type PipelineDepth = 'direct' | 'light' | 'standard' | 'full';

export class Pipeline {
  private config: NTKConfig;
  private router: Router;
  private compressor: Compressor;

  // Agents
  private planner: Planner;
  private scout: Scout;
  private summarizer: Summarizer;
  private executor: Executor;
  private verifier: Verifier;

  // LLM clients (may be different models)
  private plannerLLM: LLMClient;
  private compressorLLM: LLMClient;

  // State
  private state: PipelineState;
  private onEvent?: (event: PipelineEvent) => void;
  private forceDepth?: PipelineDepth;
  private skipScout: boolean = false;
  private locale: Locale = 'zh';
  private get strings() { return PIPELINE_STRINGS[this.locale]; }

  constructor(config: NTKConfig, onEvent?: (event: PipelineEvent) => void, options?: { forceDepth?: PipelineDepth; skipScout?: boolean }) {
    this.config = config;
    this.onEvent = onEvent;
    this.forceDepth = options?.forceDepth;
    this.skipScout = options?.skipScout ?? false;

    // Create LLM clients — planner gets the strong model
    this.plannerLLM = new LLMClient(config.planner);
    this.compressorLLM = new LLMClient(config.compressor);

    // Create agents
    this.planner = new Planner(this.plannerLLM);
    this.scout = new Scout(this.compressorLLM);
    this.summarizer = new Summarizer(this.compressorLLM);
    this.executor = new Executor(this.compressorLLM);
    this.verifier = new Verifier(this.compressorLLM);

    // Apply token budgets if configured
    if (config.tokenBudget) {
      const agents = [this.planner, this.scout, this.summarizer, this.executor, this.verifier];
      for (const agent of agents) {
        if (config.tokenBudget[agent.type] !== undefined) {
          agent.tokenBudget = config.tokenBudget[agent.type];
        }
      }
    }

    // Create router & compressor
    this.router = new Router();
    this.compressor = new Compressor(this.compressorLLM);

    // Initialize state
    this.state = {
      phase: 'gather',
      tasks: [],
      messages: [],
      userRequest: '',
    };
  }

  /**
   * Run the pipeline for a user request.
   * v2: Classifies complexity first, then routes to appropriate depth.
   */
  async run(userRequest: string): Promise<PipelineResult> {
    this.state.userRequest = userRequest;

    // Early return for empty / whitespace-only input
    if (!userRequest.trim()) {
      return {
        success: false,
        report: 'No task provided.',
        tokenReport: this.generateTokenReport(),
        routerStats: this.router.getStats(),
        blockedMessages: [],
        depth: 'direct',
      };
    }

    // Detect language from user input and propagate to all agents
    this.locale = detectLocale(userRequest);
    const agents = [this.planner, this.scout, this.summarizer, this.executor, this.verifier];
    for (const agent of agents) { agent.setLocale(this.locale); }
    this.compressor.setLocale(this.locale);

    try {
      // Step 0: Classify task complexity (or use forced depth)
      const depth = this.forceDepth ?? await this.classifyDepth(userRequest);
      this.emit({ type: 'start', phase: 'gather', detail: `[${depth}] ${userRequest}` });

      switch (depth) {
        case 'direct':
          return await this.runDirect(userRequest);
        case 'light':
          return await this.runLight(userRequest);
        case 'standard':
          return await this.runStandard(userRequest);
        case 'full':
          return await this.runFull(userRequest);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.emit({ type: 'error', phase: this.state.phase, detail: errorMessage });
      return {
        success: false,
        report: `Pipeline failed: ${errorMessage}`,
        tokenReport: this.generateTokenReport(),
        routerStats: this.router.getStats(),
        blockedMessages: this.router.getBlockedLog(),
        depth: 'full',
      };
    }
  }

  /**
   * Classify task complexity using cheap model (~50 tokens).
   * Returns the pipeline depth to use.
   */
  private async classifyDepth(userRequest: string): Promise<PipelineDepth> {
    // Fast path: obvious single-code-unit tasks (regex, no LLM cost)
    const codeUnitPattern = /^(写|实现|编写|创建|用\w+写|帮我写|请写).{0,30}(函数|function|算法|方法|脚本|工具|类|class)/;
    const simplePattern = /^(翻译|转换|解释|计算|修复|重构|分析这段|优化这|改写|将.{0,15}(翻译|转换|改为))/;
    const directPattern = /^(写一个|实现一个|用\w+实现|生成|输出|列出|什么是|如何|怎么)/;
    const directPatternEn = /^(write|implement|create|generate|explain|what is|how to|convert|translate|fix|solve|calculate|find (all )?bugs|given|read the|extract|count|list|sort|return|check|validate|parse|format|output|review|refactor|debug|optimize|describe|define)\b/i;
    if (codeUnitPattern.test(userRequest) || simplePattern.test(userRequest) || directPattern.test(userRequest) || directPatternEn.test(userRequest)) {
      // Long inputs that happen to start with a fast-path keyword may still be complex
      if (userRequest.length > 100) {
        // Fall through to classifier — don't trust regex alone for lengthy requests
      } else {
        return 'direct';
      }
    }

    // Short requests (≤30 chars) are almost always direct
    if (userRequest.length <= 30) {
      return 'direct';
    }

    const system = CLASSIFIER_PROMPT[this.locale];

    // Truncate long inputs for classifier — it only needs the task description, not the full payload
    const classifierInput = userRequest.length > 200
      ? userRequest.slice(0, 200) + '...'
      : userRequest;

    const { content } = await this.compressorLLM.chat(
      system, classifierInput, 'classifier', 'gather', 10
    );

    const word = content.trim().toLowerCase();
    if (word.includes('direct')) return 'direct';
    if (word.includes('light')) return 'light';
    if (word.includes('standard')) return 'standard';
    return 'full';
  }

  // ─── Direct: single executor call ───────────────────

  private async runDirect(userRequest: string): Promise<PipelineResult> {
    this.setPhase('execute');
    this.emit({ type: 'phase', phase: 'execute', detail: 'Direct execution...' });

    const msg = createMessage('planner', 'executor', userRequest, '');
    const context: AgentContext = { visibleMessages: [] };
    const response = await this.executor.process(msg, context);

    const report = response.payload.trim() || (this.locale === 'zh' ? '未生成输出，请重试或换一种方式描述任务。' : 'No output generated. Please retry or rephrase the task.');
    this.emit({ type: 'complete', phase: 'report', detail: 'Done (direct)' });

    return {
      success: !!response.payload.trim(),
      report,
      tokenReport: this.generateTokenReport(),
      routerStats: this.router.getStats(),
      blockedMessages: [],
      depth: 'direct',
    };
  }

  // ─── Light: executor + lightweight verify (unlike direct, adds a quick check) ──

  private async runLight(userRequest: string): Promise<PipelineResult> {
    this.setPhase('execute');
    this.emit({ type: 'phase', phase: 'execute', detail: 'Light execution...' });

    const msg = createMessage('planner', 'executor', userRequest, '');
    const context: AgentContext = { visibleMessages: [] };
    const response = await this.executor.process(msg, context);

    // Light verification: quick sanity check (unlike direct which skips entirely)
    this.setPhase('verify');
    this.emit({ type: 'phase', phase: 'verify', detail: 'Light verification...' });

    const verifyMsg = createMessage('executor', 'verifier', this.strings.quickCheck, response.payload);
    const verifyCtx: AgentContext = { visibleMessages: [] };
    const verifyResponse = await this.verifier.process(verifyMsg, verifyCtx);

    const passed = this.parseVerificationResult(verifyResponse.payload);
    let report = response.payload.trim() || (this.locale === 'zh' ? '未生成输出，请重试或换一种方式描述任务。' : 'No output generated. Please retry or rephrase the task.');

    // If verification failed, do one retry with original context
    if (!passed) {
      this.emit({ type: 'retry', phase: 'verify', detail: 'Light fix attempt...' });
      const fixMsg = createMessage('verifier', 'executor', userRequest,
        `${this.strings.verifyFeedback}: ${verifyResponse.payload.slice(0, 300)}`);
      const fixCtx: AgentContext = { visibleMessages: [] };
      const fixResponse = await this.executor.process(fixMsg, fixCtx);
      report = fixResponse.payload.trim() || report;
    }

    this.emit({ type: 'complete', phase: 'report', detail: 'Done (light)' });

    return {
      success: !!report.trim(),
      report,
      tokenReport: this.generateTokenReport(),
      routerStats: this.router.getStats(),
      blockedMessages: this.router.getBlockedLog(),
      depth: 'light',
    };
  }

  // ─── Standard: scout → executor (no planner) ────────

  private async runStandard(userRequest: string): Promise<PipelineResult> {
    // Gather with Scout
    let scoutContext = '';

    if (!this.skipScout) {
      this.setPhase('gather');
      this.emit({ type: 'phase', phase: 'gather', detail: 'Scouting...' });

      const scoutMsg = createMessage('planner', 'scout', `${this.strings.research}: ${userRequest}`, '');
      const scoutCtx: AgentContext = { visibleMessages: [] };
      const scoutResponse = await this.scout.process(scoutMsg, scoutCtx);

      this.emit({ type: 'message', phase: 'gather', detail: `scout: ${scoutResponse.payload.slice(0, 80)}` });
      scoutContext = `${this.strings.researchResult}: ${scoutResponse.payload}`;
    }

    // Execute with Scout results as context (or raw request if scout skipped)
    this.setPhase('execute');
    this.emit({ type: 'phase', phase: 'execute', detail: this.skipScout ? 'Executing (no scout)...' : 'Executing with research context...' });

    const execMsg = createMessage('planner', 'executor', userRequest, scoutContext);
    const execCtx: AgentContext = { visibleMessages: [] };
    const execResponse = await this.executor.process(execMsg, execCtx);

    const report = execResponse.payload.trim() || (this.locale === 'zh' ? '未生成输出，请重试或换一种方式描述任务。' : 'No output generated. Please retry or rephrase the task.');
    this.emit({ type: 'complete', phase: 'report', detail: 'Done (standard)' });

    return {
      success: !!execResponse.payload.trim(),
      report,
      tokenReport: this.generateTokenReport(),
      routerStats: this.router.getStats(),
      blockedMessages: this.router.getBlockedLog(),
      depth: 'standard',
    };
  }

  // ─── Full: gather → plan → execute → verify → report

  private async runFull(userRequest: string): Promise<PipelineResult> {
    // Gather
    await this.gatherPhase(userRequest);

    // Plan
    const instructions = await this.planPhase(userRequest);

    // Execute
    const results = await this.executePhase(instructions);

    // Verify (local loop)
    const verified = await this.verifyPhase(results);

    // Report: raw outputs + brief Planner conclusion
    const report = await this.reportPhaseV2(results, verified);
    this.emit({ type: 'complete', phase: 'report', detail: 'Done (full)' });

    return {
      success: verified.passed,
      report,
      tokenReport: this.generateTokenReport(),
      routerStats: this.router.getStats(),
      blockedMessages: this.router.getBlockedLog(),
      depth: 'full',
    };
  }

  /**
   * Assemble report from raw executor outputs (no LLM call).
   * This preserves the detailed content the user needs.
   */
  private assembleReport(results: ExecutionResult[]): string {
    if (results.length === 1) {
      return results[0].output;
    }
    return results
      .map((r, i) => {
        const title = r.instruction.length > 80
          ? r.instruction.slice(0, 80) + '...'
          : r.instruction;
        return `### ${i + 1}. ${title}\n\n${r.output}`;
      })
      .join('\n\n---\n\n');
  }

  // ─── Phase Implementations ──────────────────────────

  private async gatherPhase(userRequest: string): Promise<void> {
    this.setPhase('gather');
    this.emit({ type: 'phase', phase: 'gather', detail: 'Gathering information...' });

    // Ask the planner what info it needs
    const gatherPrompt = this.strings.gatherPrompt(userRequest);
    const { content } = await this.plannerLLM.chat(
      this.planner.getSystemPrompt(),
      gatherPrompt,
      'planner',
      'gather'
    );

    const instructions = this.planner.parseInstructions(content);

    // Execute gather instructions (only scout/summarizer) — run in parallel
    const gatherTasks = instructions
      .filter(inst => inst.target === 'scout' || inst.target === 'summarizer')
      .map(async (inst) => {
        const agent = inst.target === 'scout' ? this.scout : this.summarizer;
        const msg = createMessage('planner', inst.target, inst.instruction, '');

        // Route check
        const decision = this.router.route(msg, 'gather');
        if (!decision.allowed) {
          this.emit({ type: 'blocked', phase: 'gather', detail: decision.reason });
          return null;
        }

        const context: AgentContext = {
          visibleMessages: this.router.getVisibleMessages(inst.target),
        };
        const response = await agent.process(msg, context);
        return { inst, decision, response };
      });

    const gatherResults = await Promise.all(gatherTasks);

    for (const result of gatherResults) {
      if (!result) continue;
      const { inst, decision, response } = result;

      // Compress if needed before storing
      if (decision.needsCompression) {
        const compressed = await this.compressor.compress(response.payload, 'standard', inst.target, 'gather');
        response.payload = compressed.compressed;
        this.emit({
          type: 'compressed',
          phase: 'gather',
          detail: `Compressed ${compressed.originalLength}→${compressed.compressedLength} chars (${compressed.ratio.toFixed(1)}x)`,
        });
      }

      this.router.route(response, 'gather');
      this.emit({ type: 'message', phase: 'gather', detail: `${inst.target}: ${response.payload.slice(0, 100)}...` });
    }
  }

  private async planPhase(userRequest: string): Promise<PlannerInstruction[]> {
    this.setPhase('plan');
    this.emit({ type: 'phase', phase: 'plan', detail: 'Creating execution plan...' });

    // Gather all compressed info the planner has received
    const plannerMessages = this.router.getVisibleMessages('planner');
    const gatheredInfo = plannerMessages
      .filter((m) => m.from !== 'planner')
      .map((m) => `[${m.from}]: ${m.payload}`)
      .join('\n');

    const { plan, instructions } = await this.planner.createPlan(userRequest, gatheredInfo);
    this.emit({ type: 'plan', phase: 'plan', detail: plan });

    return instructions;
  }

  private async executePhase(instructions: PlannerInstruction[]): Promise<ExecutionResult[]> {
    this.setPhase('execute');
    // Cap at 3 executor tasks to prevent over-decomposition
    let executorInstructions = instructions.filter((i) => i.target === 'executor').slice(0, 3);

    // Fallback: if planner produced no parseable executor instructions, execute user request directly
    if (executorInstructions.length === 0) {
      executorInstructions = [{ target: 'executor' as const, instruction: this.state.userRequest }];
    }

    this.emit({
      type: 'phase',
      phase: 'execute',
      detail: `Executing ${executorInstructions.length} task(s)${this.config.parallelExecution ? ' in parallel' : ' sequentially'}...`,
    });

    // Pass original user request so executors have full context
    const userRequest = this.state.userRequest;

    if (this.config.parallelExecution && executorInstructions.length > 1) {
      return this.executeParallel(executorInstructions, userRequest);
    }
    return this.executeSerial(executorInstructions, userRequest);
  }

  private async executeSerial(instructions: PlannerInstruction[], userRequest: string): Promise<ExecutionResult[]> {
    const results: ExecutionResult[] = [];

    for (const inst of instructions) {
      // Include original user request as payload so executor has full context
      const msg = createMessage('planner', 'executor', inst.instruction, `${this.strings.originalRequest}: ${userRequest}`);
      const decision = this.router.route(msg, 'execute');

      if (!decision.allowed) {
        this.emit({ type: 'blocked', phase: 'execute', detail: decision.reason });
        continue;
      }

      const context: AgentContext = { visibleMessages: [] };
      const response = await this.executor.process(msg, context);
      this.router.route(response, 'execute');

      results.push({
        instruction: inst.instruction,
        output: response.payload,
        success: true,
      });

      this.emit({
        type: 'execution',
        phase: 'execute',
        detail: `${inst.instruction}: ${response.payload.slice(0, 80)}...`,
      });
    }

    return results;
  }

  private async executeParallel(instructions: PlannerInstruction[], userRequest: string): Promise<ExecutionResult[]> {
    const tasks = instructions.map(async (inst) => {
      const msg = createMessage('planner', 'executor', inst.instruction, `${this.strings.originalRequest}: ${userRequest}`);
      const decision = this.router.route(msg, 'execute');

      if (!decision.allowed) {
        this.emit({ type: 'blocked', phase: 'execute', detail: decision.reason });
        return null;
      }

      const context: AgentContext = { visibleMessages: [] };
      const response = await this.executor.process(msg, context);
      this.router.route(response, 'execute');

      this.emit({
        type: 'execution',
        phase: 'execute',
        detail: `✓ ${inst.instruction.slice(0, 60)}...`,
      });

      return {
        instruction: inst.instruction,
        output: response.payload,
        success: true,
      } as ExecutionResult;
    });

    const results = await Promise.all(tasks);
    return results.filter((r): r is ExecutionResult => r !== null);
  }

  private async verifyPhase(results: ExecutionResult[]): Promise<VerificationResult> {
    this.setPhase('verify');
    this.emit({ type: 'phase', phase: 'verify', detail: 'Verifying results...' });

    let retries = 0;
    let allPassed = false;
    let lastVerification = '';

    // Local loop: executor ↔ verifier (planner is NOT involved)
    while (retries < this.config.maxLocalRetries && !allPassed) {
      // Adaptive truncation: more results = less chars per result
      const MAX_OUTPUT_CHARS = Math.min(1200, Math.floor(4000 / results.length));
      const verifyInput = results
        .map((r) => {
          let truncated = r.output;
          if (truncated.length > MAX_OUTPUT_CHARS) {
            // Truncate at the last newline before the limit to avoid cutting mid-line/code
            const cutPoint = truncated.lastIndexOf('\n', MAX_OUTPUT_CHARS);
            truncated = truncated.slice(0, cutPoint > MAX_OUTPUT_CHARS * 0.5 ? cutPoint : MAX_OUTPUT_CHARS)
              + '\n' + this.strings.truncated;
          }
          return `[${this.strings.taskLabel}: ${r.instruction}]\n${truncated}`;
        })
        .join('\n---\n');

      const verifyMsg = createMessage('executor', 'verifier', this.strings.verifyResults, verifyInput);

      const decision = this.router.route(verifyMsg, 'verify');
      if (!decision.allowed) break;

      const context: AgentContext = {
        visibleMessages: [],
        localScratchpad: retries > 0 ? this.strings.retryVerify(retries) : undefined,
      };

      const response = await this.verifier.process(verifyMsg, context);
      this.router.route(response, 'verify');
      lastVerification = response.payload;

      allPassed = this.parseVerificationResult(response.payload);

      if (!allPassed && retries < this.config.maxLocalRetries - 1) {
        this.emit({
          type: 'retry',
          phase: 'verify',
          detail: `Verification failed (attempt ${retries + 1}), executor fixing...`,
        });

        // Parse which tasks failed — send only failure detail to executor
        const failureDetail = response.payload.slice(0, 500);
        const fixMsg = createMessage('verifier', 'executor', this.strings.fixIssues, failureDetail);
        const fixDecision = this.router.route(fixMsg, 'execute');

        if (fixDecision.allowed) {
          const execContext: AgentContext = {
            visibleMessages: [],
            localScratchpad: `${this.strings.fixVerifyIssues}: ${this.state.userRequest.slice(0, 300)}`,
          };
          const fixResponse = await this.executor.process(fixMsg, execContext);
          this.router.route(fixResponse, 'execute');

          // Append fix to last result (not replace all results)
          const lastResult = results[results.length - 1];
          if (lastResult) {
            lastResult.output += `\n\n--- ${this.strings.fixSupplement} ---\n` + fixResponse.payload;
            lastResult.success = true;
          }
        }
      }

      retries++;
    }

    const plannerReport = allPassed
      ? (this.locale === 'zh' ? '✅ 全部通过' : '✅ All passed')
      : (this.locale === 'zh' ? `❌ 验证未通过: ${lastVerification.slice(0, 100)}` : `❌ Verification failed: ${lastVerification.slice(0, 100)}`);
    const reportMsg = createMessage('verifier', 'planner', 'verify-result', plannerReport);
    this.router.route(reportMsg, 'verify');

    this.emit({
      type: allPassed ? 'verified' : 'verification-failed',
      phase: 'verify',
      detail: plannerReport,
    });

    return {
      passed: allPassed,
      attempts: retries,
      detail: lastVerification,
      plannerSummary: plannerReport,
    };
  }

  private async reportPhaseV2(results: ExecutionResult[], verification: VerificationResult): Promise<string> {
    this.setPhase('report');
    this.emit({ type: 'phase', phase: 'report', detail: 'Assembling report...' });

    // Core: include raw executor outputs (the actual deliverable)
    const executorContent = this.assembleReport(results);

    // If verification passed, just return the raw content with a brief header
    if (verification.passed) {
      return executorContent;
    }

    // If verification failed, return raw executor content with a status header
    // (Do NOT send through LLM — it may discard the actual content)
    const statusLine = verification.plannerSummary;
    return `${statusLine}\n\n---\n\n${executorContent}`;
  }

  // Keep old report phase for explicit full pipeline usage
  private async reportPhase(verification: VerificationResult): Promise<string> {
    this.setPhase('report');
    this.emit({ type: 'phase', phase: 'report', detail: 'Generating report...' });

    // Planner generates final report from compressed information
    const plannerMessages = this.router.getVisibleMessages('planner');
    const summary = plannerMessages
      .filter((m) => m.from !== 'planner')
      .slice(-10)
      .map((m) => `[${m.from}]: ${m.payload}`)
      .join('\n');

    const reportPrompt = this.strings.reportPrompt(this.state.userRequest, summary, verification.plannerSummary);

    const { content } = await this.plannerLLM.chat(
      this.strings.reportSystem,
      reportPrompt,
      'planner',
      'report'
    );

    this.state.finalReport = content;
    return content;
  }

  // ─── Helpers ────────────────────────────────────────

  /**
   * Parse verifier output to determine pass/fail.
   * Uses emoji first, then falls back to keyword matching.
   * This avoids relying solely on LLM producing exact emoji markers.
   */
  private parseVerificationResult(payload: string): boolean {
    // Primary: emoji markers (system prompt instructs verifier to use these)
    const hasPass = payload.includes('✅');
    const hasFail = payload.includes('❌');
    if (hasPass && !hasFail) return true;
    if (hasFail) return false;

    // Fallback: keyword matching (case-insensitive)
    const lower = payload.toLowerCase();
    const passKeywords = ['pass', 'passed', 'all correct', 'no issues', '通过', '正确', '没有问题', '无问题'];
    const failKeywords = ['fail', 'failed', 'error', 'incorrect', 'wrong', '失败', '错误', '不正确', '有问题'];

    const hasPassKeyword = passKeywords.some(kw => lower.includes(kw));

    // Strip negation-pass patterns before checking fail keywords
    // to avoid substring conflicts (e.g. "没有问题" contains "有问题")
    let lowerForFailCheck = lower;
    const negationPassPatterns = ['没有问题', '无问题', 'no issues', 'no errors'];
    for (const np of negationPassPatterns) {
      lowerForFailCheck = lowerForFailCheck.replaceAll(np, '');
    }
    const hasFailKeyword = failKeywords.some(kw => lowerForFailCheck.includes(kw));

    if (hasPassKeyword && !hasFailKeyword) return true;
    if (hasFailKeyword) return false;

    // Default: assume pass if no clear signal (avoid infinite retry loops)
    return true;
  }

  private setPhase(phase: Phase): void {
    this.state.phase = phase;
    this.planner.setPhase(phase);
    this.scout.setPhase(phase);
    this.summarizer.setPhase(phase);
    this.executor.setPhase(phase);
    this.verifier.setPhase(phase);
  }

  private emit(event: PipelineEvent): void {
    if (this.onEvent) {
      this.onEvent(event);
    }
    if (this.config.debug) {
      console.log(`[${event.phase}] ${event.type}: ${event.detail}`);
    }
  }

  private generateTokenReport(): TokenReport {
    const allUsage = [
      ...this.plannerLLM.getTokenLog(),
      ...this.compressorLLM.getTokenLog(),
    ];

    const report: TokenReport = {
      totalInput: 0,
      totalOutput: 0,
      byAgent: {} as any,
      byPhase: {} as any,
      estimatedSavingsVsTraditional: 0,
    };

    for (const u of allUsage) {
      report.totalInput += u.inputTokens;
      report.totalOutput += u.outputTokens;

      if (!report.byAgent[u.agent]) {
        report.byAgent[u.agent] = { input: 0, output: 0 };
      }
      report.byAgent[u.agent].input += u.inputTokens;
      report.byAgent[u.agent].output += u.outputTokens;

      if (!report.byPhase[u.phase]) {
        report.byPhase[u.phase] = { input: 0, output: 0 };
      }
      report.byPhase[u.phase].input += u.inputTokens;
      report.byPhase[u.phase].output += u.outputTokens;
    }

    // Cost-weighted savings estimate.
    // Compares NTK's dual-model approach (cheap + strong) vs using only the strong model.
    // Assumption: cheap model costs ~10x less per token than strong model (typical GPT-4 vs GPT-3.5 ratio).
    // We do NOT inflate the "traditional" token count — only the cost difference matters.
    const totalUsed = report.totalInput + report.totalOutput;
    const strongTokens = (report.byAgent.planner?.input ?? 0) + (report.byAgent.planner?.output ?? 0);
    const cheapTokens = totalUsed - strongTokens;

    // NTK cost: strong tokens at full price + cheap tokens at 1/10 price
    const ntkWeightedCost = strongTokens + cheapTokens * 0.1;
    // Traditional cost: same total tokens, all at strong model price
    const traditionalWeightedCost = totalUsed;

    report.estimatedSavingsVsTraditional =
      traditionalWeightedCost > 0
        ? Math.max(0, Math.min(100, ((traditionalWeightedCost - ntkWeightedCost) / traditionalWeightedCost) * 100))
        : 0;

    return report;
  }
}

// ─── Types ──────────────────────────────────────────

export interface PipelineEvent {
  type: string;
  phase: Phase;
  detail: string;
}

export interface PipelineResult {
  success: boolean;
  report: string;
  tokenReport: TokenReport;
  routerStats: import('../core/router.js').RouterStats;
  blockedMessages: Array<{ message: Message; reason: string }>;
  depth?: PipelineDepth;
}

export interface ExecutionResult {
  instruction: string;
  output: string;
  success: boolean;
}

export interface VerificationResult {
  passed: boolean;
  attempts: number;
  detail: string;
  plannerSummary: string;
}
