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

export class Planner extends BaseAgent {
  constructor(llm: LLMClient) {
    super('planner', llm);
  }

  getSystemPrompt(): string {
    return `你是决策核心。根据需求拆分执行步骤。

输出格式（严格遵守）：
→ executor: [具体指令，包含所有关键细节]

规则：
1. 代码实现类任务（一个函数/类/模块）= 1步
2. 最多3步，不超过
3. 每步指令必须自包含（执行器看不到其他步骤的结果）
4. 不输出解释、分析、理由
5. 可用目标: scout(查信息), executor(执行)

示例：
用户: "设计用户系统API"
→ executor: 设计用户服务REST API，包含注册(POST /register)、登录(POST /login)、获取信息(GET /user/:id)接口，使用JWT认证

完成: ✅ 完成
需要信息: ❓ [问题]`;
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
    const prompt = gatheredInfo
      ? `用户需求: ${userRequest}\n\n已收集信息:\n${gatheredInfo}`
      : `用户需求: ${userRequest}`;

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
