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

const CJK_RANGE = /[\u4e00-\u9fff\u3400-\u4dbf\uf900-\ufaff]/g;

/** Estimate token count accounting for CJK characters (~1.5 tokens each vs ASCII ~0.25) */
export function estimateTokens(text: string): number {
  const cjkCount = (text.match(CJK_RANGE) || []).length;
  const asciiCount = text.length - cjkCount;
  return Math.ceil(cjkCount * 1.5 + asciiCount / 4);
}

/**
 * Manages API endpoint registration, probing, failover ordering, and probe caching.
 * Encapsulates all mutable endpoint state that was previously module-global.
 */
export class EndpointManager {
  private activeEndpointIndex = 0;
  private endpoints: Endpoint[] = [];
  private modelEndpointMap = new Map<string, Set<number>>();
  private probeCache = new Map<string, { name: string; timestamp: number }>();
  private diskCacheLoaded = false;

  private readonly probeCacheTTL = 300_000; // 5 minutes
  private readonly diskCacheDir = join(homedir(), '.ntk');
  private readonly diskCacheFile: string;
  private readonly diskCacheTTL = 600_000; // 10 minutes

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

    const TIMEOUT = 8000;

    const probes = this.endpoints.map(async (ep, i) => {
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
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 1,
          }),
          signal: controller.signal,
        });

        if (response.ok) {
          const data = (await response.json()) as any;
          if (data.choices && data.choices.length > 0) {
            console.log(`[LLM] ✅ ${ep.name} (${ep.baseUrl}) — working`);
            return i;
          }
        }
        console.log(`[LLM] ❌ ${ep.name} (${ep.baseUrl}) — HTTP ${response.status}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.log(`[LLM] ❌ ${ep.name} (${ep.baseUrl}) — ${msg.slice(0, 80)}`);
      } finally {
        clearTimeout(timer);
      }
      return -1;
    });

    const results = await Promise.all(probes);

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

  /** Get endpoint indices ordered by priority for a given model */
  getEndpointOrder(model: string): number[] {
    const compatible = this.modelEndpointMap.get(model);
    const order: number[] = [];

    if (!compatible || compatible.has(this.activeEndpointIndex)) {
      order.push(this.activeEndpointIndex);
    }

    for (let i = 0; i < this.endpoints.length; i++) {
      if (i === this.activeEndpointIndex) continue;
      if (compatible && !compatible.has(i)) continue;
      order.push(i);
    }

    return order;
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
    const response = await this.callAPI(
      [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
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

    this.tokenLog.push(usage);
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

    this.tokenLog.push(usage);
    return { content, usage };
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
  ): Promise<{ content: string; usage: TokenUsage }> {
    const endpointsToTry = this.endpointManager.getEndpointOrder(this.model);
    const allEndpoints = this.endpointManager.getEndpoints();

    if (endpointsToTry.length === 0) throw new AllEndpointsFailedError(0);

    const payload = JSON.stringify({
      model: this.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: maxTokensOverride ?? this.maxTokens,
      temperature: temperatureOverride ?? this.temperature,
      stream: true,
      stream_options: { include_usage: true },
    });

    for (const epIndex of endpointsToTry) {
      const ep = allEndpoints[epIndex];
      const result = await this.tryStreamEndpoint(ep, payload, onToken);
      if (result) {
        const usage: TokenUsage = { agent, ...result, timestamp: Date.now(), phase };
        this.tokenLog.push(usage);
        return { content: result.content, usage };
      }
      this.endpointManager.invalidateProbeCacheFor(ep.name);
    }

    // All stream attempts failed — fall back to non-streaming
    return this.chat(systemPrompt, userMessage, agent, phase, maxTokensOverride, temperatureOverride);
  }

  private async tryStreamEndpoint(
    ep: Endpoint,
    body: string,
    onToken: (token: string) => void,
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

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ') || line === 'data: [DONE]') continue;
        try {
          const json = JSON.parse(line.slice(6));
          const delta = json.choices?.[0]?.delta?.content;
          if (delta) {
            fullContent += delta;
            onToken(delta);
          }
          if (json.usage) {
            inputTokens = json.usage.prompt_tokens || 0;
            outputTokens = json.usage.completion_tokens || 0;
          }
        } catch {
          // Skip malformed SSE lines
        }
      }
    }

    if (inputTokens === 0) {
      inputTokens = estimateTokens(body);
    }
    if (outputTokens === 0) {
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
    const payload = {
      model: this.model,
      messages,
      max_tokens: maxTokensOverride ?? this.maxTokens,
      temperature: temperatureOverride ?? this.temperature,
    };
    const body = JSON.stringify(payload);

    const endpointsToTry = this.endpointManager.getEndpointOrder(this.model);
    const allEndpoints = this.endpointManager.getEndpoints();

    for (const epIndex of endpointsToTry) {
      const ep = allEndpoints[epIndex];
      const result = await this.tryEndpoint(ep, body);

      if (result.success) {
        return result.data!;
      }

      console.error(`[LLM] ${ep.name} failed: ${result.error}`);
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
          const delay = (attempt + 1) * 2000;
          console.error(
            `[LLM] ${ep.name}: ${response.status}, retry ${attempt + 1}/${maxRetries} in ${delay / 1000}s...`,
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
          const delay = (attempt + 1) * 2000;
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
