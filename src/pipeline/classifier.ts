/**
 * Pipeline classifier — task complexity classification.
 */

import type { LLMClient } from '../core/llm.js';
import { CLASSIFIER_PROMPT, type Locale } from '../core/prompts.js';
import type { PipelineDepth } from './types.js';

/**
 * Classify task complexity using cheap model (~50 tokens).
 * Returns the pipeline depth to use.
 */
export async function classifyDepth(
  userRequest: string,
  compressorLLM: LLMClient,
  locale: Locale,
): Promise<PipelineDepth> {
  // Fast path: obvious single-code-unit tasks (regex, no LLM cost)
  const fastResult = classifyDepthFastPath(userRequest);
  if (fastResult) return fastResult;

  // Short requests (≤30 chars) are almost always direct
  if (userRequest.length <= 30) {
    return 'direct';
  }

  const system = CLASSIFIER_PROMPT[locale];

  // Truncate long inputs for classifier — it only needs the task description, not the full payload
  const classifierInput = userRequest.length > 200 ? `${userRequest.slice(0, 200)}...` : userRequest;

  const { content } = await compressorLLM.chat(system, classifierInput, 'classifier', 'gather', 10);

  const word = content.trim().toLowerCase();
  if (word.includes('direct')) return 'direct';
  if (word.includes('light')) return 'light';
  if (word.includes('standard')) return 'standard';
  return 'full';
}

/**
 * Fast path regex classification (no LLM cost).
 * Exported for testing.
 */
export function classifyDepthFastPath(userRequest: string): PipelineDepth | null {
  const codeUnitPattern = /^(写|实现|编写|创建|用\w+写|帮我写|请写).{0,30}(函数|function|算法|方法|脚本|工具|类|class)/;
  const simplePattern = /^(翻译|转换|解释|计算|修复|重构|分析这段|优化这|改写|将.{0,15}(翻译|转换|改为))/;
  const directPattern = /^(写一个|实现一个|用\w+实现|生成|输出|列出|什么是|如何|怎么)/;
  const directPatternEn =
    /^(write|implement|create|generate|explain|what is|how to|convert|translate|fix|solve|calculate|find (all )?bugs|given|read the|extract|count|list|sort|return|check|validate|parse|format|output|review|refactor|debug|optimize|describe|define)\b/i;

  if (
    codeUnitPattern.test(userRequest) ||
    simplePattern.test(userRequest) ||
    directPattern.test(userRequest) ||
    directPatternEn.test(userRequest)
  ) {
    // Long inputs that happen to start with a fast-path keyword may still be complex
    if (userRequest.length > 100) {
      return null; // Fall through to classifier
    }
    return 'direct';
  }

  if (userRequest.length <= 30) {
    return 'direct';
  }

  return null; // needs LLM classification
}
