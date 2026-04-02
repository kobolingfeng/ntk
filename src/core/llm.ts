/**
 * LLM Client — Multi-endpoint failover wrapper for OpenAI-compatible APIs.
 *
 * Features:
 * - Multiple API endpoints with automatic failover
 * - Pre-flight connectivity check
 * - Retry with exponential backoff on transient errors
 * - Token usage tracking per agent/phase
 * - EndpointManager encapsulation (no global mutable state)
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { AllEndpointsFailedError } from './errors.js';
import type { AgentType, LLMConfig, Phase, TokenUsage } from './protocol.js';

/** Shared TextDecoder instance for SSE stream parsing */
const sseDecoder = new TextDecoder();
/** Reusable decode options — avoids per-chunk object allocation */
const SSE_DECODE_OPT = { stream: true } as const;
/** 1MB safety limit for SSE buffer */
const MAX_BUFFER = 1_048_576;
/** 30s inactivity timeout for stream reading */
const STREAM_INACTIVITY_TIMEOUT = 60_000;

/** Streaming repetition detection — abort when LLM loops on the same output */
const REPEAT_CHECK_EVERY = 20;
const REPEAT_BUF_SIZE = 500;
const REPEAT_BUF_CAP = REPEAT_BUF_SIZE * 2;
const REPEAT_PAT_LENS = [150, 80, 40, 20] as const;
const REPEAT_REQUIRED = 3;

function hasStreamRepetition(buf: string): boolean {
  for (const patLen of REPEAT_PAT_LENS) {
    const needed = patLen * REPEAT_REQUIRED;
    if (buf.length < needed) continue;
    const tail = buf.slice(-needed);
    const pat = tail.slice(-patLen);
    let allMatch = true;
    for (let i = 0; i < REPEAT_REQUIRED - 1; i++) {
      if (tail.slice(i * patLen, (i + 1) * patLen) !== pat) {
        allMatch = false;
        break;
      }
    }
    if (allMatch) return true;
  }
  return false;
}

/** Extract usage info from remaining SSE buffer after stream ends */
function flushSSEBuffer(buffer: string): { inputTokens: number; outputTokens: number } | null {
  // Fast empty check without allocating a trimmed copy
  let hasContent = false;
  for (let i = 0; i < buffer.length; i++) {
    const c = buffer.charCodeAt(i);
    if (c !== 32 && c !== 9 && c !== 10 && c !== 13) { hasContent = true; break; }
  }
  if (!hasContent) return null;
  let inputTokens = 0;
  let outputTokens = 0;
  let found = false;
  let flushFrom = 0;
  let flushIdx: number;
  while ((flushIdx = buffer.indexOf('\n', flushFrom)) !== -1) {
    const line = buffer.substring(flushFrom, flushIdx);
    flushFrom = flushIdx + 1;
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
    try {
      const json = JSON.parse(line.slice(6));
      if (json.usage) {
        inputTokens = json.usage.prompt_tokens || 0;
        outputTokens = json.usage.completion_tokens || 0;
        found = true;
      }
    } catch { /* malformed */ }
  }
  // Handle last line without trailing newline
  if (flushFrom < buffer.length) {
    const lastLine = buffer.substring(flushFrom);
    if (lastLine.startsWith('data: ') && lastLine !== 'data: [DONE]') {
      try {
        const json = JSON.parse(lastLine.slice(6));
        if (json.usage) {
          inputTokens = json.usage.prompt_tokens || 0;
          outputTokens = json.usage.completion_tokens || 0;
          found = true;
        }
      } catch { /* malformed */ }
    }
  }
  return found ? { inputTokens, outputTokens } : null;
}

interface ChatCompletionResponse {
  id: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

/** A single API endpoint configuration (input — before setEndpoints processes it) */
export interface EndpointInput {
  name: string;
  apiKey: string;
  baseUrl: string;
}

/** A fully-initialized endpoint with pre-computed URL and headers */
export interface Endpoint extends EndpointInput {
  /** Pre-computed chat completions URL */
  readonly chatUrl: string;
  /** Pre-computed authorization headers */
  readonly headers: Readonly<Record<string, string>>;
}

/** Estimate token count with per-character-class coefficients.
 *  CJK ~1.5, letters ~0.25 (4 chars/token), digits/symbols ~0.5, whitespace ~0.1 */
export function estimateTokens(text: string): number {
  let tokens = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) || (c >= 0xF900 && c <= 0xFAFF)) {
      tokens += 1.5; // CJK ideographs
    } else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
      tokens += 0.25; // Letters — ~4 chars per token
    } else if (c === 32 || c === 10 || c === 9 || c === 13) {
      tokens += 0.1; // Whitespace — merged with adjacent tokens
    } else {
      tokens += 0.5; // Digits, punctuation, symbols — ~2 chars per token
    }
  }
  return Math.ceil(tokens);
}

/**
 * Manages API endpoint registration, probing, failover ordering, and probe caching.
 * Tracks endpoint health and auto-demotes consistently failing endpoints.
 */
export class EndpointManager {
  private activeEndpointIndex = 0;
  private endpoints: Endpoint[] = [];
  private modelEndpointMap = new Map<string, Set<number>>();
  private probeCache = new Map<string, { name: string; timestamp: number }>();
  private negativeProbeCache = new Map<number, number>(); // endpointIndex -> failTimestamp
  private diskCacheLoaded = false;

  private readonly probeCacheTTL = 300_000; // 5 minutes (in-memory, same process)
  private readonly negativeProbeTTL = 120_000; // 2 minutes — skip recently-failed endpoints
  private readonly diskCacheDir = join(homedir(), '.ntk');
  private readonly diskCacheFile: string;
  private readonly diskCacheTTL = 1_800_000; // 30 minutes — longer for cross-process reuse

  // Health tracking for auto-priority adjustment
  private healthStats = new Map<number, { failures: number; successes: number; lastFailure: number; demoted: boolean; avgLatencyMs: number; latencyCount: number }>();
  private readonly demoteThreshold = 3; // consecutive failures before demotion
  private readonly recoveryCheckInterval = 120_000; // re-check demoted endpoints every 2 min
  /** Cached endpoint order — invalidated on health state changes */
  private cachedOrder: { model: string; order: number[]; ts: number } | null = null;

  constructor() {
    this.diskCacheFile = join(this.diskCacheDir, 'probe-cache.json');
  }

  /** Register multiple endpoints for failover */
  setEndpoints(endpoints: EndpointInput[]): void {
    this.endpoints = endpoints.map((e) => {
      const baseUrl = e.baseUrl.replace(/\/+$/, '');
      return {
        ...e,
        baseUrl,
        chatUrl: `${baseUrl}/chat/completions`,
        headers: Object.freeze({
          'Content-Type': 'application/json',
          Authorization: `Bearer ${e.apiKey}`,
        }),
      };
    });
    this.activeEndpointIndex = 0;
  }

  /** Get the currently active endpoint */
  getActiveEndpoint(): Endpoint | undefined {
    return this.endpoints[this.activeEndpointIndex];
  }

  /** Get all registered endpoints */
  getEndpoints(): Endpoint[] {
    return this.endpoints;
  }

  /**
   * Pre-flight check: probe all endpoints in parallel, pick highest-priority working one.
   * Returns the name of the working endpoint or null if all fail.
   */
  async probeEndpoints(model: string): Promise<string | null> {
    this.loadDiskProbeCache();

    const cached = this.probeCache.get(model);
    if (cached && Date.now() - cached.timestamp < this.probeCacheTTL) {
      return cached.name;
    }

    const TIMEOUT = 4000; // 4s is enough; working endpoints respond in <2s
    const now = Date.now();
    const probeBody = `{"model":${JSON.stringify(model)},"messages":[{"role":"user","content":"hi"}],"max_tokens":1}`;

    // Track all probes and their results for background discovery
    const workingSet = new Set<number>();
    let firstWorkingIdx = -1;
    let firstResolve: ((name: string | null) => void) | null = null;
    // Suppress logging for probes that complete after we've already returned
    let quiet = false;

    // Promise that resolves as soon as the first working endpoint is found
    const firstWorking = new Promise<string | null>((resolve) => { firstResolve = resolve; });

    const probePromises: Promise<void>[] = [];

    for (let i = 0; i < this.endpoints.length; i++) {
      const ep = this.endpoints[i];
      // Skip endpoints that failed recently
      const lastFail = this.negativeProbeCache.get(i);
      if (lastFail && now - lastFail < this.negativeProbeTTL) {
        continue;
      }

      const epIndex = i;
      probePromises.push(
        (async () => {
          try {
            const response = await fetch(ep.chatUrl, {
              method: 'POST',
              headers: ep.headers,
              body: probeBody,
              signal: AbortSignal.timeout(TIMEOUT),
            });

            if (response.ok) {
              const data = (await response.json()) as { choices?: unknown[] };
              if (data.choices && data.choices.length > 0) {
                if (!quiet) console.log(`[LLM] ✅ ${ep.name} (${ep.baseUrl}) — working`);
                workingSet.add(epIndex);
                // Resolve immediately on first success — don't wait for other probes
                if (firstWorkingIdx < 0) {
                  firstWorkingIdx = epIndex;
                  this.activeEndpointIndex = epIndex;
                  this.modelEndpointMap.set(model, workingSet);
                  const name = ep.name;
                  this.probeCache.set(model, { name, timestamp: Date.now() });
                  this.saveDiskProbeCache(model, name, epIndex);
                  firstResolve!(name);
                }
                return;
              }
            }
            if (!quiet) console.log(`[LLM] ❌ ${ep.name} (${ep.baseUrl}) — HTTP ${response.status}`);
          } catch (error) {
            if (!quiet) {
              const msg = error instanceof Error ? error.message : String(error);
              console.log(`[LLM] ❌ ${ep.name} (${ep.baseUrl}) — ${msg.slice(0, 80)}`);
            }
          }
          this.negativeProbeCache.set(epIndex, Date.now());
        })(),
      );
    }

    if (probePromises.length === 0) return null;

    // Race: wait for either the first success or all probes to complete
    const allDone = Promise.all(probePromises).then(() => {
      // All probes finished — if no success yet, resolve null
      if (firstWorkingIdx < 0) firstResolve!(null);
    });

    const name = await firstWorking;

    // Suppress logging for slower background probes to avoid interleaving with task output
    quiet = true;

    // Continue background discovery for failover — don't await, just let it run
    allDone.catch(() => {});

    return name;
  }

  /**
   * Probe all endpoints and return working ones (for concurrent workload distribution).
   * Unlike probeEndpoints(), returns ALL working endpoints, not just the best one.
   */
  async probeAllEndpoints(model: string): Promise<Endpoint[]> {
    this.loadDiskProbeCache();
    const TIMEOUT = 8000;
    const now = Date.now();
    const probeBody = `{"model":${JSON.stringify(model)},"messages":[{"role":"user","content":"hi"}],"max_tokens":1}`;

    const probePromises = this.endpoints.map(async (ep, i) => {
      const lastFail = this.negativeProbeCache.get(i);
      if (lastFail && now - lastFail < this.negativeProbeTTL) return false;

      try {
        const res = await fetch(ep.chatUrl, {
          method: 'POST',
          headers: ep.headers,
          body: probeBody,
          signal: AbortSignal.timeout(TIMEOUT),
        });
        if (res.ok) {
          const data = (await res.json()) as { choices?: unknown[] };
          if (data.choices && data.choices.length > 0) return true;
        }
      } catch {
        // probe failed
      }
      this.negativeProbeCache.set(i, Date.now());
      return false;
    });

    const results = await Promise.all(probePromises);
    const working: Endpoint[] = [];
    const workingIndices = new Set<number>();
    for (let i = 0; i < results.length; i++) {
      if (results[i]) {
        working.push(this.endpoints[i]);
        workingIndices.add(i);
      }
    }

    // Also set probe cache for the best working endpoint
    if (working.length > 0) {
      const bestIdx = workingIndices.values().next().value as number;
      this.activeEndpointIndex = bestIdx;
      this.modelEndpointMap.set(model, workingIndices);
      this.probeCache.set(model, { name: working[0].name, timestamp: Date.now() });
      this.saveDiskProbeCache(model, working[0].name, bestIdx);
    }
    return working;
  }

  /** Pre-warm the probe cache to skip probing for known-working endpoints */
  prewarmProbeCache(model: string): void {
    if (this.endpoints.length === 0) return;
    this.probeCache.set(model, { name: this.endpoints[0].name, timestamp: Date.now() });
    this.modelEndpointMap.set(model, new Set([0]));
    this.activeEndpointIndex = 0;
  }

  /** Copy probe results from one model to another (endpoints are model-agnostic) */
  shareProbeResult(fromModel: string, toModel: string): void {
    const cached = this.probeCache.get(fromModel);
    if (cached) {
      this.probeCache.set(toModel, { ...cached });
    }
    const epSet = this.modelEndpointMap.get(fromModel);
    if (epSet) {
      this.modelEndpointMap.set(toModel, new Set(epSet));
    }
  }

  /** Get endpoint indices ordered by priority, with demoted endpoints at the end */
  getEndpointOrder(model: string): number[] {
    // Return cached order if still valid (invalidated by recordSuccess/recordFailure)
    if (this.cachedOrder && this.cachedOrder.model === model) {
      return this.cachedOrder.order;
    }

    const compatible = this.modelEndpointMap.get(model);
    const healthy: number[] = [];
    const demoted: number[] = [];

    // Active endpoint first if healthy
    if (!compatible || compatible.has(this.activeEndpointIndex)) {
      const stats = this.healthStats.get(this.activeEndpointIndex);
      if (stats?.demoted) {
        demoted.push(this.activeEndpointIndex);
      } else {
        healthy.push(this.activeEndpointIndex);
      }
    }

    for (let i = 0; i < this.endpoints.length; i++) {
      if (i === this.activeEndpointIndex) continue;
      if (compatible && !compatible.has(i)) continue;

      const stats = this.healthStats.get(i);
      if (stats?.demoted) {
        // Only include demoted endpoints if recovery check interval has passed
        if (Date.now() - stats.lastFailure > this.recoveryCheckInterval) {
          demoted.push(i);
        }
      } else {
        healthy.push(i);
      }
    }

    // Sort healthy endpoints by latency (fastest first), keeping active endpoint at front
    if (healthy.length > 1) {
      // Sort in-place from index 1 (keep active at front)
      for (let i = 2; i < healthy.length; i++) {
        const val = healthy[i];
        const valLat = this.healthStats.get(val)?.avgLatencyMs || Infinity;
        let j = i - 1;
        while (j >= 1 && (this.healthStats.get(healthy[j])?.avgLatencyMs || Infinity) > valLat) {
          healthy[j + 1] = healthy[j];
          j--;
        }
        healthy[j + 1] = val;
      }
    }

    // Concat without spread — avoid intermediate array
    if (demoted.length === 0) {
      this.cachedOrder = { model, order: healthy, ts: Date.now() };
      return healthy;
    }
    for (const d of demoted) healthy.push(d);
    this.cachedOrder = { model, order: healthy, ts: Date.now() };
    return healthy;
  }

  /** Record a successful API call for an endpoint */
  recordSuccess(endpointIndex: number, latencyMs?: number): void {
    const stats = this.healthStats.get(endpointIndex) ?? { failures: 0, successes: 0, lastFailure: 0, demoted: false, avgLatencyMs: 0, latencyCount: 0 };
    stats.successes++;
    stats.failures = 0;
    if (latencyMs !== undefined && latencyMs > 0) {
      // Exponential moving average for latency
      const alpha = 0.3;
      stats.avgLatencyMs = stats.latencyCount === 0 ? latencyMs : stats.avgLatencyMs * (1 - alpha) + latencyMs * alpha;
      stats.latencyCount++;
      this.cachedOrder = null; // Latency change affects priority order
    }
    if (stats.demoted) {
      stats.demoted = false;
      this.cachedOrder = null;
      console.log(`[LLM] ♻️ ${this.endpoints[endpointIndex]?.name} recovered, promoting back`);
    }
    this.healthStats.set(endpointIndex, stats);
  }

  /** Record a failed API call for an endpoint */
  recordFailure(endpointIndex: number): void {
    const stats = this.healthStats.get(endpointIndex) ?? { failures: 0, successes: 0, lastFailure: 0, demoted: false, avgLatencyMs: 0, latencyCount: 0 };
    stats.failures++;
    stats.lastFailure = Date.now();
    this.cachedOrder = null; // Failure may trigger demotion
    if (stats.failures >= this.demoteThreshold && !stats.demoted) {
      stats.demoted = true;
      console.log(`[LLM] ⬇️ ${this.endpoints[endpointIndex]?.name} demoted after ${stats.failures} consecutive failures`);
    }
    this.healthStats.set(endpointIndex, stats);
  }

  /** Get health status for all endpoints */
  getHealthStats(): Array<{ name: string; failures: number; successes: number; demoted: boolean }> {
    return this.endpoints.map((ep, i) => {
      const stats = this.healthStats.get(i);
      return {
        name: ep.name,
        failures: stats?.failures ?? 0,
        successes: stats?.successes ?? 0,
        demoted: stats?.demoted ?? false,
      };
    });
  }

  /** Remove probe cache entries matching a given endpoint name */
  invalidateProbeCacheFor(endpointName: string): void {
    for (const [model, cached] of this.probeCache.entries()) {
      if (cached.name === endpointName) this.probeCache.delete(model);
    }
  }

  private loadDiskProbeCache(): void {
    if (this.diskCacheLoaded) return;
    this.diskCacheLoaded = true;
    try {
      if (!existsSync(this.diskCacheFile)) return;
      const data = JSON.parse(readFileSync(this.diskCacheFile, 'utf-8'));
      const now = Date.now();
      for (const [model, entry] of Object.entries(data)) {
        const e = entry as { name: string; timestamp: number; endpointIndex: number };
        if (now - e.timestamp < this.diskCacheTTL) {
          this.probeCache.set(model, { name: e.name, timestamp: e.timestamp });
        }
      }
    } catch {
      // Corrupted cache, ignore
    }
  }

  private saveDiskProbeCache(model: string, name: string, endpointIndex: number): void {
    try {
      if (!existsSync(this.diskCacheDir)) mkdirSync(this.diskCacheDir, { recursive: true });
      let data: Record<string, unknown> = {};
      try {
        if (existsSync(this.diskCacheFile)) {
          data = JSON.parse(readFileSync(this.diskCacheFile, 'utf-8'));
        }
      } catch {
        // Start fresh
      }
      data[model] = { name, timestamp: Date.now(), endpointIndex };
      // Prune expired entries to prevent unbounded disk cache growth
      const now = Date.now();
      for (const key of Object.keys(data)) {
        const e = data[key] as { timestamp?: number };
        if (e.timestamp && now - e.timestamp > this.diskCacheTTL) {
          delete data[key];
        }
      }
      const tmpFile = `${this.diskCacheFile}.tmp`;
      writeFileSync(tmpFile, JSON.stringify(data));
      renameSync(tmpFile, this.diskCacheFile);
    } catch {
      // Non-critical, ignore
    }
  }
}

/** Default singleton for backward compatibility */
export const defaultEndpointManager = new EndpointManager();

export class LLMClient {
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private tokenLog: TokenUsage[] = [];
  private static readonly MAX_TOKEN_LOG = 200;
  /** Circular buffer index — avoids O(n) shift() on full log */
  private tokenLogIdx = 0;
  private endpointManager: EndpointManager;
  /** Pre-computed JSON-escaped model name — avoids JSON.stringify on every LLM call */
  private readonly modelJson: string;

  constructor(config: LLMConfig, endpointManager?: EndpointManager) {
    this.model = config.model;
    this.modelJson = JSON.stringify(config.model);
    this.maxTokens = config.maxTokens ?? 2048;
    const rawTemp = config.temperature ?? 0.3;
    this.temperature = Number.isFinite(rawTemp) ? Math.max(0, Math.min(2, rawTemp)) : 0.3;
    this.endpointManager = endpointManager ?? defaultEndpointManager;

    if (this.endpointManager.getEndpoints().length === 0) {
      this.endpointManager.setEndpoints([
        {
          name: 'primary',
          apiKey: config.apiKey,
          baseUrl: config.baseUrl,
        },
      ]);
    }
  }

  /** @deprecated Use EndpointManager.setEndpoints() directly */
  static setEndpoints(endpoints: EndpointInput[]): void {
    defaultEndpointManager.setEndpoints(endpoints);
  }

  /** @deprecated Use EndpointManager.getActiveEndpoint() directly */
  static getActiveEndpoint(): Endpoint | undefined {
    return defaultEndpointManager.getActiveEndpoint();
  }

  /** @deprecated Use EndpointManager.probeEndpoints() directly */
  static async probeEndpoints(model: string): Promise<string | null> {
    return defaultEndpointManager.probeEndpoints(model);
  }

  // ─── Chat Methods ──────────────────────────────────

  async chat(
    systemPrompt: string,
    userMessage: string,
    agent: AgentType,
    phase: Phase,
    maxTokensOverride?: number,
    temperatureOverride?: number,
    /** External abort signal for cancellation */
    signal?: AbortSignal,
  ): Promise<{ content: string; usage: TokenUsage }> {
    const effectiveMax = maxTokensOverride ?? this.maxTokens;
    const effectiveTemp = temperatureOverride ?? this.temperature;
    // Build JSON payload directly — avoids intermediate messages array + JSON.stringify overhead
    const messagesJson = systemPrompt
      ? `[{"role":"system","content":${JSON.stringify(systemPrompt)}},{"role":"user","content":${JSON.stringify(userMessage)}}]`
      : `[{"role":"user","content":${JSON.stringify(userMessage)}}]`;
    const body = `{"model":${this.modelJson},"messages":${messagesJson},"max_tokens":${effectiveMax},"max_completion_tokens":${effectiveMax},"temperature":${effectiveTemp}}`;
    const response = await this.callAPIWithBody(body, signal);

    const content = response.choices[0]?.message?.content ?? '';
    const usage: TokenUsage = {
      agent,
      inputTokens: response.usage?.prompt_tokens ?? 0,
      outputTokens: response.usage?.completion_tokens ?? 0,
      timestamp: Date.now(),
      phase,
    };

    this.pushTokenLog(usage);
    return { content, usage };
  }

  /**
   * Chat with tool-calling support (streaming).
   * Returns either text content or tool calls — never both.
   */
  async chatWithTools(
    messages: Array<{ role: string; content?: string; tool_calls?: unknown[]; tool_call_id?: string }>,
    tools: unknown[],
    agent: AgentType,
    phase: Phase,
    onToken?: (token: string) => void,
    /** Pre-serialized tools JSON fragment to avoid re-serializing tools each round */
    cachedToolsJson?: string,
    /** Pre-serialized messages JSON — avoids re-serializing entire growing array each round */
    cachedMessagesJson?: string,
    /** External abort signal for cancellation */
    signal?: AbortSignal,
  ): Promise<{ content?: string; toolCalls?: Array<{ id: string; name: string; arguments: string }>; usage: TokenUsage }> {
    const endpointsToTry = this.endpointManager.getEndpointOrder(this.model);
    const allEndpoints = this.endpointManager.getEndpoints();

    if (endpointsToTry.length === 0) throw new AllEndpointsFailedError(0);

    // Build payload with optional pre-serialized tools to avoid redundant JSON.stringify on tools array
    const toolsJson = cachedToolsJson ?? JSON.stringify(tools);
    const messagesJson = cachedMessagesJson ?? JSON.stringify(messages);
    const payload = `{"model":${this.modelJson},"messages":${messagesJson},"tools":${toolsJson},"tool_choice":"auto","max_tokens":${this.maxTokens},"max_completion_tokens":${this.maxTokens},"temperature":${this.temperature},"stream":true,"stream_options":{"include_usage":true}}`;

    for (const epIndex of endpointsToTry) {
      const ep = allEndpoints[epIndex];
      const startMs = Date.now();
      const result = await this.tryStreamToolEndpoint(ep, payload, onToken, signal);
      if (result) {
        this.endpointManager.recordSuccess(epIndex, Date.now() - startMs);
        const usage: TokenUsage = {
          agent,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          timestamp: Date.now(),
          phase,
        };
        this.pushTokenLog(usage);
        if (result.toolCalls.length > 0) {
          return { toolCalls: result.toolCalls, usage };
        }
        return { content: result.content, usage };
      }
      this.endpointManager.recordFailure(epIndex);
      this.endpointManager.invalidateProbeCacheFor(ep.name);
    }

    throw new AllEndpointsFailedError(allEndpoints.length);
  }

  private async tryStreamToolEndpoint(
    ep: Endpoint,
    body: string,
    onToken?: (token: string) => void,
    externalSignal?: AbortSignal,
  ): Promise<{ content: string; toolCalls: Array<{ id: string; name: string; arguments: string }>; inputTokens: number; outputTokens: number } | null> {
    // Fast bail: skip network call if already cancelled
    if (externalSignal?.aborted) return null;

    let response: Response;
    const fetchSignal = externalSignal
      ? AbortSignal.any([externalSignal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000);
    const maxRetries = 2;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetch(ep.chatUrl, {
          method: 'POST',
          headers: ep.headers,
          body,
          signal: fetchSignal,
        });
      } catch { return null; }

      if ((response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) && attempt < maxRetries) {
        const baseDelay = response.status === 429 ? 1000 : 500;
        await new Promise((r) => setTimeout(r, baseDelay * 2 ** attempt + Math.random() * 200));
        continue;
      }
      break;
    }

    if (!response.ok || !response.body) return null;

    const contentParts: string[] = [];
    const toolCallsMap: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let inputTokens = 0;
    let outputTokens = 0;

    const reader = response.body.getReader();
    let buffer = '';
    let lastActivityMs = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivityMs > STREAM_INACTIVITY_TIMEOUT) reader.cancel().catch(() => {});
    }, 15_000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        lastActivityMs = Date.now();
        if (done) break;

        buffer += sseDecoder.decode(value, SSE_DECODE_OPT);
        if (buffer.length > MAX_BUFFER) buffer = buffer.slice(-MAX_BUFFER / 2);

        let nlIdx: number;
        let searchFrom = 0;
        while ((nlIdx = buffer.indexOf('\n', searchFrom)) !== -1) {
          const line = buffer.substring(searchFrom, nlIdx);
          searchFrom = nlIdx + 1;
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;

          try {
            const json = JSON.parse(line.slice(6));
            const delta = json.choices?.[0]?.delta;
            if (!delta) {
              if (json.usage) {
                inputTokens = json.usage.prompt_tokens || 0;
                outputTokens = json.usage.completion_tokens || 0;
              }
              continue;
            }

            // Text content
            if (delta.content) {
              contentParts.push(delta.content);
              onToken?.(delta.content);
            }

            // Tool calls (streamed incrementally) — guard avoids `?? []` empty array allocation
            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx = tc.index ?? 0;
                let entry = toolCallsMap.get(idx);
                if (!entry) {
                  entry = { id: '', name: '', arguments: '' };
                  toolCallsMap.set(idx, entry);
                }
                if (tc.id) entry.id = tc.id;
                if (tc.function?.name) entry.name = tc.function.name;
                if (tc.function?.arguments) entry.arguments += tc.function.arguments;
              }
            }

            if (json.usage) {
              inputTokens = json.usage.prompt_tokens || 0;
              outputTokens = json.usage.completion_tokens || 0;
            }
          } catch { /* malformed SSE */ }
        }
        if (searchFrom > 0) buffer = buffer.substring(searchFrom);
      }
    } catch {
      // stream error
    } finally {
      clearInterval(watchdog);
      reader.cancel().catch(() => {});
    }

    // Flush remaining buffer — usage event may arrive in the final chunk
    const flushed = flushSSEBuffer(buffer);
    if (flushed) {
      inputTokens = flushed.inputTokens;
      outputTokens = flushed.outputTokens;
    }

    const content = contentParts.join('');
    const toolCalls: Array<{ id: string; name: string; arguments: string }> = [];
    for (const tc of toolCallsMap.values()) {
      if (tc.id && tc.name) toolCalls.push(tc);
    }

    // Fallback token estimation
    if (inputTokens === 0) inputTokens = estimateTokens(body);
    if (outputTokens === 0) outputTokens = estimateTokens(content || JSON.stringify(toolCalls));

    return { content, toolCalls, inputTokens, outputTokens };
  }

  private pushTokenLog(usage: TokenUsage): void {
    if (this.tokenLog.length < LLMClient.MAX_TOKEN_LOG) {
      this.tokenLog.push(usage);
    } else {
      this.tokenLog[this.tokenLogIdx] = usage;
      this.tokenLogIdx = (this.tokenLogIdx + 1) % LLMClient.MAX_TOKEN_LOG;
    }
  }

  getTokenLog(): readonly TokenUsage[] {
    return this.tokenLog;
  }
  resetTokenLog(): void {
    this.tokenLog = [];
    this.tokenLogIdx = 0;
  }

  async chatStream(
    systemPrompt: string,
    userMessage: string,
    agent: AgentType,
    phase: Phase,
    onToken: (token: string) => void,
    maxTokensOverride?: number,
    temperatureOverride?: number,
    maxOutputTokens?: number,
    signal?: AbortSignal,
  ): Promise<{ content: string; usage: TokenUsage }> {
    const endpointsToTry = this.endpointManager.getEndpointOrder(this.model);
    const allEndpoints = this.endpointManager.getEndpoints();

    if (endpointsToTry.length === 0) throw new AllEndpointsFailedError(0);

    const effectiveMax = maxTokensOverride ?? this.maxTokens;
    const effectiveTemp = temperatureOverride ?? this.temperature;
    // Build JSON payload directly via template literal — avoids intermediate object + JSON.stringify overhead
    const messagesJson = systemPrompt
      ? `[{"role":"system","content":${JSON.stringify(systemPrompt)}},{"role":"user","content":${JSON.stringify(userMessage)}}]`
      : `[{"role":"user","content":${JSON.stringify(userMessage)}}]`;
    const payload = `{"model":${this.modelJson},"messages":${messagesJson},"max_tokens":${effectiveMax},"max_completion_tokens":${effectiveMax},"temperature":${effectiveTemp},"stream":true,"stream_options":{"include_usage":true}}`;

    for (const epIndex of endpointsToTry) {
      const ep = allEndpoints[epIndex];
      const startMs = Date.now();
      const result = await this.tryStreamEndpoint(ep, payload, onToken, maxOutputTokens, systemPrompt, userMessage, signal);
      if (result) {
        this.endpointManager.recordSuccess(epIndex, Date.now() - startMs);
        const usage: TokenUsage = { agent, ...result, timestamp: Date.now(), phase };
        this.pushTokenLog(usage);
        return { content: result.content, usage };
      }
      this.endpointManager.recordFailure(epIndex);
      this.endpointManager.invalidateProbeCacheFor(ep.name);
    }

    // All stream attempts failed — fall back to non-streaming
    return this.chat(systemPrompt, userMessage, agent, phase, maxTokensOverride, temperatureOverride);
  }

  private async tryStreamEndpoint(
    ep: Endpoint,
    body: string,
    onToken: (token: string) => void,
    maxOutputTokens?: number,
    systemPrompt?: string,
    userMessage?: string,
    externalSignal?: AbortSignal,
  ): Promise<{ content: string; inputTokens: number; outputTokens: number } | null> {
    // Fast bail: skip network call if already cancelled
    if (externalSignal?.aborted) return null;

    // Combine external abort signal with default timeout
    const fetchSignal = externalSignal
      ? AbortSignal.any([externalSignal, AbortSignal.timeout(120000)])
      : AbortSignal.timeout(120000);

    let response: Response;
    const maxRetries = 2;
    for (let attempt = 0; ; attempt++) {
      try {
        response = await fetch(ep.chatUrl, {
          method: 'POST',
          headers: ep.headers,
          body,
          signal: fetchSignal,
        });
      } catch {
        return null;
      }

      if ((response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) && attempt < maxRetries) {
        const baseDelay = response.status === 429 ? 1000 : 500;
        await new Promise((r) => setTimeout(r, baseDelay * 2 ** attempt + Math.random() * 200));
        continue;
      }
      break;
    }

    if (!response.ok || !response.body) return null;

    let fullContent = '';
    const contentParts: string[] = [];
    let inputTokens = 0;
    let outputTokens = 0;
    let abortedByLimit = false;
    let chunkCount = 0;
    let runningTokenEstimate = 0;
    let repeatBuf = '';

    const reader = response.body.getReader();
    let buffer = '';
    let lastActivityMs = Date.now();
    const watchdog = setInterval(() => {
      if (Date.now() - lastActivityMs > STREAM_INACTIVITY_TIMEOUT) {
        reader.cancel().catch(() => {});
      }
    }, 15_000);

    try {
      while (true) {
        const { done, value } = await reader.read();
        lastActivityMs = Date.now();
        if (done) {
          // Final read may still contain data (e.g., usage event)
          if (value) buffer += sseDecoder.decode(value);
          break;
        }

        buffer += sseDecoder.decode(value, SSE_DECODE_OPT);
        if (buffer.length > MAX_BUFFER) {
          buffer = buffer.slice(-MAX_BUFFER / 2);        }

        // Index-based line parsing: avoid split('\n') array allocation
        let nlIdx: number;
        let searchFrom = 0;
        while ((nlIdx = buffer.indexOf('\n', searchFrom)) !== -1) {
          const line = buffer.substring(searchFrom, nlIdx);
          searchFrom = nlIdx + 1;
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          try {
            const json = JSON.parse(line.slice(6));
            const delta = json.choices?.[0]?.delta?.content;
            if (delta) {
              chunkCount++;
              // Per-event abort: check per-character within delta for precise cutoff
              if (maxOutputTokens) {
                let cutIdx = -1;
                for (let k = 0; k < delta.length; k++) {
                  const c = delta.charCodeAt(k);
                  runningTokenEstimate += ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) || (c >= 0xF900 && c <= 0xFAFF)) ? 1.5 : 0.4;
                  if (runningTokenEstimate >= maxOutputTokens) {
                    cutIdx = k + 1;
                    break;
                  }
                }
                if (cutIdx >= 0) {
                  const partial = delta.slice(0, cutIdx);
                  contentParts.push(partial);
                  onToken(partial);
                  abortedByLimit = true;
                  break;
                }
                contentParts.push(delta);
                onToken(delta);
              } else {
                contentParts.push(delta);
                onToken(delta);
              }
              // Streaming repetition detection
              repeatBuf += delta;
              if (repeatBuf.length > REPEAT_BUF_CAP) repeatBuf = repeatBuf.slice(-REPEAT_BUF_SIZE);
              if (chunkCount % REPEAT_CHECK_EVERY === 0 && repeatBuf.length >= REPEAT_BUF_SIZE && hasStreamRepetition(repeatBuf)) {
                abortedByLimit = true;
                break;
              }
            }
            if (json.usage) {
              inputTokens = json.usage.prompt_tokens || 0;
              outputTokens = json.usage.completion_tokens || 0;
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
        if (searchFrom > 0) buffer = buffer.substring(searchFrom);
        if (abortedByLimit) break;
      }
      // Flush remaining buffer — usage event may arrive in the final chunk
      const flushed2 = flushSSEBuffer(buffer);
      if (flushed2) {
        inputTokens = flushed2.inputTokens;
        outputTokens = flushed2.outputTokens;
      }
    } catch {
      // Stream read error — preserve partial content if we accumulated enough
      if (!abortedByLimit && contentParts.length === 0) return null;
    } finally {
      clearInterval(watchdog);
      reader.cancel().catch(() => {});
    }

    // Join accumulated chunks into final content string
    fullContent = contentParts.join('');

    // Safety net: use API-reported token count (most accurate) for truncation
    // estimateTokens severely underestimates token-dense content (regex, symbols)
    if (maxOutputTokens && outputTokens > 0 && outputTokens > maxOutputTokens && fullContent.length > 0) {
      const ratio = maxOutputTokens / outputTokens;
      const targetLen = Math.max(1, Math.floor(fullContent.length * ratio));
      fullContent = fullContent.slice(0, targetLen);
      abortedByLimit = true;
    }

    // Fallback safety net: character-based estimate when API doesn't report usage
    // Reuse runningTokenEstimate from streaming loop when available to avoid O(n) rescan
    if (maxOutputTokens && outputTokens === 0) {
      if (runningTokenEstimate >= maxOutputTokens) {
        // Already truncated during streaming — no rescan needed
        abortedByLimit = true;
      } else if (!abortedByLimit && runningTokenEstimate > 0) {
        // Stream completed without hitting limit — use accumulated estimate
        // No truncation needed
      } else {
        // No streaming estimate available (e.g., stream error) — scan fullContent
        let tokens = 0;
        let truncateAt = -1;
        for (let i = 0; i < fullContent.length; i++) {
          const ch = fullContent.charCodeAt(i);
          tokens += ((ch >= 0x4E00 && ch <= 0x9FFF) || (ch >= 0x3400 && ch <= 0x4DBF) || (ch >= 0xF900 && ch <= 0xFAFF)) ? 1.5 : 0.4;
          if (truncateAt < 0 && tokens >= maxOutputTokens) {
            truncateAt = i + 1;
          }
        }
        if (truncateAt >= 0) {
          fullContent = fullContent.slice(0, truncateAt);
          abortedByLimit = true;
        }
      }
    }

    if (inputTokens === 0) {
      // Lazy concatenation — only needed when API doesn't report usage
      const messageContent = systemPrompt ? (userMessage ? `${systemPrompt} ${userMessage}` : systemPrompt) : (userMessage || body);
      inputTokens = estimateTokens(messageContent);
    }
    if (outputTokens === 0 || abortedByLimit) {
      outputTokens = estimateTokens(fullContent);
    }

    return { content: fullContent, inputTokens, outputTokens };
  }

  // ─── Core API Call with Failover ──────────────────

  private async callAPIWithBody(
    body: string,
    externalSignal?: AbortSignal,
  ): Promise<ChatCompletionResponse> {
    const endpointsToTry = this.endpointManager.getEndpointOrder(this.model);
    const allEndpoints = this.endpointManager.getEndpoints();

    for (const epIndex of endpointsToTry) {
      const ep = allEndpoints[epIndex];
      const startMs = Date.now();
      const result = await this.tryEndpoint(ep, body, externalSignal);

      if (result.success) {
        this.endpointManager.recordSuccess(epIndex, Date.now() - startMs);
        return result.data!;
      }

      console.error(`[LLM] ${ep.name} failed: ${result.error}`);
      this.endpointManager.recordFailure(epIndex);
      this.endpointManager.invalidateProbeCacheFor(ep.name);
    }

    throw new AllEndpointsFailedError(allEndpoints.length);
  }

  private async tryEndpoint(
    ep: Endpoint,
    body: string,
    externalSignal?: AbortSignal,
  ): Promise<{ success: boolean; data?: ChatCompletionResponse; error?: string }> {
    // Fast bail: skip network call if already cancelled
    if (externalSignal?.aborted) return { success: false, error: 'Aborted' };

    const maxRetries = 2;
    const fetchSignal = externalSignal
      ? AbortSignal.any([externalSignal, AbortSignal.timeout(120000)])
      : AbortSignal.timeout(120000);

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(ep.chatUrl, {
          method: 'POST',
          headers: ep.headers,
          body,
          signal: fetchSignal,
        });

        if ((response.status === 429 || response.status === 502 || response.status === 503 || response.status === 504) && attempt < maxRetries) {
          const baseDelay = response.status === 429 ? 1000 : 500;
          const delay = baseDelay * 2 ** attempt + Math.random() * 200;
          console.error(
            `[LLM] ${ep.name}: ${response.status}, retry ${attempt + 1}/${maxRetries} in ${(delay / 1000).toFixed(1)}s...`,
          );
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        if (!response.ok) {
          const errorText = await response.text();
          const truncated = errorText.length > 150 ? `${errorText.slice(0, 150)}...` : errorText;
          return { success: false, error: `HTTP ${response.status}: ${truncated}` };
        }

        const data = (await response.json()) as ChatCompletionResponse;

        if (!data.choices || data.choices.length === 0) {
          return { success: false, error: 'Empty choices in response' };
        }

        return { success: true, data };
      } catch (error) {
        if (attempt < maxRetries) {
          const delay = 500 * 2 ** attempt + Math.random() * 200;
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
        const msg = error instanceof Error ? error.message : String(error);
        return { success: false, error: msg.slice(0, 150) };
      }
    }

    return { success: false, error: 'Max retries exceeded' };
  }
}
