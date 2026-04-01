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
import { DiffContext } from './cli/diff-context.js';
import { cmdGain, recordGain } from './cli/gain.js';
import { handleEvent, printTokenReport, printTrace } from './cli/output.js';
import { buildConfig, discoverEndpoints } from './core/config.js';
import { defaultEndpointManager, EndpointManager } from './core/llm.js';
import type { NTKConfig } from './index.js';
import { Pipeline } from './pipeline/pipeline.js';

const endpointManager = new EndpointManager();

dotenv.config();

// ─── Configuration ────────────────────────────────────

function loadEndpoints(): void {
  const endpoints = discoverEndpoints();

  if (endpoints.length === 0) {
    console.error(chalk.red('❌ No API endpoints found. Set API_ENDPOINT_1_KEY and API_ENDPOINT_1_URL in .env'));
    process.exit(1);
  }

  endpointManager.setEndpoints(endpoints);
  // Also set up defaultEndpointManager so benchmark commands using new LLMClient(config) work
  defaultEndpointManager.setEndpoints(endpoints);
  console.log(chalk.dim(`  Loaded ${endpoints.length} endpoint(s): ${endpoints.map((e) => e.name).join(', ')}`));
}

function loadConfig(): NTKConfig {
  return buildConfig(endpointManager);
}

// ─── Commands ─────────────────────────────────────────

async function cmdRun(
  task: string,
  config: NTKConfig,
  opts?: { forceDepth?: string; skipScout?: boolean; stream?: boolean; verbose?: boolean },
): Promise<void> {
  console.log(chalk.blue.bold(`\n  ⚡ Running task: "${task}"\n`));
  if (opts?.forceDepth) console.log(chalk.dim(`  Force depth: ${opts.forceDepth}`));
  if (opts?.skipScout) console.log(chalk.dim(`  Skip scout: true`));

  const useStream = opts?.stream !== false;
  let streamStarted = false;

  const startTime = Date.now();
  const pipeline = new Pipeline(config, handleEvent, {
    ...(opts as any),
    endpointManager,
    onToken: useStream
      ? (token: string) => {
          if (!streamStarted) {
            console.log(chalk.cyan.bold('\n  === Final Report ==='));
            process.stdout.write('  ');
            streamStarted = true;
          }
          process.stdout.write(token);
        }
      : undefined,
  });
  const result = await pipeline.run(task);
  const duration = ((Date.now() - startTime) / 1000).toFixed(1);

  if (streamStarted) {
    console.log('');
  } else {
    console.log(chalk.cyan.bold('\n  === Final Report ==='));
    console.log(`  ${result.report.split('\n').join('\n  ')}`);
  }
  console.log(chalk.dim(`\n  ⏱️  Duration: ${duration}s | Depth: ${result.depth ?? 'full'}`));

  printTokenReport(result);

  if ((opts?.verbose || config.debug) && result.trace) {
    printTrace(result.trace);
  }

  // Record gain stats
  const tr = result.tokenReport;
  const plannerTok = tr.byAgent.planner ? tr.byAgent.planner.input + tr.byAgent.planner.output : 0;
  const totalTok = tr.totalInput + tr.totalOutput;
  recordGain({
    timestamp: Date.now(),
    preFilterCharsRemoved: result.preFilterSavings?.totalCharsRemoved ?? 0,
    preFilterOriginal: result.preFilterSavings?.totalOriginal ?? 0,
    totalTokens: totalTok,
    strongTokens: plannerTok,
    cheapTokens: totalTok - plannerTok,
    depth: result.depth ?? 'full',
    detectedTypes: [],
  });
}

async function cmdInteractive(config: NTKConfig): Promise<void> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const diffCtx = new DiffContext();

  const ask = (): void => {
    rl.question(chalk.cyan('\n  📝 Task > '), async (input) => {
      const trimmed = input.trim();
      if (!trimmed || trimmed === 'exit' || trimmed === 'quit') {
        const stats = diffCtx.getStats();
        if (stats.totalTurns > 1) {
          console.log(
            chalk.dim(
              `  📊 Session: ${stats.totalTurns} turns, ~${stats.estimatedTokensSaved} tokens saved via diff context`,
            ),
          );
        }
        console.log(chalk.dim('  Bye!\n'));
        rl.close();
        return;
      }

      if (trimmed === 'help') {
        console.log(chalk.dim('  Type a task to run it. Special commands:'));
        console.log(chalk.dim('    exit/quit    — Exit'));
        console.log(chalk.dim('    gain         — Show cumulative savings'));
        console.log(chalk.dim('    clear        — Clear conversation context'));
        console.log(chalk.dim('    cache        — Show response cache stats'));
        console.log(chalk.dim('    cache clear  — Clear response cache'));
        console.log(chalk.dim('    help         — This help'));
        ask();
        return;
      }

      if (trimmed === 'gain') {
        cmdGain();
        ask();
        return;
      }

      if (trimmed === 'clear') {
        diffCtx.clear();
        console.log(chalk.dim('  Conversation context cleared.'));
        ask();
        return;
      }

      if (trimmed === 'cache') {
        const stats = Pipeline.getCacheStats();
        console.log(chalk.dim(`  📦 Cache: ${stats.size} entries, ${stats.hits} hits, ${stats.misses} misses`));
        console.log(
          chalk.dim(`     Hit rate: ${(stats.hitRate * 100).toFixed(1)}% | Tokens saved: ${stats.totalTokensSaved}`),
        );
        ask();
        return;
      }

      if (trimmed === 'cache clear') {
        Pipeline.clearCache();
        console.log(chalk.dim('  📦 Cache cleared.'));
        ask();
        return;
      }

      const augmented = diffCtx.buildAugmentedQuery(trimmed);
      const taskToRun = augmented ?? trimmed;
      if (augmented) {
        console.log(chalk.dim(`  📎 Injecting context from ${diffCtx.turnCount} previous turn(s)`));
      }

      try {
        const startTime = Date.now();
        let streamStarted = false;
        const pipeline = new Pipeline(config, handleEvent, {
          endpointManager,
          onToken: (token: string) => {
            if (!streamStarted) {
              console.log(chalk.cyan.bold('\n  === Final Report ==='));
              process.stdout.write('  ');
              streamStarted = true;
            }
            process.stdout.write(token);
          },
        });
        const result = await pipeline.run(taskToRun);
        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        if (streamStarted) {
          console.log('');
        } else {
          console.log(chalk.cyan.bold('\n  === Final Report ==='));
          console.log(`  ${result.report.split('\n').join('\n  ')}`);
        }
        console.log(chalk.dim(`\n  ⏱️  Duration: ${duration}s | Depth: ${result.depth ?? 'full'}`));
        printTokenReport(result);

        const tr = result.tokenReport;
        const totalTok = tr.totalInput + tr.totalOutput;
        diffCtx.addTurn(trimmed, result.report, result.depth ?? 'full', totalTok);

        const plannerTok = tr.byAgent.planner ? tr.byAgent.planner.input + tr.byAgent.planner.output : 0;
        recordGain({
          timestamp: Date.now(),
          preFilterCharsRemoved: result.preFilterSavings?.totalCharsRemoved ?? 0,
          preFilterOriginal: result.preFilterSavings?.totalOriginal ?? 0,
          totalTokens: totalTok,
          strongTokens: plannerTok,
          cheapTokens: totalTok - plannerTok,
          depth: result.depth ?? 'full',
          detectedTypes: [],
        });
      } catch (err) {
        console.log(chalk.red(`  Error: ${err instanceof Error ? err.message : err}`));
      }
      ask();
    });
  };

  ask();
}

async function cmdServe(port: number, config: NTKConfig): Promise<void> {
  const server = new NTKServer(config, endpointManager);
  await server.start(port);
}

// ─── Main ─────────────────────────────────────────────

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] || 'interactive';

  console.log(chalk.cyan.bold('\n  🔒 NTK — NeedToKnow Agent Framework'));
  console.log(chalk.dim('     "Know less. Do more."\n'));

  // Commands that don't need LLM initialization
  if (command === 'gain') {
    cmdGain();
    return;
  }

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
  const plannerModel = process.env.PLANNER_MODEL || process.env.MODEL || 'gpt-5.4';
  const compressorModel = process.env.COMPRESSOR_MODEL || process.env.MODEL || 'gpt-5.4-mini';
  const fastStart = args.includes('--fast-start');

  console.log(chalk.dim(`  Planner model: ${plannerModel}`));
  console.log(chalk.dim(`  Compressor model: ${compressorModel}`));

  if (fastStart) {
    console.log(chalk.dim('  Fast start: skipping endpoint probes'));
    const ep = endpointManager.getActiveEndpoint();
    if (!ep) {
      console.error(chalk.red('\n  ❌ No endpoints configured. Check .env'));
      process.exit(1);
    }
    console.log(chalk.green(`  Using: ${ep.name} (unprobed)\n`));
  } else {
    console.log(chalk.dim('  Probing endpoints...'));
    const working = await endpointManager.probeEndpoints(plannerModel);
    if (!working) {
      console.error(chalk.red('\n  ❌ All API endpoints are down. Check .env and try again.'));
      process.exit(1);
    }

    if (compressorModel !== plannerModel) {
      endpointManager.shareProbeResult(plannerModel, compressorModel);
      console.log(chalk.dim(`  Compressor model (${compressorModel}): shared probe from planner`));
    }

    console.log(chalk.green(`  Using: ${working}\n`));
  }
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
      const verbose = args.includes('--verbose') || args.includes('-v');
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
      await cmdRun(task, config, { forceDepth, skipScout: skipScout || undefined, verbose });
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

    case 'test:real': {
      const { cmdRealWorldTest } = await import('./cli/benchmarks/index.js');
      const realVerbose = args.includes('--verbose') || args.includes('-v');
      await cmdRealWorldTest(config, realVerbose);
      break;
    }

    case 'baseline': {
      const { cmdBaseline } = await import('./cli/benchmarks/index.js');
      await cmdBaseline(config);
      break;
    }

    case 'benchmark': {
      const { cmdBenchmark } = await import('./cli/benchmarks/index.js');
      const cached = process.argv.includes('--cached');
      await cmdBenchmark(config, { cached });
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

    case 'compare': {
      const { cmdCompare } = await import('./cli/benchmarks/index.js');
      await cmdCompare(config);
      break;
    }

    case 'gain':
      break;

    case 'estimate': {
      const estTask = args
        .slice(1)
        .filter((a) => !a.startsWith('--'))
        .join(' ');
      if (!estTask) {
        console.log(chalk.yellow('  Usage: npx tsx src/cli.ts estimate "your task"'));
        break;
      }
      const { classifyDepthFastPath } = await import('./pipeline/classifier.js');
      const { predictTokenUsage } = await import('./pipeline/helpers.js');
      const { detectLocale, detectTaskBand } = await import('./core/prompts.js');

      const fastDepth = classifyDepthFastPath(estTask) ?? 'light';
      const locale = detectLocale(estTask);
      const band = detectTaskBand(estTask);
      const prediction = predictTokenUsage(fastDepth, estTask.length);

      console.log(chalk.cyan.bold('\n  📊 Token Estimate'));
      console.log(chalk.dim(`  Task: "${estTask.length > 60 ? estTask.slice(0, 60) + '...' : estTask}"`));
      console.log(`  Predicted depth: ${chalk.bold(fastDepth)}`);
      console.log(`  Task band: ${chalk.bold(band)}`);
      console.log(`  Locale: ${chalk.bold(locale)}`);
      console.log(`  Estimated tokens: ${chalk.bold(String(prediction.estimated))}`);
      console.log(`  Range: ${prediction.range[0]} ~ ${prediction.range[1]}`);
      console.log(chalk.dim(`  (Zero LLM cost — based on heuristic classification)\n`));
      break;
    }

    case 'batch': {
      const batchFile = args[1];
      if (!batchFile) {
        console.log(chalk.yellow('  Usage: npx tsx src/cli.ts batch <tasks.txt>'));
        console.log(chalk.dim('  File format: one task per line'));
        break;
      }
      const { readFileSync } = await import('node:fs');
      let tasks: string[];
      try {
        tasks = readFileSync(batchFile, 'utf-8')
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l && !l.startsWith('#'));
      } catch (e: any) {
        console.log(chalk.red(`  Error reading file: ${e.message}`));
        break;
      }
      if (!tasks.length) {
        console.log(chalk.yellow('  No tasks found in file'));
        break;
      }

      console.log(chalk.cyan.bold(`\n  📦 Batch Mode — ${tasks.length} task(s)\n`));

      let totalTokens = 0;
      let totalTime = 0;
      const results: Array<{ task: string; tokens: number; depth: string; time: number; ok: boolean }> = [];

      for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        console.log(chalk.dim(`  [${i + 1}/${tasks.length}] ${t.length > 50 ? t.slice(0, 50) + '...' : t}`));
        const start = Date.now();
        try {
          const p = new Pipeline(config, () => {}, { endpointManager });
          const taskTimeout = 300_000; // 5 min per task
          let batchTimer: ReturnType<typeof setTimeout> | undefined;
          const r = await Promise.race([
            p.run(t),
            new Promise<never>((_, reject) => {
              batchTimer = setTimeout(() => reject(new Error('Task timeout (5min)')), taskTimeout);
            }),
          ]);
          clearTimeout(batchTimer);
          const elapsed = (Date.now() - start) / 1000;
          const tok = r.tokenReport.totalInput + r.tokenReport.totalOutput;
          totalTokens += tok;
          totalTime += elapsed;
          results.push({ task: t, tokens: tok, depth: r.depth ?? 'full', time: elapsed, ok: r.success });
          console.log(chalk.green(`    ✅ ${tok} tok, ${elapsed.toFixed(1)}s, depth=${r.depth}`));
        } catch (e: any) {
          const elapsed = (Date.now() - start) / 1000;
          totalTime += elapsed;
          results.push({ task: t, tokens: 0, depth: 'error', time: elapsed, ok: false });
          console.log(chalk.red(`    ❌ Error: ${e.message?.slice(0, 80)}`));
        }
      }

      console.log(chalk.cyan.bold(`\n  ═══ Batch Summary ═══`));
      console.log(`  Tasks: ${results.length} | Passed: ${results.filter((r) => r.ok).length}`);
      console.log(`  Total tokens: ${totalTokens}`);
      console.log(`  Total time: ${totalTime.toFixed(1)}s`);
      console.log(`  Avg tokens/task: ${Math.round(totalTokens / results.length)}`);
      console.log(`  Avg time/task: ${(totalTime / results.length).toFixed(1)}s\n`);
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
        console.log(chalk.dim('    estimate <task>   — Predict token usage (zero cost)'));
        console.log(chalk.dim('    batch <file>      — Run multiple tasks from file'));
        console.log(chalk.dim('    gain              — Show cumulative savings statistics'));
        console.log(chalk.dim('    compare           — Three-way comparison benchmark'));
        console.log(chalk.dim('    test              — Run test suite (9 tasks)'));
        console.log(chalk.dim('    test:real         — Run real-world scenario tests (6 tasks)'));
        console.log(chalk.dim('    benchmark         — Multi-run benchmark with statistics (3×, mean±stddev)'));
        console.log(chalk.dim('    baseline          — Baseline comparison (NTK vs direct LLM)'));
        console.log(chalk.dim('    ablation          — Ablation study (component contribution)'));
        console.log(chalk.dim('    optimize          — Optimization matrix'));
        console.log(chalk.dim(''));
        console.log(chalk.dim('  Flags:'));
        console.log(chalk.dim('    --force-depth <d> — Force depth (direct|light|standard|full)'));
        console.log(chalk.dim('    --skip-scout      — Skip scout in standard depth'));
        console.log(chalk.dim('    --verbose / -v    — Show pipeline trace (routing, compression, token details)'));
        console.log(chalk.dim('    --fast-start      — Skip compressor model probe'));
      }
    }
  }
}

main().catch((err) => {
  console.error(chalk.red(`  Fatal: ${err.message}`));
  process.exit(1);
});
