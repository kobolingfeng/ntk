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
import { z } from 'zod';
import { Pipeline } from '../pipeline/pipeline.js';
import { Compressor } from '../core/compressor.js';
import { LLMClient } from '../core/llm.js';
import type { NTKConfig, PipelineDepth } from '../index.js';
import dotenv from 'dotenv';

dotenv.config();

// ─── Configuration ────────────────────────────────────

function loadEndpoints(): void {
  const endpoints = [];
  for (let i = 1; i <= 10; i++) {
    const key = process.env[`API_ENDPOINT_${i}_KEY`];
    const url = process.env[`API_ENDPOINT_${i}_URL`];
    const name = process.env[`API_ENDPOINT_${i}_NAME`] || `endpoint-${i}`;
    if (key && url) endpoints.push({ name, apiKey: key, baseUrl: url });
  }
  if (endpoints.length === 0) {
    const key = process.env.UNIFIED_API_KEY || '';
    const url = process.env.UNIFIED_BASE_URL || 'https://api.openai.com/v1';
    if (key) endpoints.push({ name: 'default', apiKey: key, baseUrl: url });
  }
  LLMClient.setEndpoints(endpoints);
}

function loadConfig(): NTKConfig {
  const ep = LLMClient.getActiveEndpoint()!;
  const plannerModel = process.env.PLANNER_MODEL || process.env.MODEL || 'gpt-4o';
  const compressorModel = process.env.COMPRESSOR_MODEL || process.env.MODEL || 'gpt-4o';

  return {
    planner: { apiKey: ep.apiKey, baseUrl: ep.baseUrl, model: plannerModel, maxTokens: 4096, temperature: 0.3 },
    compressor: { apiKey: ep.apiKey, baseUrl: ep.baseUrl, model: compressorModel, maxTokens: 2048, temperature: 0.2 },
    maxLocalRetries: 2,
    debug: false,
    parallelExecution: true,
    tokenBudget: { planner: 1024, scout: 512, summarizer: 512, executor: 4096, verifier: 256 },
  };
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
    task: z.string().describe('The task to execute (e.g., "用Python写斐波那契函数", "比较React和Vue")'),
    forceDepth: z.enum(['direct', 'light', 'standard', 'full']).optional().describe('Force a specific pipeline depth instead of auto-classification'),
    skipScout: z.boolean().optional().describe('Skip the scout/research phase in standard depth'),
  },
  async ({ task, forceDepth, skipScout }) => {
    loadEndpoints();
    const plannerModel = process.env.PLANNER_MODEL || process.env.MODEL || 'gpt-4o';
    const compressorModel = process.env.COMPRESSOR_MODEL || process.env.MODEL || 'gpt-4o';
    await LLMClient.probeEndpoints(plannerModel);
    // Probe compressor model separately if different (executor/verifier use cheap model)
    if (compressorModel !== plannerModel) {
      await LLMClient.probeEndpoints(compressorModel);
    }
    const config = loadConfig();

    const pipeline = new Pipeline(config, () => {}, {
      forceDepth: forceDepth as PipelineDepth | undefined,
      skipScout,
    });
    const result = await pipeline.run(task);

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
  }
);

// Tool: ntk_run_fast — Direct depth, all cheap model
server.tool(
  'ntk_run_fast',
  'Run a task with minimal overhead: direct depth, skip classification, all cheap model. Best for simple code generation, translation, bug fixes.',
  {
    task: z.string().describe('The task to execute'),
  },
  async ({ task }) => {
    loadEndpoints();
    const compressorModel = process.env.COMPRESSOR_MODEL || process.env.MODEL || 'gpt-4o';
    await LLMClient.probeEndpoints(compressorModel);
    const config = loadConfig();
    // All cheap model
    const fastConfig = { ...config, planner: { ...config.compressor } };
    const pipeline = new Pipeline(fastConfig, () => {}, { forceDepth: 'direct' as PipelineDepth });
    const result = await pipeline.run(task);

    const totalTokens = result.tokenReport.totalInput + result.tokenReport.totalOutput;
    return {
      content: [{
        type: 'text' as const,
        text: result.report,
      }, {
        type: 'text' as const,
        text: `\n---\n⚡ Fast mode | Tokens: ${totalTokens} | Success: ${result.success}`,
      }],
    };
  }
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
    loadEndpoints();
    const model = process.env.COMPRESSOR_MODEL || process.env.MODEL || 'gpt-4o';
    await LLMClient.probeEndpoints(model);
    const config = loadConfig();

    const compressor = new Compressor(new LLMClient(config.compressor));
    const result = await compressor.compress(text, level || 'standard', 'summarizer', 'gather');

    return {
      content: [{
        type: 'text' as const,
        text: result.compressed,
      }, {
        type: 'text' as const,
        text: `\n---\n📦 Compressed: ${result.originalLength}→${result.compressedLength} chars (${result.ratio.toFixed(1)}x)`,
      }],
    };
  }
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
