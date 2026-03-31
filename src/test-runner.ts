/**
 * Clean test runner with multi-endpoint failover.
 * Writes results to test-results.md for analysis.
 */

import { writeFileSync } from 'node:fs';
import dotenv from 'dotenv';
import { buildConfig, discoverEndpoints } from './core/config.js';
import { EndpointManager } from './core/llm.js';
import type { NTKConfig } from './core/protocol.js';
import type { PipelineEvent, PipelineResult } from './pipeline/pipeline.js';
import { Pipeline } from './pipeline/pipeline.js';

dotenv.config();

const endpointManager = new EndpointManager();

function setupEndpoints(): void {
  const endpoints = discoverEndpoints();
  endpointManager.setEndpoints(endpoints);
}

function loadConfig(): NTKConfig {
  const model = process.env.MODEL || 'gpt-4o';
  return buildConfig(endpointManager, { plannerModel: model, compressorModel: model });
}

async function runTest(
  name: string,
  task: string,
  config: NTKConfig,
): Promise<{
  name: string;
  task: string;
  events: PipelineEvent[];
  result: PipelineResult;
  durationMs: number;
}> {
  const events: PipelineEvent[] = [];
  const pipeline = new Pipeline(config, (e) => events.push(e));

  const start = Date.now();
  const result = await pipeline.run(task);
  const durationMs = Date.now() - start;

  return { name, task, events, result, durationMs };
}

async function main() {
  setupEndpoints();
  const model = process.env.MODEL || 'gpt-4o';

  console.log('Probing endpoints...');
  const working = await endpointManager.probeEndpoints(model);
  if (!working) {
    console.error('All endpoints down!');
    process.exit(1);
  }
  console.log(`Using: ${working}\n`);

  const config = loadConfig();
  console.log(`Model: ${config.planner.model}`);
  console.log(`Parallel: ${config.parallelExecution}`);
  console.log(
    `Token budgets: planner=${config.tokenBudget?.planner}, executor=${config.tokenBudget?.executor}, verifier=${config.tokenBudget?.verifier}\n`,
  );

  const tests = [
    { name: 'Simple Code', task: '用Python写一个计算斐波那契数列第n项的函数' },
    { name: 'Comparison', task: '比较 React 和 Vue 的核心区别，给出选择建议' },
    { name: 'Multi-Task (parallel)', task: '设计一个简单的 TODO 应用的 REST API，包括路由和数据模型' },
  ];

  const allResults: string[] = [];
  allResults.push('# NTK Test Results (Optimized)');
  allResults.push(`Model: ${config.planner.model}`);
  allResults.push(`Endpoint: ${working}`);
  allResults.push(`Parallel: ${config.parallelExecution}`);
  allResults.push(
    `Token budgets: planner=${config.tokenBudget?.planner}, executor=${config.tokenBudget?.executor}, verifier=${config.tokenBudget?.verifier}`,
  );
  allResults.push(`Time: ${new Date().toISOString()}\n`);

  for (const test of tests) {
    console.log(`Running: ${test.name}...`);

    try {
      const { name, result, events, durationMs } = await runTest(test.name, test.task, config);

      allResults.push(`\n## Test: ${name}`);
      allResults.push(`Task: "${test.task}"`);
      allResults.push(`Duration: ${(durationMs / 1000).toFixed(1)}s`);
      allResults.push(`Success: ${result.success}\n`);

      allResults.push('### Events');
      for (const e of events) {
        allResults.push(`  [${e.phase}] ${e.type}: ${e.detail}`);
      }

      allResults.push('\n### Report');
      allResults.push(result.report);

      allResults.push('\n### Token Usage');
      const tr = result.tokenReport;
      allResults.push(`Total: ${tr.totalInput + tr.totalOutput} (input: ${tr.totalInput}, output: ${tr.totalOutput})`);

      if (Object.keys(tr.byAgent).length > 0) {
        allResults.push('\nBy Agent:');
        for (const [agent, usage] of Object.entries(tr.byAgent)) {
          allResults.push(`  ${agent}: ${usage.input + usage.output} tokens`);
        }
      }

      if (Object.keys(tr.byPhase).length > 0) {
        allResults.push('\nBy Phase:');
        for (const [phase, usage] of Object.entries(tr.byPhase)) {
          allResults.push(`  ${phase}: ${usage.input + usage.output} tokens`);
        }
      }

      const rs = result.routerStats;
      allResults.push(
        `\nRouter: ${rs.totalRouted} routed, ${rs.totalBlocked} blocked (${(rs.blockRate * 100).toFixed(1)}% block rate)`,
      );

      allResults.push(`\n---`);
      console.log(`  Done: ${name} (${(durationMs / 1000).toFixed(1)}s, ${tr.totalInput + tr.totalOutput} tokens)\n`);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      allResults.push(`\n## Test: ${test.name} - FAILED`);
      allResults.push(`Error: ${msg}\n---`);
      console.log(`  FAILED: ${msg}\n`);
    }
  }

  writeFileSync('test-results.md', allResults.join('\n'), 'utf-8');
  console.log('\nResults written to test-results.md');
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
