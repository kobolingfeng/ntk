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
  llm?: LLMClient;
  onToken?: (token: string) => void;
}

/**
 * Heuristic: check if output looks structurally complete enough to skip verification.
 * Returns true if verification can be skipped.
 */
function shouldSkipVerification(output: string, userRequest: string): boolean {
  if (output.length < 100) return true;

  const hasCodeBlock = /```[\s\S]{20,}```/.test(output);
  const hasNumberedList = /^\d+\.\s/m.test(output);
  const hasBulletList = /^[-*]\s/m.test(output);

  const isCodeTask = /写|实现|编写|代码|write|implement|code|function|class/i.test(userRequest);
  const isAnalysisTask = /分析|比较|对比|解释|compare|analyze|explain/i.test(userRequest);

  if (isCodeTask && hasCodeBlock && output.length > 200) return true;
  if (isAnalysisTask && (hasNumberedList || hasBulletList) && output.length > 150) return true;

  if (output.length > 500 && (hasCodeBlock || hasNumberedList)) return true;

  return false;
}

export async function runLight(ctx: LightDepthContext): Promise<PipelineResult> {
  ctx.emit({ type: 'phase', phase: 'execute', detail: 'Light execution...' });

  const msg = createMessage('planner', 'executor', ctx.userRequest, '');
  ctx.router.route(msg, 'execute');

  let rawContent = '';
  if (ctx.llm && ctx.onToken) {
    const bandPrompt = getBandPrompt(ctx.userRequest, ctx.locale);
    const { content } = await ctx.llm.chatStream(bandPrompt, ctx.userRequest, 'executor', 'execute', ctx.onToken);
    rawContent = content.trim();
    const streamedResponse = createMessage('executor', 'planner', ctx.userRequest, rawContent);
    ctx.router.route(streamedResponse, 'execute');
  } else {
    const context: AgentContext = { visibleMessages: [] };
    const response = await ctx.executor.process(msg, context);
    ctx.router.route(response, 'execute');
    rawContent = response.payload.trim();
  }

  let report = rawContent || emptyOutputMessage(ctx.locale);

  const skipVerify = shouldSkipVerification(rawContent, ctx.userRequest);

  let passed = true;
  let verifyFeedback = '';
  if (!skipVerify) {
    ctx.emit({ type: 'phase', phase: 'verify', detail: 'Light verification...' });

    const verifyMsg = createMessage('executor', 'verifier', ctx.strings.quickCheck, rawContent);
    const verifyCtx: AgentContext = { visibleMessages: [] };
    const verifyResponse = await ctx.verifier.process(verifyMsg, verifyCtx);

    passed = parseVerificationResult(verifyResponse.payload);
    verifyFeedback = verifyResponse.payload;
  } else if (rawContent.length >= 100) {
    ctx.emit({ type: 'message', phase: 'verify', detail: 'Smart skip: output looks structurally complete' });
  }

  if (!passed) {
    ctx.emit({ type: 'retry', phase: 'verify', detail: 'Light fix attempt...' });
    const fixMsg = createMessage(
      'verifier',
      'executor',
      ctx.userRequest,
      `${ctx.strings.verifyFeedback}: ${verifyFeedback.slice(0, 300)}`,
    );
    const fixCtx: AgentContext = { visibleMessages: [] };
    const fixResponse = await ctx.executor.process(fixMsg, fixCtx);
    report = fixResponse.payload.trim() || report;
  }

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
