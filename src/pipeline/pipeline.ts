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
    const directPattern = /^(写一个|实现一个|用\w+实现|生成|输出|列出|比较|对比|什么是|如何|怎么)/;
    if (codeUnitPattern.test(userRequest) || simplePattern.test(userRequest) || directPattern.test(userRequest)) {
      return 'direct';
    }

    // Short requests (≤30 chars) are almost always direct
    if (userRequest.length <= 30) {
      return 'direct';
    }

    const system = `分类任务复杂度。只输出一个词:
direct = 单一代码单元或简单任务(写一个函数/算法题/翻译/格式转换/简单问答/bug修复/解释概念，即使有多个子要求也是direct)
light = 单个完整模块(设计REST API、写完整React组件、实现一个类、数据库方案设计)
standard = 多角度分析(技术方案对比、架构选型、框架评估、优缺点分析)
full = 多步协作+验证(完整项目设计、多模块集成、复杂系统方案)`;

    const { content } = await this.compressorLLM.chat(
      system, userRequest, 'classifier' as any, 'gather', 10
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

    const report = response.payload;
    this.emit({ type: 'complete', phase: 'report', detail: 'Done (direct)' });

    return {
      success: true,
      report,
      tokenReport: this.generateTokenReport(),
      routerStats: this.router.getStats(),
      blockedMessages: [],
      depth: 'direct',
    };
  }

  // ─── Light: single executor call (same as direct, distinct classification) ──

  private async runLight(userRequest: string): Promise<PipelineResult> {
    this.setPhase('execute');
    this.emit({ type: 'phase', phase: 'execute', detail: 'Light execution...' });

    const msg = createMessage('planner', 'executor', userRequest, '');
    const context: AgentContext = { visibleMessages: [] };
    const response = await this.executor.process(msg, context);

    const report = response.payload;
    this.emit({ type: 'complete', phase: 'report', detail: 'Done (light)' });

    return {
      success: true,
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

      const scoutMsg = createMessage('planner', 'scout', `调研: ${userRequest}`, '');
      const scoutCtx: AgentContext = { visibleMessages: [] };
      const scoutResponse = await this.scout.process(scoutMsg, scoutCtx);

      this.emit({ type: 'message', phase: 'gather', detail: `scout: ${scoutResponse.payload.slice(0, 80)}` });
      scoutContext = `调研结果: ${scoutResponse.payload}`;
    }

    // Execute with Scout results as context (or raw request if scout skipped)
    this.setPhase('execute');
    this.emit({ type: 'phase', phase: 'execute', detail: this.skipScout ? 'Executing (no scout)...' : 'Executing with research context...' });

    const execMsg = createMessage('planner', 'executor', userRequest, scoutContext);
    const execCtx: AgentContext = { visibleMessages: [] };
    const execResponse = await this.executor.process(execMsg, execCtx);

    const report = execResponse.payload;
    this.emit({ type: 'complete', phase: 'report', detail: 'Done (standard)' });

    return {
      success: true,
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
      success: true,
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
      .map((r, i) => `### ${i + 1}. ${r.instruction}\n\n${r.output}`)
      .join('\n\n---\n\n');
  }

  // ─── Phase Implementations ──────────────────────────

  private async gatherPhase(userRequest: string): Promise<void> {
    this.setPhase('gather');
    this.emit({ type: 'phase', phase: 'gather', detail: 'Gathering information...' });

    // Ask the planner what info it needs
    const gatherPrompt = `用户需求: ${userRequest}\n\n你需要先了解什么信息？输出查询指令。如果不需要额外信息，输出: → executor: [直接根据需求执行]`;
    const { content } = await this.plannerLLM.chat(
      this.planner.getSystemPrompt(),
      gatherPrompt,
      'planner',
      'gather'
    );

    const instructions = this.planner.parseInstructions(content);

    // Execute gather instructions (only scout/summarizer)
    for (const inst of instructions) {
      if (inst.target !== 'scout' && inst.target !== 'summarizer') continue;

      const agent = inst.target === 'scout' ? this.scout : this.summarizer;
      const msg = createMessage('planner', inst.target, inst.instruction, '');

      // Route check
      const decision = this.router.route(msg, 'gather');
      if (!decision.allowed) {
        this.emit({ type: 'blocked', phase: 'gather', detail: decision.reason });
        continue;
      }

      const context: AgentContext = {
        visibleMessages: this.router.getVisibleMessages(inst.target),
      };
      const response = await agent.process(msg, context);

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
    const executorInstructions = instructions.filter((i) => i.target === 'executor').slice(0, 3);
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
      const msg = createMessage('planner', 'executor', inst.instruction, `原始需求: ${userRequest}`);
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
        success: !response.payload.includes('失败'),
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
      const msg = createMessage('planner', 'executor', inst.instruction, `原始需求: ${userRequest}`);
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
        success: !response.payload.includes('失败'),
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
          const truncated = r.output.length > MAX_OUTPUT_CHARS
            ? r.output.slice(0, MAX_OUTPUT_CHARS) + '\n...[截断,内容完整但超长]'
            : r.output;
          return `[任务: ${r.instruction}]\n${truncated}`;
        })
        .join('\n---\n');

      const verifyMsg = createMessage('executor', 'verifier', '验证以下执行结果', verifyInput);

      const decision = this.router.route(verifyMsg, 'verify');
      if (!decision.allowed) break;

      const context: AgentContext = {
        visibleMessages: [],
        localScratchpad: retries > 0 ? `第${retries}次重新验证` : undefined,
      };

      const response = await this.verifier.process(verifyMsg, context);
      this.router.route(response, 'verify');
      lastVerification = response.payload;

      allPassed = response.payload.includes('✅') && !response.payload.includes('❌');

      if (!allPassed && retries < this.config.maxLocalRetries - 1) {
        this.emit({
          type: 'retry',
          phase: 'verify',
          detail: `Verification failed (attempt ${retries + 1}), executor fixing...`,
        });

        // Parse which tasks failed — send only failure detail to executor
        const failureDetail = response.payload.slice(0, 500);
        const fixMsg = createMessage('verifier', 'executor', '修复以下问题', failureDetail);
        const fixDecision = this.router.route(fixMsg, 'execute');

        if (fixDecision.allowed) {
          const execContext: AgentContext = {
            visibleMessages: [],
            localScratchpad: `修复验证发现的问题。原始需求: ${this.state.userRequest.slice(0, 300)}`,
          };
          const fixResponse = await this.executor.process(fixMsg, execContext);
          this.router.route(fixResponse, 'execute');

          // Append fix to last result (not replace all results)
          const lastResult = results[results.length - 1];
          if (lastResult) {
            lastResult.output += '\n\n--- 修复补充 ---\n' + fixResponse.payload;
            lastResult.success = !fixResponse.payload.includes('失败');
          }
        }
      }

      retries++;
    }

    const plannerReport = allPassed ? '✅ 全部通过' : `❌ 验证未通过: ${lastVerification.slice(0, 100)}`;
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

    // If verification failed, add a brief Planner conclusion (1 cheap call)
    const { content } = await this.compressorLLM.chat(
      '在输出前加一行验证状态摘要。保留原始内容不变。',
      `验证状态: ${verification.plannerSummary}\n\n---\n\n${executorContent.slice(0, 3000)}`,
      'summarizer',
      'report'
    );

    return content;
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

    const reportPrompt = `用户原始需求: ${this.state.userRequest}\n\n执行摘要:\n${summary}\n\n验证结果: ${verification.plannerSummary}\n\n用中文给用户写一份简洁的完成报告。不要废话。`;

    const { content } = await this.plannerLLM.chat(
      '你是报告者。用最少的话总结任务完成情况。格式清晰，重点突出。',
      reportPrompt,
      'planner',
      'report'
    );

    this.state.finalReport = content;
    return content;
  }

  // ─── Helpers ────────────────────────────────────────

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

    // Estimate: traditional multi-agent typically uses 3-5x more tokens
    // due to full context sharing and verbose agent communication
    const totalUsed = report.totalInput + report.totalOutput;
    const estimatedTraditional = totalUsed * 4; // Conservative 4x multiplier
    report.estimatedSavingsVsTraditional =
      ((estimatedTraditional - totalUsed) / estimatedTraditional) * 100;

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
