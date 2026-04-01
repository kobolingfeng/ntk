/**
 * Pipeline types — shared interfaces and type definitions.
 */

import type { Message, Phase, TokenReport } from '../core/protocol.js';
import type { RouterStats } from '../core/router.js';

export type PipelineDepth = 'direct' | 'light' | 'standard' | 'full';

export interface PipelineEvent {
  type: string;
  phase: Phase;
  detail: string;
}

export interface PreFilterSavings {
  totalCharsRemoved: number;
  totalOriginal: number;
  callCount: number;
  reductionPercent: number;
}

export interface PipelineTrace {
  startedAt: number;
  finishedAt: number;
  durationMs: number;
  routing: {
    fastPathResult: PipelineDepth | null;
    classifierResult: PipelineDepth | null;
    finalDepth: PipelineDepth;
    speculativeHit: boolean | null;
    predictionConfidence: number | null;
  };
  compression: {
    preFilterCharsRemoved: number;
    preFilterOriginalChars: number;
    preFilterReductionPercent: number;
    llmCompressionCalls: number;
    teeEntriesStored: number;
    teeRetrieved: number;
  };
  tokens: {
    totalInput: number;
    totalOutput: number;
    total: number;
    strongModelTokens: number;
    cheapModelTokens: number;
    strongModelPercent: number;
    estimatedCostSavingsPercent: number;
    byAgent: Record<string, { input: number; output: number }>;
  };
  errors: {
    compressionFallbacks: number;
    teeRecoveryAttempts: number;
    teeRecoverySuccesses: number;
    apiRetries: number;
  };
  cached: boolean;
  events: PipelineEvent[];
}

export interface PipelineResult {
  success: boolean;
  report: string;
  tokenReport: TokenReport;
  routerStats: RouterStats;
  blockedMessages: readonly { message: Message; reason: string }[];
  depth?: PipelineDepth;
  preFilterSavings?: PreFilterSavings;
  cached?: boolean;
  trace?: PipelineTrace;
}

export interface ExecutionResult {
  instruction: string;
  output: string;
  success: boolean;
}

export interface VerificationResult {
  passed: boolean;
  attempts: number;
  detail: string;
  plannerSummary: string;
}
