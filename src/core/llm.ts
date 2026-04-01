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

/** A single API endpoint configuration */
export interface Endpoint {
  name: string;
  apiKey: string;
  baseUrl: string;
}

/** Estimate token count accounting for CJK characters (~1.5 tokens each vs ASCII ~0.25) */
export function estimateTokens(text: string): number {
  let cjkCount = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if ((c >= 0x4E00 && c <= 0x9FFF) || (c >= 0x3400 && c <= 0x4DBF) || (c >= 0xF900 && c <= 0xFAFF)) {
      cjkCount++;
    }
  }
  return Math.ceil(cjkCount * 1.5 + (text.length - cjkCount) / 4);
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

  constructor() {
    this.diskCacheFile = join(this.diskCacheDir, 'probe-cache.json');
  }

  /** Register multiple endpoints for failover */
  setEndpoints(endpoints: Endpoint[]): void {
    this.endpoints = endpoints.map((e) => ({
      ...e,
      baseUrl: e.baseUrl.replace(/\/+$/, ''),
    }));
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
    const probeBody = JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });

    // Track which probes are still in flight
    const probePromises: Promise<number>[] = [];

    for (let i = 0; i < this.endpoints.length; i++) {
      const ep = this.endpoints[i];
      // Skip endpoints that failed recently
      const lastFail = this.negativeProbeCache.get(i);
      if (lastFail && now - lastFail < this.negativeProbeTTL) {
        probePromises.push(Promise.resolve(-1));
        continue;
      }

      const epIndex = i;
      probePromises.push(
        (async () => {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), TIMEOUT);
          try {
            const url = `${ep.baseUrl}/chat/completions`;
            const response = await fetch(url, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${ep.apiKey}`,
              },
              body: probeBody,
              signal: controller.signal,
            });

            if (response.ok) {
              const data = (await response.json()) as { choices?: unknown[] };
              if (data.choices && data.choices.length > 0) {
                console.log(`[LLM] ✅ ${ep.name} (${ep.baseUrl}) — working`);
                return epIndex;
              }
            }
            console.log(`[LLM] ❌ ${ep.name} (${ep.baseUrl}) — HTTP ${response.status}`);
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            console.log(`[LLM] ❌ ${ep.name} (${ep.baseUrl}) — ${msg.slice(0, 80)}`);
          } finally {
            clearTimeout(timer);
          }
          this.negativeProbeCache.set(epIndex, Date.now());
          return -1;
        })(),
      );
    }

    const results = await Promise.all(probePromises);

    const working = results
      .map((idx, originalIdx) => ({ resultIdx: idx, priority: originalIdx }))
      .filter((r) => r.resultIdx >= 0)
      .sort((a, b) => a.priority - b.priority);

    if (working.length > 0) {
      this.activeEndpointIndex = working[0].resultIdx;
      const supportedSet = new Set(working.map((w) => w.resultIdx));
      this.modelEndpointMap.set(model, supportedSet);
      const name = this.endpoints[this.activeEndpointIndex].name;
      this.probeCache.set(model, { name, timestamp: Date.now() });
      this.saveDiskProbeCache(model, name, this.activeEndpointIndex);
      return name;
    }
    return null;
  }

  /**
   * Probe all endpoints and return working ones (for concurrent workload distribution).
   * Unlike probeEndpoints(), returns ALL working endpoints, not just the best one.
   */
  async probeAllEndpoints(model: string): Promise<Endpoint[]> {
    this.loadDiskProbeCache();
    const TIMEOUT = 8000;
    const now = Date.now();
    const probeBody = JSON.stringify({ model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 });

    const probePromises = this.endpoints.map(async (ep, i) => {
      const lastFail = this.negativeProbeCache.get(i);
      if (lastFail && now - lastFail < this.negativeProbeTTL) return false;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT);
      try {
        const res = await fetch(`${ep.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ep.apiKey}` },
          body: probeBody,
          signal: controller.signal,
        });
        if (res.ok) {
          const data = (await res.json()) as { choices?: unknown[] };
          if (data.choices && data.choices.length > 0) return true;
        }
      } catch {
        // probe failed
      } finally {
        clearTimeout(timer);
      }
      this.negativeProbeCache.set(i, Date.now());
      return false;
    });

    const results = await Promise.all(probePromises);
    const working: Endpoint[] = [];
    for (let i = 0; i < results.length; i++) {
      if (results[i]) working.push(this.endpoints[i]);
    }

    // Also set probe cache for the best working endpoint
    if (working.length > 0) {
      const bestIdx = this.endpoints.indexOf(working[0]);
      this.activeEndpointIndex = bestIdx;
      this.modelEndpointMap.set(model, new Set(results.map((ok, i) => ok ? i : -1).filter(i => i >= 0)));
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
      const activeIdx = healthy[0];
      const rest = healthy.slice(1).sort((a, b) => {
        const aLat = this.healthStats.get(a)?.avgLatencyMs || Infinity;
        const bLat = this.healthStats.get(b)?.avgLatencyMs || Infinity;
        return aLat - bLat;
      });
      healthy.length = 0;
      healthy.push(activeIdx, ...rest);
    }

    return [...healthy, ...demoted];
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
    }
    if (stats.demoted) {
      stats.demoted = false;
      console.log(`[LLM] ♻️ ${this.endpoints[endpointIndex]?.name} recovered, promoting back`);
    }
    this.healthStats.set(endpointIndex, stats);
  }

  /** Record a failed API call for an endpoint */
  recordFailure(endpointIndex: number): void {
    const stats = this.healthStats.get(endpointIndex) ?? { failures: 0, successes: 0, lastFailure: 0, demoted: false, avgLatencyMs: 0, latencyCount: 0 };
    stats.failures++;
    stats.lastFailure = Date.now();
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
  private endpointManager: EndpointManager;

  constructor(config: LLMConfig, endpointManager?: EndpointManager) {
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 2048;
    this.temperature = config.temperature ?? 0.3;
    this.endpointManager = endpointManager ?? defaultEndpointManager;

    if (this.endpointManager.getEndpoints().length === 0) {
      this.endpointManager.setEndpoints([
        {
          name: 'primary',
          apiKey: config.apiKey,
          baseUrl: config.baseUrl.replace(/\/+$/, ''),
        },
      ]);
    }
  }

  /** @deprecated Use EndpointManager.setEndpoints() directly */
  static setEndpoints(endpoints: Endpoint[]): void {
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
  ): Promise<{ content: string; usage: TokenUsage }> {
    const messages = systemPrompt
      ? [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ]
      : [{ role: 'user', content: userMessage }];
    const response = await this.callAPI(
      messages,
      maxTokensOverride,
      temperatureOverride,
    );

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

  async chatMultiTurn(
    systemPrompt: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string }>,
    agent: AgentType,
    phase: Phase,
  ): Promise<{ content: string; usage: TokenUsage }> {
    const response = await this.callAPI([{ role: 'system', content: systemPrompt }, ...messages]);

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

  private pushTokenLog(usage: TokenUsage): void {
    this.tokenLog.push(usage);
    if (this.tokenLog.length > LLMClient.MAX_TOKEN_LOG) {
      this.tokenLog = this.tokenLog.slice(-LLMClient.MAX_TOKEN_LOG);
    }
  }

  getTokenLog(): TokenUsage[] {
    return [...this.tokenLog];
  }
  resetTokenLog(): void {
    this.tokenLog = [];
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
  ): Promise<{ content: string; usage: TokenUsage }> {
    const endpointsToTry = this.endpointManager.getEndpointOrder(this.model);
    const allEndpoints = this.endpointManager.getEndpoints();

    if (endpointsToTry.length === 0) throw new AllEndpointsFailedError(0);

    const effectiveMax = maxTokensOverride ?? this.maxTokens;
    const messages = systemPrompt
      ? [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userMessage },
        ]
      : [{ role: 'user', content: userMessage }];
    const payload = JSON.stringify({
      model: this.model,
      messages,
      max_tokens: effectiveMax,
      max_completion_tokens: effectiveMax,
      temperature: temperatureOverride ?? this.temperature,
      stream: true,
      stream_options: { include_usage: true },
    });

    for (const epIndex of endpointsToTry) {
      const ep = allEndpoints[epIndex];
      const messageContent = systemPrompt ? systemPrompt + ' ' + userMessage : userMessage;
      const startMs = Date.now();
      const result = await this.tryStreamEndpoint(ep, payload, onToken, maxOutputTokens, messageContent);
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
    messageContent?: string,
  ): Promise<{ content: string; inputTokens: number; outputTokens: number } | null> {
    const url = `${ep.baseUrl}/chat/completions`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120000);

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${ep.apiKey}`,
        },
        body,
        signal: controller.signal,
      });
    } catch {
      clearTimeout(timer);
      return null;
    }

    clearTimeout(timer);
    if (!response.ok || !response.body) return null;

    let fullContent = '';
    let inputTokens = 0;
    let outputTokens = 0;
    let abortedByLimit = false;
    let chunkCount = 0;
    let runningTokenEstimate = 0;
    const MAX_BUFFER = 1_048_576; // 1MB safety limit for SSE buffer
    const STREAM_INACTIVITY_TIMEOUT = 30_000; // 30s inactivity timeout for stream reading

    const reader = response.body.getReader();
    let buffer = '';
    let streamTimer: ReturnType<typeof setTimeout> | undefined;
    const resetStreamTimer = () => {
      if (streamTimer) clearTimeout(streamTimer);
      streamTimer = setTimeout(() => reader.cancel().catch(() => {}), STREAM_INACTIVITY_TIMEOUT);
    };

    try {
      resetStreamTimer();
      while (true) {
        const { done, value } = await reader.read();
        resetStreamTimer();
        if (done) {
          // Final read may still contain data (e.g., usage event)
          if (value) buffer += sseDecoder.decode(value);
          break;
        }

        buffer += sseDecoder.decode(value, { stream: true });
        if (buffer.length > MAX_BUFFER) {
          buffer = buffer.slice(-MAX_BUFFER / 2);
        }

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
                  runningTokenEstimate += (c >= 0x4E00 && c <= 0x9FFF) ? 1.5 : 0.4;
                  if (runningTokenEstimate >= maxOutputTokens) {
                    cutIdx = k + 1;
                    break;
                  }
                }
                if (cutIdx >= 0) {
                  const partial = delta.slice(0, cutIdx);
                  fullContent += partial;
                  onToken(partial);
                  abortedByLimit = true;
                  break;
                }
                fullContent += delta;
                onToken(delta);
              } else {
                fullContent += delta;
                onToken(delta);
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
        buffer = buffer.substring(searchFrom);
        if (abortedByLimit) break;
      }
      // Flush remaining buffer — usage event may arrive in the final chunk
      if (buffer.trim()) {
        for (const line of buffer.split('\n')) {
          if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
          try {
            const json = JSON.parse(line.slice(6));
            if (json.usage) {
              inputTokens = json.usage.prompt_tokens || 0;
              outputTokens = json.usage.completion_tokens || 0;
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }
    } catch {
      // Stream read error — only unexpected if we didn't intentionally abort
      if (!abortedByLimit) return null;
    } finally {
      if (streamTimer) clearTimeout(streamTimer);
      reader.cancel().catch(() => {});
    }

    // Safety net: use API-reported token count (most accurate) for truncation
    // estimateTokens severely underestimates token-dense content (regex, symbols)
    if (maxOutputTokens && outputTokens > 0 && outputTokens > maxOutputTokens && fullContent.length > 0) {
      const ratio = maxOutputTokens / outputTokens;
      const targetLen = Math.max(1, Math.floor(fullContent.length * ratio));
      fullContent = fullContent.slice(0, targetLen);
      abortedByLimit = true;
    }

    // Fallback safety net: character-based estimate when API doesn't report usage
    // Use same 0.4 rate as streaming estimate to ensure consistent trigger threshold
    if (maxOutputTokens && outputTokens === 0) {
      let tokens = 0;
      let truncateAt = -1;
      for (let i = 0; i < fullContent.length; i++) {
        const ch = fullContent.charCodeAt(i);
        tokens += (ch >= 0x4E00 && ch <= 0x9FFF) ? 1.5 : 0.4;
        if (truncateAt < 0 && tokens >= maxOutputTokens) {
          truncateAt = i + 1;
        }
      }
      if (truncateAt >= 0) {
        fullContent = fullContent.slice(0, truncateAt);
        abortedByLimit = true;
      }
    }

    if (inputTokens === 0) {
      inputTokens = estimateTokens(messageContent || body);
    }
    if (outputTokens === 0 || abortedByLimit) {
      outputTokens = estimateTokens(fullContent);
    }

    return { content: fullContent, inputTokens, outputTokens };
  }

  // ─── Core API Call with Failover ──────────────────

  private async callAPI(
    messages: Array<{ role: string; content: string }>,
    maxTokensOverride?: number,
    temperatureOverride?: number,
  ): Promise<ChatCompletionResponse> {
    const effectiveMax = maxTokensOverride ?? this.maxTokens;
    const payload = {
      model: this.model,
      messages,
      max_tokens: effectiveMax,
      max_completion_tokens: effectiveMax,
      temperature: temperatureOverride ?? this.temperature,
    };
    const body = JSON.stringify(payload);

    const endpointsToTry = this.endpointManager.getEndpointOrder(this.model);
    const allEndpoints = this.endpointManager.getEndpoints();

    for (const epIndex of endpointsToTry) {
      const ep = allEndpoints[epIndex];
      const startMs = Date.now();
      const result = await this.tryEndpoint(ep, body);

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
  ): Promise<{ success: boolean; data?: ChatCompletionResponse; error?: string }> {
    const url = `${ep.baseUrl}/chat/completions`;
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${ep.apiKey}`,
          },
          body,
          signal: controller.signal,
        });

        if ([429, 502, 503, 504].includes(response.status) && attempt < maxRetries) {
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
      } finally {
        clearTimeout(timer);
      }
    }

    return { success: false, error: 'Max retries exceeded' };
  }
}
