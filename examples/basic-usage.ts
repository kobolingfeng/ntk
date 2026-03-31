/**
 * NTK 基础用法示例
 *
 * 展示如何创建 Pipeline 并运行一个任务。
 * 运行: npx tsx examples/basic-usage.ts
 */
import { Pipeline } from '../src/index.js';
import { getConfig } from './shared.js';

const config = getConfig();

// ─── 创建 Pipeline 并订阅事件 ──────────────────────────

const pipeline = new Pipeline(config, (event) => {
  console.log(`[${event.phase}] ${event.type}: ${event.detail ?? ''}`);
});

// ─── 运行任务 ──────────────────────────────────────

const task = '用 3 句话解释什么是信息密度路由';

console.log(`\n⚡ 任务: "${task}"\n`);

const result = await pipeline.run(task);

console.log('\n─── 结果 ───');
console.log(result.report);
console.log(`\n📊 深度: ${result.depth}`);
console.log(`📊 Token — 输入: ${result.tokenReport.totalInput}, 输出: ${result.tokenReport.totalOutput}`);
console.log(`📊 预估节省: ${result.tokenReport.estimatedSavingsVsTraditional}%`);
