/**
 * Direct depth — single executor call, no verification.
 * Uses lightweight system prompt for minimal token overhead.
 */

import type { Executor } from '../agents/executor.js';
import type { LLMClient } from '../core/llm.js';
import { EXECUTOR_LITE_PROMPT, type Locale } from '../core/prompts.js';
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
  llm?: LLMClient,
): Promise<PipelineResult> {
  emit({ type: 'phase', phase: 'execute', detail: 'Direct execution...' });

  let report: string;
  if (llm) {
    const { content } = await llm.chat(EXECUTOR_LITE_PROMPT[locale], userRequest, 'executor', 'execute');
    report = content.trim() || emptyOutputMessage(locale);
  } else {
    const msg = createMessage('planner', 'executor', userRequest, '');
    const context: AgentContext = { visibleMessages: [] };
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
