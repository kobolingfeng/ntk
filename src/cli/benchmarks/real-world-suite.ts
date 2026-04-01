/**
 * Real-world scenario test suite — tests NTK with production-like tasks.
 *
 * Covers: multi-file reasoning, existing codebase comprehension,
 * ambiguous requirements, noisy input, and complex multi-part tasks.
 */

import chalk from 'chalk';
import type { NTKConfig } from '../../core/protocol.js';
import type { PipelineDepth, PipelineResult } from '../../pipeline/types.js';
import { Pipeline } from '../../pipeline/pipeline.js';
import { handleEvent, printTokenReport, printTrace } from '../output.js';

interface RealWorldTest {
  name: string;
  category: 'multi-file' | 'comprehension' | 'ambiguous' | 'noisy-context' | 'multi-part' | 'refactor-existing';
  task: string;
  expectedMinDepth: PipelineDepth;
  validate: (result: PipelineResult) => { pass: boolean; reason: string }[];
}

const NOISY_TEST_OUTPUT = `
\x1b[32m✓\x1b[0m auth.test.ts (15 tests)
\x1b[32m  ✓\x1b[0m should create user
\x1b[32m  ✓\x1b[0m should validate email
\x1b[32m  ✓\x1b[0m should hash password
\x1b[32m  ✓\x1b[0m should generate token
\x1b[32m  ✓\x1b[0m should refresh token
\x1b[32m  ✓\x1b[0m should invalidate token
\x1b[32m  ✓\x1b[0m should check permissions
\x1b[32m  ✓\x1b[0m should rate limit
\x1b[32m  ✓\x1b[0m should log attempts
\x1b[32m  ✓\x1b[0m should block after 5 failures
\x1b[32m  ✓\x1b[0m should reset counter
\x1b[32m  ✓\x1b[0m should handle concurrent
\x1b[32m  ✓\x1b[0m should timeout session
\x1b[32m  ✓\x1b[0m should cleanup expired
\x1b[32m  ✓\x1b[0m should audit trail
\x1b[31m✗\x1b[0m payment.test.ts (3 tests)
\x1b[32m  ✓\x1b[0m should process card
\x1b[31m  ✗ should handle refund — Error: refundAmount exceeds original charge\x1b[0m
\x1b[31m  ✗ should retry on timeout — AssertionError: expected 3 retries but got 0\x1b[0m

████████████████████░░░░ 90% (18/20)

Test Suites: 1 passed, 1 failed, 2 total
Tests:       15 passed, 2 failed, 17 total
`;

const EXISTING_CODE_CONTEXT = `
// Current implementation (users.ts):
export class UserService {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  async getUser(id: string): Promise<User | null> {
    return this.db.query('SELECT * FROM users WHERE id = ?', [id]);
  }

  async createUser(data: CreateUserDTO): Promise<User> {
    const exists = await this.db.query('SELECT id FROM users WHERE email = ?', [data.email]);
    if (exists) throw new Error('Email already exists');
    return this.db.query('INSERT INTO users (name, email, password) VALUES (?, ?, ?)',
      [data.name, data.email, data.password]);
  }

  async deleteUser(id: string): Promise<void> {
    await this.db.query('DELETE FROM users WHERE id = ?', [id]);
  }
}

// Current implementation (orders.ts):
export class OrderService {
  private db: Database;
  private userService: UserService;

  constructor(db: Database, userService: UserService) {
    this.db = db;
    this.userService = userService;
  }

  async createOrder(userId: string, items: OrderItem[]): Promise<Order> {
    const user = await this.userService.getUser(userId);
    if (!user) throw new Error('User not found');
    const total = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
    return this.db.query('INSERT INTO orders (user_id, items, total) VALUES (?, ?, ?)',
      [userId, JSON.stringify(items), total]);
  }
}
`;

function containsAny(text: string, keywords: string[]): boolean {
  const lower = text.toLowerCase();
  return keywords.some((kw) => lower.includes(kw.toLowerCase()));
}

const TESTS: RealWorldTest[] = [
  {
    name: 'Multi-file: Add soft delete across services',
    category: 'multi-file',
    task: `Given this codebase:
${EXISTING_CODE_CONTEXT}
Add soft delete support: instead of actually deleting users, set a 'deleted_at' timestamp. Update both UserService and OrderService so that:
1. deleteUser sets deleted_at instead of DELETE
2. getUser excludes soft-deleted users
3. createOrder rejects orders from soft-deleted users
4. Add a restoreUser method
Show the updated code for BOTH files.`,
    expectedMinDepth: 'light',
    validate: (r) => [
      { pass: r.success, reason: 'Pipeline succeeded' },
      { pass: r.report.length > 300, reason: 'Substantial output' },
      { pass: containsAny(r.report, ['deleted_at', 'deletedAt', 'soft']), reason: 'Contains soft delete logic' },
      { pass: containsAny(r.report, ['restore', 'restoreUser']), reason: 'Contains restore method' },
      { pass: containsAny(r.report, ['UserService', 'OrderService']), reason: 'Addresses both services' },
    ],
  },
  {
    name: 'Comprehension: Fix bugs from test output',
    category: 'comprehension',
    task: `Here are failing test results from our CI:
${NOISY_TEST_OUTPUT}
Analyze the 2 failing tests and provide:
1. Root cause analysis for each failure
2. Code fix suggestions
3. Additional test cases to prevent regression`,
    expectedMinDepth: 'direct',
    validate: (r) => [
      { pass: r.success, reason: 'Pipeline succeeded' },
      { pass: containsAny(r.report, ['refund', 'refundAmount']), reason: 'Addresses refund bug' },
      { pass: containsAny(r.report, ['retry', 'timeout']), reason: 'Addresses retry bug' },
      { pass: r.report.length > 200, reason: 'Substantial analysis' },
    ],
  },
  {
    name: 'Ambiguous: Vague performance request',
    category: 'ambiguous',
    task: '我们的后台管理系统最近变慢了，用户抱怨加载很久。你能帮忙看看吗？技术栈是 React + Node.js + PostgreSQL。',
    expectedMinDepth: 'direct',
    validate: (r) => [
      { pass: r.success, reason: 'Pipeline succeeded' },
      { pass: r.report.length > 200, reason: 'Provides actionable guidance despite vagueness' },
      { pass: containsAny(r.report, ['数据库', 'database', '查询', 'query', 'index', '索引', '缓存', 'cache']),
        reason: 'Suggests database-level optimizations' },
      { pass: containsAny(r.report, ['React', 'frontend', '前端', '渲染', 'render']),
        reason: 'Covers frontend side' },
    ],
  },
  {
    name: 'Noisy context: Extract signal from verbose logs',
    category: 'noisy-context',
    task: `Here is a production error log. Identify the root cause and suggest a fix:

2026-03-31T10:00:01.234Z INFO  [health-check] All services healthy
2026-03-31T10:00:01.235Z INFO  [health-check] Memory: 1.2GB / 4GB (30%)
2026-03-31T10:00:01.235Z INFO  [health-check] CPU: 15%
2026-03-31T10:00:02.100Z INFO  [request] GET /api/users 200 12ms
2026-03-31T10:00:02.300Z INFO  [request] GET /api/users 200 14ms
2026-03-31T10:00:02.500Z INFO  [request] POST /api/orders 201 45ms
2026-03-31T10:00:03.100Z INFO  [request] GET /api/products 200 8ms
2026-03-31T10:00:03.800Z WARN  [pool] Connection pool at 90% capacity (45/50)
2026-03-31T10:00:04.200Z INFO  [request] GET /api/users 200 120ms
2026-03-31T10:00:04.500Z WARN  [pool] Connection pool at 96% capacity (48/50)
2026-03-31T10:00:05.000Z ERROR [pool] Connection pool exhausted, queuing requests
2026-03-31T10:00:05.100Z ERROR [request] GET /api/users 503 5023ms - Error: Connection acquire timeout
2026-03-31T10:00:05.200Z ERROR [request] POST /api/orders 503 5018ms - Error: Connection acquire timeout
2026-03-31T10:00:05.300Z ERROR [request] GET /api/products 503 5012ms - Error: Connection acquire timeout
2026-03-31T10:00:06.000Z INFO  [pool] 3 connections returned to pool
2026-03-31T10:00:06.100Z INFO  [request] GET /api/users 200 89ms
2026-03-31T10:00:30.000Z INFO  [health-check] All services healthy`,
    expectedMinDepth: 'direct',
    validate: (r) => [
      { pass: r.success, reason: 'Pipeline succeeded' },
      { pass: containsAny(r.report, ['connection pool', '连接池', 'pool']), reason: 'Identifies connection pool issue' },
      { pass: containsAny(r.report, ['50', 'max', 'limit', '上限']), reason: 'References pool size limit' },
    ],
  },
  {
    name: 'Multi-part: Design + implement + test',
    category: 'multi-part',
    task: `设计并实现一个 TypeScript 的 RateLimiter 类，要求：
1. 支持滑动窗口算法（不是固定窗口）
2. 支持不同的限流策略（按 IP、按用户、按 API key）
3. 支持分布式场景（提供 Redis 适配器接口）
4. 包含完整的单元测试
5. 处理边界情况：并发请求、时间回拨、key 过期
请给出完整的实现代码和测试代码。`,
    expectedMinDepth: 'light',
    validate: (r) => [
      { pass: r.success, reason: 'Pipeline succeeded' },
      { pass: r.report.length > 500, reason: 'Substantial implementation' },
      { pass: containsAny(r.report, ['class RateLimiter', 'RateLimiter']), reason: 'Contains RateLimiter class' },
      { pass: containsAny(r.report, ['sliding', '滑动']), reason: 'Mentions sliding window' },
      { pass: containsAny(r.report, ['Redis', 'redis', 'adapter', '适配']), reason: 'Redis adapter interface' },
      { pass: containsAny(r.report, ['test', 'describe', 'it(', 'expect', '测试']), reason: 'Contains tests' },
    ],
  },
  {
    name: 'Refactor: Existing code with constraints',
    category: 'refactor-existing',
    task: `Refactor this Express.js route handler. It works but has issues with error handling, validation, and separation of concerns. Keep backward compatibility with existing API consumers.

\`\`\`javascript
app.post('/api/users', async (req, res) => {
  try {
    if (!req.body.email) { res.status(400).send('need email'); return; }
    if (!req.body.name) { res.status(400).send('need name'); return; }
    if (req.body.email.indexOf('@') === -1) { res.status(400).send('bad email'); return; }
    let user = await db.query('SELECT * FROM users WHERE email = $1', [req.body.email]);
    if (user.rows.length > 0) { res.status(409).send('exists'); return; }
    let hash = await bcrypt.hash(req.body.password || '123456', 10);
    let result = await db.query('INSERT INTO users (name, email, password_hash, created_at) VALUES ($1, $2, $3, NOW()) RETURNING *', [req.body.name, req.body.email, hash]);
    let token = jwt.sign({ id: result.rows[0].id }, 'secret-key', { expiresIn: '7d' });
    res.json({ user: result.rows[0], token: token });
  } catch(e) {
    console.log(e);
    res.status(500).send('error');
  }
});
\`\`\``,
    expectedMinDepth: 'direct',
    validate: (r) => [
      { pass: r.success, reason: 'Pipeline succeeded' },
      { pass: r.report.length > 300, reason: 'Substantial refactoring' },
      { pass: containsAny(r.report, ['validation', 'validate', '验证']), reason: 'Addresses validation' },
      { pass: containsAny(r.report, ['secret', 'env', 'config', '硬编码']), reason: 'Flags hardcoded secret' },
      { pass: containsAny(r.report, ['123456', 'default', '默认密码']), reason: 'Flags default password issue' },
    ],
  },
];

export async function cmdRealWorldTest(config: NTKConfig, verbose = false): Promise<void> {
  console.log(chalk.cyan.bold('\n  🌍 Running Real-World Scenario Tests\n'));
  console.log(chalk.dim(`  Planner: ${config.planner.model}`));
  console.log(chalk.dim(`  Compressor: ${config.compressor.model}\n`));

  let passed = 0;
  let failed = 0;
  const results: Array<{
    name: string;
    category: string;
    passed: boolean;
    tokens: number;
    duration: number;
    depth: string;
    checks: { pass: boolean; reason: string }[];
  }> = [];

  for (const test of TESTS) {
    console.log(chalk.yellow(`  ── ${test.category}: ${test.name} ──`));
    console.log(chalk.dim(`  Task: "${test.task.slice(0, 100)}${test.task.length > 100 ? '...' : ''}"\n`));

    const startTime = Date.now();

    try {
      const pipeline = new Pipeline(config, handleEvent);
      const result = await pipeline.run(test.task);
      const duration = (Date.now() - startTime) / 1000;
      const totalTokens = result.tokenReport.totalInput + result.tokenReport.totalOutput;

      console.log(chalk.cyan('\n  Report (first 500 chars):'));
      const preview = result.report.slice(0, 500);
      console.log(`  ${preview.split('\n').join('\n  ')}${result.report.length > 500 ? '\n  ...' : ''}`);

      const checks = test.validate(result);
      console.log('');
      for (const check of checks) {
        const icon = check.pass ? chalk.green('✓') : chalk.red('✗');
        console.log(`  ${icon} ${check.reason}`);
      }

      const allPassed = checks.every((c) => c.pass);
      if (allPassed) {
        console.log(chalk.green.bold(`\n  ✅ PASSED (${duration.toFixed(1)}s, ${totalTokens} tok, depth=${result.depth})\n`));
        passed++;
      } else {
        console.log(chalk.red.bold(`\n  ❌ FAILED (${duration.toFixed(1)}s)\n`));
        failed++;
      }

      if (verbose) {
        printTokenReport(result);
        if (result.trace) printTrace(result.trace);
      }

      results.push({
        name: test.name,
        category: test.category,
        passed: allPassed,
        tokens: totalTokens,
        duration,
        depth: result.depth ?? 'full',
        checks,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.log(chalk.red(`\n  ❌ ERROR: ${message}\n`));
      failed++;
      results.push({
        name: test.name,
        category: test.category,
        passed: false,
        tokens: 0,
        duration: (Date.now() - startTime) / 1000,
        depth: 'error',
        checks: [{ pass: false, reason: `Error: ${message.slice(0, 100)}` }],
      });
    }

    console.log(chalk.dim(`  ${'─'.repeat(50)}`));
  }

  // Summary
  const totalTokens = results.reduce((s, r) => s + r.tokens, 0);
  const totalDuration = results.reduce((s, r) => s + r.duration, 0);

  console.log(chalk.cyan.bold('\n  ═══ Real-World Test Summary ═══'));
  console.log(chalk.green(`  Passed: ${passed}/${TESTS.length}`));
  if (failed > 0) console.log(chalk.red(`  Failed: ${failed}/${TESTS.length}`));
  console.log(chalk.dim(`  Total tokens: ${totalTokens}`));
  console.log(chalk.dim(`  Total time: ${totalDuration.toFixed(1)}s`));
  console.log(chalk.dim(`  Avg tokens/task: ${Math.round(totalTokens / TESTS.length)}`));
  console.log(chalk.dim(`  Avg time/task: ${(totalDuration / TESTS.length).toFixed(1)}s`));
  console.log('');

  // Per-category breakdown
  const categories = [...new Set(results.map((r) => r.category))];
  for (const cat of categories) {
    const catResults = results.filter((r) => r.category === cat);
    const catPassed = catResults.filter((r) => r.passed).length;
    const status = catPassed === catResults.length ? chalk.green('✓') : chalk.red('✗');
    console.log(`  ${status} ${cat}: ${catPassed}/${catResults.length}`);
  }
  console.log('');
}
