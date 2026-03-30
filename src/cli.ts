/**
 * NTK CLI — The unified entry point.
 *
 * Modes:
 *   npx tsx src/cli.ts run "your task"           — Single task execution
 *   npx tsx src/cli.ts interactive               — Interactive REPL
 *   npx tsx src/cli.ts serve [--port 3210]       — Start API server
 *   npx tsx src/cli.ts test                      — Run built-in test suite
 */

import { Pipeline } from './pipeline/pipeline.js';
import { NTKServer } from './api/server.js';
import { LLMClient } from './core/llm.js';
import type { NTKConfig, PipelineEvent } from './index.js';
import type { PipelineResult } from './pipeline/pipeline.js';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { createInterface } from 'readline';

dotenv.config();

// ─── Configuration ────────────────────────────────────

function loadEndpoints(): void {
  const endpoints = [];

  // Scan for API_ENDPOINT_N_* env vars
  for (let i = 1; i <= 10; i++) {
    const key = process.env[`API_ENDPOINT_${i}_KEY`];
    const url = process.env[`API_ENDPOINT_${i}_URL`];
    const name = process.env[`API_ENDPOINT_${i}_NAME`] || `endpoint-${i}`;
    if (key && url) {
      endpoints.push({ name, apiKey: key, baseUrl: url });
    }
  }

  // Fallback: legacy UNIFIED_API_KEY format
  if (endpoints.length === 0) {
    const key = process.env.UNIFIED_API_KEY || '';
    const url = process.env.UNIFIED_BASE_URL || 'https://api.openai.com/v1';
    if (key) endpoints.push({ name: 'default', apiKey: key, baseUrl: url });
  }

  if (endpoints.length === 0) {
    console.error(chalk.red('❌ No API endpoints found. Set API_ENDPOINT_1_KEY and API_ENDPOINT_1_URL in .env'));
    process.exit(1);
  }

  LLMClient.setEndpoints(endpoints);
  console.log(chalk.dim(`  Loaded ${endpoints.length} endpoint(s): ${endpoints.map(e => e.name).join(', ')}`));
}

function loadConfig(): NTKConfig {
  const ep = LLMClient.getActiveEndpoint()!;

  const plannerModel = process.env.PLANNER_MODEL || process.env.MODEL || 'gpt-4o';
  const compressorModel = process.env.COMPRESSOR_MODEL || process.env.MODEL || 'gpt-4o';

  const plannerConfig = {
    apiKey: ep.apiKey,
    baseUrl: ep.baseUrl,
    model: plannerModel,
    maxTokens: 4096,
    temperature: 0.3,
  };

  const compressorConfig = {
    apiKey: ep.apiKey,
    baseUrl: ep.baseUrl,
    model: compressorModel,
    maxTokens: 2048,
    temperature: 0.2,
  };

  return {
    planner: plannerConfig,
    compressor: compressorConfig,
    maxLocalRetries: 2,
    debug: process.env.DEBUG === 'true',
    parallelExecution: true,
    tokenBudget: {
      planner: 1024,
      scout: 512,
      summarizer: 512,
      executor: 4096,
      verifier: 256,
    },
  };
}

// ─── Pretty Event Printer ─────────────────────────────

function handleEvent(event: PipelineEvent): void {
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

// ─── Token Report Printer ─────────────────────────────

function printTokenReport(result: PipelineResult): void {
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

// ─── Commands ─────────────────────────────────────────

async function cmdRun(task: string, config: NTKConfig, opts?: { forceDepth?: string; skipScout?: boolean }): Promise<void> {
  console.log(chalk.blue.bold(`\n  ⚡ Running task: "${task}"\n`));
  if (opts?.forceDepth) console.log(chalk.dim(`  Force depth: ${opts.forceDepth}`));
  if (opts?.skipScout) console.log(chalk.dim(`  Skip scout: true`));

  const startTime = Date.now();
  const pipeline = new Pipeline(config, handleEvent, opts as any);
  const result = await pipeline.run(task);
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(chalk.cyan.bold('\n  ═══ Final Report ═══'));
  console.log('  ' + result.report.split('\n').join('\n  '));
  console.log(chalk.dim(`\n  ⏱️  Duration: ${duration}s | Depth: ${result.depth ?? 'full'}`));

  printTokenReport(result);
}

async function cmdInteractive(config: NTKConfig): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const ask = (): void => {
    rl.question(chalk.cyan('\n  📝 Task > '), async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === 'exit' || trimmed === 'quit') {
        console.log(chalk.dim('  Bye!\n'));
        rl.close();
        return;
      }

      if (trimmed === 'help') {
        console.log(chalk.dim('  Type a task to run, or "exit" to quit.'));
        ask();
        return;
      }

      await cmdRun(trimmed, config);
      ask();
    });
  };

  ask();
}

async function cmdServe(port: number, config: NTKConfig): Promise<void> {
  const server = new NTKServer(config);
  await server.start(port);
}

// ─── Baseline: single LLM call, no pipeline ──────────

async function cmdBaseline(config: NTKConfig): Promise<void> {
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

    // Baseline 1: cheap model direct
    const t1 = Date.now();
    const r1 = await llm.chat('You are a helpful assistant. Output concisely.', t.task, 'executor', 'execute');
    const baselineCheap = { tokens: r1.usage.inputTokens + r1.usage.outputTokens, time: Date.now() - t1, model: config.compressor.model };
    console.log(chalk.dim(`  Baseline (${config.compressor.model}): ${baselineCheap.tokens} tok, ${(baselineCheap.time / 1000).toFixed(1)}s`));

    // Baseline 2: strong model direct
    const t2 = Date.now();
    const r2 = await strongLLM.chat('You are a helpful assistant. Output concisely.', t.task, 'executor', 'execute');
    const baselineStrong = { tokens: r2.usage.inputTokens + r2.usage.outputTokens, time: Date.now() - t2, model: config.planner.model };
    console.log(chalk.dim(`  Baseline (${config.planner.model}): ${baselineStrong.tokens} tok, ${(baselineStrong.time / 1000).toFixed(1)}s`));

    // NTK Pipeline
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

  // Summary table
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

async function cmdAblation(config: NTKConfig): Promise<void> {
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

// ─── Optimization Matrix: find best config per dimension ──

async function cmdOptimize(config: NTKConfig): Promise<void> {
  console.log(chalk.cyan.bold('\n  🎯 Optimization Matrix: Speed / Cost / Token / Quality\n'));

  // Complex task with 5 verifiable requirements
  const task = '用TypeScript实现一个LRU Cache类，要求：1.O(1)的get和put操作(用双向链表+Map) 2.支持泛型<K,V> 3.支持maxAge过期时间(ms)，get时检查过期 4.容量满时的onEvict回调 5.提供size()方法';
  console.log(chalk.dim(`  Task: "${task}"\n`));

  // 5 verifiable requirements for quality evaluation
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
    {
      name: 'NTK Default',
      target: 'balance',
      cfg: config,
    },
    {
      name: 'Token-Min',
      target: 'tokens',
      cfg: config,
      opts: { forceDepth: 'direct', skipScout: true },
    },
    {
      name: 'Quality-Std',
      target: 'quality',
      cfg: config,
      opts: { forceDepth: 'standard' },
    },
    {
      name: 'Premium',
      target: 'quality+',
      cfg: config,
      opts: { forceDepth: 'full' },
    },
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

      // Evaluate requirements
      const report = r.report.toLowerCase();
      const reqDetail: string[] = [];
      let reqScore = 0;
      for (const req of requirements) {
        const met = req.keywords.some(kw => report.includes(kw.toLowerCase()));
        reqDetail.push(met ? '✓' : '✗');
        if (met) reqScore++;
      }

      const entry: RunResult = {
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
      };
      results.push(entry);

      console.log(chalk.dim(`  ${totalTok} tok | ${duration.toFixed(1)}s | depth=${r.depth} | quality=${reqScore}/5 | report=${r.report.length} chars`));
    } catch (e) {
      console.log(chalk.red(`  ❌ ERROR: ${e instanceof Error ? e.message : e}`));
      results.push({
        name: c.name, target: c.target, tokens: 0, strongTok: 0, time: (Date.now() - t0) / 1000,
        depth: 'error', reportLen: 0, reqScore: 0, reqDetail: ['✗','✗','✗','✗','✗'], report: '', success: false,
      });
    }
  }

  // ── Summary Table ──
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

  // ── Per-dimension winners ──
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
    return a.reportLen > b.reportLen ? a : b; // tie-break on report length
  });

  console.log(chalk.cyan.bold('\n  ═══ Dimension Winners ═══\n'));
  console.log(chalk.green(`  🏎️  Speed:    ${fastest.name} (${fastest.time.toFixed(1)}s, ${fastest.tokens} tok, quality ${fastest.reqScore}/5)`));
  console.log(chalk.green(`  💰 Cost:     ${cheapest.name} (strong=${cheapest.strongTok} tok, total=${cheapest.tokens}, quality ${cheapest.reqScore}/5)`));
  console.log(chalk.green(`  📦 Tokens:   ${leanest.name} (${leanest.tokens} tok, ${leanest.time.toFixed(1)}s, quality ${leanest.reqScore}/5)`));
  console.log(chalk.green(`  ⭐ Quality:  ${bestQuality.name} (${bestQuality.reqScore}/5, ${bestQuality.reportLen} chars, ${bestQuality.tokens} tok)`));

  // ── Balanced score (normalized) ──
  const maxTok = Math.max(...valid.map(r => r.tokens));
  const maxTime = Math.max(...valid.map(r => r.time));
  const maxStrong = Math.max(...valid.map(r => r.strongTok), 1);

  console.log(chalk.cyan.bold('\n  ═══ Balanced Score (lower=better, quality inverted) ═══\n'));
  const scored = valid.map(r => {
    const tokScore = r.tokens / maxTok;                 // 0-1, lower is better
    const timeScore = r.time / maxTime;                 // 0-1, lower is better
    const costScore = r.strongTok / maxStrong;           // 0-1, lower is better
    const qualityScore = 1 - (r.reqScore / 5);          // 0-1, lower is better (inverted)
    // Weighted composite: quality 40%, tokens 25%, time 20%, cost 15%
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

  // ── Requirement detail ──
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

async function cmdTest(config: NTKConfig): Promise<void> {
  console.log(chalk.cyan.bold('\n  🧪 Running NTK Test Suite\n'));
  console.log(chalk.dim(`  Planner: ${config.planner.model}`));
  console.log(chalk.dim(`  Compressor: ${config.compressor.model}`));
  console.log(chalk.dim(`  Base URL: ${config.planner.baseUrl}\n`));

  const tests = [
    // ── Direct depth tasks ──
    {
      name: 'Code-Gen: Python Function',
      task: '用Python写一个计算斐波那契数列第n项的函数',
      category: 'code-gen',
      expectInReport: ['def', 'fib'],
    },
    {
      name: 'Code-Gen: TypeScript Utility',
      task: '用TypeScript写一个深拷贝函数，支持循环引用检测',
      category: 'code-gen',
      expectInReport: ['function', 'deep'],
    },
    {
      name: 'Translation',
      task: '将以下技术文档翻译成英文：Redis是一个开源的内存数据结构存储系统，可用作数据库、缓存和消息代理。它支持多种数据结构，如字符串、哈希、列表、集合和有序集合。',
      category: 'translation',
      expectInReport: ['Redis', 'database'],
    },
    {
      name: 'Math/Logic',
      task: '解释快速排序算法的时间复杂度分析，包括最好、最坏和平均情况',
      category: 'reasoning',
      expectInReport: ['O(', 'log'],
    },
    // ── Light depth tasks ──
    {
      name: 'API Design',
      task: '设计一个简单的 TODO 应用的 REST API，包括路由、数据模型和错误处理',
      category: 'design',
      expectInReport: ['API', 'TODO'],
    },
    {
      name: 'Code Refactor',
      task: '重构以下代码为函数式风格：for(let i=0;i<arr.length;i++){if(arr[i]>0){result.push(arr[i]*2)}}',
      category: 'refactor',
      expectInReport: ['filter', 'map'],
    },
    // ── Standard depth tasks ──
    {
      name: 'Tech Comparison',
      task: '比较 React 和 Vue 的核心区别，给出选择建议',
      category: 'comparison',
      expectInReport: ['React', 'Vue'],
    },
    {
      name: 'Architecture Decision',
      task: '对比微服务架构和单体架构的优缺点，给出何时选择哪种的建议',
      category: 'comparison',
      expectInReport: ['微服务', '单体'],
    },
    // ── Debug task ──
    {
      name: 'Debug Analysis',
      task: '分析这段代码的bug并给出修复：function sum(arr) { let total; for(let i=0; i<=arr.length; i++) { total += arr[i]; } return total; }',
      category: 'debug',
      expectInReport: ['total', '0'],
    },
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

      // Basic quality checks
      const hasContent = result.report.length > 50;
      const isSuccess = result.success;
      const totalTokens = result.tokenReport.totalInput + result.tokenReport.totalOutput;
      const isEfficient = totalTokens < 10000; // Should use < 10k tokens

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

    // Separator between tests
    console.log(chalk.dim('  ' + '─'.repeat(50)));
  }

  // Summary
  console.log(chalk.cyan.bold('\n  ═══ Test Summary ═══'));
  console.log(chalk.green(`  Passed: ${passed}/${tests.length}`));
  if (failed > 0) console.log(chalk.red(`  Failed: ${failed}/${tests.length}`));
  console.log('');
}

// ─── Main ─────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || 'interactive';

  console.log(chalk.cyan.bold('\n  🔒 NTK — NeedToKnow Agent Framework'));
  console.log(chalk.dim('     "Know less. Do more."\n'));

  // Early validation for 'run' command — avoid wasting time probing if no task
  if (command === 'run') {
    const task = args.slice(1).filter((a) => !a.startsWith('--')).join(' ');
    if (!task) {
      console.log(chalk.yellow('  Usage: npx tsx src/cli.ts run "your task here" [--force-depth direct|light|standard|full] [--skip-scout]'));
      return;
    }
  }

  // Load and probe endpoints
  loadEndpoints();
  const plannerModel = process.env.PLANNER_MODEL || process.env.MODEL || 'gpt-4o';
  const compressorModel = process.env.COMPRESSOR_MODEL || process.env.MODEL || 'gpt-4o';
  console.log(chalk.dim(`  Planner model: ${plannerModel}`));
  console.log(chalk.dim(`  Compressor model: ${compressorModel}`));
  console.log(chalk.dim('  Probing endpoints...'));

  const working = await LLMClient.probeEndpoints(plannerModel);
  if (!working) {
    console.error(chalk.red('\n  ❌ All API endpoints are down. Check .env and try again.'));
    process.exit(1);
  }

  // If using different models, verify compressor model too
  if (compressorModel !== plannerModel) {
    console.log(chalk.dim(`  Verifying compressor model (${compressorModel})...`));
    const compressorWorking = await LLMClient.probeEndpoints(compressorModel);
    if (!compressorWorking) {
      console.log(chalk.yellow(`  ⚠️  Compressor model probe failed, falling back to planner endpoint`));
    }
  }

  console.log(chalk.green(`  Using: ${working}\n`));
  const config = loadConfig();

  switch (command) {
    case 'run': {
      const fdIdx = args.indexOf('--force-depth');
      const forceDepth = fdIdx >= 0 ? args[fdIdx + 1] : undefined;
      const skipScout = args.includes('--skip-scout');
      // Exclude --flag values from task string
      const skipIndices = new Set<number>();
      if (fdIdx >= 0) { skipIndices.add(fdIdx); skipIndices.add(fdIdx + 1); }
      const ssIdx = args.indexOf('--skip-scout');
      if (ssIdx >= 0) skipIndices.add(ssIdx);
      const task = args.slice(1).filter((a, i) => !a.startsWith('--') && !skipIndices.has(i + 1)).join(' ');
      if (!task) {
        console.log(chalk.yellow('  Usage: npx tsx src/cli.ts run "your task here" [--force-depth direct|light|standard|full] [--skip-scout]'));
        return;
      }
      await cmdRun(task, config, { forceDepth, skipScout: skipScout || undefined });
      break;
    }

    case 'interactive':
    case '-i':
      await cmdInteractive(config);
      break;

    case 'serve':
    case 'api': {
      const portIdx = args.indexOf('--port');
      const port = portIdx >= 0 ? parseInt(args[portIdx + 1]) : 3210;
      await cmdServe(port, config);
      break;
    }

    case 'test':
      await cmdTest(config);
      break;

    case 'baseline':
      await cmdBaseline(config);
      break;

    case 'ablation':
      await cmdAblation(config);
      break;

    case 'optimize':
      await cmdOptimize(config);
      break;

    case 'mcp': {
      const { startMcpServer } = await import('./mcp/server.js');
      await startMcpServer();
      break;
    }

    default: {
      // Treat unknown command as a task to run
      const task = args.filter((a) => !a.startsWith('--')).join(' ');
      if (task) {
        await cmdRun(task, config);
      } else {
        console.log(chalk.yellow('  Commands:'));
        console.log(chalk.dim('    run <task>        — Run a single task'));
        console.log(chalk.dim('    interactive       — Interactive REPL'));
        console.log(chalk.dim('    serve [--port N]  — Start API server'));
        console.log(chalk.dim('    mcp               — Start MCP server (stdio transport)'));
        console.log(chalk.dim('    test              — Run test suite (9 tasks)'));
        console.log(chalk.dim('    baseline          — Baseline comparison (NTK vs direct LLM)'));
        console.log(chalk.dim('    ablation          — Ablation study (component contribution)'));
        console.log(chalk.dim('    optimize          — Optimization matrix (speed/cost/token/quality)'));
      }
    }
  }
}

main().catch((err) => {
  console.error(chalk.red(`  Fatal: ${err.message}`));
  process.exit(1);
});
