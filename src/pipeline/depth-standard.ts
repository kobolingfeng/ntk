/**
 * Standard depth — scout → executor (no planner).
 */

import type { Executor } from '../agents/executor.js';
import type { Scout } from '../agents/scout.js';
import type { LLMClient } from '../core/llm.js';
import { getBandPrompt, type Locale, type PIPELINE_STRINGS } from '../core/prompts.js';
import type { AgentContext, TokenReport } from '../core/protocol.js';
import { createMessage, EMPTY_CONTEXT } from '../core/protocol.js';
import type { Router, RouterStats } from '../core/router.js';
import { emptyOutputMessage } from './helpers.js';
import type { PipelineEvent, PipelineResult } from './types.js';

export interface StandardDepthContext {
  userRequest: string;
  executor: Executor;
  scout: Scout;
  router: Router;
  skipScout: boolean;
  strings: (typeof PIPELINE_STRINGS)['zh'];
  locale: Locale;
  getTokenReport: () => TokenReport;
  getRouterStats: () => RouterStats;
  emit: (event: PipelineEvent) => void;
  llm?: LLMClient;
  onToken?: (token: string) => void;
}

export async function runStandard(ctx: StandardDepthContext): Promise<PipelineResult> {
  let scoutContext = '';

  if (!ctx.skipScout) {
    ctx.emit({ type: 'phase', phase: 'gather', detail: 'Scouting...' });

    const scoutMsg = createMessage('planner', 'scout', `${ctx.strings.research}: ${ctx.userRequest}`, '');
    const scoutResponse = await ctx.scout.process(scoutMsg, EMPTY_CONTEXT);

    ctx.emit({ type: 'message', phase: 'gather', detail: `scout: ${scoutResponse.payload.slice(0, 80)}` });
    scoutContext = `${ctx.strings.researchResult}: ${scoutResponse.payload}`;
  }

  ctx.emit({
    type: 'phase',
    phase: 'execute',
    detail: ctx.skipScout ? 'Executing (no scout)...' : 'Executing with research context...',
  });

  let rawContent = '';
  if (ctx.llm && ctx.onToken) {
    const bandPrompt = getBandPrompt(ctx.userRequest, ctx.locale);
    const fullPrompt = scoutContext ? `${scoutContext}\n\n${ctx.userRequest}` : ctx.userRequest;
    const { content } = await ctx.llm.chatStream(bandPrompt, fullPrompt, 'executor', 'execute', ctx.onToken, 2048, undefined, 2048);
    rawContent = content.trim();
    const streamedResponse = createMessage('executor', 'planner', ctx.userRequest, rawContent);
    ctx.router.route(streamedResponse, 'execute');
  } else {
    const execMsg = createMessage('planner', 'executor', ctx.userRequest, scoutContext);
    ctx.router.route(execMsg, 'execute');
    const execResponse = await ctx.executor.process(execMsg, EMPTY_CONTEXT);
    ctx.router.route(execResponse, 'execute');
    rawContent = execResponse.payload.trim();
  }
  const report = rawContent || emptyOutputMessage(ctx.locale);
  ctx.emit({ type: 'complete', phase: 'report', detail: 'Done (standard)' });

  return {
    success: rawContent.length > 0,
    report,
    tokenReport: ctx.getTokenReport(),
    routerStats: ctx.getRouterStats(),
    blockedMessages: ctx.router.getBlockedLog(),
    depth: 'standard',
  };
}
