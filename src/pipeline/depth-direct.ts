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

  let effectiveRequest = userRequest;
  if (userRequest.length > 3000) {
    const head = userRequest.slice(0, 1500);
    const tail = userRequest.slice(-500);
    effectiveRequest = `${head}\n\n[... ${userRequest.length - 2000} chars truncated for brevity ...]\n\n${tail}`;
    emit({ type: 'message', phase: 'execute', detail: `Input truncated: ${userRequest.length} → ${effectiveRequest.length} chars` });
  }

  const adaptiveTemp = userRequest.length < 30 ? 0.1 : userRequest.length > 200 ? 0.4 : undefined;

  let report: string;
  if (llm) {
    const bandPrompt = getBandPrompt(effectiveRequest, locale);
    const { content } = await llm.chat(bandPrompt, effectiveRequest, 'executor', 'execute', adaptiveMaxTokens, adaptiveTemp);
    report = content.trim() || emptyOutputMessage(locale);
  } else {
    const { createMessage } = await import('../core/protocol.js');
    const msg = createMessage('planner', 'executor', userRequest, '');
    const context = { visibleMessages: [] };
    const response = await executor.process(msg, context);
    report = response.payload.trim() || emptyOutputMessage(locale);
  }

  report = report.replace(/\n*\[完成\]\s*$/g, '').replace(/\n*\[done\]\s*$/gi, '').trimEnd();

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
