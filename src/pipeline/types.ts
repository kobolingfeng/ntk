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

export interface PipelineResult {
  success: boolean;
  report: string;
  tokenReport: TokenReport;
  routerStats: RouterStats;
  blockedMessages: Array<{ message: Message; reason: string }>;
  depth?: PipelineDepth;
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
