/**
 * Light depth — executor + smart verification skip + one retry.
 *
 * Smart skip: if executor output looks structurally complete (has code blocks,
 * numbered lists, or sufficient length), skip the verifier LLM call entirely.
 * This saves ~50% of light depth token costs for well-formed outputs.
 */

import type { Executor } from '../agents/executor.js';
import type { Verifier } from '../agents/verifier.js';
import type { LLMClient } from '../core/llm.js';
import { getBandPrompt, type Locale, type PIPELINE_STRINGS } from '../core/prompts.js';
import type { AgentContext, TokenReport } from '../core/protocol.js';
import { createMessage, EMPTY_CONTEXT } from '../core/protocol.js';
import type { Router, RouterStats } from '../core/router.js';
import { emptyOutputMessage, fixUnbalancedFences, isStructurallyComplete, parseVerificationResult } from './helpers.js';
import type { PipelineEvent, PipelineResult } from './types.js';

export interface LightDepthContext {
  userRequest: string;
  executor: Executor;
  verifier: Verifier;
  router: Router;
  strings: (typeof PIPELINE_STRINGS)['zh'];
  locale: Locale;
  getTokenReport: () => TokenReport;
  getRouterStats: () => RouterStats;
  emit: (event: PipelineEvent) => void;
  llm?: LLMClient;
  onToken?: (token: string) => void;
}


export async function runLight(ctx: LightDepthContext): Promise<PipelineResult> {
  ctx.emit({ type: 'phase', phase: 'execute', detail: 'Light execution...' });

  const msg = createMessage('planner', 'executor', ctx.userRequest, '');
  ctx.router.route(msg, 'execute');

  let rawContent = '';
  if (ctx.llm && ctx.onToken) {
    const bandPrompt = getBandPrompt(ctx.userRequest, ctx.locale);
    const { content } = await ctx.llm.chatStream(bandPrompt, ctx.userRequest, 'executor', 'execute', ctx.onToken, 2048, undefined, 2048);
    rawContent = content.trim();
    const streamedResponse = createMessage('executor', 'planner', ctx.userRequest, rawContent);
    ctx.router.route(streamedResponse, 'execute');
  } else {
    const response = await ctx.executor.process(msg, EMPTY_CONTEXT);
    ctx.router.route(response, 'execute');
    rawContent = response.payload.trim();
  }

  let report = rawContent || emptyOutputMessage(ctx.locale);

  const skipVerify = isStructurallyComplete(rawContent, ctx.userRequest);

  let passed = true;
  let verifyFeedback = '';
  if (!skipVerify) {
    ctx.emit({ type: 'phase', phase: 'verify', detail: 'Light verification...' });

    try {
      const verifyMsg = createMessage('executor', 'verifier', ctx.strings.quickCheck, rawContent);
      const verifyResponse = await ctx.verifier.process(verifyMsg, EMPTY_CONTEXT);

      passed = parseVerificationResult(verifyResponse.payload);
      verifyFeedback = verifyResponse.payload;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      ctx.emit({ type: 'error', phase: 'verify', detail: `verifier failed: ${errMsg}` });
      // Verifier crash → treat as passed
    }
  } else if (rawContent.length >= 100) {
    ctx.emit({ type: 'message', phase: 'verify', detail: 'Smart skip: output looks structurally complete' });
  }

  if (!passed) {
    ctx.emit({ type: 'retry', phase: 'verify', detail: 'Light fix attempt...' });
    try {
      const fixMsg = createMessage(
        'verifier',
        'executor',
        ctx.userRequest,
        `${ctx.strings.verifyFeedback}: ${verifyFeedback.slice(0, 300)}`,
      );
      const fixResponse = await ctx.executor.process(fixMsg, EMPTY_CONTEXT);
      report = fixResponse.payload.trim() || report;
    } catch {
      ctx.emit({ type: 'error', phase: 'verify', detail: 'Fix attempt failed, keeping original output' });
    }
  }

  report = fixUnbalancedFences(report);
  ctx.emit({ type: 'complete', phase: 'report', detail: 'Done (light)' });

  return {
    success: rawContent.length > 0,
    report,
    tokenReport: ctx.getTokenReport(),
    routerStats: ctx.getRouterStats(),
    blockedMessages: ctx.router.getBlockedLog(),
    depth: 'light',
  };
}
