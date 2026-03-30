/**
 * LLM Client — Multi-endpoint failover wrapper for OpenAI-compatible APIs.
 *
 * Features:
 * - Multiple API endpoints with automatic failover
 * - Pre-flight connectivity check
 * - Retry with exponential backoff on transient errors
 * - Token usage tracking per agent/phase
 */

import type { LLMConfig, TokenUsage, AgentType, Phase } from './protocol.js';

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

/** Global endpoint state — shared across all LLMClient instances */
let activeEndpointIndex = 0;
let registeredEndpoints: Endpoint[] = [];

export class LLMClient {
  private model: string;
  private maxTokens: number;
  private temperature: number;
  private tokenLog: TokenUsage[] = [];

  constructor(config: LLMConfig) {
    this.model = config.model;
    this.maxTokens = config.maxTokens ?? 2048;
    this.temperature = config.temperature ?? 0.3;

    // Register endpoints from config if not already done
    if (registeredEndpoints.length === 0) {
      registeredEndpoints.push({
        name: 'primary',
        apiKey: config.apiKey,
        baseUrl: config.baseUrl.replace(/\/+$/, ''),
      });
    }
  }

  /** Register multiple endpoints for failover */
  static setEndpoints(endpoints: Endpoint[]): void {
    registeredEndpoints = endpoints.map((e) => ({
      ...e,
      baseUrl: e.baseUrl.replace(/\/+$/, ''),
    }));
    activeEndpointIndex = 0;
  }

  /** Get the currently active endpoint */
  static getActiveEndpoint(): Endpoint | undefined {
    return registeredEndpoints[activeEndpointIndex];
  }

  /**
   * Pre-flight check: probe all endpoints in parallel, pick highest-priority working one.
   * Returns the name of the working endpoint or null if all fail.
   */
  static async probeEndpoints(model: string): Promise<string | null> {
    const TIMEOUT = 8000;

    const probes = registeredEndpoints.map(async (ep, i) => {
      try {
        const url = `${ep.baseUrl}/chat/completions`;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TIMEOUT);

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${ep.apiKey}`,
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: 'hi' }],
            max_tokens: 5,
          }),
          signal: controller.signal,
        });

        clearTimeout(timer);

        if (response.ok) {
          const data = await response.json() as any;
          if (data.choices && data.choices.length > 0) {
            console.log(`[LLM] ✅ ${ep.name} (${ep.baseUrl}) — working`);
            return i;
          }
        }
        console.log(`[LLM] ❌ ${ep.name} (${ep.baseUrl}) — HTTP ${response.status}`);
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        console.log(`[LLM] ❌ ${ep.name} (${ep.baseUrl}) — ${msg.slice(0, 80)}`);
      }
      return -1;
    });

    const results = await Promise.all(probes);

    // Pick the highest-priority (lowest index) working endpoint
    const working = results
      .map((idx, originalIdx) => ({ resultIdx: idx, priority: originalIdx }))
      .filter(r => r.resultIdx >= 0)
      .sort((a, b) => a.priority - b.priority);

    if (working.length > 0) {
      activeEndpointIndex = working[0].resultIdx;
      return registeredEndpoints[activeEndpointIndex].name;
    }
    return null;
  }

  // ─── Chat Methods ──────────────────────────────────

  async chat(
    systemPrompt: string,
    userMessage: string,
    agent: AgentType,
    phase: Phase,
    maxTokensOverride?: number
  ): Promise<{ content: string; usage: TokenUsage }> {
    const response = await this.callAPI([
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ], maxTokensOverride);

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
    phase: Phase
  ): Promise<{ content: string; usage: TokenUsage }> {
    const response = await this.callAPI([
      { role: 'system', content: systemPrompt },
      ...messages,
    ]);

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

  getTokenLog(): TokenUsage[] { return [...this.tokenLog]; }
  resetTokenLog(): void { this.tokenLog = []; }

  // ─── Core API Call with Failover ──────────────────

  private async callAPI(
    messages: Array<{ role: string; content: string }>,
    maxTokensOverride?: number
  ): Promise<ChatCompletionResponse> {
    const payload = {
      model: this.model,
      messages,
      max_tokens: maxTokensOverride ?? this.maxTokens,
      temperature: this.temperature,
    };
    const body = JSON.stringify(payload);

    // Try current active endpoint first, then failover to others
    const endpointsToTry = this.getEndpointOrder();

    for (const epIndex of endpointsToTry) {
      const ep = registeredEndpoints[epIndex];
      const result = await this.tryEndpoint(ep, body);

      if (result.success) {
        // If we failed over to a different endpoint, update the active one
        if (epIndex !== activeEndpointIndex) {
          console.log(`[LLM] Switched to ${ep.name}`);
          activeEndpointIndex = epIndex;
        }
        return result.data!;
      }

      // Log failure and try next
      console.error(`[LLM] ${ep.name} failed: ${result.error}`);
    }

    throw new Error(`All ${registeredEndpoints.length} endpoints failed`);
  }

  private async tryEndpoint(
    ep: Endpoint,
    body: string
  ): Promise<{ success: boolean; data?: ChatCompletionResponse; error?: string }> {
    const url = `${ep.baseUrl}/chat/completions`;
    const maxRetries = 2;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${ep.apiKey}`,
          },
          body,
        });

        // Retry on transient errors (within this endpoint)
        if ([429, 502, 503, 504].includes(response.status) && attempt < maxRetries) {
          const delay = (attempt + 1) * 2000;
          console.error(`[LLM] ${ep.name}: ${response.status}, retry ${attempt + 1}/${maxRetries} in ${delay / 1000}s...`);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }

        if (!response.ok) {
          const errorText = await response.text();
          const truncated = errorText.length > 150 ? errorText.slice(0, 150) + '...' : errorText;
          return { success: false, error: `HTTP ${response.status}: ${truncated}` };
        }

        const data = await response.json() as ChatCompletionResponse;

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
      }
    }

    return { success: false, error: 'Max retries exceeded' };
  }

  /** Get endpoint indices in order: active first, then others */
  private getEndpointOrder(): number[] {
    const order = [activeEndpointIndex];
    for (let i = 0; i < registeredEndpoints.length; i++) {
      if (i !== activeEndpointIndex) order.push(i);
    }
    return order;
  }
}
