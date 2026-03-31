/**
 * Pipeline helpers — verification parsing, report generation, token calculation.
 */

import { ANALYSIS_TASK_PATTERN, CODE_TASK_PATTERN, type Locale } from '../core/prompts.js';
import type { TokenReport, TokenUsage } from '../core/protocol.js';
import type { ExecutionResult } from './types.js';

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
  const passKeywords = ['pass', 'passed', 'all correct', 'no issues', '通过', '正确', '没有问题', '无问题'];
  const failKeywords = ['fail', 'failed', 'error', 'incorrect', 'wrong', '失败', '错误', '不正确', '有问题'];

  const hasPassKeyword = passKeywords.some((kw) => lower.includes(kw));

  // Strip negation-pass patterns before checking fail keywords
  let lowerForFailCheck = lower;
  const negationPassPatterns = [
    '没有问题',
    '无问题',
    '没有错误',
    '无错误',
    'no issues',
    'no errors',
    'no error',
    '0 errors',
    '0 error',
    'without error',
    'error-free',
    'error free',
  ];
  for (const np of negationPassPatterns) {
    lowerForFailCheck = lowerForFailCheck.replaceAll(np, '');
  }
  const hasFailKeyword = failKeywords.some((kw) => lowerForFailCheck.includes(kw));

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
 */
export function generateTokenReport(allUsage: TokenUsage[]): TokenReport {
  const report: TokenReport = {
    totalInput: 0,
    totalOutput: 0,
    byAgent: {},
    byPhase: {},
    estimatedSavingsVsTraditional: 0,
  };

  for (const u of allUsage) {
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

interface SkipThresholds {
  codeMinLen: number;
  analysisMinLen: number;
  generalMinLen: number;
}

const DEFAULT_SKIP_THRESHOLDS: SkipThresholds = { codeMinLen: 200, analysisMinLen: 150, generalMinLen: 500 };
const FULL_SKIP_THRESHOLDS: SkipThresholds = { codeMinLen: 300, analysisMinLen: 300, generalMinLen: 800 };

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

  const hasCodeBlock = /```[\s\S]{20,}```/.test(output);
  const hasNumberedList = /^\d+\.\s/m.test(output);
  const hasBulletList = /^[-*]\s/m.test(output);

  const isCodeTask = CODE_TASK_PATTERN.test(userRequest);
  const isAnalysisTask = ANALYSIS_TASK_PATTERN.test(userRequest);

  if (isCodeTask && hasCodeBlock && output.length > thresholds.codeMinLen) return true;
  if (isAnalysisTask && (hasNumberedList || hasBulletList) && output.length > thresholds.analysisMinLen) return true;
  if (output.length > thresholds.generalMinLen && (hasCodeBlock || hasNumberedList)) return true;

  return false;
}

export { DEFAULT_SKIP_THRESHOLDS, FULL_SKIP_THRESHOLDS };
export type { SkipThresholds };

/**
 * Predict token usage for a task before execution.
 * Based on empirical averages from benchmarks.
 */
export function predictTokenUsage(
  depth: 'direct' | 'light' | 'standard' | 'full',
  inputLength: number,
): { estimated: number; range: [number, number] } {
  const inputTokens = Math.ceil(inputLength / 3.5);

  const depthProfiles: Record<string, { base: number; outputMultiplier: number; min: number; max: number }> = {
    direct: { base: 30, outputMultiplier: 3, min: 60, max: 800 },
    light: { base: 200, outputMultiplier: 5, min: 500, max: 2000 },
    standard: { base: 500, outputMultiplier: 6, min: 1500, max: 4000 },
    full: { base: 800, outputMultiplier: 8, min: 2000, max: 6000 },
  };

  const profile = depthProfiles[depth];
  const estimated = Math.round(profile.base + inputTokens * profile.outputMultiplier);
  const clamped = Math.max(profile.min, Math.min(profile.max, estimated));

  const rangeLow = Math.round(clamped * 0.6);
  const rangeHigh = Math.round(clamped * 1.5);

  return { estimated: clamped, range: [rangeLow, rangeHigh] };
}
