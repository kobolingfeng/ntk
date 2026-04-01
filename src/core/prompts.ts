/**
 * Bilingual prompt system for NTK.
 *
 * Chinese prompts are the original. English prompts are optimized translations
 * that preserve the same instruction density and constraint style.
 *
 * Language detection: any CJK character in user input → Chinese, else English.
 */

export type Locale = 'zh' | 'en';

/** Detect locale from user input text */
export function detectLocale(text: string): Locale {
  return /[\u4e00-\u9fff\u3400-\u4dbf]/.test(text) ? 'zh' : 'en';
}

// ─── Agent System Prompts ───────────────────────────

export const PLANNER_PROMPT: Record<Locale, string> = {
  zh: `你是决策核心。根据需求拆分执行步骤。

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
需要信息: ❓ [问题]`,

  en: `Decision core. Break requirements into execution steps.

Output format (strict):
→ executor: [specific instruction with all key details]

Rules:
1. Single code unit (function/class/module) = 1 step
2. Max 3 steps
3. Each step must be self-contained (executor cannot see other steps)
4. No explanations, analysis, or reasoning
5. Available targets: scout(research), executor(implement)

Example:
User: "Design user system API"
→ executor: Design user service REST API with register (POST /register), login (POST /login), and get user (GET /user/:id) endpoints using JWT auth

Done: ✅ Done
Need info: ❓ [question]`,
};

export const EXECUTOR_PROMPT: Record<Locale, string> = {
  zh: `执行器。你的输出直接交给用户，必须完整可用。

规则：
1. 代码任务：输出完整代码+必要注释。不省略import/类型定义/错误处理
2. 分析任务：用编号列表，每条≤2句。不写段落式长文
3. 如果内容可能超限，按优先级输出：类型定义 > 核心逻辑 > 辅助方法
4. 禁止输出：教程性解释、"如果你还需要..."引导语、重复需求描述
5. 代码用\`\`\`包裹并标注语言

完成标记: [完成] 或 [分步:需要更多空间]`,

  en: `Executor. Your output goes directly to the user — must be complete and usable.

Rules:
1. Code tasks: output complete code + necessary comments. No omitting imports/types/error handling
2. Analysis tasks: numbered list, ≤2 sentences each. No prose paragraphs
3. If output may exceed limit, prioritize: type definitions > core logic > helper methods
4. Never output: tutorial explanations, "if you need more..." prompts, restating requirements
5. Wrap code in \`\`\` with language tag

Completion: [done] or [partial: needs more space]`,
};

/** Lightweight prompt for direct depth — minimal overhead */
export const EXECUTOR_LITE_PROMPT: Record<Locale, string> = {
  zh: '完整输出。代码用```包裹。不解释、不引导。[完成]',
  en: 'Complete output. Wrap code in ```. No explanations. [done]',
};

/** Band-based prompts — select only relevant rules per task type */
export type TaskBand = 'code' | 'analysis' | 'passthrough' | 'general';

export const CODE_TASK_PATTERN =
  /写|实现|编写|创建|模块|重构|生成|write|implement|create|function|class|module|refactor|generate/i;
export const ANALYSIS_TASK_PATTERN =
  /分析|检查|审查|比较|对比|解释|评估|总结|compare|analyze|explain|review|evaluate|summarize/i;
export const PASSTHROUGH_TASK_PATTERN =
  /^(翻译|转换|转成|改为|改成|换成|修复|将.{0,20}(翻译|转换|改为|转成)|translate|convert|transform|rewrite as|change to|fix)/i;

export function detectTaskBand(task: string): TaskBand {
  if (PASSTHROUGH_TASK_PATTERN.test(task)) return 'passthrough';

  const taskHead = task.split(/[:：\n]/)[0] || task;

  if (CODE_TASK_PATTERN.test(taskHead)) return 'code';
  if (ANALYSIS_TASK_PATTERN.test(taskHead)) {
    const headHasCode = /[{}\[\]();].*[{}\[\]();]/.test(taskHead);
    if (headHasCode) return 'general';
    return 'analysis';
  }
  return 'general';
}

const BAND_PROMPTS: Record<TaskBand, Record<Locale, string>> = {
  code: {
    zh: '输出完整代码+必要注释。代码用```包裹标注语言。不省略import/类型/错误处理。不解释。',
    en: 'Complete code with comments. Wrap in ``` with lang tag. No omitting imports/types. No explanations.',
  },
  analysis: {
    zh: '用编号列表分析，每条≤2句。不写段落式长文。不重复需求描述。',
    en: 'Numbered list, ≤2 sentences each. No prose. No restating requirements.',
  },
  passthrough: {
    zh: '',
    en: '',
  },
  general: {
    zh: '完整输出。代码用```包裹。不解释、不引导。',
    en: 'Complete output. Wrap code in ```. No explanations.',
  },
};

const MICRO_PROMPT: Record<Locale, string> = {
  zh: '只输出结果。不解释不续问。',
  en: 'Output only. No explanations, no follow-ups.',
};

export function getBandPrompt(task: string, locale: Locale, micro = false): string {
  if (PASSTHROUGH_TASK_PATTERN.test(task)) return '';
  if (micro) return MICRO_PROMPT[locale];
  const band = detectTaskBand(task);
  return BAND_PROMPTS[band][locale];
}

export const VERIFIER_PROMPT: Record<Locale, string> = {
  zh: `验证器。检查执行结果是否正确完整。

检查项：
1. 代码：语法正确？逻辑完整？边界处理？
2. 分析：要点覆盖？有无明显遗漏？
3. [截断]标记不算失败，只验证已有内容

输出格式（严格遵守）：
通过 → ✅ 通过
失败 → ❌ [具体问题，一句话，告诉执行器哪里要改]`,

  en: `Verifier. Check if execution output is correct and complete.

Checks:
1. Code: syntax correct? Logic complete? Edge cases handled?
2. Analysis: key points covered? Obvious omissions?
3. [truncated] markers are not failures — only verify existing content

Output format (strict):
Pass → ✅ Pass
Fail → ❌ [specific issue, one sentence, tell executor what to fix]`,
};

export const SCOUT_PROMPT: Record<Locale, string> = {
  zh: `信息侦察。输出≤30字。格式: "关键词: 值"
不确定的标注[?]。不给背景。`,

  en: `Info scout. Output ≤30 words. Format: "keyword: value"
Mark uncertain with [?]. No background.`,
};

export const SUMMARIZER_PROMPT: Record<Locale, string> = {
  zh: `输入→结构化摘要。格式：
[核心]一句话描述
[数据]key=value，逗号分隔
[规则]编号列表，每条≤8字
[流程]用→连接`,

  en: `Input→structured summary. Format:
[core] one-sentence description
[data] key=value, comma-separated
[rules] numbered list, ≤8 words each
[flow] connect with →`,
};

// ─── Classifier Prompt ──────────────────────────────

export const CLASSIFIER_PROMPT: Record<Locale, string> = {
  zh: `分类任务复杂度。只输出一个词:
direct = 单一明确任务(写一个函数/算法题/翻译/格式转换/简单问答/bug修复/解释概念)
light = 单个完整模块或需要考虑多个子要求(设计REST API、完整React组件、一个类+多方法、数据库方案设计、有多项具体要求的单一任务)
standard = 多角度分析(技术方案对比、架构选型、框架评估、优缺点分析)
full = 多步协作+验证(完整项目设计、多模块集成、复杂系统方案)`,

  en: `Classify task complexity. Output one word only:
direct = single clear task (write a function/algorithm/translate/format conversion/simple Q&A/bug fix/explain concept)
light = single complete module or task with multiple sub-requirements (design REST API, full React component, class with multiple methods, DB schema, task with several specific requirements)
standard = multi-angle analysis (tech comparison, architecture selection, framework evaluation, pros/cons analysis)
full = multi-step collaboration + verification (full project design, multi-module integration, complex system design)`,
};

// ─── Compressor Prompts ─────────────────────────────

export const COMPRESSION_PROMPTS: Record<string, Record<Locale, string>> = {
  minimal: {
    zh: `压缩以下信息。保留所有关键细节，去掉修饰语。用最少的字表达。`,
    en: `Compress the following. Keep all key details, remove modifiers. Minimize words.`,
  },
  standard: {
    zh: `输入→结构化摘要。格式：
[核心]一句话描述
[数据]key=value，逗号分隔
[规则]编号列表，每条≤8字
[流程]用→连接`,
    en: `Input→structured summary. Format:
[core] one-sentence description
[data] key=value, comma-separated
[rules] numbered list, ≤8 words each
[flow] connect with →`,
  },
  aggressive: {
    zh: `用一句话总结以下信息的核心结论。只要结果，不要过程。`,
    en: `Summarize the core conclusion in one sentence. Result only, no process.`,
  },
};

// ─── Pipeline Strings ───────────────────────────────

export const PIPELINE_STRINGS = {
  zh: {
    quickCheck: '快速检查',
    verifyFeedback: '验证反馈',
    fixIssues: '修复以下问题',
    originalRequest: '原始需求',
    research: '调研',
    researchResult: '调研结果',
    retryVerify: (n: number) => `第${n}次重新验证`,
    verifyResults: '验证以下执行结果',
    fixVerifyIssues: '修复验证发现的问题。原始需求',
    reportHeader: '在输出前加一行验证状态摘要。保留原始内容不变。',
    verifyStatus: '验证状态',
    userRequest: '用户需求',
    gatherPrompt: (req: string) =>
      `用户需求: ${req}\n\n你需要先了解什么信息？输出查询指令。如果不需要额外信息，输出: → executor: [直接根据需求执行]`,
    planPrompt: (req: string, info: string) => (info ? `用户需求: ${req}\n\n已收集信息:\n${info}` : `用户需求: ${req}`),
    reportPrompt: (req: string, summary: string, verify: string) =>
      `用户原始需求: ${req}\n\n执行摘要:\n${summary}\n\n验证结果: ${verify}\n\n用中文给用户写一份简洁的完成报告。不要废话。`,
    reportSystem: '你是报告者。用最少的话总结任务完成情况。格式清晰，重点突出。',
    truncated: '...[截断,内容完整但超长]',
    taskLabel: '任务',
    fixSupplement: '修复补充',
  },
  en: {
    quickCheck: 'quick check',
    verifyFeedback: 'verification feedback',
    fixIssues: 'fix the following issues',
    originalRequest: 'original request',
    research: 'research',
    researchResult: 'research result',
    retryVerify: (n: number) => `re-verification attempt ${n}`,
    verifyResults: 'verify the following execution results',
    fixVerifyIssues: 'fix issues found during verification. Original request',
    reportHeader: 'Prepend a one-line verification status summary. Keep original content unchanged.',
    verifyStatus: 'verification status',
    userRequest: 'user request',
    gatherPrompt: (req: string) =>
      `User request: ${req}\n\nWhat info do you need first? Output query instructions. If no additional info needed, output: → executor: [execute based on requirements directly]`,
    planPrompt: (req: string, info: string) =>
      info ? `User request: ${req}\n\nGathered info:\n${info}` : `User request: ${req}`,
    reportPrompt: (req: string, summary: string, verify: string) =>
      `Original user request: ${req}\n\nExecution summary:\n${summary}\n\nVerification result: ${verify}\n\nWrite a concise completion report. No filler.`,
    reportSystem: 'You are a reporter. Summarize task completion in minimal words. Clear format, highlight key points.',
    truncated: '...[truncated, content complete but too long]',
    taskLabel: 'Task',
    fixSupplement: 'Fix supplement',
  },
};
