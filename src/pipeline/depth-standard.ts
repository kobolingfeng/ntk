/**
 * Standard depth — scout → executor → optional verification.
 */

import type { Executor } from '../agents/executor.js';
import type { Scout } from '../agents/scout.js';
import type { Verifier } from '../agents/verifier.js';
import type { LLMClient } from '../core/llm.js';
import { getBandPrompt, type Locale, type PIPELINE_STRINGS } from '../core/prompts.js';
import type { AgentContext, TokenReport } from '../core/protocol.js';
import { createMessage, EMPTY_CONTEXT } from '../core/protocol.js';
import type { Router, RouterStats } from '../core/router.js';
import { emptyOutputMessage, fixUnbalancedFences, isStructurallyComplete, parseVerificationResult } from './helpers.js';
import type { PipelineEvent, PipelineResult } from './types.js';

export interface StandardDepthContext {
  userRequest: string;
  executor: Executor;
  scout: Scout;
  verifier?: Verifier;
  router: Router;
  skipScout: boolean;
  strings: (typeof PIPELINE_STRINGS)['zh'];
  locale: Locale;
  getTokenReport: () => TokenReport;
  getRouterStats: () => RouterStats;
  emit: (event: PipelineEvent) => void;
  llm?: LLMClient;
  onToken?: (token: string) => void;
  signal?: AbortSignal;
}

export async function runStandard(ctx: StandardDepthContext): Promise<PipelineResult> {
  let scoutContext = '';

  if (!ctx.skipScout) {
    ctx.emit({ type: 'phase', phase: 'gather', detail: 'Scouting...' });

    try {
      const scoutMsg = createMessage('planner', 'scout', `${ctx.strings.research}: ${ctx.userRequest}`, '');
      const scoutResponse = await ctx.scout.process(scoutMsg, EMPTY_CONTEXT);

      ctx.emit({ type: 'message', phase: 'gather', detail: `scout: ${scoutResponse.payload.slice(0, 80)}` });
      scoutContext = `${ctx.strings.researchResult}: ${scoutResponse.payload}`;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      ctx.emit({ type: 'error', phase: 'gather', detail: `scout failed, continuing without: ${errMsg}` });
    }
  }

  if (ctx.signal?.aborted) return abortedResult(ctx);

  ctx.emit({
    type: 'phase',
    phase: 'execute',
    detail: ctx.skipScout ? 'Executing (no scout)...' : 'Executing with research context...',
  });

  let rawContent = '';
  if (ctx.llm && ctx.onToken) {
    const bandPrompt = getBandPrompt(ctx.userRequest, ctx.locale);
    const fullPrompt = scoutContext ? `${scoutContext}\n\n${ctx.userRequest}` : ctx.userRequest;
    const { content } = await ctx.llm.chatStream(bandPrompt, fullPrompt, 'executor', 'execute', ctx.onToken, 2048, undefined, 2048, ctx.signal);
    rawContent = content.trim();
    const streamedResponse = createMessage('executor', 'planner', ctx.userRequest, rawContent);
    ctx.router.route(streamedResponse, 'execute');
  } else {
    const execMsg = createMessage('planner', 'executor', ctx.userRequest, scoutContext);
    ctx.router.route(execMsg, 'execute');
    const execResponse = await ctx.executor.process(execMsg, EMPTY_CONTEXT);
    ctx.router.route(execResponse, 'execute');
    rawContent = execResponse.payload.trim();
  }
  let report = rawContent || emptyOutputMessage(ctx.locale);

  if (ctx.signal?.aborted) return abortedResult(ctx);

  // Lightweight verification with smart skip (like light depth)
  if (ctx.verifier && rawContent.length > 0) {
    const skipVerify = isStructurallyComplete(rawContent, ctx.userRequest);
    if (!skipVerify) {
      ctx.emit({ type: 'phase', phase: 'verify', detail: 'Standard verification...' });
      try {
        const verifyMsg = createMessage('executor', 'verifier', ctx.strings.quickCheck, rawContent);
        const verifyResponse = await ctx.verifier.process(verifyMsg, EMPTY_CONTEXT);
        const passed = parseVerificationResult(verifyResponse.payload);
        if (!passed) {
          ctx.emit({ type: 'retry', phase: 'verify', detail: 'Standard fix attempt...' });
          try {
            const fixMsg = createMessage(
              'verifier',
              'executor',
              ctx.userRequest,
              `${ctx.strings.verifyFeedback}: ${verifyResponse.payload.slice(0, 300)}`,
            );
            const fixResponse = await ctx.executor.process(fixMsg, EMPTY_CONTEXT);
            report = fixResponse.payload.trim() || report;
          } catch {
            ctx.emit({ type: 'error', phase: 'verify', detail: 'Fix attempt failed, keeping original output' });
          }
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        ctx.emit({ type: 'error', phase: 'verify', detail: `verification failed: ${errMsg}` });
      }
    } else if (rawContent.length >= 100) {
      ctx.emit({ type: 'message', phase: 'verify', detail: 'Smart skip: output looks structurally complete' });
    }
  }

  report = fixUnbalancedFences(report);
  ctx.emit({ type: 'complete', phase: 'report', detail: 'Done (standard)' });

  return {
    success: rawContent.length > 0,
    report,
    tokenReport: ctx.getTokenReport(),
    routerStats: ctx.getRouterStats(),
    blockedMessages: ctx.router.getBlockedLog(),
    depth: 'standard',
  };
}

function abortedResult(ctx: StandardDepthContext): PipelineResult {
  return {
    success: false,
    report: 'Task cancelled.',
    tokenReport: ctx.getTokenReport(),
    routerStats: ctx.getRouterStats(),
    blockedMessages: ctx.router.getBlockedLog(),
    depth: 'standard',
  };
}
