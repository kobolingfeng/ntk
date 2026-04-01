/**
 * Pipeline classifier — task complexity classification.
 */

import type { LLMClient } from '../core/llm.js';
import { CLASSIFIER_PROMPT, PASSTHROUGH_TASK_PATTERN, type Locale } from '../core/prompts.js';
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
  // Fast path already checked by pipeline.run() before calling this function,
  // but guard against direct callers
  const fastResult = classifyDepthFastPath(userRequest);
  if (fastResult) return fastResult;

  const system = CLASSIFIER_PROMPT[locale];

  // Truncate long inputs for classifier — it only needs the task description, not the full payload
  const classifierInput = userRequest.length > 200 ? `${userRequest.slice(0, 200)}...` : userRequest;

  const { content } = await compressorLLM.chat(system, classifierInput, 'classifier', 'gather', 10, 0);

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
  // Passthrough tasks (translations, conversions, summaries) are always direct
  if (PASSTHROUGH_TASK_PATTERN.test(userRequest)) return 'direct';

  const codeUnitPattern = /^(写|实现|编写|创建|用\w+写|帮我写|请写).{0,30}(函数|function|算法|方法|脚本|工具|类|class)/;
  const simplePattern =
    /^(翻译|转换|解释|计算|修复|重构|分析这段|优化这|改写|将.{0,15}(翻译|转换|改为)|分析以下|以下是|帮我|请|给出)/;
  const directPattern =
    /^(写一个|写一|实现一个|用\w+实现|生成|输出|列出|什么是|如何|怎么|用.{0,15}(写|解释|计算|描述|说明|分析|创建|生成|实现)|对比|比较|介绍|说明|描述|总结|设计|编写|为.{0,20}(写|编写|创建|实现|开发|设计|构建))/;
  const directPatternEn =
    /^(write|implement|create|generate|explain|what is|how to|convert|translate|fix|solve|calculate|find (all )?bugs|given|read the|extract|count|list|sort|return|check|validate|parse|format|output|review|refactor|debug|optimize|describe|define|analyze|summarize|design|build|add|compare|set up|configure)\b/i;

  // Tasks with embedded data (log/code/test output) — direct regardless of length
  const embeddedDataPattern =
    /^(分析以下|以下是|分析这|分析下面|请分析|帮我分析|看看以下|检查以下|为以下|审查以下|审查这|对以下|给以下|review the|analyze the|check the|look at|debug this|fix this|write .{0,20}tests? for)/;
  if (embeddedDataPattern.test(userRequest)) {
    return 'direct';
  }

  // Tasks starting with tech names (e.g. "Node.js的事件循环", "Redis缓存策略") — direct
  const techNamePattern = /^[A-Za-z][A-Za-z0-9.+\-#/]*[\s的和与\u4e00-\u9fff]/;
  if (techNamePattern.test(userRequest) && userRequest.length <= 200) {
    return 'direct';
  }

  if (
    codeUnitPattern.test(userRequest) ||
    simplePattern.test(userRequest) ||
    directPattern.test(userRequest) ||
    directPatternEn.test(userRequest)
  ) {
    if (userRequest.length > 200) {
      return null;
    }
    return 'direct';
  }

  const hasCJK = /[\u4e00-\u9fff]/.test(userRequest);
  const threshold = hasCJK ? 12 : 30;
  if (userRequest.length <= threshold) {
    return 'direct';
  }

  // Complex-depth fast path — skip classifier for clearly non-direct tasks
  if (userRequest.length > 200) {
    // Standard: multi-angle analysis patterns
    const standardPatternZh = /比较.{2,20}(和|与|跟).{2,20}(优缺点|区别|差异|选型)|技术(方案)?选型|框架(评估|对比|选型)|从.{0,10}(方面|角度|维度)(分析|对比|评估)/;
    const standardPatternEn = /compare .{2,30}(and|vs|versus|with)|pros (?:and )?cons|trade.?offs? (?:of|between)|evaluate .{2,30}(frameworks?|approaches|options)|from .{2,30}(perspectives?|angles?|dimensions?)/i;
    if (standardPatternZh.test(userRequest) || standardPatternEn.test(userRequest)) {
      return 'standard';
    }

    // Full: multi-step collaboration patterns
    const fullPatternZh = /完整(项目|系统|方案)(设计|架构)|多模块.{0,10}(集成|协作)|系统(架构|设计).{0,15}(包含|涵盖|包括).{0,15}(模块|组件|服务)/;
    const fullPatternEn = /complete (project|system) (design|architecture)|multi.?module .{0,20}(integration|design)|system architecture .{0,20}(including|with|containing) .{0,20}(modules?|components?|services?)/i;
    if (fullPatternZh.test(userRequest) || fullPatternEn.test(userRequest)) {
      return 'full';
    }
  }

  return null;
}
