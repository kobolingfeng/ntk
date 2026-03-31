/**
 * CLI output formatting — event printing and token report display.
 */

import chalk from 'chalk';
import type { PipelineEvent, PipelineResult } from '../pipeline/pipeline.js';

export function handleEvent(event: PipelineEvent): void {
  const phaseIcons: Record<string, string> = {
    gather: '🔍',
    plan: '🧠',
    execute: '🔧',
    verify: '✅',
    report: '📋',
  };

  const typeStyles: Record<string, (s: string) => string> = {
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

  const icon = phaseIcons[event.phase] || '•';
  const styleFn = typeStyles[event.type] || chalk.white;
  console.log(`  ${icon} ${styleFn(event.detail)}`);
}

export function printTokenReport(result: PipelineResult): void {
  const { tokenReport, routerStats, blockedMessages } = result;
  const total = tokenReport.totalInput + tokenReport.totalOutput;

  console.log('\n' + chalk.cyan.bold('  ┌─── Token Usage Report ───────────────────────┐'));
  console.log(chalk.white(`  │ Total: ${total} tokens (in: ${tokenReport.totalInput}, out: ${tokenReport.totalOutput})`));

  if (Object.keys(tokenReport.byAgent).length > 0) {
    console.log(chalk.cyan('  │'));
    console.log(chalk.cyan('  │ By Agent:'));
    for (const [agent, usage] of Object.entries(tokenReport.byAgent)) {
      const t = usage.input + usage.output;
      const pct = total > 0 ? ((t / total) * 100).toFixed(0) : '0';
      console.log(chalk.dim(`  │   ${agent}: ${t} tokens (${pct}%)`));
    }
  }

  if (Object.keys(tokenReport.byPhase).length > 0) {
    console.log(chalk.cyan('  │'));
    console.log(chalk.cyan('  │ By Phase:'));
    for (const [phase, usage] of Object.entries(tokenReport.byPhase)) {
      const t = usage.input + usage.output;
      console.log(chalk.dim(`  │   ${phase}: ${t} tokens`));
    }
  }

  console.log(chalk.cyan('  │'));
  console.log(chalk.cyan('  │ Router:'));
  console.log(chalk.dim(`  │   Routed: ${routerStats.totalRouted} | Blocked: ${routerStats.totalBlocked} | Block rate: ${(routerStats.blockRate * 100).toFixed(1)}%`));

  if (blockedMessages.length > 0) {
    console.log(chalk.cyan('  │'));
    console.log(chalk.yellow('  │ Blocked:'));
    for (const { message, reason } of blockedMessages.slice(0, 3)) {
      console.log(chalk.dim(`  │   ${message.from}→${message.to}: ${reason.slice(0, 60)}`));
    }
  }

  console.log(chalk.cyan('  │'));
  console.log(chalk.green.bold(`  │ 💰 Est. savings vs traditional: ~${tokenReport.estimatedSavingsVsTraditional.toFixed(0)}%`));
  console.log(chalk.cyan.bold('  └────────────────────────────────────────────────┘\n'));
}
