/**
 * CLI output formatting — event printing and token report display.
 */

import chalk from 'chalk';
import type { PipelineEvent, PipelineResult, PipelineTrace } from '../pipeline/pipeline.js';

const PHASE_ICONS: Record<string, string> = {
  gather: '🔍',
  plan: '🧠',
  execute: '🔧',
  verify: '✅',
  report: '📋',
};

const TYPE_STYLES: Record<string, (s: string) => string> = {
  phase: chalk.cyan.bold,
  message: chalk.gray,
  plan: chalk.yellow,
  execution: chalk.green,
  compressed: chalk.magenta,
  blocked: chalk.red.dim,
  retry: chalk.yellow.dim,
  verified: chalk.green.bold,
  'verification-failed': chalk.red.bold,
  error: chalk.red.bold,
  start: chalk.blue.bold,
  complete: chalk.green.bold,
};

export function handleEvent(event: PipelineEvent): void {
  const icon = PHASE_ICONS[event.phase] || '•';
  const styleFn = TYPE_STYLES[event.type] || chalk.white;
  console.log(`  ${icon} ${styleFn(event.detail)}`);
}

function renderBar(pct: number, width: number = 20): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;
  return chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(empty));
}

export function printTokenReport(result: PipelineResult): void {
  const { tokenReport, routerStats, blockedMessages, preFilterSavings } = result;
  const total = tokenReport.totalInput + tokenReport.totalOutput;

  console.log(`\n${chalk.cyan.bold('  ┌─── Token Usage Report ───────────────────────┐')}`);
  console.log(
    chalk.white(`  │ Total: ${total} tokens (in: ${tokenReport.totalInput}, out: ${tokenReport.totalOutput})`),
  );

  if (tokenReport.byAgent.executor || tokenReport.byAgent.planner || tokenReport.byAgent.scout || tokenReport.byAgent.summarizer || tokenReport.byAgent.verifier || tokenReport.byAgent.classifier) {
    console.log(chalk.cyan('  │'));
    console.log(chalk.cyan('  │ By Agent:'));
    for (const [agent, usage] of Object.entries(tokenReport.byAgent)) {
      const t = usage.input + usage.output;
      const pct = total > 0 ? ((t / total) * 100).toFixed(0) : '0';
      console.log(chalk.dim(`  │   ${agent}: ${t} tokens (${pct}%)`));
    }
  }

  if (tokenReport.byPhase.gather || tokenReport.byPhase.plan || tokenReport.byPhase.execute || tokenReport.byPhase.verify || tokenReport.byPhase.report) {
    console.log(chalk.cyan('  │'));
    console.log(chalk.cyan('  │ By Phase:'));
    for (const [phase, usage] of Object.entries(tokenReport.byPhase)) {
      const t = usage.input + usage.output;
      console.log(chalk.dim(`  │   ${phase}: ${t} tokens`));
    }
  }

  console.log(chalk.cyan('  │'));
  console.log(chalk.cyan('  │ Router:'));
  console.log(
    chalk.dim(
      `  │   Routed: ${routerStats.totalRouted} | Blocked: ${routerStats.totalBlocked} | Block rate: ${(routerStats.blockRate * 100).toFixed(1)}%`,
    ),
  );

  if (blockedMessages.length > 0) {
    console.log(chalk.cyan('  │'));
    console.log(chalk.yellow('  │ Blocked:'));
    for (const { message, reason } of blockedMessages.slice(0, 3)) {
      console.log(chalk.dim(`  │   ${message.from}→${message.to}: ${reason.slice(0, 60)}`));
    }
  }

  // Pre-filter savings section
  if (preFilterSavings && preFilterSavings.callCount > 0) {
    console.log(chalk.cyan('  │'));
    console.log(chalk.magenta.bold('  │ 🧹 Pre-filter (zero token cost):'));
    console.log(
      chalk.dim(`  │   Calls: ${preFilterSavings.callCount} | Removed: ${preFilterSavings.totalCharsRemoved} chars`),
    );
    if (preFilterSavings.reductionPercent > 0) {
      const bar = renderBar(preFilterSavings.reductionPercent);
      console.log(chalk.dim(`  │   Reduction: ${bar} ${preFilterSavings.reductionPercent.toFixed(1)}%`));
    }
  }

  // Cache indicator
  if (result.cached) {
    console.log(chalk.cyan('  │'));
    console.log(chalk.green.bold('  │ ⚡ Cache hit — zero token cost'));
  }

  // Combined savings visualization
  console.log(chalk.cyan('  │'));
  const savingsPct = tokenReport.estimatedSavingsVsTraditional;
  const savingsBar = renderBar(savingsPct);
  console.log(chalk.green.bold(`  │ 💰 Savings vs traditional: ${savingsBar} ~${savingsPct.toFixed(0)}%`));
  console.log(chalk.cyan.bold('  └────────────────────────────────────────────────┘\n'));
}

export function printTrace(trace: PipelineTrace): void {
  console.log(chalk.magenta.bold('\n  ┌─── Pipeline Trace ──────────────────────────────┐'));

  // Routing
  const r = trace.routing;
  const routeMethod = r.fastPathResult ? 'regex fast path' : 'LLM classifier';
  console.log(chalk.white(`  │ Route: ${routeMethod} → ${chalk.bold(r.finalDepth)}`));
  if (r.speculativeHit !== null) {
    const hitLabel = r.speculativeHit ? chalk.green('hit') : chalk.yellow('miss');
    const conf = r.predictionConfidence !== null ? ` (${(r.predictionConfidence * 100).toFixed(0)}% conf)` : '';
    console.log(chalk.white(`  │ Speculative: ${hitLabel}${chalk.dim(conf)}`));
  }

  // Compression
  const c = trace.compression;
  if (c.preFilterOriginalChars > 0 && c.preFilterCharsRemoved > 0) {
    console.log(chalk.magenta(`  │ Pre-filter: −${c.preFilterCharsRemoved} chars (${c.preFilterReductionPercent.toFixed(1)}%)`));
  }
  if (c.llmCompressionCalls > 0) {
    console.log(chalk.magenta(`  │ LLM compressions: ${c.llmCompressionCalls}`));
  }
  if (c.teeEntriesStored > 0 || c.teeRetrieved > 0) {
    console.log(chalk.magenta(`  │ Tee: ${c.teeEntriesStored} stored, ${c.teeRetrieved} retrieved`));
  }

  // Token breakdown
  const t = trace.tokens;
  console.log(chalk.cyan(`  │`));
  console.log(chalk.white(`  │ Tokens: ${chalk.bold(String(t.total))} (${t.totalInput} in + ${t.totalOutput} out)`));
  console.log(chalk.white(`  │ Model:  ${t.cheapModelTokens} cheap + ${t.strongModelTokens} strong (${t.strongModelPercent.toFixed(1)}% strong)`));
  const agents = Object.entries(t.byAgent);
  if (agents.length > 0) {
    console.log(chalk.dim(`  │ Agents: ${agents.map(([a, v]) => `${a}=${v.input + v.output}`).join('  ')}`));
  }

  // Error recovery
  const e = trace.errors;
  if (e.compressionFallbacks > 0 || e.teeRecoveryAttempts > 0 || e.apiRetries > 0) {
    console.log(chalk.cyan(`  │`));
    console.log(chalk.yellow(`  │ Recovery:`));
    if (e.apiRetries > 0) console.log(chalk.yellow(`  │   API retries: ${e.apiRetries}`));
    if (e.compressionFallbacks > 0) console.log(chalk.yellow(`  │   Compression fallbacks: ${e.compressionFallbacks}`));
    if (e.teeRecoveryAttempts > 0) {
      console.log(chalk.yellow(`  │   Tee recovery: ${e.teeRecoverySuccesses}/${e.teeRecoveryAttempts} succeeded`));
    }
  }

  // Timing & cache
  console.log(chalk.cyan(`  │`));
  console.log(chalk.white(`  │ Duration: ${chalk.bold(trace.durationMs + 'ms')}`));
  if (trace.cached) console.log(chalk.green.bold(`  │ Cache: HIT`));

  console.log(chalk.magenta.bold('  └──────────────────────────────────────────────────┘'));
}
