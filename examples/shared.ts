/**
 * 示例公共配置加载器
 *
 * 从 .env 加载 API 端点并构建 NTK 配置。
 */
import dotenv from 'dotenv';
import { LLMClient } from '../src/index.js';
import type { NTKConfig } from '../src/index.js';

dotenv.config();

export function loadEndpoints(): void {
  const endpoints = [];
  for (let i = 1; i <= 10; i++) {
    const key = process.env[`API_ENDPOINT_${i}_KEY`];
    const url = process.env[`API_ENDPOINT_${i}_URL`];
    const name = process.env[`API_ENDPOINT_${i}_NAME`] || `endpoint-${i}`;
    if (key && url) endpoints.push({ name, apiKey: key, baseUrl: url });
  }
  if (endpoints.length === 0) {
    console.error('❌ 未找到 API 配置，请检查 .env 文件');
    console.error('   参考 .env.example 进行配置');
    process.exit(1);
  }
  LLMClient.setEndpoints(endpoints);
  console.log(`✅ 已加载 ${endpoints.length} 个端点: ${endpoints.map((e) => e.name).join(', ')}`);
}

export function getConfig(): NTKConfig {
  loadEndpoints();
  const ep = LLMClient.getActiveEndpoint()!;
  return {
    planner: {
      apiKey: ep.apiKey,
      baseUrl: ep.baseUrl,
      model: process.env.PLANNER_MODEL || 'gpt-4o',
      maxTokens: 4096,
      temperature: 0.3,
    },
    compressor: {
      apiKey: ep.apiKey,
      baseUrl: ep.baseUrl,
      model: process.env.COMPRESSOR_MODEL || 'gpt-4o-mini',
      maxTokens: 2048,
      temperature: 0.2,
    },
    maxLocalRetries: 2,
    debug: false,
    parallelExecution: true,
  };
}
