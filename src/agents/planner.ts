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
import type { Message, AgentContext, Task } from '../core/protocol.js';
import { createMessage, createTask } from '../core/protocol.js';
import { PLANNER_PROMPT } from '../core/prompts.js';

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
    const validTargets = new Set(['scout', 'summarizer', 'executor']);
    const results: PlannerInstruction[] = [];

    for (const line of output.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // Format 1: → agent: instruction
      const arrowMatch = trimmed.match(/→\s*(\w+):\s*(.+)/);
      if (arrowMatch) {
        const target = validTargets.has(arrowMatch[1]) ? arrowMatch[1] : 'executor';
        results.push({ target: target as any, instruction: arrowMatch[2].trim() });
        continue;
      }

      // Format 2: [agent name][...]: instruction (GPT style)
      const bracketMatch = trimmed.match(/^\[([^\]]+)\](?:\[[^\]]*\])*[：:]\s*(.+)/);
      if (bracketMatch) {
        results.push({ target: 'executor' as const, instruction: bracketMatch[2].trim() });
        continue;
      }

      // Format 3: numbered list — 1. instruction or 1) instruction
      const numberedMatch = trimmed.match(/^\d+[.)、]\s*(.+)/);
      if (numberedMatch && trimmed.length > 20) {
        results.push({ target: 'executor' as const, instruction: numberedMatch[1].trim() });
        continue;
      }
    }

    return results;
  }

  /**
   * Create a plan from user request + gathered info.
   */
  async createPlan(
    userRequest: string,
    gatheredInfo: string
  ): Promise<{ plan: string; instructions: PlannerInstruction[] }> {
    const { PIPELINE_STRINGS } = await import('../core/prompts.js');
    const s = PIPELINE_STRINGS[this.locale];
    const prompt = gatheredInfo
      ? s.planPrompt(userRequest, gatheredInfo)
      : s.planPrompt(userRequest, '');

    const { content } = await this.llm.chat(
      this.getSystemPrompt(),
      prompt,
      'planner',
      'plan'
    );

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
    context: AgentContext
  ): Promise<{ decision: string; instructions: PlannerInstruction[] }> {
    const userPrompt = this.buildUserPrompt(
      createMessage('verifier', 'planner', 'status', statusUpdate),
      context
    );

    const { content } = await this.llm.chat(
      this.getSystemPrompt(),
      userPrompt,
      'planner',
      this.currentPhase
    );

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
