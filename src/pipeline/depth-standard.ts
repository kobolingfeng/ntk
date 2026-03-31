/**
 * Standard depth — scout → executor (no planner).
 */

import type { Executor } from '../agents/executor.js';
import type { Scout } from '../agents/scout.js';
import type { Locale, PIPELINE_STRINGS } from '../core/prompts.js';
import type { AgentContext, TokenReport } from '../core/protocol.js';
import { createMessage } from '../core/protocol.js';
import type { Router, RouterStats } from '../core/router.js';
import { emptyOutputMessage } from './helpers.js';
import type { PipelineEvent, PipelineResult } from './types.js';

export async function runStandard(
  userRequest: string,
  executor: Executor,
  scout: Scout,
  router: Router,
  skipScout: boolean,
  strings: (typeof PIPELINE_STRINGS)['zh'],
  locale: Locale,
  getTokenReport: () => TokenReport,
  getRouterStats: () => RouterStats,
  emit: (event: PipelineEvent) => void,
): Promise<PipelineResult> {
  // Gather with Scout
  let scoutContext = '';

  if (!skipScout) {
    emit({ type: 'phase', phase: 'gather', detail: 'Scouting...' });

    const scoutMsg = createMessage('planner', 'scout', `${strings.research}: ${userRequest}`, '');
    const scoutCtx: AgentContext = { visibleMessages: [] };
    const scoutResponse = await scout.process(scoutMsg, scoutCtx);

    emit({ type: 'message', phase: 'gather', detail: `scout: ${scoutResponse.payload.slice(0, 80)}` });
    scoutContext = `${strings.researchResult}: ${scoutResponse.payload}`;
  }

  // Execute with Scout results as context
  emit({
    type: 'phase',
    phase: 'execute',
    detail: skipScout ? 'Executing (no scout)...' : 'Executing with research context...',
  });

  const execMsg = createMessage('planner', 'executor', userRequest, scoutContext);
  const execCtx: AgentContext = { visibleMessages: [] };
  const execResponse = await executor.process(execMsg, execCtx);

  const report = execResponse.payload.trim() || emptyOutputMessage(locale);
  emit({ type: 'complete', phase: 'report', detail: 'Done (standard)' });

  return {
    success: !!execResponse.payload.trim(),
    report,
    tokenReport: getTokenReport(),
    routerStats: getRouterStats(),
    blockedMessages: router.getBlockedLog(),
    depth: 'standard',
  };
}
