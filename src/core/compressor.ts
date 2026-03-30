/**
 * Compressor — Takes large information and makes it small.
 *
 * This is the critical bridge between raw data and the planner's
 * limited attention. A good compressor means a smart planner.
 * A bad compressor means garbage in, garbage out.
 */

import type { LLMClient } from './llm.js';
import type { AgentType, Phase } from './protocol.js';
import { COMPRESSION_PROMPTS, detectLocale, type Locale } from './prompts.js';

/** Compression level determines how aggressively we compress */
export type CompressionLevel = 'minimal' | 'standard' | 'aggressive';

export class Compressor {
  private llm: LLMClient;
  private locale: Locale = 'zh';

  constructor(llm: LLMClient) {
    this.llm = llm;
  }

  setLocale(locale: Locale): void {
    this.locale = locale;
  }

  /**
   * Compress a piece of text to a target density.
   * This is what low-info agents do before sending info to the planner.
   */
  async compress(
    text: string,
    level: CompressionLevel = 'standard',
    agent: AgentType = 'summarizer',
    phase: Phase = 'gather'
  ): Promise<CompressResult> {
    const originalLength = text.length;

    // If already short enough, don't waste an API call
    if (originalLength < 200 && level !== 'aggressive') {
      return {
        compressed: text,
        originalLength,
        compressedLength: originalLength,
        ratio: 1,
        wasCompressed: false,
      };
    }

    const { content, usage } = await this.llm.chat(
      COMPRESSION_PROMPTS[level][this.locale],
      text,
      agent,
      phase
    );

    return {
      compressed: content,
      originalLength,
      compressedLength: content.length,
      ratio: originalLength / Math.max(content.length, 1),
      wasCompressed: true,
      tokensUsed: usage.inputTokens + usage.outputTokens,
    };
  }

  /**
   * Compress multiple items and merge them into one summary.
   * Used when the planner needs a briefing from multiple sources.
   */
  async compressAndMerge(
    items: Array<{ source: string; content: string }>,
    phase: Phase = 'gather'
  ): Promise<CompressResult> {
    const formatted = items
      .map((item) => `[${item.source}]: ${item.content}`)
      .join('\n');

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
}
