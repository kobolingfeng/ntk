/**
 * NTK 自定义 Agent 示例
 *
 * 展示如何单独使用 Compressor、Router 等核心组件。
 * 运行: npx tsx examples/custom-agents.ts
 */
import { Compressor, LLMClient, Router, createMessage } from '../src/index.js';
import { getConfig } from './shared.js';

const config = getConfig();

const llm = new LLMClient(config.compressor);

// ─── 示例 1: 信息压缩器 ───────────────────────────────

console.log('=== 信息压缩器 ===\n');

const compressor = new Compressor(llm);

const longText = `
人工智能（Artificial Intelligence，简称 AI）是计算机科学的一个分支，
它企图了解智能的实质，并生产出一种新的能以人类智能相似的方式做出反应的智能机器。
该领域的研究包括机器人、语言识别、图像识别、自然语言处理和专家系统等。
人工智能从诞生以来，理论和技术日益成熟，应用领域也不断扩大，
可以设想，未来人工智能带来的科技产品，将会是人类智慧的"容器"。
人工智能的核心技术包括机器学习、深度学习、自然语言处理、计算机视觉等。
其中深度学习通过多层神经网络实现对复杂数据的自动特征提取和模式识别，
已经在图像分类、语音识别、机器翻译等多个领域取得了突破性成果。
随着算力提升和数据量增长，大语言模型（LLM）成为了人工智能最前沿的研究方向。
`;

const compressed = await compressor.compress(longText, 'standard');
console.log('原文长度:', longText.length, '字符');
console.log('压缩后长度:', compressed.compressed.length, '字符');
console.log('压缩结果:', compressed.compressed);
console.log('压缩率:', compressed.ratio.toFixed(2));

// ─── 示例 2: 信息路由器 ───────────────────────────────

console.log('\n=== 信息路由器 ===\n');

const router = new Router();

// 创建消息
const msg1 = createMessage('scout', 'planner', 'report-findings', '发现了 3 个相关 API 端点');
const msg2 = createMessage('executor', 'planner', 'task-done', '任务已完成');
const msg3 = createMessage('executor', 'scout', 'need-info', '需要更多信息');

// 路由消息
for (const msg of [msg1, msg2, msg3]) {
  const decision = router.route(msg, 'gather');
  console.log(`${msg.from} → ${msg.to}: ${decision.allowed ? '✅ 允许' : '❌ 阻止'} (${decision.reason})${decision.needsCompression ? ' [需压缩]' : ''}`);
}

// 查看路由统计
const stats = router.getStats();
console.log('\n路由统计:');
console.log(`  总路由: ${stats.totalRouted}`);
console.log(`  总阻止: ${stats.totalBlocked}`);
console.log(`  阻止率: ${(stats.blockRate * 100).toFixed(1)}%`);
console.log(`  路由明细:`, stats.byRoute);
