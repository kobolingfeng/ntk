/**
 * Shared configuration utilities — endpoint discovery and NTKConfig building.
 *
 * Eliminates endpoint loading duplication across CLI, MCP server, and test runner.
 */

import type { Endpoint, EndpointManager } from './llm.js';
import type { NTKConfig } from './protocol.js';

/**
 * Discover API endpoints from environment variables.
 *
 * Searches API_ENDPOINT_{1..10}_{KEY,URL,NAME} first,
 * falls back to UNIFIED_API_KEY + UNIFIED_BASE_URL.
 */
export function discoverEndpoints(): Endpoint[] {
  const endpoints: Endpoint[] = [];

  for (let i = 1; i <= 10; i++) {
    const key = process.env[`API_ENDPOINT_${i}_KEY`];
    const url = process.env[`API_ENDPOINT_${i}_URL`];
    const name = process.env[`API_ENDPOINT_${i}_NAME`] || `endpoint-${i}`;
    if (key && url) {
      if (!isValidUrl(url)) {
        console.warn(`[config] ⚠️ Skipping ${name}: invalid URL "${url}"`);
        continue;
      }
      endpoints.push({ name, apiKey: key, baseUrl: url });
    }
  }

  if (endpoints.length === 0) {
    const key = process.env.UNIFIED_API_KEY || '';
    const url = process.env.UNIFIED_BASE_URL || 'https://api.openai.com/v1';
    if (key) endpoints.push({ name: 'default', apiKey: key, baseUrl: url });
  }

  return endpoints;
}

function isValidUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/**
 * Build NTKConfig from an EndpointManager's active endpoint and model env vars.
 */
export function buildConfig(
  em: EndpointManager,
  overrides?: Partial<{
    plannerModel: string;
    compressorModel: string;
    debug: boolean;
  }>,
): NTKConfig {
  const ep = em.getActiveEndpoint();
  if (!ep) {
    throw new Error('No active endpoint available. Ensure API endpoints are configured in .env');
  }

  const plannerModel = overrides?.plannerModel ?? process.env.PLANNER_MODEL ?? process.env.MODEL ?? 'gpt-5.4';
  const compressorModel = overrides?.compressorModel ?? process.env.COMPRESSOR_MODEL ?? process.env.MODEL ?? 'gpt-5.4-mini';

  return {
    planner: { apiKey: ep.apiKey, baseUrl: ep.baseUrl, model: plannerModel, maxTokens: 4096, temperature: 0.3 },
    compressor: { apiKey: ep.apiKey, baseUrl: ep.baseUrl, model: compressorModel, maxTokens: 2048, temperature: 0.2 },
    maxLocalRetries: 2,
    debug: overrides?.debug ?? process.env.DEBUG === 'true',
    parallelExecution: true,
    tokenBudget: {
      planner: 1024,
      scout: 512,
      summarizer: 512,
      executor: 4096,
      verifier: 128,
    },
  };
}
