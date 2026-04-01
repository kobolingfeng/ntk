/**
 * Benchmark runner — multi-run execution with mean/stddev and raw data export.
 *
 * Provides a reusable framework for running benchmarks with statistical rigor:
 * - Each configuration runs N times (default 3)
 * - Calculates mean and standard deviation for tokens, time
 * - Exports raw results as JSON for reproducibility
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import chalk from 'chalk';
import { LLMClient } from '../../core/llm.js';
import type { NTKConfig } from '../../core/protocol.js';
import { Pipeline } from '../../pipeline/pipeline.js';

export interface BenchmarkTask {
  name: string;
  task: string;
  category: string;
}

interface SingleRunResult {
  tokens: number;
  durationMs: number;
  depth: string;
  strongTokens: number;
  cheapTokens: number;
  success: boolean;
  outputLength: number;
}

interface AggregatedResult {
  task: string;
  category: string;
  runs: SingleRunResult[];
  stats: {
    tokens: { mean: number; stddev: number; min: number; max: number };
    durationMs: { mean: number; stddev: number; min: number; max: number };
  };
}

interface BenchmarkReport {
  metadata: {
    timestamp: string;
    runs: number;
    plannerModel: string;
    compressorModel: string;
    configLabel: string;
  };
  results: AggregatedResult[];
  summary: {
    totalTasks: number;
    passRate: number;
    avgTokens: number;
    avgDurationMs: number;
  };
}

function mean(arr: number[]): number {
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function stddev(arr: number[]): number {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  const variance = arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1);
  return Math.sqrt(variance);
}

function stats(arr: number[]) {
  return {
    mean: Math.round(mean(arr) * 10) / 10,
    stddev: Math.round(stddev(arr) * 10) / 10,
    min: Math.min(...arr),
    max: Math.max(...arr),
  };
}

async function runSingleNTK(config: NTKConfig, task: string): Promise<SingleRunResult> {
  Pipeline.clearCache();
  const start = Date.now();
  const pipeline = new Pipeline(config, () => {});
  const result = await pipeline.run(task);
  const durationMs = Date.now() - start;
  const totalTok = result.tokenReport.totalInput + result.tokenReport.totalOutput;
  const plannerTok = result.tokenReport.byAgent.planner
    ? result.tokenReport.byAgent.planner.input + result.tokenReport.byAgent.planner.output
    : 0;

  return {
    tokens: totalTok,
    durationMs,
    depth: result.depth ?? 'full',
    strongTokens: plannerTok,
    cheapTokens: totalTok - plannerTok,
    success: result.success,
    outputLength: result.report.length,
  };
}

async function runSingleDirect(llm: LLMClient, task: string, model: string): Promise<SingleRunResult> {
  const start = Date.now();
  const result = await llm.chat('You are a helpful assistant. Output concisely.', task, 'executor', 'execute');
  const durationMs = Date.now() - start;
  const tokens = result.usage.inputTokens + result.usage.outputTokens;

  return {
    tokens,
    durationMs,
    depth: 'direct',
    strongTokens: model.includes('mini') || model.includes('nano') ? 0 : tokens,
    cheapTokens: model.includes('mini') || model.includes('nano') ? tokens : 0,
    success: true,
    outputLength: result.content.length,
  };
}

export async function runBenchmarkSuite(
  config: NTKConfig,
  tasks: BenchmarkTask[],
  options: {
    runs?: number;
    label?: string;
    outputDir?: string;
    configs?: Array<'ntk' | 'cheap' | 'strong'>;
  } = {},
): Promise<void> {
  const runs = options.runs ?? 3;
  const label = options.label ?? 'benchmark';
  const outputDir = options.outputDir ?? join(process.cwd(), 'benchmarks', 'results');
  const configs = options.configs ?? ['ntk', 'cheap', 'strong'];

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  console.log(chalk.cyan.bold(`\n  📊 Benchmark: ${label}`));
  console.log(chalk.dim(`  Runs per config: ${runs}`));
  console.log(chalk.dim(`  Tasks: ${tasks.length}`));
  console.log(chalk.dim(`  Configs: ${configs.join(', ')}`));
  console.log(chalk.dim(`  Output: ${outputDir}\n`));

  const allReports: Map<string, BenchmarkReport> = new Map();

  for (const configName of configs) {
    console.log(chalk.yellow.bold(`\n  ═══ Config: ${configName} ═══\n`));

    const configResults: AggregatedResult[] = [];

    for (const task of tasks) {
      console.log(chalk.dim(`  [${task.category}] ${task.name}`));
      const taskRuns: SingleRunResult[] = [];

      for (let i = 0; i < runs; i++) {
        process.stdout.write(chalk.dim(`    run ${i + 1}/${runs}... `));

        try {
          let result: SingleRunResult;
          switch (configName) {
            case 'ntk':
              result = await runSingleNTK(config, task.task);
              break;
            case 'cheap':
              result = await runSingleDirect(new LLMClient(config.compressor), task.task, config.compressor.model);
              break;
            case 'strong':
              result = await runSingleDirect(new LLMClient(config.planner), task.task, config.planner.model);
              break;
            default:
              throw new Error(`Unknown config: ${configName}`);
          }
          taskRuns.push(result);
          console.log(chalk.green(`${result.tokens} tok, ${(result.durationMs / 1000).toFixed(1)}s`));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.log(chalk.red(`error: ${msg.slice(0, 80)}`));
          taskRuns.push({
            tokens: 0,
            durationMs: 0,
            depth: 'error',
            strongTokens: 0,
            cheapTokens: 0,
            success: false,
            outputLength: 0,
          });
        }
      }

      const successRuns = taskRuns.filter((r) => r.success);
      const tokenValues = successRuns.map((r) => r.tokens);
      const durationValues = successRuns.map((r) => r.durationMs);

      configResults.push({
        task: task.name,
        category: task.category,
        runs: taskRuns,
        stats: {
          tokens: tokenValues.length > 0 ? stats(tokenValues) : { mean: 0, stddev: 0, min: 0, max: 0 },
          durationMs: durationValues.length > 0 ? stats(durationValues) : { mean: 0, stddev: 0, min: 0, max: 0 },
        },
      });
    }

    const successfulResults = configResults.filter((r) => r.runs.some((run) => run.success));
    const report: BenchmarkReport = {
      metadata: {
        timestamp: new Date().toISOString(),
        runs,
        plannerModel: config.planner.model,
        compressorModel: config.compressor.model,
        configLabel: configName,
      },
      results: configResults,
      summary: {
        totalTasks: tasks.length,
        passRate: (successfulResults.length / tasks.length) * 100,
        avgTokens: mean(configResults.map((r) => r.stats.tokens.mean)),
        avgDurationMs: mean(configResults.map((r) => r.stats.durationMs.mean)),
      },
    };

    allReports.set(configName, report);

    const filename = `${label}-${configName}-${new Date().toISOString().slice(0, 10)}.json`;
    const filepath = join(outputDir, filename);
    writeFileSync(filepath, JSON.stringify(report, null, 2));
    console.log(chalk.dim(`\n  Saved: ${filepath}`));
  }

  // Print comparison table
  console.log(chalk.cyan.bold('\n  ═══ Comparison Table (mean ± stddev) ═══\n'));

  const header = ['Task', ...configs.map((c) => `${c} (tokens)`), ...configs.map((c) => `${c} (time)`)];
  console.log(chalk.dim(`  ${header.map((h) => h.padEnd(20)).join('| ')}`));
  console.log(chalk.dim(`  ${'─'.repeat(header.length * 22)}`));

  for (let i = 0; i < tasks.length; i++) {
    const name = tasks[i].name.slice(0, 18).padEnd(20);
    const tokCols = configs.map((c) => {
      const r = allReports.get(c)?.results[i];
      if (!r) return '—'.padEnd(20);
      return `${r.stats.tokens.mean}±${r.stats.tokens.stddev}`.padEnd(20);
    });
    const timeCols = configs.map((c) => {
      const r = allReports.get(c)?.results[i];
      if (!r) return '—'.padEnd(20);
      return `${(r.stats.durationMs.mean / 1000).toFixed(1)}±${(r.stats.durationMs.stddev / 1000).toFixed(1)}s`.padEnd(20);
    });
    console.log(`  ${name}| ${tokCols.join('| ')}| ${timeCols.join('| ')}`);
  }

  console.log('');
}

export async function cmdBenchmark(config: NTKConfig): Promise<void> {
  const defaultTasks: BenchmarkTask[] = [
    // --- 原始 9 任务 ---
    { name: 'Fibonacci', task: '用Python写一个计算斐波那契数列第n项的函数', category: 'code-gen' },
    { name: 'Deep Copy', task: '用TypeScript写一个深拷贝函数，支持循环引用检测', category: 'code-gen' },
    { name: 'Translation', task: '将以下技术文档翻译成英文：Redis是一个开源的内存数据结构存储系统，可用作数据库、缓存和消息代理。', category: 'translation' },
    { name: 'React vs Vue', task: '比较 React 和 Vue 的核心区别，给出选择建议', category: 'comparison' },
    { name: 'REST API Design', task: '设计一个简单的 TODO 应用的 REST API，包括路由、数据模型和错误处理', category: 'design' },
    { name: 'Code Refactor', task: '重构以下代码为函数式风格：for(let i=0;i<arr.length;i++){if(arr[i]>0){result.push(arr[i]*2)}}', category: 'refactor' },
    { name: 'Bug Analysis', task: '分析这段代码的bug并给出修复：function sum(arr) { let total; for(let i=0; i<=arr.length; i++) { total += arr[i]; } return total; }', category: 'debug' },
    { name: 'Quick Sort', task: '解释快速排序算法的时间复杂度分析，包括最好、最坏和平均情况', category: 'reasoning' },
    { name: 'Debounce', task: '写一个防抖函数，支持 leading 和 trailing 选项', category: 'code-gen' },
    // --- 扩展任务 ---
    { name: 'Math Series', task: '计算 1+2+3+...+100 的和，给出推导过程和公式', category: 'math' },
    { name: 'SQL Top-N', task: '写一个SQL查询，找出每个部门薪资最高的前3名员工，包含部门名称、员工姓名和薪资', category: 'sql' },
    { name: 'LRU Cache', task: '用Python实现一个LRU缓存类，支持O(1)的get和put操作', category: 'code-gen' },
    { name: 'IPv4 Regex', task: '写一个正则表达式匹配合法的IPv4地址，需要检查每段在0-255范围内', category: 'regex' },
    { name: 'Unit Test', task: '为以下函数编写Jest单元测试：function binarySearch(arr: number[], target: number): number { let lo = 0, hi = arr.length - 1; while (lo <= hi) { const mid = (lo + hi) >> 1; if (arr[mid] === target) return mid; if (arr[mid] < target) lo = mid + 1; else hi = mid - 1; } return -1; }', category: 'test-gen' },
    { name: 'JSON to Table', task: '将以下JSON数组转换为Markdown表格：[{"name":"Alice","age":30,"role":"Engineer"},{"name":"Bob","age":25,"role":"Designer"},{"name":"Charlie","age":35,"role":"Manager"}]', category: 'data-transform' },
    { name: 'SQL Injection Fix', task: '审查以下Node.js代码的安全漏洞并给出修复方案：app.get("/user", (req, res) => { const id = req.query.id; db.query("SELECT * FROM users WHERE id = " + id, (err, rows) => { res.json(rows); }); });', category: 'security' },
  ];

  await runBenchmarkSuite(config, defaultTasks, {
    runs: 3,
    label: 'ntk-baseline',
    configs: ['ntk', 'cheap', 'strong'],
  });
}
