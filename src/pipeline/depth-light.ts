/**
 * Light depth — executor + lightweight verification with one retry.
 */

import type { Executor } from '../agents/executor.js';
import type { Verifier } from '../agents/verifier.js';
import type { Locale, PIPELINE_STRINGS } from '../core/prompts.js';
import type { AgentContext, TokenReport } from '../core/protocol.js';
import { createMessage } from '../core/protocol.js';
import type { Router, RouterStats } from '../core/router.js';
import { emptyOutputMessage, parseVerificationResult } from './helpers.js';
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
}

export async function runLight(ctx: LightDepthContext): Promise<PipelineResult> {
  ctx.emit({ type: 'phase', phase: 'execute', detail: 'Light execution...' });

  const msg = createMessage('planner', 'executor', ctx.userRequest, '');
  const context: AgentContext = { visibleMessages: [] };
  const response = await ctx.executor.process(msg, context);

  ctx.emit({ type: 'phase', phase: 'verify', detail: 'Light verification...' });

  const verifyMsg = createMessage('executor', 'verifier', ctx.strings.quickCheck, response.payload);
  const verifyCtx: AgentContext = { visibleMessages: [] };
  const verifyResponse = await ctx.verifier.process(verifyMsg, verifyCtx);

  const passed = parseVerificationResult(verifyResponse.payload);
  let report = response.payload.trim() || emptyOutputMessage(ctx.locale);

  if (!passed) {
    ctx.emit({ type: 'retry', phase: 'verify', detail: 'Light fix attempt...' });
    const fixMsg = createMessage(
      'verifier',
      'executor',
      ctx.userRequest,
      `${ctx.strings.verifyFeedback}: ${verifyResponse.payload.slice(0, 300)}`,
    );
    const fixCtx: AgentContext = { visibleMessages: [] };
    const fixResponse = await ctx.executor.process(fixMsg, fixCtx);
    report = fixResponse.payload.trim() || report;
  }

  ctx.emit({ type: 'complete', phase: 'report', detail: 'Done (light)' });

  return {
    success: !!report.trim(),
    report,
    tokenReport: ctx.getTokenReport(),
    routerStats: ctx.getRouterStats(),
    blockedMessages: ctx.router.getBlockedLog(),
    depth: 'light',
  };
}
