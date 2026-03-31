/**
 * Ablation study — test with components disabled.
 */

import chalk from 'chalk';
import type { NTKConfig } from '../../core/protocol.js';
import { Pipeline } from '../../pipeline/pipeline.js';

export async function cmdAblation(config: NTKConfig): Promise<void> {
  console.log(chalk.cyan.bold('\n  🔬 Ablation Study\n'));

  const task = '比较 React 和 Vue 的核心区别，给出选择建议';
  console.log(chalk.dim(`  Task: "${task}"\n`));

  const conditions: Array<{ name: string; cfg: NTKConfig; opts?: { forceDepth?: any; skipScout?: boolean } }> = [
    { name: 'v2 Adaptive (baseline)', cfg: config },
    { name: 'No Scout (skip gather)', cfg: config, opts: { skipScout: true } },
    { name: 'Force Full Depth', cfg: config, opts: { forceDepth: 'full' } },
    { name: 'Force Direct Depth', cfg: config, opts: { forceDepth: 'direct' } },
    { name: 'Single Model (all strong)', cfg: { ...config, compressor: { ...config.planner } } },
    { name: 'Single Model (all cheap)', cfg: { ...config, planner: { ...config.compressor } } },
  ];

  console.log(chalk.dim('  Condition                  | Tokens | Time   | Depth    | Strong | Report'));
  console.log(chalk.dim(`  ${'─'.repeat(85)}`));

  for (const cond of conditions) {
    const t1 = Date.now();
    try {
      const pipeline = new Pipeline(cond.cfg, () => {}, cond.opts);
      const result = await pipeline.run(task);
      const totalTok = result.tokenReport.totalInput + result.tokenReport.totalOutput;
      const duration = ((Date.now() - t1) / 1000).toFixed(1);
      const quality = result.report.length > 50 && result.success ? '✅' : '❌';
      const plannerTok = result.tokenReport.byAgent.planner
        ? result.tokenReport.byAgent.planner.input + result.tokenReport.byAgent.planner.output
        : 0;
      const name = cond.name.padEnd(29);
      console.log(
        `  ${quality} ${name}| ${String(totalTok).padEnd(7)}| ${(`${duration}s`).padEnd(7)}| ${(result.depth ?? 'full').padEnd(9)}| ${String(plannerTok).padEnd(7)}| ${result.report.length} chars`,
      );
    } catch (e) {
      const name = cond.name.padEnd(29);
      console.log(chalk.red(`  ❌ ${name}| ERROR: ${e instanceof Error ? e.message : e}`));
    }
  }

  console.log('');
}
