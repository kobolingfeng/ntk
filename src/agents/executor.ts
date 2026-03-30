/**
 * Executor — The doer.
 *
 * Receives precise instructions and executes them.
 * Returns results in a compressed format.
 *
 * In a real implementation, this would:
 * - Write/modify code files
 * - Run terminal commands
 * - Generate artifacts
 *
 * For now, it generates the output content directly via LLM.
 */

import { BaseAgent } from '../core/base-agent.js';
import type { LLMClient } from '../core/llm.js';
import { EXECUTOR_PROMPT } from '../core/prompts.js';

export class Executor extends BaseAgent {
  constructor(llm: LLMClient) {
    super('executor', llm);
  }

  getSystemPrompt(): string {
    return EXECUTOR_PROMPT[this.locale];
  }
}
