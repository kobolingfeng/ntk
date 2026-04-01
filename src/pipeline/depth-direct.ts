/**
 * Direct depth — single executor call, no verification.
 * Uses lightweight system prompt for minimal token overhead.
 */

import type { Executor } from '../agents/executor.js';
import type { LLMClient } from '../core/llm.js';
import { getBandPrompt, type Locale } from '../core/prompts.js';
import { estimateTokens } from '../core/llm.js';
import type { TokenReport } from '../core/protocol.js';
import type { RouterStats } from '../core/router.js';
import { emptyOutputMessage } from './helpers.js';
import type { PipelineEvent, PipelineResult } from './types.js';

export interface DirectDepthContext {
  userRequest: string;
  executor: Executor;
  locale: Locale;
  getTokenReport: () => TokenReport;
  getRouterStats: () => RouterStats;
  emit: (event: PipelineEvent) => void;
  llm?: LLMClient;
  onToken?: (token: string) => void;
}

export async function runDirect(ctx: DirectDepthContext): Promise<PipelineResult> {
  ctx.emit({ type: 'phase', phase: 'execute', detail: 'Direct execution...' });

  let effectiveRequest = ctx.userRequest;
  if (ctx.userRequest.length > 3000) {
    const head = ctx.userRequest.slice(0, 1500);
    const tail = ctx.userRequest.slice(-500);
    effectiveRequest = `${head}\n\n[... ${ctx.userRequest.length - 2000} chars truncated for brevity ...]\n\n${tail}`;
    ctx.emit({
      type: 'message',
      phase: 'execute',
      detail: `Input truncated: ${ctx.userRequest.length} → ${effectiveRequest.length} chars`,
    });
  }

  const isMicroTask = effectiveRequest.length < 90;
  const adaptiveMaxTokens = isMicroTask
    ? 256
    : effectiveRequest.length < 150
      ? 512
      : effectiveRequest.length < 300
        ? 640
        : effectiveRequest.length < 500
          ? 1024
          : effectiveRequest.length > 2000
            ? 16384
            : 2048;
  const adaptiveTemp = isMicroTask ? 0 : effectiveRequest.length > 200 ? 0.4 : 0.1;

  const bandPrompt = getBandPrompt(effectiveRequest, ctx.locale, isMicroTask);

  // For passthrough tasks (no system prompt), use tight output budget
  // since output should be proportional to input size
  const maxOutputTokens = !bandPrompt
    ? Math.max(80, estimateTokens(effectiveRequest))
    : adaptiveMaxTokens;

  let rawContent = '';
  if (ctx.llm) {
    // Always use streaming for reliable output token limit enforcement
    const onToken = ctx.onToken ?? (() => {});
    const { content } = await ctx.llm.chatStream(
      bandPrompt,
      effectiveRequest,
      'executor',
      'execute',
      onToken,
      adaptiveMaxTokens,
      adaptiveTemp,
      maxOutputTokens,
    );
    rawContent = content.trim();
  } else {
    const { createMessage } = await import('../core/protocol.js');
    const msg = createMessage('planner', 'executor', effectiveRequest, '');
    const context = { visibleMessages: [] as never[] };
    const response = await ctx.executor.process(msg, context);
    rawContent = response.payload.trim();
  }

  const success = rawContent.length > 0;
  let report = rawContent || emptyOutputMessage(ctx.locale);
  report = report
    .replace(/\n*\[完成\]\s*$/g, '')
    .replace(/\n*\[done\]\s*$/gi, '')
    .trimEnd();

  ctx.emit({ type: 'complete', phase: 'report', detail: 'Done (direct)' });

  return {
    success,
    report,
    tokenReport: ctx.getTokenReport(),
    routerStats: ctx.getRouterStats(),
    blockedMessages: [],
    depth: 'direct',
  };
}
