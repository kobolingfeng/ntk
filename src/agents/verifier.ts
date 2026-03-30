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

export class Verifier extends BaseAgent {
  constructor(llm: LLMClient) {
    super('verifier', llm);
  }

  getSystemPrompt(): string {
    return `验证器。检查执行结果是否正确完整。

检查项：
1. 代码：语法正确？逻辑完整？边界处理？
2. 分析：要点覆盖？有无明显遗漏？
3. [截断]标记不算失败，只验证已有内容

输出格式（严格遵守）：
通过 → ✅ 通过
失败 → ❌ [具体问题，一句话，告诉执行器哪里要改]`;
  }
}
