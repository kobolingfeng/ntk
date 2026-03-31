/**
 * Full depth — gather → plan → execute → verify → report.
 *
 * The most complex pipeline depth, involving all agents and phases.
 */

import type { Executor } from '../agents/executor.js';
import type { Planner, PlannerInstruction } from '../agents/planner.js';
import type { Scout } from '../agents/scout.js';
import type { Summarizer } from '../agents/summarizer.js';
import type { Verifier } from '../agents/verifier.js';
import type { Compressor } from '../core/compressor.js';
import type { LLMClient } from '../core/llm.js';
import type { Locale, PIPELINE_STRINGS } from '../core/prompts.js';
import type { AgentContext, NTKConfig, TokenReport } from '../core/protocol.js';
import { createMessage } from '../core/protocol.js';
import type { Router, RouterStats } from '../core/router.js';
import { assembleReport, parseVerificationResult } from './helpers.js';
import type { ExecutionResult, PipelineEvent, PipelineResult, VerificationResult } from './types.js';

/** Dependencies needed by the full depth runner */
export interface FullDepthContext {
  config: NTKConfig;
  plannerLLM: LLMClient;
  compressorLLM: LLMClient;
  router: Router;
  compressor: Compressor;
  planner: Planner;
  scout: Scout;
  summarizer: Summarizer;
  executor: Executor;
  verifier: Verifier;
  strings: (typeof PIPELINE_STRINGS)['zh'];
  locale: Locale;
  userRequest: string;
  getTokenReport: () => TokenReport;
  getRouterStats: () => RouterStats;
  emit: (event: PipelineEvent) => void;
  onToken?: (token: string) => void;
}

export async function runFull(ctx: FullDepthContext): Promise<PipelineResult> {
  // Gather
  await gatherPhase(ctx);

  // Plan
  const instructions = await planPhase(ctx);

  // Execute
  const results = await executePhase(ctx, instructions);

  // Verify (local loop)
  const verified = await verifyPhase(ctx, results);

  // Report: raw outputs + brief Planner conclusion
  const report = reportPhaseV2(results, verified);
  ctx.emit({ type: 'complete', phase: 'report', detail: 'Done (full)' });

  return {
    success: verified.passed,
    report,
    tokenReport: ctx.getTokenReport(),
    routerStats: ctx.getRouterStats(),
    blockedMessages: ctx.router.getBlockedLog(),
    depth: 'full',
  };
}

// ─── Phase Implementations ──────────────────────────

async function gatherPhase(ctx: FullDepthContext): Promise<void> {
  ctx.emit({ type: 'phase', phase: 'gather', detail: 'Gathering information...' });

  const gatherPrompt = ctx.strings.gatherPrompt(ctx.userRequest);
  const { content } = await ctx.plannerLLM.chat(ctx.planner.getSystemPrompt(), gatherPrompt, 'planner', 'gather');

  const instructions = ctx.planner.parseInstructions(content);

  // Execute gather instructions (only scout/summarizer) — run in parallel
  const gatherTasks = instructions
    .filter((inst) => inst.target === 'scout' || inst.target === 'summarizer')
    .map(async (inst) => {
      const agent = inst.target === 'scout' ? ctx.scout : ctx.summarizer;
      const msg = createMessage('planner', inst.target, inst.instruction, '');

      const decision = ctx.router.route(msg, 'gather');
      if (!decision.allowed) {
        ctx.emit({ type: 'blocked', phase: 'gather', detail: decision.reason });
        return null;
      }

      const context: AgentContext = {
        visibleMessages: ctx.router.getVisibleMessages(inst.target),
      };
      const response = await agent.process(msg, context);
      return { inst, decision, response };
    });

  const gatherResults = await Promise.all(gatherTasks);

  for (const result of gatherResults) {
    if (!result) continue;
    const { inst, decision, response } = result;

    if (decision.needsCompression) {
      const compressed = await ctx.compressor.compress(response.payload, 'standard', inst.target, 'gather', {
        tee: true,
      });
      response.payload = compressed.compressed;

      const pfInfo =
        compressed.preFilterResult && compressed.preFilterResult.charsRemoved > 0
          ? ` (pre-filter: -${compressed.preFilterResult.charsRemoved} chars)`
          : '';
      ctx.emit({
        type: 'compressed',
        phase: 'gather',
        detail: `Compressed ${compressed.originalLength}→${compressed.compressedLength} chars (${compressed.ratio.toFixed(1)}x)${pfInfo}`,
      });
    }

    ctx.router.route(response, 'gather');
    ctx.emit({ type: 'message', phase: 'gather', detail: `${inst.target}: ${response.payload.slice(0, 100)}...` });
  }
}

async function planPhase(ctx: FullDepthContext): Promise<PlannerInstruction[]> {
  ctx.emit({ type: 'phase', phase: 'plan', detail: 'Creating execution plan...' });

  const plannerMessages = ctx.router.getVisibleMessages('planner');
  const gatheredInfo = plannerMessages
    .filter((m) => m.from !== 'planner')
    .map((m) => `[${m.from}]: ${m.payload}`)
    .join('\n');

  const { plan, instructions } = await ctx.planner.createPlan(ctx.userRequest, gatheredInfo);
  ctx.emit({ type: 'plan', phase: 'plan', detail: plan });

  return instructions;
}

async function executePhase(ctx: FullDepthContext, instructions: PlannerInstruction[]): Promise<ExecutionResult[]> {
  // Cap at 3 executor tasks to prevent over-decomposition
  let executorInstructions = instructions.filter((i) => i.target === 'executor').slice(0, 3);

  // Fallback: if planner produced no parseable executor instructions, execute user request directly
  if (executorInstructions.length === 0) {
    executorInstructions = [{ target: 'executor' as const, instruction: ctx.userRequest }];
  }

  ctx.emit({
    type: 'phase',
    phase: 'execute',
    detail: `Executing ${executorInstructions.length} task(s)${ctx.config.parallelExecution ? ' in parallel' : ' sequentially'}...`,
  });

  if (ctx.config.parallelExecution && executorInstructions.length > 1) {
    return executeParallel(ctx, executorInstructions);
  }
  return executeSerial(ctx, executorInstructions);
}

async function executeSerial(ctx: FullDepthContext, instructions: PlannerInstruction[]): Promise<ExecutionResult[]> {
  const results: ExecutionResult[] = [];

  for (const inst of instructions) {
    const msg = createMessage(
      'planner',
      'executor',
      inst.instruction,
      `${ctx.strings.originalRequest}: ${ctx.userRequest}`,
    );
    const decision = ctx.router.route(msg, 'execute');

    if (!decision.allowed) {
      ctx.emit({ type: 'blocked', phase: 'execute', detail: decision.reason });
      continue;
    }

    let output: string;
    if (ctx.onToken && ctx.compressorLLM) {
      const { getBandPrompt } = await import('../core/prompts.js');
      const prompt = getBandPrompt(inst.instruction, ctx.locale);
      const fullInput = `${ctx.strings.originalRequest}: ${ctx.userRequest}\n\n${inst.instruction}`;
      const { content } = await ctx.compressorLLM.chatStream(prompt, fullInput, 'executor', 'execute', ctx.onToken);
      output = content;
      // Route the streamed response through the router for consistency with non-streaming path
      const streamedResponse = createMessage('executor', 'planner', inst.instruction, output);
      ctx.router.route(streamedResponse, 'execute');
    } else {
      const context: AgentContext = { visibleMessages: [] };
      const response = await ctx.executor.process(msg, context);
      ctx.router.route(response, 'execute');
      output = response.payload;
    }

    results.push({
      instruction: inst.instruction,
      output,
      success: true,
    });

    ctx.emit({
      type: 'execution',
      phase: 'execute',
      detail: `${inst.instruction}: ${output.slice(0, 80)}...`,
    });
  }

  return results;
}

async function executeParallel(ctx: FullDepthContext, instructions: PlannerInstruction[]): Promise<ExecutionResult[]> {
  const tasks = instructions.map(async (inst) => {
    const msg = createMessage(
      'planner',
      'executor',
      inst.instruction,
      `${ctx.strings.originalRequest}: ${ctx.userRequest}`,
    );
    const decision = ctx.router.route(msg, 'execute');

    if (!decision.allowed) {
      ctx.emit({ type: 'blocked', phase: 'execute', detail: decision.reason });
      return null;
    }

    const context: AgentContext = { visibleMessages: [] };
    const response = await ctx.executor.process(msg, context);
    ctx.router.route(response, 'execute');

    ctx.emit({
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

async function verifyPhase(ctx: FullDepthContext, results: ExecutionResult[]): Promise<VerificationResult> {
  ctx.emit({ type: 'phase', phase: 'verify', detail: 'Verifying results...' });

  let retries = 0;
  let allPassed = false;
  let lastVerification = '';

  while (retries < ctx.config.maxLocalRetries && !allPassed) {
    const MAX_OUTPUT_CHARS = Math.min(1200, Math.floor(4000 / results.length));
    const verifyInput = results
      .map((r) => {
        let truncated = r.output;
        if (truncated.length > MAX_OUTPUT_CHARS) {
          const cutPoint = truncated.lastIndexOf('\n', MAX_OUTPUT_CHARS);
          truncated =
            truncated.slice(0, cutPoint > MAX_OUTPUT_CHARS * 0.5 ? cutPoint : MAX_OUTPUT_CHARS) +
            '\n' +
            ctx.strings.truncated;
        }
        return `[${ctx.strings.taskLabel}: ${r.instruction}]\n${truncated}`;
      })
      .join('\n---\n');

    const verifyMsg = createMessage('executor', 'verifier', ctx.strings.verifyResults, verifyInput);

    const decision = ctx.router.route(verifyMsg, 'verify');
    if (!decision.allowed) break;

    const context: AgentContext = {
      visibleMessages: [],
      localScratchpad: retries > 0 ? ctx.strings.retryVerify(retries) : undefined,
    };

    const response = await ctx.verifier.process(verifyMsg, context);
    ctx.router.route(response, 'verify');
    lastVerification = response.payload;

    allPassed = parseVerificationResult(response.payload);

    if (!allPassed && retries < ctx.config.maxLocalRetries - 1) {
      ctx.emit({
        type: 'retry',
        phase: 'verify',
        detail: `Verification failed (attempt ${retries + 1}), executor fixing...`,
      });

      const failureDetail = response.payload.slice(0, 500);
      const fixMsg = createMessage('verifier', 'executor', ctx.strings.fixIssues, failureDetail);
      const fixDecision = ctx.router.route(fixMsg, 'execute');

      if (fixDecision.allowed) {
        const execContext: AgentContext = {
          visibleMessages: [],
          localScratchpad: `${ctx.strings.fixVerifyIssues}: ${ctx.userRequest.slice(0, 300)}`,
        };
        const fixResponse = await ctx.executor.process(fixMsg, execContext);
        ctx.router.route(fixResponse, 'execute');

        const lastResult = results[results.length - 1];
        if (lastResult) {
          lastResult.output += `\n\n--- ${ctx.strings.fixSupplement} ---\n${fixResponse.payload}`;
          lastResult.success = true;
        }
      }
    }

    retries++;
  }

  // On failure, check if tee has original data that might help diagnosis
  if (!allPassed && ctx.compressor.teeSize > 0) {
    ctx.emit({
      type: 'message',
      phase: 'verify',
      detail: `Tee store has ${ctx.compressor.teeSize} original(s) available for recovery`,
    });
  }

  // Clean up tee store on success — no longer needed
  if (allPassed) {
    ctx.compressor.teeClear();
  }

  const plannerReport = allPassed
    ? ctx.locale === 'zh'
      ? '✅ 全部通过'
      : '✅ All passed'
    : ctx.locale === 'zh'
      ? `❌ 验证未通过: ${lastVerification.slice(0, 100)}`
      : `❌ Verification failed: ${lastVerification.slice(0, 100)}`;
  const reportMsg = createMessage('verifier', 'planner', 'verify-result', plannerReport);
  ctx.router.route(reportMsg, 'verify');

  ctx.emit({
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

function reportPhaseV2(results: ExecutionResult[], verification: VerificationResult): string {
  const executorContent = assembleReport(results);

  if (verification.passed) {
    return executorContent;
  }

  const statusLine = verification.plannerSummary;
  return `${statusLine}\n\n---\n\n${executorContent}`;
}
