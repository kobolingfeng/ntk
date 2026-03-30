/**
 * Compressor — Takes large information and makes it small.
 *
 * This is the critical bridge between raw data and the planner's
 * limited attention. A good compressor means a smart planner.
 * A bad compressor means garbage in, garbage out.
 */

import type { LLMClient } from './llm.js';
import type { AgentType, Phase } from './protocol.js';

/** Compression level determines how aggressively we compress */
export type CompressionLevel = 'minimal' | 'standard' | 'aggressive';

const COMPRESSION_PROMPTS: Record<CompressionLevel, string> = {
  minimal: `压缩以下信息。保留所有关键细节，去掉修饰语。用最少的字表达。`,

  standard: `输入→结构化摘要。格式：
[核心]一句话描述
[数据]key=value，逗号分隔
[规则]编号列表，每条≤8字
[流程]用→连接`,

  aggressive: `用一句话总结以下信息的核心结论。只要结果，不要过程。`,
};

export class Compressor {
  private llm: LLMClient;

  constructor(llm: LLMClient) {
    this.llm = llm;
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
      COMPRESSION_PROMPTS[level],
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
