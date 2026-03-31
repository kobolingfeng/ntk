/**
 * Optimization matrix — speed / cost / token / quality analysis.
 */

import chalk from 'chalk';
import type { NTKConfig } from '../../core/protocol.js';
import { Pipeline } from '../../pipeline/pipeline.js';

export async function cmdOptimize(config: NTKConfig): Promise<void> {
  console.log(chalk.cyan.bold('\n  🎯 Optimization Matrix: Speed / Cost / Token / Quality\n'));

  const task =
    '用TypeScript实现一个LRU Cache类，要求：1.O(1)的get和put操作(用双向链表+Map) 2.支持泛型<K,V> 3.支持maxAge过期时间(ms)，get时检查过期 4.容量满时的onEvict回调 5.提供size()方法';
  console.log(chalk.dim(`  Task: "${task}"\n`));

  const requirements = [
    {
      name: 'O(1) get+put (LinkedList+Map)',
      keywords: ['Map', 'next', 'prev'],
      desc: 'doubly-linked list + Map for O(1)',
    },
    { name: 'Generic <K,V>', keywords: ['<K', 'K,', 'V>'], desc: 'TypeScript generics' },
    {
      name: 'maxAge expiration',
      keywords: ['maxAge', 'expire', 'Date.now', 'timestamp'],
      desc: 'TTL-based expiration',
    },
    { name: 'onEvict callback', keywords: ['onEvict', 'evict', 'callback'], desc: 'eviction callback' },
    { name: 'size() method', keywords: ['size()', 'size ()', '.size'], desc: 'size accessor' },
  ];

  const configs: Array<{
    name: string;
    target: string;
    cfg: NTKConfig;
    opts?: { forceDepth?: any; skipScout?: boolean };
  }> = [
    {
      name: 'Ultra-Fast',
      target: 'speed',
      cfg: { ...config, planner: { ...config.compressor } },
      opts: { forceDepth: 'direct' },
    },
    {
      name: 'Budget',
      target: 'cost',
      cfg: { ...config, planner: { ...config.compressor } },
      opts: { skipScout: true },
    },
    { name: 'NTK Default', target: 'balance', cfg: config },
    { name: 'Token-Min', target: 'tokens', cfg: config, opts: { forceDepth: 'direct', skipScout: true } },
    { name: 'Quality-Std', target: 'quality', cfg: config, opts: { forceDepth: 'standard' } },
    { name: 'Premium', target: 'quality+', cfg: config, opts: { forceDepth: 'full' } },
  ];

  type RunResult = {
    name: string;
    target: string;
    tokens: number;
    strongTok: number;
    time: number;
    depth: string;
    reportLen: number;
    reqScore: number;
    reqDetail: string[];
    report: string;
    success: boolean;
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
        const met = req.keywords.some((kw) => report.includes(kw.toLowerCase()));
        reqDetail.push(met ? '✓' : '✗');
        if (met) reqScore++;
      }

      results.push({
        name: c.name,
        target: c.target,
        tokens: totalTok,
        strongTok: plannerTok,
        time: duration,
        depth: r.depth ?? 'full',
        reportLen: r.report.length,
        reqScore,
        reqDetail,
        report: r.report,
        success: r.success,
      });

      console.log(
        chalk.dim(
          `  ${totalTok} tok | ${duration.toFixed(1)}s | depth=${r.depth} | quality=${reqScore}/5 | report=${r.report.length} chars`,
        ),
      );
    } catch (e) {
      console.log(chalk.red(`  ❌ ERROR: ${e instanceof Error ? e.message : e}`));
      results.push({
        name: c.name,
        target: c.target,
        tokens: 0,
        strongTok: 0,
        time: (Date.now() - t0) / 1000,
        depth: 'error',
        reportLen: 0,
        reqScore: 0,
        reqDetail: ['✗', '✗', '✗', '✗', '✗'],
        report: '',
        success: false,
      });
    }
  }

  // Summary Table
  console.log(chalk.cyan.bold('\n  ═══ Optimization Matrix Results ═══\n'));
  console.log(chalk.dim('  Config        | Tokens | Time   | Strong | Depth    | Quality | Report | Req Details'));
  console.log(chalk.dim(`  ${'─'.repeat(95)}`));
  for (const r of results) {
    const name = r.name.padEnd(14);
    const tok = String(r.tokens).padEnd(7);
    const time = `${r.time.toFixed(1)}s`.padEnd(7);
    const strong = String(r.strongTok).padEnd(7);
    const depth = r.depth.padEnd(9);
    const quality = `${r.reqScore}/5`.padEnd(8);
    const rlen = String(r.reportLen).padEnd(7);
    const detail = r.reqDetail.join(' ');
    const icon = r.success ? '  ' : '❌';
    console.log(`  ${icon}${name}| ${tok}| ${time}| ${strong}| ${depth}| ${quality}| ${rlen}| ${detail}`);
  }

  // Per-dimension winners
  const valid = results.filter((r) => r.success);
  if (valid.length === 0) {
    console.log(chalk.red('\n  No successful runs to evaluate.'));
    return;
  }

  const fastest = valid.reduce((a, b) => (a.time < b.time ? a : b));
  const cheapest = valid.reduce((a, b) => (a.strongTok < b.strongTok ? a : b));
  const leanest = valid.reduce((a, b) => (a.tokens < b.tokens ? a : b));
  const bestQuality = valid.reduce((a, b) => {
    if (a.reqScore !== b.reqScore) return a.reqScore > b.reqScore ? a : b;
    return a.reportLen > b.reportLen ? a : b;
  });

  console.log(chalk.cyan.bold('\n  ═══ Dimension Winners ═══\n'));
  console.log(
    chalk.green(
      `  🏎️  Speed:    ${fastest.name} (${fastest.time.toFixed(1)}s, ${fastest.tokens} tok, quality ${fastest.reqScore}/5)`,
    ),
  );
  console.log(
    chalk.green(
      `  💰 Cost:     ${cheapest.name} (strong=${cheapest.strongTok} tok, total=${cheapest.tokens}, quality ${cheapest.reqScore}/5)`,
    ),
  );
  console.log(
    chalk.green(
      `  📦 Tokens:   ${leanest.name} (${leanest.tokens} tok, ${leanest.time.toFixed(1)}s, quality ${leanest.reqScore}/5)`,
    ),
  );
  console.log(
    chalk.green(
      `  ⭐ Quality:  ${bestQuality.name} (${bestQuality.reqScore}/5, ${bestQuality.reportLen} chars, ${bestQuality.tokens} tok)`,
    ),
  );

  // Balanced score
  const maxTok = Math.max(...valid.map((r) => r.tokens));
  const maxTime = Math.max(...valid.map((r) => r.time));
  const maxStrong = Math.max(...valid.map((r) => r.strongTok), 1);

  console.log(chalk.cyan.bold('\n  ═══ Balanced Score (lower=better, quality inverted) ═══\n'));
  const scored = valid
    .map((r) => {
      const tokScore = r.tokens / maxTok;
      const timeScore = r.time / maxTime;
      const costScore = r.strongTok / maxStrong;
      const qualityScore = 1 - r.reqScore / 5;
      const composite = qualityScore * 0.4 + tokScore * 0.25 + timeScore * 0.2 + costScore * 0.15;
      return { ...r, composite, tokScore, timeScore, costScore, qualityScore };
    })
    .sort((a, b) => a.composite - b.composite);

  for (const s of scored) {
    const name = s.name.padEnd(14);
    const comp = s.composite.toFixed(3);
    const bar = '█'.repeat(Math.round(s.composite * 20)).padEnd(20);
    console.log(
      `  ${name} ${comp}  ${chalk.cyan(bar)}  q=${s.reqScore}/5 tok=${s.tokens} t=${s.time.toFixed(1)}s $=${s.strongTok}`,
    );
  }

  console.log(chalk.green.bold(`\n  🏆 Balanced Winner: ${scored[0].name} (score: ${scored[0].composite.toFixed(3)})`));

  // Requirement detail
  console.log(chalk.cyan.bold('\n  ═══ Requirement Breakdown ═══\n'));
  const reqNames = requirements.map((r) => r.name);
  console.log(chalk.dim(`  Config        | ${reqNames.map((n) => n.slice(0, 12).padEnd(13)).join('| ')}`));
  console.log(chalk.dim(`  ${'─'.repeat(14 + reqNames.length * 15)}`));
  for (const r of results) {
    const name = r.name.padEnd(14);
    const details = r.reqDetail.map((d) => (d === '✓' ? chalk.green(d) : chalk.red(d)).padEnd(13)).join('| ');
    console.log(`  ${name}| ${details}`);
  }

  console.log('');
}
