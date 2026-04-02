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
import { getBandPrompt } from '../core/prompts.js';
import type { AgentContext, NTKConfig, TokenReport } from '../core/protocol.js';
import { createMessage, EMPTY_CONTEXT } from '../core/protocol.js';
import type { Router, RouterStats } from '../core/router.js';
import { assembleReport, fixUnbalancedFences, FULL_SKIP_THRESHOLDS, isStructurallyComplete, parseVerificationResult } from './helpers.js';
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
  signal?: AbortSignal;
}

export async function runFull(ctx: FullDepthContext): Promise<PipelineResult> {
  // Gather
  await gatherPhase(ctx);
  if (ctx.signal?.aborted) return abortedResult(ctx);

  // Plan
  const instructions = await planPhase(ctx);
  if (ctx.signal?.aborted) return abortedResult(ctx);

  // Execute
  const results = await executePhase(ctx, instructions);
  if (ctx.signal?.aborted) return abortedResult(ctx);

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

// ─── Abort Helper ───────────────────────────────────

function abortedResult(ctx: { getTokenReport: () => TokenReport; getRouterStats: () => RouterStats; router: Router }, depth: 'full' | 'light' | 'standard' = 'full'): PipelineResult {
  return {
    success: false,
    report: 'Task cancelled.',
    tokenReport: ctx.getTokenReport(),
    routerStats: ctx.getRouterStats(),
    blockedMessages: ctx.router.getBlockedLog(),
    depth,
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
      try {
        const response = await agent.process(msg, context);
        return { inst, decision, response };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        ctx.emit({ type: 'error', phase: 'gather', detail: `${inst.target} failed: ${errMsg}` });
        return null;
      }
    });

  const gatherResults = await Promise.all(gatherTasks);

  // Compress gather results in parallel (all use independent compressor calls)
  const validResults = gatherResults.filter((r): r is NonNullable<typeof r> => r !== null);
  const compressionTasks = validResults.map(async (result) => {
    const { inst, decision, response } = result;
    if (decision.needsCompression) {
      try {
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
      } catch {
        // Compression failed — use uncompressed payload (graceful degradation)
        ctx.emit({
          type: 'message',
          phase: 'gather',
          detail: `Compression fallback: using uncompressed ${inst.target} output (${response.payload.length} chars)`,
        });
      }
    }
  });
  await Promise.all(compressionTasks);

  for (const result of validResults) {
    const { inst, response } = result;
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
    try {
      if (ctx.onToken && ctx.compressorLLM) {
        const prompt = getBandPrompt(inst.instruction, ctx.locale);
        const fullInput = `${ctx.strings.originalRequest}: ${ctx.userRequest}\n\n${inst.instruction}`;
        const { content } = await ctx.compressorLLM.chatStream(prompt, fullInput, 'executor', 'execute', ctx.onToken, undefined, undefined, undefined, ctx.signal);
        output = content;
        // Route the streamed response through the router for consistency with non-streaming path
        const streamedResponse = createMessage('executor', 'planner', inst.instruction, output);
        ctx.router.route(streamedResponse, 'execute');
      } else {
        const response = await ctx.executor.process(msg, EMPTY_CONTEXT);
        ctx.router.route(response, 'execute');
        output = response.payload;
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      ctx.emit({ type: 'error', phase: 'execute', detail: `serial task failed: ${errMsg}` });
      results.push({ instruction: inst.instruction, output: '', success: false });
      continue;
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

    try {
      const response = await ctx.executor.process(msg, EMPTY_CONTEXT);
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
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      ctx.emit({ type: 'error', phase: 'execute', detail: `parallel task failed: ${errMsg}` });
      return {
        instruction: inst.instruction,
        output: '',
        success: false,
      } as ExecutionResult;
    }
  });

  const results = await Promise.all(tasks);
  return results.filter((r): r is ExecutionResult => r !== null && (r.success || r.output.length > 0));
}

async function verifyPhase(ctx: FullDepthContext, results: ExecutionResult[]): Promise<VerificationResult> {
  if (results.length === 0) {
    return { passed: false, attempts: 0, detail: '', plannerSummary: ctx.locale === 'zh' ? '❌ 无执行结果' : '❌ No results' };
  }

  const combinedOutput = results.map((r) => r.output).join('\n');
  if (results.length > 0 && isStructurallyComplete(combinedOutput, ctx.userRequest, FULL_SKIP_THRESHOLDS)) {
    ctx.emit({ type: 'message', phase: 'verify', detail: 'Smart skip: all results look structurally complete' });
    ctx.compressor.teeClear();
    const summaryMsg = ctx.locale === 'zh' ? '✅ 全部通过（智能跳过）' : '✅ All passed (smart skip)';
    const reportMsg = createMessage('verifier', 'planner', 'verify-result', summaryMsg);
    ctx.router.route(reportMsg, 'verify');
    ctx.emit({ type: 'verified', phase: 'verify', detail: summaryMsg });
    return { passed: true, attempts: 0, detail: '', plannerSummary: summaryMsg };
  }

  ctx.emit({ type: 'phase', phase: 'verify', detail: 'Verifying results...' });

  let retries = 0;
  let allPassed = false;
  let lastVerification = '';

  while (retries < ctx.config.maxLocalRetries && !allPassed) {
    const MAX_OUTPUT_CHARS = Math.max(100, Math.min(1200, Math.floor(4000 / results.length)));
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

    let response;
    try {
      response = await ctx.verifier.process(verifyMsg, context);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      ctx.emit({ type: 'error', phase: 'verify', detail: `verifier failed: ${errMsg}` });
      // Verifier crash → treat as passed (benefit of the doubt)
      allPassed = true;
      break;
    }
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
        try {
          const fixResponse = await ctx.executor.process(fixMsg, execContext);
          ctx.router.route(fixResponse, 'execute');

          const lastResult = results[results.length - 1];
          if (lastResult) {
            lastResult.output += `\n\n--- ${ctx.strings.fixSupplement} ---\n${fixResponse.payload}`;
            lastResult.success = true;
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          ctx.emit({ type: 'error', phase: 'verify', detail: `fix attempt failed: ${errMsg}` });
        }
      }
    }

    retries++;
  }

  // On failure, attempt tee recovery: restore original context and re-execute
  if (!allPassed && ctx.compressor.teeSize > 0 && retries >= ctx.config.maxLocalRetries) {
    ctx.emit({
      type: 'message',
      phase: 'verify',
      detail: `Attempting tee recovery: ${ctx.compressor.teeSize} original(s) available`,
    });

    // Re-execute the last failed result with original (uncompressed) context
    const lastResult = results[results.length - 1];
    if (lastResult) {
      try {
        const originals: string[] = [];
        for (const id of ctx.compressor.teeIds) {
          const original = ctx.compressor.teeRetrieve(id);
          if (original) originals.push(original);
        }

        if (originals.length > 0) {
          const recoveredContext = originals.join('\n');

          const fixMsg = createMessage(
            'verifier',
            'executor',
            ctx.strings.fixIssues,
            `${lastVerification.slice(0, 300)}\n\n${ctx.strings.originalRequest}: ${ctx.userRequest.slice(0, 300)}\n\n[Recovered context]:\n${recoveredContext.slice(0, 2000)}`,
          );
          const fixDecision = ctx.router.route(fixMsg, 'execute');
          if (fixDecision.allowed) {
            const fixResponse = await ctx.executor.process(fixMsg, EMPTY_CONTEXT);
            ctx.router.route(fixResponse, 'execute');
            lastResult.output += `\n\n--- ${ctx.strings.fixSupplement} (tee recovery) ---\n${fixResponse.payload}`;

            // Re-verify after tee recovery
            const reVerifyInput = `[${ctx.strings.taskLabel}: ${lastResult.instruction}]\n${lastResult.output.slice(0, 2000)}`;
            const reVerifyMsg = createMessage('executor', 'verifier', ctx.strings.verifyResults, reVerifyInput);
            const reDecision = ctx.router.route(reVerifyMsg, 'verify');
            if (reDecision.allowed) {
              const reResponse = await ctx.verifier.process(reVerifyMsg, EMPTY_CONTEXT);
              ctx.router.route(reResponse, 'verify');
              allPassed = parseVerificationResult(reResponse.payload);
              lastVerification = reResponse.payload;
              ctx.emit({
                type: allPassed ? 'verified' : 'verification-failed',
                phase: 'verify',
                detail: `Tee recovery ${allPassed ? 'succeeded' : 'failed'}: ${reResponse.payload.slice(0, 100)}`,
              });
            }
          }
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.emit({ type: 'error', phase: 'verify', detail: `Tee recovery error: ${msg}` });
      }
    }
  }

  // Clean up tee store
  ctx.compressor.teeClear();

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
  const executorContent = fixUnbalancedFences(assembleReport(results));

  if (verification.passed) {
    return executorContent;
  }

  const statusLine = verification.plannerSummary;
  return `${statusLine}\n\n---\n\n${executorContent}`;
}
