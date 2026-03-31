/**
 * Direct depth — single executor call, no verification.
 */

import type { Executor } from '../agents/executor.js';
import type { Locale } from '../core/prompts.js';
import type { AgentContext, TokenReport } from '../core/protocol.js';
import { createMessage } from '../core/protocol.js';
import type { RouterStats } from '../core/router.js';
import { emptyOutputMessage } from './helpers.js';
import type { PipelineEvent, PipelineResult } from './types.js';

export async function runDirect(
  userRequest: string,
  executor: Executor,
  locale: Locale,
  getTokenReport: () => TokenReport,
  getRouterStats: () => RouterStats,
  emit: (event: PipelineEvent) => void,
): Promise<PipelineResult> {
  emit({ type: 'phase', phase: 'execute', detail: 'Direct execution...' });

  const msg = createMessage('planner', 'executor', userRequest, '');
  const context: AgentContext = { visibleMessages: [] };
  const response = await executor.process(msg, context);

  const report = response.payload.trim() || emptyOutputMessage(locale);
  emit({ type: 'complete', phase: 'report', detail: 'Done (direct)' });

  return {
    success: !!response.payload.trim(),
    report,
    tokenReport: getTokenReport(),
    routerStats: getRouterStats(),
    blockedMessages: [],
    depth: 'direct',
  };
}
