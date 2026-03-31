/**
 * Test suite — 9 categories of tasks for comprehensive testing.
 */

import chalk from 'chalk';
import type { NTKConfig } from '../../core/protocol.js';
import { Pipeline } from '../../pipeline/pipeline.js';
import { handleEvent, printTokenReport } from '../output.js';

export async function cmdTest(config: NTKConfig): Promise<void> {
  console.log(chalk.cyan.bold('\n  🧪 Running NTK Test Suite\n'));
  console.log(chalk.dim(`  Planner: ${config.planner.model}`));
  console.log(chalk.dim(`  Compressor: ${config.compressor.model}`));
  console.log(chalk.dim(`  Base URL: ${config.planner.baseUrl}\n`));

  const tests = [
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
      console.log(`  ${result.report.split('\n').join('\n  ')}`);

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

    console.log(chalk.dim(`  ${'─'.repeat(50)}`));
  }

  console.log(chalk.cyan.bold('\n  ═══ Test Summary ═══'));
  console.log(chalk.green(`  Passed: ${passed}/${tests.length}`));
  if (failed > 0) console.log(chalk.red(`  Failed: ${failed}/${tests.length}`));
  console.log('');
}
