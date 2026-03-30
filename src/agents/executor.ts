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

export class Executor extends BaseAgent {
  constructor(llm: LLMClient) {
    super('executor', llm);
  }

  getSystemPrompt(): string {
    return `执行器。你的输出直接交给用户，必须完整可用。

规则：
1. 代码任务：输出完整代码+必要注释。不省略import/类型定义/错误处理
2. 分析任务：用编号列表，每条≤2句。不写段落式长文
3. 如果内容可能超限，按优先级输出：类型定义 > 核心逻辑 > 辅助方法
4. 禁止输出：教程性解释、"如果你还需要..."引导语、重复需求描述
5. 代码用\`\`\`包裹并标注语言

完成标记: [完成] 或 [分步:需要更多空间]`;
  }
}
