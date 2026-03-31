/**
 * Direct depth — single executor call, no verification.
 * Uses lightweight system prompt for minimal token overhead.
 */

import type { Executor } from '../agents/executor.js';
import type { LLMClient } from '../core/llm.js';
import { getBandPrompt, type Locale } from '../core/prompts.js';
import type { TokenReport } from '../core/protocol.js';
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
  llm?: LLMClient,
): Promise<PipelineResult> {
  emit({ type: 'phase', phase: 'execute', detail: 'Direct execution...' });

  const adaptiveMaxTokens =
    userRequest.length < 50 ? 512 : userRequest.length < 200 ? 1024 : userRequest.length > 2000 ? 1024 : undefined;

  let report: string;
  if (llm) {
    const bandPrompt = getBandPrompt(userRequest, locale);
    const { content } = await llm.chat(bandPrompt, userRequest, 'executor', 'execute', adaptiveMaxTokens);
    report = content.trim() || emptyOutputMessage(locale);
  } else {
    const { createMessage } = await import('../core/protocol.js');
    const msg = createMessage('planner', 'executor', userRequest, '');
    const context = { visibleMessages: [] };
    const response = await executor.process(msg, context);
    report = response.payload.trim() || emptyOutputMessage(locale);
  }

  emit({ type: 'complete', phase: 'report', detail: 'Done (direct)' });

  return {
    success: !!report,
    report,
    tokenReport: getTokenReport(),
    routerStats: getRouterStats(),
    blockedMessages: [],
    depth: 'direct',
  };
}
