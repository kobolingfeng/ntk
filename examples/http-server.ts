/**
 * NTK HTTP API 服务示例
 *
 * 展示如何启动 NTK 的 REST API 服务。
 * 运行: npx tsx examples/http-server.ts
 * 测试: curl -X POST http://localhost:3210/run -H "Content-Type: application/json" -d '{"task":"你好"}'
 */
import { NTKServer } from '../src/index.js';
import { getConfig } from './shared.js';

const config = getConfig();
const PORT = 3210;

const server = new NTKServer(config);
await server.start(PORT);

console.log(`🚀 NTK API 服务已启动: http://localhost:${PORT}`);
console.log('\n使用方式:');
console.log(`  curl -X POST http://localhost:${PORT}/run \\`);
console.log(`    -H "Content-Type: application/json" \\`);
console.log(`    -d '{"task":"用 3 句话解释信息密度路由"}'`);
console.log('\n按 Ctrl+C 停止服务');
