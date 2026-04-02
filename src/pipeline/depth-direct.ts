/**
 * Direct depth — single executor call, no verification.
 * Uses lightweight system prompt for minimal token overhead.
 */

import type { Executor } from '../agents/executor.js';
import type { LLMClient } from '../core/llm.js';
import { getBandPrompt, PASSTHROUGH_TASK_PATTERN, CODE_TASK_PATTERN, type Locale } from '../core/prompts.js';
import { estimateTokens } from '../core/llm.js';
import type { TokenReport } from '../core/protocol.js';
import { createMessage } from '../core/protocol.js';
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
  plannerLLM?: LLMClient;
  onToken?: (token: string) => void;
}

export async function runDirect(ctx: DirectDepthContext): Promise<PipelineResult> {
  ctx.emit({ type: 'phase', phase: 'execute', detail: 'Direct execution...' });

  let effectiveRequest = ctx.userRequest;
  if (ctx.userRequest.length > 3000) {
    const head = ctx.userRequest.slice(0, 1200);
    const midStart = Math.floor((ctx.userRequest.length - 400) / 2);
    const mid = ctx.userRequest.slice(midStart, midStart + 400);
    const tail = ctx.userRequest.slice(-500);
    const omitted = ctx.userRequest.length - 2100;
    effectiveRequest = `${head}\n\n[... ${omitted} chars omitted ...]\n\n${mid}\n\n[... omitted ...]\n\n${tail}`;
    ctx.emit({
      type: 'message',
      phase: 'execute',
      detail: `Input truncated: ${ctx.userRequest.length} → ${effectiveRequest.length} chars`,
    });
  }

  const isMicroTask = effectiveRequest.length < 90;
  const isMicroCode = isMicroTask && CODE_TASK_PATTERN.test(effectiveRequest);
  const adaptiveMaxTokens = isMicroTask
    ? (isMicroCode ? 768 : 256)
    : effectiveRequest.length < 150
      ? 512
      : effectiveRequest.length < 300
        ? 640
        : effectiveRequest.length < 500
          ? 1024
          : effectiveRequest.length < 1000
            ? 1536
            : effectiveRequest.length > 2000
              ? 16384
              : 2048;
  const adaptiveTemp = 0;

  const bandPrompt = getBandPrompt(effectiveRequest, ctx.locale, isMicroTask);

  // For passthrough tasks (no system prompt), use tight output budget
  // since output should be proportional to input size
  const maxOutputTokens = !bandPrompt
    ? Math.max(80, estimateTokens(effectiveRequest))
    : adaptiveMaxTokens;

  let rawContent = '';
  // Use planner model for passthrough and micro tasks — native conciseness
  const isPassthrough = !bandPrompt && PASSTHROUGH_TASK_PATTERN.test(effectiveRequest);
  const usePlanner = (isPassthrough || isMicroTask) && !!ctx.plannerLLM;
  const activeLLM = usePlanner ? ctx.plannerLLM : ctx.llm;
  if (activeLLM) {
    // Always use streaming for reliable output token limit enforcement
    const onToken = ctx.onToken ?? (() => {});
    const { content } = await activeLLM.chatStream(
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
    const msg = createMessage('planner', 'executor', effectiveRequest, '');
    const context = { visibleMessages: [] as never[] };
    const response = await ctx.executor.process(msg, context);
    rawContent = response.payload.trim();
  }

  const success = rawContent.length > 0;
  let report = rawContent || emptyOutputMessage(ctx.locale);
  report = report
    .replace(/\n*\[(?:完成|done)\]\s*$/gi, '')
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
