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

export { Executor } from './agents/executor.js';
export type { PlannerInstruction } from './agents/planner.js';
export { Planner } from './agents/planner.js';
export { Scout } from './agents/scout.js';
export { Summarizer } from './agents/summarizer.js';
export { Verifier } from './agents/verifier.js';
export { NTKServer } from './api/server.js';
export type { CacheStats } from './core/cache.js';
export { ResponseCache } from './core/cache.js';
export {
  AllEndpointsFailedError,
  ClassifierError,
  CompressionError,
  LLMClientError,
  NTKError,
  PipelineError,
} from './core/errors.js';
export type { CompressionLevel, CompressResult } from './core/compressor.js';
export { Compressor } from './core/compressor.js';
export type { Endpoint } from './core/llm.js';
export { LLMClient } from './core/llm.js';
export type { PreFilterResult, PreFilterStrategyReport } from './core/pre-filter.js';
export { preFilter } from './core/pre-filter.js';
export type { Locale } from './core/prompts.js';
export { detectLocale } from './core/prompts.js';
export type {
  AgentContext,
  AgentType,
  InfoLevel,
  LLMConfig,
  Message,
  NTKConfig,
  Phase,
  Priority,
  RoutingRule,
  Task,
  TaskStatus,
  TokenReport,
  TokenUsage,
} from './core/protocol.js';
export { AGENT_INFO_LEVEL, createMessage, createTask } from './core/protocol.js';
export type { RouteDecision, RouterStats } from './core/router.js';
export { Router } from './core/router.js';
export { startMcpServer } from './mcp/server.js';
export { classifyDepthFastPath } from './pipeline/classifier.js';
export { assembleReport, generateTokenReport, parseVerificationResult } from './pipeline/helpers.js';
export { Pipeline } from './pipeline/pipeline.js';
export type {
  ExecutionResult,
  PipelineDepth,
  PipelineEvent,
  PipelineResult,
  VerificationResult,
} from './pipeline/types.js';
