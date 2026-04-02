/**
 * Pipeline classifier — task complexity classification.
 */

import type { LLMClient } from '../core/llm.js';
import { CLASSIFIER_PROMPT, PASSTHROUGH_TASK_PATTERN, type Locale } from '../core/prompts.js';
import type { PipelineDepth } from './types.js';

// ─── Pre-compiled regex patterns for fast-path classification ───
const CODE_UNIT = /^(写|实现|编写|创建|用\w+写|帮我写|请写).{0,30}(函数|function|算法|方法|脚本|工具|类|class)/;
const SIMPLE = /^(翻译|转换|解释|计算|修复|重构|分析这段|优化这|改写|将.{0,15}(翻译|转换|改为)|分析以下|以下是|帮我|请|给出)/;
const DIRECT_ZH = /^(写一个|写一|实现一个|用\w+实现|生成|输出|列出|什么是|如何|怎么|用.{0,15}(写|解释|计算|描述|说明|分析|创建|生成|实现)|对比|比较|介绍|说明|描述|总结|设计|编写|为.{0,20}(写|编写|创建|实现|开发|设计|构建))/;
const DIRECT_EN = /^(write|implement|create|generate|explain|what is|how to|convert|translate|fix|solve|calculate|find (all )?bugs|given|read the|extract|count|list|sort|return|check|validate|parse|format|output|review|refactor|debug|optimize|describe|define|analyze|summarize|design|build|add|compare|set up|configure)\b/i;
const EMBEDDED_DATA = /^(分析以下|以下是|分析这|分析下面|请分析|帮我分析|看看以下|检查以下|为以下|审查以下|审查这|对以下|给以下|review the|analyze the|check the|look at|debug this|fix this|write .{0,20}tests? for)/;
const TECH_NAME = /^[A-Za-z][A-Za-z0-9.+\-#/]*[\s的和与\u4e00-\u9fff]/;
const HAS_CJK = /[\u4e00-\u9fff]/;
const STANDARD_ZH = /比较.{2,20}(和|与|跟).{2,20}(优缺点|区别|差异|选型)|技术(方案)?选型|框架(评估|对比|选型)|从.{0,10}(方面|角度|维度)(分析|对比|评估)/;
const STANDARD_EN = /compare .{2,30}(?:and|vs|versus|with) .{2,30}(?:pros|cons|advantages|disadvantages|differences|similarities|trade.?offs?|strengths|weaknesses)|pros (?:and )?cons|trade.?offs? (?:of|between)|evaluate .{2,30}(?:frameworks?|approaches|options)|from .{2,30}(?:perspectives?|angles?|dimensions?)/i;
const FULL_ZH = /完整(项目|系统|方案)(设计|架构)|多模块.{0,10}(集成|协作)|系统(架构|设计).{0,15}(包含|涵盖|包括).{0,15}(模块|组件|服务)/;
const FULL_EN = /complete (project|system) (design|architecture)|multi.?module .{0,20}(integration|design)|system architecture .{0,20}(including|with|containing) .{0,20}(modules?|components?|services?)/i;

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

  // Tasks with embedded data (log/code/test output) — direct regardless of length
  if (EMBEDDED_DATA.test(userRequest)) return 'direct';

  // Complex-depth fast path — check BEFORE direct patterns to avoid mis-classifying
  // e.g. "比较React和Vue的优缺点" matches both DIRECT_ZH (比较) and STANDARD_ZH (比较...和...优缺点)
  if (STANDARD_ZH.test(userRequest) || STANDARD_EN.test(userRequest)) return 'standard';
  if (FULL_ZH.test(userRequest) || FULL_EN.test(userRequest)) return 'full';

  // Tasks starting with tech names (e.g. "Node.js的事件循环", "Redis缓存策略") — direct
  if (TECH_NAME.test(userRequest) && userRequest.length <= 200) return 'direct';

  if (
    CODE_UNIT.test(userRequest) ||
    SIMPLE.test(userRequest) ||
    DIRECT_ZH.test(userRequest) ||
    DIRECT_EN.test(userRequest)
  ) {
    if (userRequest.length > 200) {
      return null;
    }
    return 'direct';
  }

  const threshold = HAS_CJK.test(userRequest) ? 12 : 30;
  if (userRequest.length <= threshold) {
    return 'direct';
  }

  return null;
}
