/**
 * NTK MCP Server — Expose NTK pipeline as MCP tools.
 *
 * Tools:
 *   ntk_run          — Run a task through the adaptive pipeline
 *   ntk_run_fast     — Run with forced direct depth (fastest/cheapest)
 *   ntk_compress     — Compress text (standalone utility)
 *
 * Usage:
 *   npx tsx src/mcp/server.ts              (stdio transport)
 *   npx tsx src/cli.ts mcp                 (via CLI)
 *
 * VS Code / Claude Desktop config:
 *   {
 *     "mcpServers": {
 *       "ntk": {
 *         "command": "npx",
 *         "args": ["tsx", "src/mcp/server.ts"],
 *         "cwd": "/path/to/ntk"
 *       }
 *     }
 *   }
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import dotenv from 'dotenv';
import { z } from 'zod';
import { Compressor } from '../core/compressor.js';
import { buildConfig, discoverEndpoints } from '../core/config.js';
import { EndpointManager, LLMClient } from '../core/llm.js';
import type { NTKConfig, PipelineDepth } from '../index.js';
import { Pipeline } from '../pipeline/pipeline.js';

dotenv.config();

// ─── Configuration ────────────────────────────────────

const endpointManager = new EndpointManager();

function loadEndpoints(): void {
  const endpoints = discoverEndpoints();
  endpointManager.setEndpoints(endpoints);
}

function loadConfig(): NTKConfig {
  return buildConfig(endpointManager);
}

let initialized = false;
let cachedConfig: NTKConfig | null = null;
let cachedCompressor: Compressor | null = null;

async function ensureInitialized(): Promise<NTKConfig> {
  if (!initialized) {
    loadEndpoints();
    const plannerModel = process.env.PLANNER_MODEL || process.env.MODEL || 'gpt-5.4';
    const compressorModel = process.env.COMPRESSOR_MODEL || process.env.MODEL || 'gpt-5.4-mini';
    await endpointManager.probeEndpoints(plannerModel);
    if (compressorModel !== plannerModel) {
      endpointManager.shareProbeResult(plannerModel, compressorModel);
    }
    cachedConfig = loadConfig();
    initialized = true;
  }
  return cachedConfig!;
}

// ─── MCP Server ───────────────────────────────────────

const server = new McpServer({
  name: 'ntk',
  version: '0.1.0',
});

// Tool: ntk_run — Full adaptive pipeline
server.tool(
  'ntk_run',
  'Run a task through NTK adaptive pipeline. Auto-routes to optimal depth (direct/light/standard/full) based on task complexity. Uses cheap model for most work, strong model only for complex planning.',
  {
    task: z.string().max(10000).describe('The task to execute (e.g., "用Python写斐波那契函数", "比较React和Vue")'),
    forceDepth: z
      .enum(['direct', 'light', 'standard', 'full'])
      .optional()
      .describe('Force a specific pipeline depth instead of auto-classification'),
    skipScout: z.boolean().optional().describe('Skip the scout/research phase in standard depth'),
  },
  async ({ task, forceDepth, skipScout }) => {
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const config = await ensureInitialized();

      const pipeline = new Pipeline(config, () => {}, {
        forceDepth: forceDepth as PipelineDepth | undefined,
        skipScout,
        endpointManager,
      });
      const result = await Promise.race([
        pipeline.run(task),
        new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => reject(new Error('Task timeout (5min)')), 300_000);
        }),
      ]);

      const totalTokens = result.tokenReport.totalInput + result.tokenReport.totalOutput;
      const plannerTok = result.tokenReport.byAgent.planner
        ? result.tokenReport.byAgent.planner.input + result.tokenReport.byAgent.planner.output
        : 0;

      return {
        content: [
          {
            type: 'text' as const,
            text: result.report,
          },
          {
            type: 'text' as const,
            text: `\n---\n📊 Depth: ${result.depth} | Tokens: ${totalTokens} (strong: ${plannerTok}) | Success: ${result.success}`,
          },
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
        isError: true,
      };
    } finally {
      clearTimeout(timeoutTimer);
    }
  },
);

// Tool: ntk_run_fast — Direct depth, all cheap model
server.tool(
  'ntk_run_fast',
  'Run a task with minimal overhead: direct depth, skip classification, all cheap model. Best for simple code generation, translation, bug fixes.',
  {
    task: z.string().max(10000).describe('The task to execute'),
  },
  async ({ task }) => {
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      const config = await ensureInitialized();
      const fastConfig = { ...config, planner: { ...config.compressor } };
      const pipeline = new Pipeline(fastConfig, () => {}, { forceDepth: 'direct' as PipelineDepth, endpointManager });
      const result = await Promise.race([
        pipeline.run(task),
        new Promise<never>((_, reject) => {
          timeoutTimer = setTimeout(() => reject(new Error('Task timeout (5min)')), 300_000);
        }),
      ]);

      const totalTokens = result.tokenReport.totalInput + result.tokenReport.totalOutput;
      return {
        content: [
          {
            type: 'text' as const,
            text: result.report,
          },
          {
            type: 'text' as const,
            text: `\n---\n⚡ Fast mode | Tokens: ${totalTokens} | Success: ${result.success}`,
          },
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
        isError: true,
      };
    } finally {
      clearTimeout(timeoutTimer);
    }
  },
);

// Tool: ntk_compress — Standalone text compression
server.tool(
  'ntk_compress',
  'Compress text using NTK information-density compression. Extracts key points while preserving critical information. Useful for summarizing long content before processing.',
  {
    text: z.string().describe('The text to compress'),
    level: z.enum(['minimal', 'standard', 'aggressive']).optional().describe('Compression level (default: standard)'),
  },
  async ({ text, level }) => {
    try {
      const config = await ensureInitialized();

      if (!cachedCompressor) {
        cachedCompressor = new Compressor(new LLMClient(config.compressor, endpointManager));
      }
      const result = await cachedCompressor.compress(text, level || 'standard', 'summarizer', 'gather');

      return {
        content: [
          {
            type: 'text' as const,
            text: result.compressed,
          },
          {
            type: 'text' as const,
            text: `\n---\n📦 Compressed: ${result.originalLength}→${result.compressedLength} chars (${result.ratio.toFixed(1)}x)`,
          },
        ],
      };
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Error: ${msg}` }],
        isError: true,
      };
    }
  },
);

// Tool: ntk_estimate — Zero-cost token estimation
server.tool(
  'ntk_estimate',
  'Estimate token usage for a task without executing it. Zero LLM cost — uses heuristic classification. Useful to decide whether to use ntk_run or ntk_run_fast.',
  {
    task: z.string().max(10000).describe('The task to estimate'),
  },
  async ({ task }) => {
    const { classifyDepthFastPath } = await import('../pipeline/classifier.js');
    const { predictTokenUsage } = await import('../pipeline/helpers.js');
    const { detectLocale, detectTaskBand } = await import('../core/prompts.js');

    const depth = classifyDepthFastPath(task) ?? 'light';
    const locale = detectLocale(task);
    const band = detectTaskBand(task);
    const prediction = predictTokenUsage(depth, task.length);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Depth: ${depth} | Band: ${band} | Locale: ${locale}\nEstimated tokens: ${prediction.estimated} (range: ${prediction.range[0]}~${prediction.range[1]})\nZero LLM cost — heuristic classification`,
        },
      ],
    };
  },
);

// ─── Start Server ─────────────────────────────────────

export async function startMcpServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Auto-start when run directly
const isMain = process.argv[1]?.replace(/\\/g, '/').includes('mcp/server');
if (isMain) {
  startMcpServer().catch((err) => {
    console.error(`NTK MCP Server fatal: ${err.message}`);
    process.exit(1);
  });
}
