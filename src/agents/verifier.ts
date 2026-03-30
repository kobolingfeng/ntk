/**
 * Verifier — Quality gate.
 *
 * Checks executor output. Part of the local loop (executor↔verifier).
 * Does NOT report details to planner — only pass/fail.
 *
 * This is a key NTK principle: the planner doesn't need to know
 * that test #37 failed because of a missing semicolon. It only
 * needs to know "failed, executor is fixing it" or "all passed".
 */

import { BaseAgent } from '../core/base-agent.js';
import type { LLMClient } from '../core/llm.js';
import { VERIFIER_PROMPT } from '../core/prompts.js';

export class Verifier extends BaseAgent {
  constructor(llm: LLMClient) {
    super('verifier', llm);
  }

  getSystemPrompt(): string {
    return VERIFIER_PROMPT[this.locale];
  }
}
