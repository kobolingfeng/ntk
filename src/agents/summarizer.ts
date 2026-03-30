/**
 * Summarizer — Document/text compressor.
 *
 * Takes large text and makes it small.
 * Specialized for reading long documents, codebases, logs.
 */

import { BaseAgent } from '../core/base-agent.js';
import type { LLMClient } from '../core/llm.js';

export class Summarizer extends BaseAgent {
  constructor(llm: LLMClient) {
    super('summarizer', llm);
  }

  getSystemPrompt(): string {
    return `输入→结构化摘要。格式：
[核心]一句话描述
[数据]key=value，逗号分隔
[规则]编号列表，每条≤8字
[流程]用→连接`;
  }
}
