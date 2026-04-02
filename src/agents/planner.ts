/**
 * Planner — The high-info agent. The brain.
 *
 * Receives compressed information from scouts/summarizers.
 * Outputs precise instructions to executors.
 *
 * System prompt is intentionally minimal (~50 tokens).
 * Every word earns its place.
 */

import { BaseAgent } from '../core/base-agent.js';
import type { LLMClient } from '../core/llm.js';
import { PLANNER_PROMPT, PIPELINE_STRINGS } from '../core/prompts.js';
import type { AgentContext } from '../core/protocol.js';
import { createMessage } from '../core/protocol.js';

// Precompiled patterns for parseInstructions
const ARROW_INSTRUCTION = /→\s*(\w+):\s*(.+)/;
const BRACKET_INSTRUCTION = /^\[([^\]]+)\](?:\[[^\]]*\])*[：:]\s*(.+)/;
const NUMBERED_INSTRUCTION = /^\d+[.)、]\s*(.+)/;
const VALID_TARGETS = new Set(['scout', 'summarizer', 'executor']);

export class Planner extends BaseAgent {
  constructor(llm: LLMClient) {
    super('planner', llm);
  }

  getSystemPrompt(): string {
    return PLANNER_PROMPT[this.locale];
  }

  /**
   * Parse planner output into actionable instructions.
   * Expected format:
   *   → scout: 查xxx
   *   → executor: 做xxx
   */
  parseInstructions(output: string): PlannerInstruction[] {
    const results: PlannerInstruction[] = [];

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Format 1: → agent: instruction
      const arrowMatch = trimmed.match(ARROW_INSTRUCTION);
      if (arrowMatch) {
        const target = VALID_TARGETS.has(arrowMatch[1]) ? arrowMatch[1] : 'executor';
        results.push({ target: target as any, instruction: arrowMatch[2].trim() });
        continue;
      }

      // Format 2: [agent name][...]: instruction (GPT style)
      const bracketMatch = trimmed.match(BRACKET_INSTRUCTION);
      if (bracketMatch) {
        const rawTarget = bracketMatch[1].trim().toLowerCase();
        const target = VALID_TARGETS.has(rawTarget) ? rawTarget : 'executor';
        const instruction = bracketMatch[2].trim();
        if (instruction.length >= 2) {
          results.push({ target: target as any, instruction });
        }
        continue;
      }

      // Format 3: numbered list — 1. instruction or 1) instruction
      const numberedMatch = trimmed.match(NUMBERED_INSTRUCTION);
      if (numberedMatch && numberedMatch[1].trim().length >= 2) {
        results.push({ target: 'executor' as const, instruction: numberedMatch[1].trim() });
      }
    }

    return results;
  }

  /**
   * Create a plan from user request + gathered info.
   */
  async createPlan(
    userRequest: string,
    gatheredInfo: string,
  ): Promise<{ plan: string; instructions: PlannerInstruction[] }> {
    const s = PIPELINE_STRINGS[this.locale];
    const prompt = gatheredInfo ? s.planPrompt(userRequest, gatheredInfo) : s.planPrompt(userRequest, '');

    const { content } = await this.llm.chat(this.getSystemPrompt(), prompt, 'planner', 'plan');

    return {
      plan: content,
      instructions: this.parseInstructions(content),
    };
  }

  /**
   * Decide what to do based on a status update.
   */
  async decide(
    statusUpdate: string,
    context: AgentContext,
  ): Promise<{ decision: string; instructions: PlannerInstruction[] }> {
    const userPrompt = this.buildUserPrompt(createMessage('verifier', 'planner', 'status', statusUpdate), context);

    const { content } = await this.llm.chat(this.getSystemPrompt(), userPrompt, 'planner', this.currentPhase);

    return {
      decision: content,
      instructions: this.parseInstructions(content),
    };
  }
}

export interface PlannerInstruction {
  target: 'scout' | 'summarizer' | 'executor' | 'verifier';
  instruction: string;
}
