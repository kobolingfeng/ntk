/**
 * Compare benchmark — I/O-filter-only vs Traditional vs NTK.
 *
 * Measures three approaches on the same tasks:
 * 1. Traditional: raw task → single LLM (no filtering)
 * 2. Filter-only: deterministic pre-filter → single LLM (no routing/compression)
 * 3. NTK: full pipeline (pre-filter + LLM compression + routing + multi-agent)
 */

import chalk from 'chalk';
import { LLMClient } from '../../core/llm.js';
import { preFilter } from '../../core/pre-filter.js';
import type { NTKConfig } from '../../core/protocol.js';
import { Pipeline } from '../../pipeline/pipeline.js';

interface CompareResult {
  name: string;
  category: string;
  traditional: RunMetrics;
  filterOnly: RunMetrics;
  ntk: NTKRunMetrics;
}

interface RunMetrics {
  inputChars: number;
  outputChars: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  timeMs: number;
  costWeighted: number;
}

interface NTKRunMetrics extends RunMetrics {
  depth: string;
  preFilterCharsRemoved: number;
  preFilterReductionPct: number;
  routerBlocked: number;
  routerBlockRate: number;
  strongTokens: number;
  cheapTokens: number;
}

const STRONG_COST_RATIO = 10;

function estimateCost(tokens: number, isStrong: boolean): number {
  return isStrong ? tokens * STRONG_COST_RATIO : tokens;
}

const noisyTestOutput = [
  '\x1b[32m✓ test addition (2ms)\x1b[0m',
  '\x1b[32m✓ test subtraction (1ms)\x1b[0m',
  '\x1b[32m✓ test multiplication (1ms)\x1b[0m',
  '\x1b[32m✓ test division (2ms)\x1b[0m',
  '\x1b[32m✓ test modulo (1ms)\x1b[0m',
  '\x1b[32m✓ test power (1ms)\x1b[0m',
  '\x1b[32m✓ test sqrt (1ms)\x1b[0m',
  '\x1b[32m✓ test abs (1ms)\x1b[0m',
  '\x1b[32m✓ test floor (1ms)\x1b[0m',
  '\x1b[32m✓ test ceil (1ms)\x1b[0m',
  '\x1b[32m✓ test round (1ms)\x1b[0m',
  '\x1b[32m✓ test min (1ms)\x1b[0m',
  '\x1b[32m✓ test max (1ms)\x1b[0m',
  '\x1b[32m✓ test sum (1ms)\x1b[0m',
  '\x1b[32m✓ test average (1ms)\x1b[0m',
  '\x1b[31m✗ test divideByZero — Expected: Error, Got: Infinity\x1b[0m',
  '\x1b[31m✗ test parseFloat("abc") — Expected: NaN check, Got: no error thrown\x1b[0m',
  '',
  '',
  '',
  '',
  '████████████████░░░░ 80%',
  '[=======>    ] 80%',
  '',
  'Test Suites: 1 passed, 1 total',
  'Tests: 15 passed, 2 failed, 17 total',
  'Time: 0.834s',
].join('\n');

const noisyJsonOutput = `API Response:
{
  "status": "success",
  "data": {
    "users": [
      {
        "id": 1,
        "name": "Alice",
        "email": "alice@example.com",
        "role": "admin",
        "lastLogin": "2025-01-15T08:00:00Z"
      },
      {
        "id": 2,
        "name": "Bob",
        "email": "bob@example.com",
        "role": "user",
        "lastLogin": "2025-01-14T12:30:00Z"
      },
      {
        "id": 3,
        "name": "Charlie",
        "email": "charlie@example.com",
        "role": "user",
        "lastLogin": "2025-01-13T09:15:00Z"
      }
    ],
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "total": 3,
      "totalPages": 1
    }
  },
  "meta": {
    "requestId": "req_abc123",
    "timestamp": "2025-01-15T10:00:00Z",
    "version": "v2"
  }
}

Error log:
error line 1
error line 1
error line 1
error line 1
error line 1
error line 1

Build output:
Building module 1/5...
████░░░░░░ 20%
Building module 2/5...
████████░░ 40%
Building module 3/5...
████████████░ 60%
Building module 4/5...
████████████████░ 80%
Building module 5/5...
████████████████████ 100%
Done.`;

const noisyLogOutput = [
  '\x1b[90m[2025-01-15T08:00:01Z]\x1b[0m \x1b[32mINFO\x1b[0m  Server starting on port 3000',
  '\x1b[90m[2025-01-15T08:00:01Z]\x1b[0m \x1b[32mINFO\x1b[0m  Database connected',
  '\x1b[90m[2025-01-15T08:00:02Z]\x1b[0m \x1b[32mINFO\x1b[0m  Request GET /api/users',
  '\x1b[90m[2025-01-15T08:00:02Z]\x1b[0m \x1b[32mINFO\x1b[0m  Request GET /api/users',
  '\x1b[90m[2025-01-15T08:00:02Z]\x1b[0m \x1b[32mINFO\x1b[0m  Request GET /api/users',
  '\x1b[90m[2025-01-15T08:00:02Z]\x1b[0m \x1b[32mINFO\x1b[0m  Request GET /api/users',
  '\x1b[90m[2025-01-15T08:00:02Z]\x1b[0m \x1b[32mINFO\x1b[0m  Request GET /api/users',
  '\x1b[90m[2025-01-15T08:00:03Z]\x1b[0m \x1b[31mERROR\x1b[0m Connection pool exhausted: max 10 connections reached',
  '\x1b[90m[2025-01-15T08:00:03Z]\x1b[0m \x1b[31mERROR\x1b[0m Query timeout after 5000ms on SELECT * FROM orders WHERE user_id = $1',
  '\x1b[90m[2025-01-15T08:00:04Z]\x1b[0m \x1b[33mWARN\x1b[0m  Memory usage: 85% (threshold: 80%)',
  '',
  '',
  '',
  '████████████████████ 100%',
  'Uploading logs... 100%',
  '',
  '\x1b[90m[2025-01-15T08:00:05Z]\x1b[0m \x1b[32mINFO\x1b[0m  Health check: OK',
  '\x1b[90m[2025-01-15T08:00:05Z]\x1b[0m \x1b[32mINFO\x1b[0m  Health check: OK',
  '\x1b[90m[2025-01-15T08:00:05Z]\x1b[0m \x1b[32mINFO\x1b[0m  Health check: OK',
].join('\n');

const noisyNpmOutput = [
  '\x1b[33mnpm\x1b[0m \x1b[33mwarn\x1b[0m deprecated inflight@1.0.6: This module is not supported',
  '\x1b[33mnpm\x1b[0m \x1b[33mwarn\x1b[0m deprecated glob@7.2.3: Glob versions prior to v9 are no longer supported',
  '\x1b[33mnpm\x1b[0m \x1b[33mwarn\x1b[0m deprecated rimraf@3.0.2: Rimraf versions prior to v4 are no longer supported',
  '',
  'added 523 packages in 12s',
  '',
  '████████░░ 40%',
  '████████████████░░ 80%',
  '████████████████████ 100%',
  '',
  '✓ express@4.18.2',
  '✓ typescript@5.3.3',
  '✓ vitest@1.2.0',
  '✓ @types/node@20.11.0',
  '✓ dotenv@16.3.1',
  '✓ chalk@5.3.0',
  '✗ @prisma/client@5.8.0 — peer dependency conflict: requires typescript@>=4.7 <5.4',
  '✗ eslint-config-next@14.1.0 — missing peer: eslint@^8.0.0',
  '',
  '65 packages are looking for funding',
  '  run `npm fund` for details',
  '',
  '2 vulnerabilities (1 moderate, 1 high)',
  '  run `npm audit fix` to resolve',
].join('\n');

const testCases = [
  {
    name: '简单代码生成（无噪声）',
    category: 'clean',
    task: '用Python写一个计算斐波那契数列第n项的函数',
  },
  {
    name: '翻译任务（无噪声）',
    category: 'clean',
    task: '将以下技术文档翻译成英文：Redis是一个开源的内存数据结构存储系统，可用作数据库、缓存和消息代理。',
  },
  {
    name: '测试输出分析（带噪声）',
    category: 'noisy',
    task: `分析以下测试输出，找出失败的测试用例并给出修复建议：\n\n${noisyTestOutput}`,
  },
  {
    name: 'API响应分析（JSON噪声）',
    category: 'noisy',
    task: `分析以下构建和API输出，总结关键信息：\n\n${noisyJsonOutput}`,
  },
  {
    name: '服务器日志分析（ANSI+重复噪声）',
    category: 'noisy',
    task: `分析以下服务器日志，找出性能瓶颈和异常：\n\n${noisyLogOutput}`,
  },
  {
    name: 'NPM安装问题诊断（混合噪声）',
    category: 'noisy',
    task: `以下是npm install的输出，分析问题并给出解决方案：\n\n${noisyNpmOutput}`,
  },
  {
    name: '技术对比（多维度）',
    category: 'complex',
    task: '对比 PostgreSQL 和 MongoDB 在大规模应用中的优缺点，包括性能、扩展性、数据一致性、运维成本',
  },
  {
    name: '重构建议（代码分析）',
    category: 'complex',
    task: '重构以下代码为函数式风格，并解释每步改动的原因：for(let i=0;i<arr.length;i++){if(arr[i]>0){result.push(arr[i]*2)}}; for(let j=0;j<result.length;j++){total+=result[j]}',
  },
  {
    name: 'Code review (EN, with comments)',
    category: 'code',
    task: `Review this code and suggest improvements:\n\n\`\`\`typescript\n// This function processes user data\n// It takes an array of users and returns filtered results\n// Author: John Doe, 2024-01-15\n// Last modified: 2024-03-20\nimport { User } from './types';\nimport { logger } from './utils';\n// Unused import\nimport { deprecated } from './old-module';\n\n// Main processing function\nexport function processUsers(users: User[]): User[] {\n  // Initialize empty result array\n  const result: User[] = [];\n  // Loop through all users\n  for (let i = 0; i < users.length; i++) {\n    // Check if user is active\n    if (users[i].active === true) {\n      // Check if user has email\n      if (users[i].email !== null && users[i].email !== undefined) {\n        // Add to result\n        result.push(users[i]);\n      }\n    }\n  }\n  // Return the result\n  return result;\n}\n\`\`\``,
  },
  {
    name: 'English task (architecture)',
    category: 'complex-en',
    task: 'Design a rate limiter middleware for an Express.js API. It should support sliding window algorithm, per-user limits via JWT, and configurable thresholds.',
  },
  {
    name: '长文本分析（超长输入）',
    category: 'long',
    task: `分析以下代码库的架构问题并给出改进建议：\n\n${generateLongCodeSample()}`,
  },
];

function generateLongCodeSample(): string {
  const modules = [];
  for (let i = 1; i <= 5; i++) {
    modules.push(`// Module ${i}: ${['UserService', 'OrderService', 'PaymentService', 'NotificationService', 'CacheService'][i - 1]}
// Created: 2024-01-${i.toString().padStart(2, '0')}
// TODO: refactor this module
// FIXME: known memory leak in production

import { Database } from '../db';
import { Logger } from '../logger';
import { Config } from '../config';

export class Module${i} {
  private db: Database;
  private logger: Logger;

  constructor(db: Database, logger: Logger) {
    this.db = db;
    this.logger = logger;
  }

  // Main processing method
  async process(input: any): Promise<any> {
    this.logger.info('Processing started');  // Log start
    try {
      const result = await this.db.query('SELECT * FROM table_${i}');  // Query database
      // Transform results
      return result.map((r: any) => ({
        ...r,
        processed: true,  // Mark as processed
        timestamp: Date.now(),  // Add timestamp
      }));
    } catch (error) {
      this.logger.error('Processing failed');  // Log error
      throw error;  // Re-throw
    }
  }
}`);
  }
  return modules.join('\n\n');
}

export async function cmdCompare(config: NTKConfig): Promise<void> {
  console.log(chalk.cyan.bold('\n  📊 Traditional vs Filter-only vs NTK — 三方对比基准测试\n'));
  console.log(chalk.dim(`  Planner: ${config.planner.model}`));
  console.log(chalk.dim(`  Compressor: ${config.compressor.model}`));
  console.log(chalk.dim(`  测试用例: ${testCases.length} 个\n`));

  const llm = new LLMClient(config.compressor);
  const results: CompareResult[] = [];

  for (const tc of testCases) {
    console.log(chalk.yellow(`\n  ── ${tc.name} (${tc.category}) ──\n`));

    // 1. Traditional: raw input → LLM
    const traditional = await runTraditional(llm, tc.task);
    console.log(
      chalk.dim(
        `  Traditional: ${traditional.totalTokens} tok, ${(traditional.timeMs / 1000).toFixed(1)}s, ${traditional.inputChars} chars in`,
      ),
    );

    // 2. Filter-only: pre-filter → LLM
    const filterOnlyResult = await runFilterOnly(llm, tc.task);
    console.log(
      chalk.blue(
        `  Filter-only: ${filterOnlyResult.totalTokens} tok, ${(filterOnlyResult.timeMs / 1000).toFixed(1)}s, ${filterOnlyResult.inputChars} chars in (pre-filter: -${traditional.inputChars - filterOnlyResult.inputChars} chars)`,
      ),
    );

    // 3. NTK: full pipeline
    const ntk = await runNTK(config, tc.task);
    console.log(
      chalk.green(
        `  NTK:         ${ntk.totalTokens} tok, ${(ntk.timeMs / 1000).toFixed(1)}s, depth=${ntk.depth}, preFilter=-${ntk.preFilterCharsRemoved}chars, blocked=${ntk.routerBlocked}`,
      ),
    );

    results.push({
      name: tc.name,
      category: tc.category,
      traditional,
      filterOnly: filterOnlyResult,
      ntk,
    });
  }

  printSummary(results);
}

async function runTraditional(llm: LLMClient, task: string): Promise<RunMetrics> {
  const start = Date.now();
  const { usage } = await llm.chat(
    'You are a helpful assistant. Respond concisely and precisely.',
    task,
    'executor',
    'execute',
  );
  return {
    inputChars: task.length,
    outputChars: 0,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    timeMs: Date.now() - start,
    costWeighted: estimateCost(usage.inputTokens + usage.outputTokens, true),
  };
}

async function runFilterOnly(llm: LLMClient, task: string): Promise<RunMetrics> {
  const start = Date.now();
  const pfResult = preFilter(task);
  const { usage } = await llm.chat(
    'You are a helpful assistant. Respond concisely and precisely.',
    pfResult.filtered,
    'executor',
    'execute',
  );
  return {
    inputChars: pfResult.filteredLength,
    outputChars: 0,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    totalTokens: usage.inputTokens + usage.outputTokens,
    timeMs: Date.now() - start,
    costWeighted: estimateCost(usage.inputTokens + usage.outputTokens, true),
  };
}

async function runNTK(config: NTKConfig, task: string): Promise<NTKRunMetrics> {
  const start = Date.now();
  const pipeline = new Pipeline(config, () => {});
  const result = await pipeline.run(task);

  const tr = result.tokenReport;
  const total = tr.totalInput + tr.totalOutput;
  const plannerTok = tr.byAgent.planner ? tr.byAgent.planner.input + tr.byAgent.planner.output : 0;
  const cheapTok = total - plannerTok;

  const pf = result.preFilterSavings;

  return {
    inputChars: task.length,
    outputChars: result.report.length,
    inputTokens: tr.totalInput,
    outputTokens: tr.totalOutput,
    totalTokens: total,
    timeMs: Date.now() - start,
    costWeighted: estimateCost(plannerTok, true) + estimateCost(cheapTok, false),
    depth: result.depth ?? 'full',
    preFilterCharsRemoved: pf?.totalCharsRemoved ?? 0,
    preFilterReductionPct: pf?.reductionPercent ?? 0,
    routerBlocked: result.routerStats.totalBlocked,
    routerBlockRate: result.routerStats.blockRate,
    strongTokens: plannerTok,
    cheapTokens: cheapTok,
  };
}

function renderBar(pct: number, width = 15): string {
  const clamped = Math.max(0, Math.min(100, pct));
  const filled = Math.round((clamped / 100) * width);
  return chalk.green('█'.repeat(filled)) + chalk.gray('░'.repeat(width - filled));
}

function printSummary(results: CompareResult[]): void {
  console.log(chalk.cyan.bold('\n  ═══════════════════════════════════════════════'));
  console.log(chalk.cyan.bold('  ═══ 三方对比总结 ═══'));
  console.log(chalk.cyan.bold('  ═══════════════════════════════════════════════\n'));

  // Per-test comparison table
  console.log(
    chalk.white.bold('  测试用例                        | Traditional | Filter-only | NTK         | NTK优势'),
  );
  console.log(chalk.dim(`  ${'─'.repeat(95)}`));

  let totalTraditional = 0;
  let totalFilter = 0;
  let totalNTK = 0;
  let totalNTKCost = 0;
  let totalTraditionalCost = 0;

  for (const r of results) {
    const name = r.name.padEnd(32);
    const trad = `${r.traditional.totalTokens}tok`.padEnd(12);
    const filter = `${r.filterOnly.totalTokens}tok`.padEnd(12);
    const ntk = `${r.ntk.totalTokens}tok`.padEnd(12);

    const ntkSaving =
      r.traditional.totalTokens > 0 ? ((1 - r.ntk.costWeighted / r.traditional.costWeighted) * 100).toFixed(0) : '0';

    console.log(`  ${name}| ${trad}| ${filter}| ${ntk}| ${ntkSaving}% cost`);

    totalTraditional += r.traditional.totalTokens;
    totalFilter += r.filterOnly.totalTokens;
    totalNTK += r.ntk.totalTokens;
    totalNTKCost += r.ntk.costWeighted;
    totalTraditionalCost += r.traditional.costWeighted;
  }

  console.log(chalk.dim(`  ${'─'.repeat(95)}`));
  console.log(
    `  ${'总计'.padEnd(31)}| ${`${totalTraditional}tok`.padEnd(12)}| ${`${totalFilter}tok`.padEnd(12)}| ${`${totalNTK}tok`.padEnd(12)}|`,
  );

  // NTK unique advantages section
  console.log(chalk.cyan.bold('\n  ═══ NTK 独有优势 ═══\n'));

  // 1. Pre-filter savings
  const totalPFRemoved = results.reduce((s, r) => s + r.ntk.preFilterCharsRemoved, 0);
  const avgPFPct = results.reduce((s, r) => s + r.ntk.preFilterReductionPct, 0) / results.length;
  console.log(chalk.magenta.bold('  🧹 确定性预过滤（零 token 成本）'));
  console.log(chalk.dim(`     总移除字符: ${totalPFRemoved} chars`));
  console.log(chalk.dim(`     平均降噪率: ${renderBar(avgPFPct)} ${avgPFPct.toFixed(1)}%`));

  // 2. Cost separation (NTK unique)
  const costSavingPct = totalTraditionalCost > 0 ? ((1 - totalNTKCost / totalTraditionalCost) * 100).toFixed(0) : '0';
  console.log(chalk.green.bold('\n  💰 双模型成本分离（NTK 独有）'));
  for (const r of results) {
    if (r.ntk.strongTokens > 0) {
      const sRatio = ((r.ntk.strongTokens / r.ntk.totalTokens) * 100).toFixed(0);
      console.log(
        chalk.dim(`     ${r.name}: strong=${r.ntk.strongTokens}tok (${sRatio}%), cheap=${r.ntk.cheapTokens}tok`),
      );
    }
  }
  console.log(chalk.green(`     加权成本节省: ${renderBar(Number(costSavingPct))} ~${costSavingPct}%`));

  // 3. Router information isolation (NTK unique)
  const totalBlocked = results.reduce((s, r) => s + r.ntk.routerBlocked, 0);
  const avgBlockRate = results.reduce((s, r) => s + r.ntk.routerBlockRate, 0) / results.length;
  console.log(chalk.yellow.bold('\n  🔒 Need-to-Know 路由（NTK 独有）'));
  console.log(chalk.dim(`     总阻断消息: ${totalBlocked} 条`));
  console.log(chalk.dim(`     平均阻断率: ${renderBar(avgBlockRate * 100)} ${(avgBlockRate * 100).toFixed(1)}%`));

  // 4. Adaptive depth (NTK unique)
  console.log(chalk.blue.bold('\n  🎯 自适应管线深度（NTK 独有）'));
  for (const r of results) {
    console.log(chalk.dim(`     ${r.name}: depth=${r.ntk.depth}`));
  }

  // Final comparison matrix
  console.log(chalk.cyan.bold('\n  ═══ 能力矩阵 ═══\n'));
  console.log(chalk.white('  能力                        | Traditional | Filter-only | NTK'));
  console.log(chalk.dim(`  ${'─'.repeat(75)}`));
  const matrix = [
    ['确定性预过滤（零token成本）', '❌', '✅', '✅'],
    ['语义压缩（LLM理解内容）', '❌', '❌', '✅'],
    ['信息路由隔离', '❌', '❌', '✅'],
    ['自适应管线深度', '❌', '❌', '✅'],
    ['双模型成本分离', '❌', '❌', '✅'],
    ['压缩回溯（Tee机制）', '❌', '❌', '✅'],
    ['多Agent协作', '❌', '❌', '✅'],
    ['失败测试提取', '❌', '✅', '✅'],
    ['JSON紧凑化', '❌', '✅', '✅'],
    ['ANSI码清除', '❌', '✅', '✅'],
  ];
  for (const [cap, trad, rtk, ntk] of matrix) {
    console.log(`  ${cap.padEnd(30)}| ${trad.padEnd(12)}| ${rtk.padEnd(12)}| ${ntk}`);
  }

  console.log(chalk.cyan.bold('\n  ═══ 结论 ═══'));
  console.log(chalk.white('\n  I/O 过滤压缩数据（删字符），NTK 压缩认知（控信息流）。'));
  console.log(chalk.white('  NTK 涵盖了所有 I/O 过滤能力，同时拥有语义压缩、路由隔离、'));
  console.log(chalk.white('  自适应深度和双模型成本分离等独有能力。\n'));
}
