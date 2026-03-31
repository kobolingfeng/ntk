/**
 * CLI Benchmarks — baseline, ablation, optimize, and test commands.
 *
 * Extracted from cli.ts to reduce file size.
 */

import { Pipeline } from '../pipeline/pipeline.js';
import { LLMClient } from '../core/llm.js';
import type { NTKConfig } from '../core/protocol.js';
import { handleEvent, printTokenReport } from './output.js';
import chalk from 'chalk';

// ─── Baseline: single LLM call, no pipeline ──────────

export async function cmdBaseline(config: NTKConfig): Promise<void> {
  console.log(chalk.cyan.bold('\n  📊 Baseline Comparison: NTK Pipeline vs Direct LLM\n'));

  const llm = new LLMClient(config.compressor);
  const strongLLM = new LLMClient(config.planner);

  const tasks = [
    { name: 'Code-Gen (simple)', task: '用Python写一个计算斐波那契数列第n项的函数' },
    { name: 'Tech Comparison (medium)', task: '比较 React 和 Vue 的核心区别，给出选择建议' },
    { name: 'API Design (medium)', task: '设计一个简单的 TODO 应用的 REST API，包括路由、数据模型和错误处理' },
    { name: 'Debug (simple)', task: '分析这段代码的bug并给出修复：function sum(arr) { let total; for(let i=0; i<=arr.length; i++) { total += arr[i]; } return total; }' },
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
    const baselineCheap = { tokens: r1.usage.inputTokens + r1.usage.outputTokens, time: Date.now() - t1, model: config.compressor.model };
    console.log(chalk.dim(`  Baseline (${config.compressor.model}): ${baselineCheap.tokens} tok, ${(baselineCheap.time / 1000).toFixed(1)}s`));

    const t2 = Date.now();
    const r2 = await strongLLM.chat('You are a helpful assistant. Output concisely.', t.task, 'executor', 'execute');
    const baselineStrong = { tokens: r2.usage.inputTokens + r2.usage.outputTokens, time: Date.now() - t2, model: config.planner.model };
    console.log(chalk.dim(`  Baseline (${config.planner.model}): ${baselineStrong.tokens} tok, ${(baselineStrong.time / 1000).toFixed(1)}s`));

    const t3 = Date.now();
    const pipeline = new Pipeline(config, () => {});
    const r3 = await pipeline.run(t.task);
    const totalTok = r3.tokenReport.totalInput + r3.tokenReport.totalOutput;
    const plannerTok = r3.tokenReport.byAgent.planner
      ? r3.tokenReport.byAgent.planner.input + r3.tokenReport.byAgent.planner.output
      : 0;
    const ntk = { tokens: totalTok, time: Date.now() - t3, depth: r3.depth ?? 'full', cheapTokens: totalTok - plannerTok, strongTokens: plannerTok };
    console.log(chalk.green(`  NTK (${r3.depth}): ${ntk.tokens} tok, ${(ntk.time / 1000).toFixed(1)}s [strong=${plannerTok}, cheap=${totalTok - plannerTok}]`));

    results.push({ name: t.name, baseline: baselineCheap, baselineStrong: baselineStrong, ntk });
  }

  console.log(chalk.cyan.bold('\n  ═══ Baseline Comparison Summary ═══\n'));
  console.log(chalk.dim('  Task                    | Cheap Direct | Strong Direct | NTK Pipeline | Depth    | Strong Tok'));
  console.log(chalk.dim('  ' + '─'.repeat(100)));
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

// ─── Ablation: test with components disabled ─────────

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
  console.log(chalk.dim('  ' + '─'.repeat(85)));

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
      console.log(`  ${quality} ${name}| ${String(totalTok).padEnd(7)}| ${(duration + 's').padEnd(7)}| ${(result.depth ?? 'full').padEnd(9)}| ${String(plannerTok).padEnd(7)}| ${result.report.length} chars`);
    } catch (e) {
      const name = cond.name.padEnd(29);
      console.log(chalk.red(`  ❌ ${name}| ERROR: ${e instanceof Error ? e.message : e}`));
    }
  }

  console.log('');
}

// ─── Optimization Matrix ──────────────────────────────

export async function cmdOptimize(config: NTKConfig): Promise<void> {
  console.log(chalk.cyan.bold('\n  🎯 Optimization Matrix: Speed / Cost / Token / Quality\n'));

  const task = '用TypeScript实现一个LRU Cache类，要求：1.O(1)的get和put操作(用双向链表+Map) 2.支持泛型<K,V> 3.支持maxAge过期时间(ms)，get时检查过期 4.容量满时的onEvict回调 5.提供size()方法';
  console.log(chalk.dim(`  Task: "${task}"\n`));

  const requirements = [
    { name: 'O(1) get+put (LinkedList+Map)', keywords: ['Map', 'next', 'prev'], desc: 'doubly-linked list + Map for O(1)' },
    { name: 'Generic <K,V>', keywords: ['<K', 'K,', 'V>'], desc: 'TypeScript generics' },
    { name: 'maxAge expiration', keywords: ['maxAge', 'expire', 'Date.now', 'timestamp'], desc: 'TTL-based expiration' },
    { name: 'onEvict callback', keywords: ['onEvict', 'evict', 'callback'], desc: 'eviction callback' },
    { name: 'size() method', keywords: ['size()', 'size ()', '.size'], desc: 'size accessor' },
  ];

  const configs: Array<{
    name: string;
    target: string;
    cfg: NTKConfig;
    opts?: { forceDepth?: any; skipScout?: boolean };
  }> = [
    { name: 'Ultra-Fast', target: 'speed', cfg: { ...config, planner: { ...config.compressor } }, opts: { forceDepth: 'direct' } },
    { name: 'Budget', target: 'cost', cfg: { ...config, planner: { ...config.compressor } }, opts: { skipScout: true } },
    { name: 'NTK Default', target: 'balance', cfg: config },
    { name: 'Token-Min', target: 'tokens', cfg: config, opts: { forceDepth: 'direct', skipScout: true } },
    { name: 'Quality-Std', target: 'quality', cfg: config, opts: { forceDepth: 'standard' } },
    { name: 'Premium', target: 'quality+', cfg: config, opts: { forceDepth: 'full' } },
  ];

  type RunResult = {
    name: string; target: string; tokens: number; strongTok: number;
    time: number; depth: string; reportLen: number;
    reqScore: number; reqDetail: string[]; report: string; success: boolean;
  };

  const results: RunResult[] = [];

  for (const c of configs) {
    console.log(chalk.yellow(`\n  ── ${c.name} (target: ${c.target}) ──`));
    const t0 = Date.now();
    try {
      const pipeline = new Pipeline(c.cfg, () => {}, c.opts);
      const r = await pipeline.run(task);
      const totalTok = r.tokenReport.totalInput + r.tokenReport.totalOutput;
      const plannerTok = r.tokenReport.byAgent.planner
        ? r.tokenReport.byAgent.planner.input + r.tokenReport.byAgent.planner.output
        : 0;
      const duration = (Date.now() - t0) / 1000;

      const report = r.report.toLowerCase();
      const reqDetail: string[] = [];
      let reqScore = 0;
      for (const req of requirements) {
        const met = req.keywords.some(kw => report.includes(kw.toLowerCase()));
        reqDetail.push(met ? '✓' : '✗');
        if (met) reqScore++;
      }

      results.push({
        name: c.name, target: c.target, tokens: totalTok, strongTok: plannerTok,
        time: duration, depth: r.depth ?? 'full', reportLen: r.report.length,
        reqScore, reqDetail, report: r.report, success: r.success,
      });

      console.log(chalk.dim(`  ${totalTok} tok | ${duration.toFixed(1)}s | depth=${r.depth} | quality=${reqScore}/5 | report=${r.report.length} chars`));
    } catch (e) {
      console.log(chalk.red(`  ❌ ERROR: ${e instanceof Error ? e.message : e}`));
      results.push({
        name: c.name, target: c.target, tokens: 0, strongTok: 0, time: (Date.now() - t0) / 1000,
        depth: 'error', reportLen: 0, reqScore: 0, reqDetail: ['✗','✗','✗','✗','✗'], report: '', success: false,
      });
    }
  }

  // Summary Table
  console.log(chalk.cyan.bold('\n  ═══ Optimization Matrix Results ═══\n'));
  console.log(chalk.dim('  Config        | Tokens | Time   | Strong | Depth    | Quality | Report | Req Details'));
  console.log(chalk.dim('  ' + '─'.repeat(95)));
  for (const r of results) {
    const name = r.name.padEnd(14);
    const tok = String(r.tokens).padEnd(7);
    const time = (r.time.toFixed(1) + 's').padEnd(7);
    const strong = String(r.strongTok).padEnd(7);
    const depth = r.depth.padEnd(9);
    const quality = `${r.reqScore}/5`.padEnd(8);
    const rlen = String(r.reportLen).padEnd(7);
    const detail = r.reqDetail.join(' ');
    const icon = r.success ? '  ' : '❌';
    console.log(`  ${icon}${name}| ${tok}| ${time}| ${strong}| ${depth}| ${quality}| ${rlen}| ${detail}`);
  }

  // Per-dimension winners
  const valid = results.filter(r => r.success);
  if (valid.length === 0) {
    console.log(chalk.red('\n  No successful runs to evaluate.'));
    return;
  }

  const fastest = valid.reduce((a, b) => a.time < b.time ? a : b);
  const cheapest = valid.reduce((a, b) => a.strongTok < b.strongTok ? a : b);
  const leanest = valid.reduce((a, b) => a.tokens < b.tokens ? a : b);
  const bestQuality = valid.reduce((a, b) => {
    if (a.reqScore !== b.reqScore) return a.reqScore > b.reqScore ? a : b;
    return a.reportLen > b.reportLen ? a : b;
  });

  console.log(chalk.cyan.bold('\n  ═══ Dimension Winners ═══\n'));
  console.log(chalk.green(`  🏎️  Speed:    ${fastest.name} (${fastest.time.toFixed(1)}s, ${fastest.tokens} tok, quality ${fastest.reqScore}/5)`));
  console.log(chalk.green(`  💰 Cost:     ${cheapest.name} (strong=${cheapest.strongTok} tok, total=${cheapest.tokens}, quality ${cheapest.reqScore}/5)`));
  console.log(chalk.green(`  📦 Tokens:   ${leanest.name} (${leanest.tokens} tok, ${leanest.time.toFixed(1)}s, quality ${leanest.reqScore}/5)`));
  console.log(chalk.green(`  ⭐ Quality:  ${bestQuality.name} (${bestQuality.reqScore}/5, ${bestQuality.reportLen} chars, ${bestQuality.tokens} tok)`));

  // Balanced score
  const maxTok = Math.max(...valid.map(r => r.tokens));
  const maxTime = Math.max(...valid.map(r => r.time));
  const maxStrong = Math.max(...valid.map(r => r.strongTok), 1);

  console.log(chalk.cyan.bold('\n  ═══ Balanced Score (lower=better, quality inverted) ═══\n'));
  const scored = valid.map(r => {
    const tokScore = r.tokens / maxTok;
    const timeScore = r.time / maxTime;
    const costScore = r.strongTok / maxStrong;
    const qualityScore = 1 - (r.reqScore / 5);
    const composite = qualityScore * 0.40 + tokScore * 0.25 + timeScore * 0.20 + costScore * 0.15;
    return { ...r, composite, tokScore, timeScore, costScore, qualityScore };
  }).sort((a, b) => a.composite - b.composite);

  for (const s of scored) {
    const name = s.name.padEnd(14);
    const comp = s.composite.toFixed(3);
    const bar = '█'.repeat(Math.round(s.composite * 20)).padEnd(20);
    console.log(`  ${name} ${comp}  ${chalk.cyan(bar)}  q=${s.reqScore}/5 tok=${s.tokens} t=${s.time.toFixed(1)}s $=${s.strongTok}`);
  }

  console.log(chalk.green.bold(`\n  🏆 Balanced Winner: ${scored[0].name} (score: ${scored[0].composite.toFixed(3)})`));

  // Requirement detail
  console.log(chalk.cyan.bold('\n  ═══ Requirement Breakdown ═══\n'));
  const reqNames = requirements.map(r => r.name);
  console.log(chalk.dim(`  Config        | ${reqNames.map(n => n.slice(0, 12).padEnd(13)).join('| ')}`));
  console.log(chalk.dim('  ' + '─'.repeat(14 + reqNames.length * 15)));
  for (const r of results) {
    const name = r.name.padEnd(14);
    const details = r.reqDetail.map(d => (d === '✓' ? chalk.green(d) : chalk.red(d)).padEnd(13)).join('| ');
    console.log(`  ${name}| ${details}`);
  }

  console.log('');
}

// ─── Test Suite ───────────────────────────────────────

export async function cmdTest(config: NTKConfig): Promise<void> {
  console.log(chalk.cyan.bold('\n  🧪 Running NTK Test Suite\n'));
  console.log(chalk.dim(`  Planner: ${config.planner.model}`));
  console.log(chalk.dim(`  Compressor: ${config.compressor.model}`));
  console.log(chalk.dim(`  Base URL: ${config.planner.baseUrl}\n`));

  const tests = [
    { name: 'Code-Gen: Python Function', task: '用Python写一个计算斐波那契数列第n项的函数', category: 'code-gen', expectInReport: ['def', 'fib'] },
    { name: 'Code-Gen: TypeScript Utility', task: '用TypeScript写一个深拷贝函数，支持循环引用检测', category: 'code-gen', expectInReport: ['function', 'deep'] },
    { name: 'Translation', task: '将以下技术文档翻译成英文：Redis是一个开源的内存数据结构存储系统，可用作数据库、缓存和消息代理。它支持多种数据结构，如字符串、哈希、列表、集合和有序集合。', category: 'translation', expectInReport: ['Redis', 'database'] },
    { name: 'Math/Logic', task: '解释快速排序算法的时间复杂度分析，包括最好、最坏和平均情况', category: 'reasoning', expectInReport: ['O(', 'log'] },
    { name: 'API Design', task: '设计一个简单的 TODO 应用的 REST API，包括路由、数据模型和错误处理', category: 'design', expectInReport: ['API', 'TODO'] },
    { name: 'Code Refactor', task: '重构以下代码为函数式风格：for(let i=0;i<arr.length;i++){if(arr[i]>0){result.push(arr[i]*2)}}', category: 'refactor', expectInReport: ['filter', 'map'] },
    { name: 'Tech Comparison', task: '比较 React 和 Vue 的核心区别，给出选择建议', category: 'comparison', expectInReport: ['React', 'Vue'] },
    { name: 'Architecture Decision', task: '对比微服务架构和单体架构的优缺点，给出何时选择哪种的建议', category: 'comparison', expectInReport: ['微服务', '单体'] },
    { name: 'Debug Analysis', task: '分析这段代码的bug并给出修复：function sum(arr) { let total; for(let i=0; i<=arr.length; i++) { total += arr[i]; } return total; }', category: 'debug', expectInReport: ['total', '0'] },
  ];

  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    console.log(chalk.yellow(`  ── Test: ${test.name} ──`));
    console.log(chalk.dim(`  Task: "${test.task}"\n`));

    const startTime = Date.now();

    try {
      const pipeline = new Pipeline(config, handleEvent);
      const result = await pipeline.run(test.task);
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      console.log(chalk.cyan('\n  Report:'));
      console.log('  ' + result.report.split('\n').join('\n  '));

      const hasContent = result.report.length > 50;
      const isSuccess = result.success;
      const totalTokens = result.tokenReport.totalInput + result.tokenReport.totalOutput;
      const isEfficient = totalTokens < 10000;

      const checks = [
        { name: 'Has substantial content', pass: hasContent },
        { name: 'Pipeline succeeded', pass: isSuccess },
        { name: 'Token efficient (<10k)', pass: isEfficient },
      ];

      console.log('');
      for (const check of checks) {
        const icon = check.pass ? chalk.green('✓') : chalk.red('✗');
        console.log(`  ${icon} ${check.name}`);
      }

      const allPassed = checks.every((c) => c.pass);
      if (allPassed) {
        console.log(chalk.green.bold(`\n  ✅ PASSED (${duration}s, ${totalTokens} tokens)\n`));
        passed++;
      } else {
        console.log(chalk.red.bold(`\n  ❌ FAILED (${duration}s)\n`));
        failed++;
      }

      printTokenReport(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(chalk.red(`\n  ❌ ERROR: ${message}\n`));
      failed++;
    }

    console.log(chalk.dim('  ' + '─'.repeat(50)));
  }

  console.log(chalk.cyan.bold('\n  ═══ Test Summary ═══'));
  console.log(chalk.green(`  Passed: ${passed}/${tests.length}`));
  if (failed > 0) console.log(chalk.red(`  Failed: ${failed}/${tests.length}`));
  console.log('');
}
