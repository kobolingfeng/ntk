/**
 * Scout — Information gatherer.
 *
 * Goes out, finds information, and compresses it.
 * The planner says "查X", the scout returns a 1-3 sentence answer.
 *
 * In a real implementation, this would integrate with:
 * - Web search APIs
 * - File system reading
 * - Code analysis tools
 * - Documentation scrapers
 *
 * For now, it uses the LLM's knowledge as the information source.
 */

import { BaseAgent } from '../core/base-agent.js';
import type { LLMClient } from '../core/llm.js';

export class Scout extends BaseAgent {
  constructor(llm: LLMClient) {
    super('scout', llm);
  }

  getSystemPrompt(): string {
    return `信息侦察。输出≤30字。格式: "关键词: 值"
不确定的标注[?]。不给背景。`;
  }
}
