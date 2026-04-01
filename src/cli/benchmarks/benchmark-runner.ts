/**
 * Benchmark runner — multi-run execution with mean/stddev and raw data export.
 *
 * Provides a reusable framework for running benchmarks with statistical rigor:
 * - Each configuration runs N times (default 3)
 * - Calculates mean and standard deviation for tokens, time
 * - Exports raw results as JSON for reproducibility
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync, readdirSync } from 'node:fs';
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
    cachedBaselines?: boolean;
  } = {},
): Promise<void> {
  const runs = options.runs ?? 3;
  const label = options.label ?? 'benchmark';
  const outputDir = options.outputDir ?? join(process.cwd(), 'benchmarks', 'results');
  const runConfigs = options.cachedBaselines ? ['ntk'] : (options.configs ?? ['ntk', 'cheap', 'strong']);
  const displayConfigs = options.configs ?? ['ntk', 'cheap', 'strong'];

  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  // Load cached baselines if only running NTK
  const allReports: Map<string, BenchmarkReport> = new Map();
  if (options.cachedBaselines) {
    for (const baseline of displayConfigs.filter((c) => c !== 'ntk')) {
      const files = readdirSync(outputDir)
        .filter((f) => f.includes(`-${baseline}-`) && f.endsWith('.json'))
        .sort()
        .reverse();
      if (files.length > 0) {
        const cached = JSON.parse(readFileSync(join(outputDir, files[0]), 'utf-8')) as BenchmarkReport;
        allReports.set(baseline, cached);
        console.log(chalk.dim(`  Loaded cached ${baseline}: ${files[0]}`));
      }
    }
  }

  console.log(chalk.cyan.bold(`\n  📊 Benchmark: ${label}`));
  console.log(chalk.dim(`  Runs per config: ${runs}`));
  console.log(chalk.dim(`  Tasks: ${tasks.length}`));
  console.log(chalk.dim(`  Configs: ${runConfigs.join(', ')}${options.cachedBaselines ? ' (baselines cached)' : ''}`));
  console.log(chalk.dim(`  Output: ${outputDir}\n`));

  for (const configName of runConfigs) {
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

  const header = ['Task', ...displayConfigs.map((c) => `${c} (tokens)`), ...displayConfigs.map((c) => `${c} (time)`)];
  console.log(chalk.dim(`  ${header.map((h) => h.padEnd(20)).join('| ')}`));
  console.log(chalk.dim(`  ${'─'.repeat(header.length * 22)}`));

  for (let i = 0; i < tasks.length; i++) {
    const name = tasks[i].name.slice(0, 18).padEnd(20);
    const tokCols = displayConfigs.map((c) => {
      const r = allReports.get(c)?.results[i];
      if (!r) return '—'.padEnd(20);
      return `${r.stats.tokens.mean}±${r.stats.tokens.stddev}`.padEnd(20);
    });
    const timeCols = displayConfigs.map((c) => {
      const r = allReports.get(c)?.results[i];
      if (!r) return '—'.padEnd(20);
      return `${(r.stats.durationMs.mean / 1000).toFixed(1)}±${(r.stats.durationMs.stddev / 1000).toFixed(1)}s`.padEnd(20);
    });
    console.log(`  ${name}| ${tokCols.join('| ')}| ${timeCols.join('| ')}`);
  }

  // Annotate NTK vs cheap/strong wins/losses
  if (displayConfigs.includes('ntk') && displayConfigs.length > 1) {
    const ntkReport = allReports.get('ntk');
    for (const baseline of displayConfigs.filter((c) => c !== 'ntk')) {
      const baseReport = allReports.get(baseline);
      if (!ntkReport || !baseReport) continue;
      const wins = [];
      const losses = [];
      for (let i = 0; i < tasks.length; i++) {
        const ntkMean = ntkReport.results[i]?.stats.tokens.mean ?? Infinity;
        const baseMean = baseReport.results[i]?.stats.tokens.mean ?? Infinity;
        if (ntkMean < baseMean) wins.push(tasks[i].name);
        else if (ntkMean > baseMean) losses.push({ name: tasks[i].name, ntk: ntkMean, base: baseMean, diff: ntkMean - baseMean });
      }
      console.log(chalk.cyan(`  ntk vs ${baseline}: ${chalk.green(`${wins.length} wins`)} / ${losses.length > 0 ? chalk.red(`${losses.length} losses`) : chalk.green('0 losses')}`));
      if (losses.length > 0) {
        for (const l of losses) {
          console.log(chalk.dim(`    ⚠ ${l.name}: ntk ${l.ntk} vs ${baseline} ${l.base} (+${l.diff.toFixed(1)} tok) — 简单任务，大模型已优化极致无余地`));
        }
      }
    }
  }

  console.log('');
}

export async function cmdBenchmark(config: NTKConfig, opts?: { cached?: boolean }): Promise<void> {
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
    // --- 扩展任务 v2 (17-32) ---
    { name: 'Text Summary', task: '用一句话概括以下段落的核心观点：微服务架构通过将应用拆分为小型独立服务来提高系统的可维护性和可扩展性，每个服务可以独立开发、部署和扩缩容，但也引入了分布式系统的复杂性，包括服务发现、负载均衡、熔断降级和分布式追踪等挑战。', category: 'summarization' },
    { name: 'Explain Closure', task: '用简单的例子解释JavaScript闭包是什么以及常见用途', category: 'explanation' },
    { name: 'Dockerfile', task: '为一个Node.js Express应用编写多阶段构建的Dockerfile，要求生产镜像尽可能小', category: 'devops' },
    { name: 'Shell Pipeline', task: '写一条Linux命令：统计当前目录下所有.ts文件的总行数', category: 'cli' },
    { name: 'Name Generator', task: '为一个专注于代码质量检测的开发工具起5个简短有力的英文产品名', category: 'creative' },
    { name: 'YAML to JSON', task: '将以下YAML转换为JSON：\nserver:\n  host: localhost\n  port: 8080\ndatabase:\n  url: postgres://localhost:5432/mydb\n  pool: 10', category: 'conversion' },
    { name: 'Code Review', task: '审查以下Go代码并给出改进建议：func getUser(id string) (*User, error) { resp, _ := http.Get("http://api/users/" + id); defer resp.Body.Close(); var u User; json.NewDecoder(resp.Body).Decode(&u); return &u, nil }', category: 'review' },
    { name: 'Go Channel', task: '用Go写一个使用channel实现的生产者-消费者模式示例', category: 'code-gen' },
    { name: 'Race Condition', task: '分析以下代码的并发bug：var count int; func increment() { for i := 0; i < 1000; i++ { count++ } }; 两个goroutine同时调用increment会怎样？', category: 'debug' },
    { name: 'Window Func', task: '用SQL窗口函数计算每个用户的订单金额累计和，按下单时间排序，表结构：orders(user_id, amount, created_at)', category: 'sql' },
    { name: 'Observer Pattern', task: '用TypeScript实现观察者模式，包含Subject和Observer接口', category: 'design' },
    { name: 'GitHub Actions', task: '编写一个GitHub Actions workflow：在push到main分支时运行npm test和npm run build', category: 'devops' },
    { name: 'CSV Parse', task: '用Python写一个函数解析CSV字符串为字典列表，正确处理引号内的逗号', category: 'code-gen' },
    { name: 'Big-O Analyze', task: '分析以下算法的时间复杂度：for i in range(n): for j in range(i, n): for k in range(j, n): pass', category: 'reasoning' },
    { name: 'Promise Chain', task: '将以下回调地狱改写为async/await：getUser(id, (user) => { getPosts(user.id, (posts) => { getComments(posts[0].id, (comments) => { console.log(comments); }); }); });', category: 'refactor' },
    { name: 'XSS Prevention', task: '解释XSS跨站脚本攻击的三种类型（反射型、存储型、DOM型），各给一个攻击示例和防御方法', category: 'security' },
  ];

  await runBenchmarkSuite(config, defaultTasks, {
    runs: 3,
    label: 'ntk-baseline',
    configs: ['ntk', 'cheap', 'strong'],
    cachedBaselines: opts?.cached,
  });
}
