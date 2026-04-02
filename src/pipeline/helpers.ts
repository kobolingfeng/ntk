/**
 * Pipeline helpers — verification parsing, report generation, token calculation.
 */

import { ANALYSIS_TASK_PATTERN, CODE_TASK_PATTERN, type Locale } from '../core/prompts.js';
import type { TokenReport, TokenUsage } from '../core/protocol.js';
import type { ExecutionResult, PipelineTrace } from './types.js';

// Pre-compiled regex for parseVerificationResult
const PASS_KEYWORD = /\b(?:pass(?:ed)?|all correct|no issues)\b|通过|正确|没有问题|无问题/;
const FAIL_KEYWORD = /\b(?:fail(?:ed)?|errors?|incorrect|wrong)\b|失败|错误|不正确|有问题/;
const NEGATION_PASS = /没有问题|无问题|没有错误|无错误|no issues|no errors?|0 errors?|without error|error[- ]free/g;

/**
 * Parse verifier output to determine pass/fail.
 * Uses emoji first, then falls back to keyword matching.
 */
export function parseVerificationResult(payload: string): boolean {
  // Primary: emoji markers (system prompt instructs verifier to use these)
  const hasPass = payload.includes('✅');
  const hasFail = payload.includes('❌');
  if (hasPass && !hasFail) return true;
  if (hasFail) return false;

  // Fallback: keyword matching (case-insensitive)
  const lower = payload.toLowerCase();
  const hasPassKeyword = PASS_KEYWORD.test(lower);

  // Strip negation-pass patterns before checking fail keywords
  const lowerForFailCheck = lower.replace(NEGATION_PASS, '');
  const hasFailKeyword = FAIL_KEYWORD.test(lowerForFailCheck);

  if (hasPassKeyword && !hasFailKeyword) return true;
  if (hasFailKeyword) return false;

  // Default: assume pass if no clear signal (avoid infinite retry loops)
  return true;
}

/**
 * Assemble report from raw executor outputs (no LLM call).
 */
export function assembleReport(results: ExecutionResult[]): string {
  if (results.length === 1) {
    return results[0].output;
  }
  return results
    .map((r, i) => {
      const title = r.instruction.length > 80 ? `${r.instruction.slice(0, 80)}...` : r.instruction;
      return `### ${i + 1}. ${title}\n\n${r.output}`;
    })
    .join('\n\n---\n\n');
}

/**
 * Generate token usage report from LLM logs.
 * Accepts multiple log arrays to avoid array spread allocation.
 */
export function generateTokenReport(...logs: readonly (readonly TokenUsage[])[]): TokenReport {
  const report: TokenReport = {
    totalInput: 0,
    totalOutput: 0,
    byAgent: {},
    byPhase: {},
    estimatedSavingsVsTraditional: 0,
  };

  for (const log of logs) {
    for (const u of log) {
      report.totalInput += u.inputTokens;
      report.totalOutput += u.outputTokens;

      const agentEntry = report.byAgent[u.agent] ?? { input: 0, output: 0 };
      agentEntry.input += u.inputTokens;
      agentEntry.output += u.outputTokens;
      report.byAgent[u.agent] = agentEntry;

      const phaseEntry = report.byPhase[u.phase] ?? { input: 0, output: 0 };
      phaseEntry.input += u.inputTokens;
      phaseEntry.output += u.outputTokens;
      report.byPhase[u.phase] = phaseEntry;
    }
  }

  // Cost-weighted savings estimate
  const totalUsed = report.totalInput + report.totalOutput;
  const strongTokens = (report.byAgent.planner?.input ?? 0) + (report.byAgent.planner?.output ?? 0);
  const cheapTokens = totalUsed - strongTokens;

  const ntkWeightedCost = strongTokens + cheapTokens * 0.1;
  const traditionalWeightedCost = totalUsed;

  report.estimatedSavingsVsTraditional =
    traditionalWeightedCost > 0
      ? Math.max(0, Math.min(100, ((traditionalWeightedCost - ntkWeightedCost) / traditionalWeightedCost) * 100))
      : 0;

  return report;
}

/** Get fallback message for empty output */
export function emptyOutputMessage(locale: Locale): string {
  return locale === 'zh'
    ? '未生成输出，请重试或换一种方式描述任务。'
    : 'No output generated. Please retry or rephrase the task.';
}

/** Fix unclosed code fences from truncated output */
export function fixUnbalancedFences(text: string): string {
  if (!text.includes('```')) return text;
  let count = 0;
  let idx = 0;
  while ((idx = text.indexOf('```', idx)) !== -1) { count++; idx += 3; }
  return count % 2 !== 0 ? text + '\n```' : text;
}

interface SkipThresholds {
  codeMinLen: number;
  analysisMinLen: number;
  generalMinLen: number;
}

const DEFAULT_SKIP_THRESHOLDS: SkipThresholds = { codeMinLen: 200, analysisMinLen: 150, generalMinLen: 500 };
const FULL_SKIP_THRESHOLDS: SkipThresholds = { codeMinLen: 300, analysisMinLen: 300, generalMinLen: 800 };

// Fast code-block check: avoids [\s\S]{20,} backtracking on large outputs
function hasCodeBlock(output: string): boolean {
  const open = output.indexOf('```');
  if (open < 0) return false;
  const close = output.indexOf('```', open + 3);
  return close >= 0 && (close - open - 3) >= 20;
}
const HAS_NUMBERED_LIST = /^\d+\.\s/m;
const HAS_BULLET_LIST = /^[-*]\s/m;

/**
 * Heuristic: check if output looks structurally complete enough to skip verification.
 * Shared by depth-light and depth-full.
 */
export function isStructurallyComplete(
  output: string,
  userRequest: string,
  thresholds: SkipThresholds = DEFAULT_SKIP_THRESHOLDS,
): boolean {
  if (output.length < 100) return true;

  const hasCode = hasCodeBlock(output);
  const hasNumberedList = HAS_NUMBERED_LIST.test(output);
  const hasBulletList = HAS_BULLET_LIST.test(output);

  const isCodeTask = CODE_TASK_PATTERN.test(userRequest);
  const isAnalysisTask = ANALYSIS_TASK_PATTERN.test(userRequest);

  if (isCodeTask && hasCode && output.length > thresholds.codeMinLen) return true;
  if (isAnalysisTask && (hasNumberedList || hasBulletList) && output.length > thresholds.analysisMinLen) return true;
  if (output.length > thresholds.generalMinLen && (hasCode || hasNumberedList)) return true;

  return false;
}

export { DEFAULT_SKIP_THRESHOLDS, FULL_SKIP_THRESHOLDS };
export type { SkipThresholds };

const DEPTH_PROFILES: Record<string, { base: number; outputMultiplier: number; min: number; max: number }> = {
  direct: { base: 30, outputMultiplier: 3, min: 60, max: 800 },
  light: { base: 200, outputMultiplier: 5, min: 500, max: 2000 },
  standard: { base: 500, outputMultiplier: 6, min: 1500, max: 4000 },
  full: { base: 800, outputMultiplier: 8, min: 2000, max: 6000 },
};

/**
 * Predict token usage for a task before execution.
 * Based on empirical averages from benchmarks.
 */
export function predictTokenUsage(
  depth: 'direct' | 'light' | 'standard' | 'full',
  inputLength: number,
): { estimated: number; range: [number, number] } {
  const inputTokens = Math.ceil(inputLength / 3.5);

  const profile = DEPTH_PROFILES[depth];
  const estimated = Math.round(profile.base + inputTokens * profile.outputMultiplier);
  const clamped = Math.max(profile.min, Math.min(profile.max, estimated));

  const rangeLow = Math.round(clamped * 0.6);
  const rangeHigh = Math.round(clamped * 1.5);

  return { estimated: clamped, range: [rangeLow, rangeHigh] };
}

/**
 * Format a PipelineTrace into a human-readable summary.
 * Shows routing path, compression stats, token breakdown, and timing.
 */
export function formatTrace(trace: PipelineTrace): string {
  const lines: string[] = [];

  lines.push('── Pipeline Trace ──────────────────────────');

  // Routing
  const r = trace.routing;
  const routePath = r.fastPathResult
    ? `regex → ${r.finalDepth}`
    : `LLM classifier → ${r.classifierResult ?? r.finalDepth}`;
  lines.push(`  Routing:    ${routePath}`);
  lines.push(`  Depth:      ${r.finalDepth}`);
  if (r.speculativeHit !== null) {
    lines.push(`  Speculative: ${r.speculativeHit ? 'hit' : 'miss'}${r.predictionConfidence !== null ? ` (confidence: ${(r.predictionConfidence * 100).toFixed(0)}%)` : ''}`);
  }

  // Compression
  const c = trace.compression;
  if (c.preFilterOriginalChars > 0) {
    lines.push(`  Pre-filter: ${c.preFilterCharsRemoved} chars removed (${c.preFilterReductionPercent.toFixed(1)}%)`);
  }
  if (c.llmCompressionCalls > 0) {
    lines.push(`  LLM compression calls: ${c.llmCompressionCalls}`);
  }
  if (c.teeEntriesStored > 0 || c.teeRetrieved > 0) {
    lines.push(`  Tee: ${c.teeEntriesStored} stored, ${c.teeRetrieved} retrieved`);
  }

  // Tokens
  const t = trace.tokens;
  lines.push(`  Tokens:     ${t.total} total (${t.totalInput} in / ${t.totalOutput} out)`);
  lines.push(`  Model split: ${t.cheapModelTokens} cheap + ${t.strongModelTokens} strong (${t.strongModelPercent.toFixed(1)}% strong)`);
  lines.push(`  Est. savings vs all-strong: ${t.estimatedCostSavingsPercent.toFixed(0)}%`);
  const agents = Object.entries(t.byAgent);
  if (agents.length > 0) {
    lines.push(`  By agent:   ${agents.map(([a, v]) => `${a}=${v.input + v.output}`).join(', ')}`);
  }

  // Error recovery
  const e = trace.errors;
  if (e.compressionFallbacks > 0 || e.teeRecoveryAttempts > 0 || e.apiRetries > 0) {
    const parts: string[] = [];
    if (e.apiRetries > 0) parts.push(`api-retries=${e.apiRetries}`);
    if (e.compressionFallbacks > 0) parts.push(`compression-fallbacks=${e.compressionFallbacks}`);
    if (e.teeRecoveryAttempts > 0) parts.push(`tee-recovery=${e.teeRecoverySuccesses}/${e.teeRecoveryAttempts}`);
    lines.push(`  Recovery:   ${parts.join(', ')}`);
  }

  // Timing
  lines.push(`  Duration:   ${trace.durationMs}ms`);
  if (trace.cached) lines.push('  Cache:      HIT');

  lines.push('────────────────────────────────────────────');
  return lines.join('\n');
}
