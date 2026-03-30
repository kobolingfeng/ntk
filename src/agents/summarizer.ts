/**
 * Summarizer — Document/text compressor.
 *
 * Takes large text and makes it small.
 * Specialized for reading long documents, codebases, logs.
 */

import { BaseAgent } from '../core/base-agent.js';
import type { LLMClient } from '../core/llm.js';
import { SUMMARIZER_PROMPT } from '../core/prompts.js';

export class Summarizer extends BaseAgent {
  constructor(llm: LLMClient) {
    super('summarizer', llm);
  }

  getSystemPrompt(): string {
    return SUMMARIZER_PROMPT[this.locale];
  }
}
