/**
 * Baseline benchmark — NTK Pipeline vs Direct LLM comparison.
 */

import chalk from 'chalk';
import { LLMClient } from '../../core/llm.js';
import type { NTKConfig } from '../../core/protocol.js';
import { Pipeline } from '../../pipeline/pipeline.js';

export async function cmdBaseline(config: NTKConfig): Promise<void> {
  console.log(chalk.cyan.bold('\n  📊 Baseline Comparison: NTK Pipeline vs Direct LLM\n'));

  const llm = new LLMClient(config.compressor);
  const strongLLM = new LLMClient(config.planner);

  const tasks = [
    { name: 'Code-Gen (simple)', task: '用Python写一个计算斐波那契数列第n项的函数' },
    { name: 'Tech Comparison (medium)', task: '比较 React 和 Vue 的核心区别，给出选择建议' },
    { name: 'API Design (medium)', task: '设计一个简单的 TODO 应用的 REST API，包括路由、数据模型和错误处理' },
    {
      name: 'Debug (simple)',
      task: '分析这段代码的bug并给出修复：function sum(arr) { let total; for(let i=0; i<=arr.length; i++) { total += arr[i]; } return total; }',
    },
  ];

  const results: Array<{
    name: string;
    baseline: { tokens: number; time: number; model: string };
    baselineStrong: { tokens: number; time: number; model: string };
    ntk: { tokens: number; time: number; depth: string; cheapTokens: number; strongTokens: number };
  }> = [];

  for (const t of tasks) {
    console.log(chalk.yellow(`\n  ── ${t.name} ──`));

    const t1 = Date.now();
    const r1 = await llm.chat('You are a helpful assistant. Output concisely.', t.task, 'executor', 'execute');
    const baselineCheap = {
      tokens: r1.usage.inputTokens + r1.usage.outputTokens,
      time: Date.now() - t1,
      model: config.compressor.model,
    };
    console.log(
      chalk.dim(
        `  Baseline (${config.compressor.model}): ${baselineCheap.tokens} tok, ${(baselineCheap.time / 1000).toFixed(1)}s`,
      ),
    );

    const t2 = Date.now();
    const r2 = await strongLLM.chat('You are a helpful assistant. Output concisely.', t.task, 'executor', 'execute');
    const baselineStrong = {
      tokens: r2.usage.inputTokens + r2.usage.outputTokens,
      time: Date.now() - t2,
      model: config.planner.model,
    };
    console.log(
      chalk.dim(
        `  Baseline (${config.planner.model}): ${baselineStrong.tokens} tok, ${(baselineStrong.time / 1000).toFixed(1)}s`,
      ),
    );

    const t3 = Date.now();
    const pipeline = new Pipeline(config, () => {});
    const r3 = await pipeline.run(t.task);
    const totalTok = r3.tokenReport.totalInput + r3.tokenReport.totalOutput;
    const plannerTok = r3.tokenReport.byAgent.planner
      ? r3.tokenReport.byAgent.planner.input + r3.tokenReport.byAgent.planner.output
      : 0;
    const ntk = {
      tokens: totalTok,
      time: Date.now() - t3,
      depth: r3.depth ?? 'full',
      cheapTokens: totalTok - plannerTok,
      strongTokens: plannerTok,
    };
    console.log(
      chalk.green(
        `  NTK (${r3.depth}): ${ntk.tokens} tok, ${(ntk.time / 1000).toFixed(1)}s [strong=${plannerTok}, cheap=${totalTok - plannerTok}]`,
      ),
    );

    results.push({ name: t.name, baseline: baselineCheap, baselineStrong: baselineStrong, ntk });
  }

  console.log(chalk.cyan.bold('\n  ═══ Baseline Comparison Summary ═══\n'));
  console.log(
    chalk.dim('  Task                    | Cheap Direct | Strong Direct | NTK Pipeline | Depth    | Strong Tok'),
  );
  console.log(chalk.dim(`  ${'─'.repeat(100)}`));
  for (const r of results) {
    const name = r.name.padEnd(24);
    const cheap = `${r.baseline.tokens}tok/${(r.baseline.time / 1000).toFixed(1)}s`.padEnd(13);
    const strong = `${r.baselineStrong.tokens}tok/${(r.baselineStrong.time / 1000).toFixed(1)}s`.padEnd(14);
    const ntk = `${r.ntk.tokens}tok/${(r.ntk.time / 1000).toFixed(1)}s`.padEnd(13);
    const depth = r.ntk.depth.padEnd(9);
    const strongTok = `${r.ntk.strongTokens}`;
    console.log(`  ${name}| ${cheap}| ${strong}| ${ntk}| ${depth}| ${strongTok}`);
  }
  console.log('');
}
