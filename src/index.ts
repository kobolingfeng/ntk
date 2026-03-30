/**
 * NTK — NeedToKnow Multi-Agent Framework
 *
 * A framework that treats AI agents differently from humans.
 * Because AI needs to know LESS to do MORE.
 *
 * Two innovations:
 * 1. Role division by information density, not human job titles
 * 2. Selective information routing (need-to-know basis)
 */

export { Pipeline } from './pipeline/pipeline.js';
export { NTKServer } from './api/server.js';
export { startMcpServer } from './mcp/server.js';
export type { PipelineResult, PipelineEvent, PipelineDepth } from './pipeline/pipeline.js';

export { Router } from './core/router.js';
export type { RouteDecision, RouterStats } from './core/router.js';

export { Compressor } from './core/compressor.js';
export type { CompressResult } from './core/compressor.js';

export { LLMClient } from './core/llm.js';

export { Planner } from './agents/planner.js';
export { Scout } from './agents/scout.js';
export { Summarizer } from './agents/summarizer.js';
export { Executor } from './agents/executor.js';
export { Verifier } from './agents/verifier.js';

export type {
  NTKConfig,
  LLMConfig,
  Message,
  Task,
  AgentType,
  InfoLevel,
  Phase,
  TokenReport,
} from './core/protocol.js';
export { createMessage, createTask, AGENT_INFO_LEVEL } from './core/protocol.js';

export { detectLocale } from './core/prompts.js';
export type { Locale } from './core/prompts.js';
