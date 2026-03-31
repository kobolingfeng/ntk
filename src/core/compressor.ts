/**
 * Compressor — Takes large information and makes it small.
 *
 * This is the critical bridge between raw data and the planner's
 * limited attention. A good compressor means a smart planner.
 * A bad compressor means garbage in, garbage out.
 */

import type { LLMClient } from './llm.js';
import { type PreFilterResult, preFilter } from './pre-filter.js';
import { COMPRESSION_PROMPTS, type Locale } from './prompts.js';
import type { AgentType, Phase } from './protocol.js';

/** Compression level determines how aggressively we compress */
export type CompressionLevel = 'minimal' | 'standard' | 'aggressive';

const MAX_TEE_ENTRIES = 20;

export class Compressor {
  private llm: LLMClient;
  private locale: Locale = 'zh';
  private preFilterStats: PreFilterResult[] = [];
  private teeStore: Map<string, string> = new Map();
  private teeCounter = 0;

  constructor(llm: LLMClient) {
    this.llm = llm;
  }

  setLocale(locale: Locale): void {
    this.locale = locale;
  }

  getPreFilterStats(): PreFilterResult[] {
    return [...this.preFilterStats];
  }

  getTotalPreFilterSavings(): { totalCharsRemoved: number; totalOriginal: number; callCount: number } {
    let totalCharsRemoved = 0;
    let totalOriginal = 0;
    for (const stat of this.preFilterStats) {
      totalCharsRemoved += stat.charsRemoved;
      totalOriginal += stat.originalLength;
    }
    return { totalCharsRemoved, totalOriginal, callCount: this.preFilterStats.length };
  }

  /**
   * Retrieve the original (pre-compression) text by tee ID.
   * Returns undefined if the ID doesn't exist or tee was not enabled.
   */
  teeRetrieve(teeId: string): string | undefined {
    return this.teeStore.get(teeId);
  }

  /** Number of tee entries currently stored */
  get teeSize(): number {
    return this.teeStore.size;
  }

  /** Discard a tee entry after it's no longer needed */
  teeDiscard(teeId: string): boolean {
    return this.teeStore.delete(teeId);
  }

  /** Clear all tee entries */
  teeClear(): void {
    this.teeStore.clear();
  }

  /**
   * Compress a piece of text to a target density.
   * Runs deterministic pre-filter first (zero token cost),
   * then LLM compression on the cleaned text.
   *
   * When `tee: true`, the original text is stored and can be
   * retrieved later via `teeRetrieve(result.teeId)` if the
   * compressed version turns out to have lost critical details.
   */
  async compress(
    text: string,
    level: CompressionLevel = 'standard',
    agent: AgentType = 'summarizer',
    phase: Phase = 'gather',
    options?: { tee?: boolean },
  ): Promise<CompressResult> {
    const originalLength = text.length;

    // Tee: store original before any transformation
    let teeId: string | undefined;
    if (options?.tee) {
      teeId = `tee-${++this.teeCounter}`;
      this.teeStore.set(teeId, text);

      // Evict oldest entries if over limit
      if (this.teeStore.size > MAX_TEE_ENTRIES) {
        const oldest = this.teeStore.keys().next().value;
        if (oldest) this.teeStore.delete(oldest);
      }
    }

    // Stage 1: Deterministic pre-filter (zero token cost)
    const pfResult = preFilter(text);
    const preFiltered = pfResult.filtered;
    this.preFilterStats.push(pfResult);
    if (this.preFilterStats.length > 100) this.preFilterStats.shift();

    // If already short enough after pre-filter, don't waste an API call
    if (preFiltered.length < 200 && level !== 'aggressive') {
      return {
        compressed: preFiltered,
        originalLength,
        compressedLength: preFiltered.length,
        ratio: originalLength / Math.max(preFiltered.length, 1),
        wasCompressed: pfResult.charsRemoved > 0,
        preFilterResult: pfResult,
        teeId,
      };
    }

    // Stage 2: LLM semantic compression on pre-filtered text
    const { content, usage } = await this.llm.chat(COMPRESSION_PROMPTS[level][this.locale], preFiltered, agent, phase);

    return {
      compressed: content,
      originalLength,
      compressedLength: content.length,
      ratio: originalLength / Math.max(content.length, 1),
      wasCompressed: true,
      tokensUsed: usage.inputTokens + usage.outputTokens,
      preFilterResult: pfResult,
      teeId,
    };
  }

  /**
   * Compress multiple items and merge them into one summary.
   * Used when the planner needs a briefing from multiple sources.
   */
  async compressAndMerge(
    items: Array<{ source: string; content: string }>,
    phase: Phase = 'gather',
  ): Promise<CompressResult> {
    const formatted = items.map((item) => `[${item.source}]: ${item.content}`).join('\n');

    return this.compress(formatted, 'standard', 'summarizer', phase);
  }
}

export interface CompressResult {
  compressed: string;
  originalLength: number;
  compressedLength: number;
  /** Compression ratio: original / compressed. Higher = more compression */
  ratio: number;
  wasCompressed: boolean;
  tokensUsed?: number;
  preFilterResult?: PreFilterResult;
  /** If tee was enabled, use this ID with `compressor.teeRetrieve(teeId)` to get the original */
  teeId?: string;
}
