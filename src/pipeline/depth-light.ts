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

export async function runLight(
  userRequest: string,
  executor: Executor,
  verifier: Verifier,
  router: Router,
  strings: (typeof PIPELINE_STRINGS)['zh'],
  locale: Locale,
  getTokenReport: () => TokenReport,
  getRouterStats: () => RouterStats,
  emit: (event: PipelineEvent) => void,
): Promise<PipelineResult> {
  emit({ type: 'phase', phase: 'execute', detail: 'Light execution...' });

  const msg = createMessage('planner', 'executor', userRequest, '');
  const context: AgentContext = { visibleMessages: [] };
  const response = await executor.process(msg, context);

  // Light verification: quick sanity check
  emit({ type: 'phase', phase: 'verify', detail: 'Light verification...' });

  const verifyMsg = createMessage('executor', 'verifier', strings.quickCheck, response.payload);
  const verifyCtx: AgentContext = { visibleMessages: [] };
  const verifyResponse = await verifier.process(verifyMsg, verifyCtx);

  const passed = parseVerificationResult(verifyResponse.payload);
  let report = response.payload.trim() || emptyOutputMessage(locale);

  // If verification failed, do one retry with original context
  if (!passed) {
    emit({ type: 'retry', phase: 'verify', detail: 'Light fix attempt...' });
    const fixMsg = createMessage(
      'verifier',
      'executor',
      userRequest,
      `${strings.verifyFeedback}: ${verifyResponse.payload.slice(0, 300)}`,
    );
    const fixCtx: AgentContext = { visibleMessages: [] };
    const fixResponse = await executor.process(fixMsg, fixCtx);
    report = fixResponse.payload.trim() || report;
  }

  emit({ type: 'complete', phase: 'report', detail: 'Done (light)' });

  return {
    success: !!report.trim(),
    report,
    tokenReport: getTokenReport(),
    routerStats: getRouterStats(),
    blockedMessages: router.getBlockedLog(),
    depth: 'light',
  };
}
