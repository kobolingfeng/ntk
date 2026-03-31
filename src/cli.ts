/**
 * NTK CLI — The unified entry point.
 *
 * Modes:
 *   npx tsx src/cli.ts run "your task"           — Single task execution
 *   npx tsx src/cli.ts interactive               — Interactive REPL
 *   npx tsx src/cli.ts serve [--port 3210]       — Start API server
 *   npx tsx src/cli.ts test                      — Run built-in test suite
 */

import { createInterface } from 'node:readline';
import chalk from 'chalk';
import dotenv from 'dotenv';
import { NTKServer } from './api/server.js';
import { handleEvent, printTokenReport } from './cli/output.js';
import { LLMClient } from './core/llm.js';
import type { NTKConfig } from './index.js';
import { Pipeline } from './pipeline/pipeline.js';

dotenv.config();

// ─── Configuration ────────────────────────────────────

function loadEndpoints(): void {
  const endpoints = [];

  for (let i = 1; i <= 10; i++) {
    const key = process.env[`API_ENDPOINT_${i}_KEY`];
    const url = process.env[`API_ENDPOINT_${i}_URL`];
    const name = process.env[`API_ENDPOINT_${i}_NAME`] || `endpoint-${i}`;
    if (key && url) {
      endpoints.push({ name, apiKey: key, baseUrl: url });
    }
  }

  if (endpoints.length === 0) {
    const key = process.env.UNIFIED_API_KEY || '';
    const url = process.env.UNIFIED_BASE_URL || 'https://api.openai.com/v1';
    if (key) endpoints.push({ name: 'default', apiKey: key, baseUrl: url });
  }

  if (endpoints.length === 0) {
    console.error(chalk.red('❌ No API endpoints found. Set API_ENDPOINT_1_KEY and API_ENDPOINT_1_URL in .env'));
    process.exit(1);
  }

  LLMClient.setEndpoints(endpoints);
  console.log(chalk.dim(`  Loaded ${endpoints.length} endpoint(s): ${endpoints.map((e) => e.name).join(', ')}`));
}

function loadConfig(): NTKConfig {
  const ep = LLMClient.getActiveEndpoint()!;

  const plannerModel = process.env.PLANNER_MODEL || process.env.MODEL || 'gpt-4o';
  const compressorModel = process.env.COMPRESSOR_MODEL || process.env.MODEL || 'gpt-4o';

  return {
    planner: { apiKey: ep.apiKey, baseUrl: ep.baseUrl, model: plannerModel, maxTokens: 4096, temperature: 0.3 },
    compressor: { apiKey: ep.apiKey, baseUrl: ep.baseUrl, model: compressorModel, maxTokens: 2048, temperature: 0.2 },
    maxLocalRetries: 2,
    debug: process.env.DEBUG === 'true',
    parallelExecution: true,
    tokenBudget: {
      planner: 1024,
      scout: 512,
      summarizer: 512,
      executor: 4096,
      verifier: 256,
    },
  };
}

// ─── Commands ─────────────────────────────────────────

async function cmdRun(
  task: string,
  config: NTKConfig,
  opts?: { forceDepth?: string; skipScout?: boolean },
): Promise<void> {
  console.log(chalk.blue.bold(`\n  ⚡ Running task: "${task}"\n`));
  if (opts?.forceDepth) console.log(chalk.dim(`  Force depth: ${opts.forceDepth}`));
  if (opts?.skipScout) console.log(chalk.dim(`  Skip scout: true`));

  const startTime = Date.now();
  const pipeline = new Pipeline(config, handleEvent, opts as any);
  const result = await pipeline.run(task);
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  console.log(chalk.cyan.bold('\n  === Final Report ==='));
  console.log(`  ${result.report.split('\n').join('\n  ')}`);
  console.log(chalk.dim(`\n  ⏱️  Duration: ${duration}s | Depth: ${result.depth ?? 'full'}`));

  printTokenReport(result);
}

async function cmdInteractive(config: NTKConfig): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  const ask = (): void => {
    rl.question(chalk.cyan('\n  📝 Task > '), async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === 'exit' || trimmed === 'quit') {
        console.log(chalk.dim('  Bye!\n'));
        rl.close();
        return;
      }

      if (trimmed === 'help') {
        console.log(chalk.dim('  Type a task to run, or "exit" to quit.'));
        ask();
        return;
      }

      await cmdRun(trimmed, config).catch((err) => {
        console.log(chalk.red(`  Error: ${err instanceof Error ? err.message : err}`));
      });
      ask();
    });
  };

  ask();
}

async function cmdServe(port: number, config: NTKConfig): Promise<void> {
  const server = new NTKServer(config);
  await server.start(port);
}

// ─── Main ─────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || 'interactive';

  console.log(chalk.cyan.bold('\n  🔒 NTK — NeedToKnow Agent Framework'));
  console.log(chalk.dim('     "Know less. Do more."\n'));

  // Early validation for 'run' command
  if (command === 'run') {
    const task = args
      .slice(1)
      .filter((a) => !a.startsWith('--'))
      .join(' ');
    if (!task) {
      console.log(
        chalk.yellow(
          '  Usage: npx tsx src/cli.ts run "your task here" [--force-depth direct|light|standard|full] [--skip-scout]',
        ),
      );
      return;
    }
  }

  // Load and probe endpoints
  loadEndpoints();
  const plannerModel = process.env.PLANNER_MODEL || process.env.MODEL || 'gpt-4o';
  const compressorModel = process.env.COMPRESSOR_MODEL || process.env.MODEL || 'gpt-4o';
  console.log(chalk.dim(`  Planner model: ${plannerModel}`));
  console.log(chalk.dim(`  Compressor model: ${compressorModel}`));
  console.log(chalk.dim('  Probing endpoints...'));

  const working = await LLMClient.probeEndpoints(plannerModel);
  if (!working) {
    console.error(chalk.red('\n  ❌ All API endpoints are down. Check .env and try again.'));
    process.exit(1);
  }

  if (compressorModel !== plannerModel) {
    console.log(chalk.dim(`  Verifying compressor model (${compressorModel})...`));
    const compressorWorking = await LLMClient.probeEndpoints(compressorModel);
    if (!compressorWorking) {
      console.log(chalk.yellow(`  ⚠️  Compressor model probe failed, falling back to planner endpoint`));
    }
  }

  console.log(chalk.green(`  Using: ${working}\n`));
  const config = loadConfig();

  switch (command) {
    case 'run': {
      const fdIdx = args.indexOf('--force-depth');
      const validDepths = ['direct', 'light', 'standard', 'full'];
      const rawDepth = fdIdx >= 0 ? args[fdIdx + 1] : undefined;
      const forceDepth = rawDepth && validDepths.includes(rawDepth) ? rawDepth : undefined;
      if (fdIdx >= 0 && !forceDepth) {
        console.log(chalk.yellow(`  ⚠️ Invalid --force-depth value "${rawDepth}". Valid: ${validDepths.join(', ')}`));
        return;
      }
      const skipScout = args.includes('--skip-scout');
      const skipIndices = new Set<number>();
      if (fdIdx >= 0) {
        skipIndices.add(fdIdx);
        skipIndices.add(fdIdx + 1);
      }
      const ssIdx = args.indexOf('--skip-scout');
      if (ssIdx >= 0) skipIndices.add(ssIdx);
      const task = args
        .slice(1)
        .filter((a, i) => !a.startsWith('--') && !skipIndices.has(i + 1))
        .join(' ');
      if (!task) {
        console.log(
          chalk.yellow(
            '  Usage: npx tsx src/cli.ts run "your task here" [--force-depth direct|light|standard|full] [--skip-scout]',
          ),
        );
        return;
      }
      await cmdRun(task, config, { forceDepth, skipScout: skipScout || undefined });
      break;
    }

    case 'interactive':
    case '-i':
      await cmdInteractive(config);
      break;

    case 'serve':
    case 'api': {
      const portIdx = args.indexOf('--port');
      const port = portIdx >= 0 ? parseInt(args[portIdx + 1], 10) || 3210 : 3210;
      await cmdServe(port, config);
      break;
    }

    case 'test': {
      const { cmdTest } = await import('./cli/benchmarks/index.js');
      await cmdTest(config);
      break;
    }

    case 'baseline': {
      const { cmdBaseline } = await import('./cli/benchmarks/index.js');
      await cmdBaseline(config);
      break;
    }

    case 'ablation': {
      const { cmdAblation } = await import('./cli/benchmarks/index.js');
      await cmdAblation(config);
      break;
    }

    case 'optimize': {
      const { cmdOptimize } = await import('./cli/benchmarks/index.js');
      await cmdOptimize(config);
      break;
    }

    case 'mcp': {
      const { startMcpServer } = await import('./mcp/server.js');
      await startMcpServer();
      break;
    }

    default: {
      const task = args.filter((a) => !a.startsWith('--')).join(' ');
      if (task) {
        await cmdRun(task, config);
      } else {
        console.log(chalk.yellow('  Commands:'));
        console.log(chalk.dim('    run <task>        — Run a single task'));
        console.log(chalk.dim('    interactive       — Interactive REPL'));
        console.log(chalk.dim('    serve [--port N]  — Start API server'));
        console.log(chalk.dim('    mcp               — Start MCP server (stdio transport)'));
        console.log(chalk.dim('    test              — Run test suite (9 tasks)'));
        console.log(chalk.dim('    baseline          — Baseline comparison (NTK vs direct LLM)'));
        console.log(chalk.dim('    ablation          — Ablation study (component contribution)'));
        console.log(chalk.dim('    optimize          — Optimization matrix (speed/cost/token/quality)'));
      }
    }
  }
}

main().catch((err) => {
  console.error(chalk.red(`  Fatal: ${err.message}`));
  process.exit(1);
});
