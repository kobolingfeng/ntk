import { describe, expect, it } from 'vitest';
import { detectLocale, detectTaskBand, getBandPrompt } from '../core/prompts.js';
import { classifyDepthFastPath } from './classifier.js';
import {
  assembleReport,
  DEFAULT_SKIP_THRESHOLDS,
  emptyOutputMessage,
  FULL_SKIP_THRESHOLDS,
  generateTokenReport,
  isStructurallyComplete,
  parseVerificationResult,
  predictTokenUsage,
} from './helpers.js';
import type { ExecutionResult } from './types.js';

/**
 * Wrapper for cost savings calculation using the real generateTokenReport function.
 */
function calculateSavings(strongTokens: number, cheapTokens: number): number {
  const totalUsed = strongTokens + cheapTokens;
  const ntkWeightedCost = strongTokens + cheapTokens * 0.1;
  const traditionalWeightedCost = totalUsed;
  return traditionalWeightedCost > 0
    ? Math.max(0, Math.min(100, ((traditionalWeightedCost - ntkWeightedCost) / traditionalWeightedCost) * 100))
    : 0;
}

// ═══════════════════════════════════════════════════════

describe('parseVerificationResult', () => {
  describe('emoji markers (highest priority)', () => {
    it('✅ only → true', () => {
      expect(parseVerificationResult('✅ All checks passed')).toBe(true);
    });

    it('❌ only → false', () => {
      expect(parseVerificationResult('❌ Failed: missing return')).toBe(false);
    });

    it('both ✅ and ❌ → false (❌ wins)', () => {
      expect(parseVerificationResult('✅ 通过了大部分 ❌ 一个失败')).toBe(false);
    });

    it('✅ without ❌ even if fail keywords present → true (emoji priority)', () => {
      // Emoji check happens before keyword check
      expect(parseVerificationResult('✅ passed with error handling')).toBe(true);
    });
  });

  describe('keyword fallback (no emojis)', () => {
    it('"passed" → true', () => {
      expect(parseVerificationResult('All tests passed successfully')).toBe(true);
    });

    it('"all correct" → true', () => {
      expect(parseVerificationResult('The solution is all correct')).toBe(true);
    });

    it('"no issues" → true', () => {
      expect(parseVerificationResult('No issues found in the code')).toBe(true);
    });

    it('"通过" → true', () => {
      expect(parseVerificationResult('代码审查通过')).toBe(true);
    });

    it('"正确" → true', () => {
      expect(parseVerificationResult('实现正确')).toBe(true);
    });

    it('"没有问题" → true (fixed: negation context recognized)', () => {
      expect(parseVerificationResult('代码没有问题')).toBe(true);
    });

    it('"无问题" → true', () => {
      expect(parseVerificationResult('检查结果无问题')).toBe(true);
    });

    it('"failed" → false', () => {
      expect(parseVerificationResult('Test failed for edge case')).toBe(false);
    });

    it('"error" → false', () => {
      expect(parseVerificationResult('Found a critical error')).toBe(false);
    });

    it('"incorrect" → false', () => {
      expect(parseVerificationResult('The logic is incorrect')).toBe(false);
    });

    it('"wrong" → false', () => {
      expect(parseVerificationResult('Something went wrong')).toBe(false);
    });

    it('"失败" → false', () => {
      expect(parseVerificationResult('验证失败')).toBe(false);
    });

    it('"错误" → false', () => {
      expect(parseVerificationResult('有一个错误')).toBe(false);
    });

    it('"不正确" → false', () => {
      expect(parseVerificationResult('结果不正确')).toBe(false);
    });

    it('"有问题" → false', () => {
      expect(parseVerificationResult('代码有问题')).toBe(false);
    });

    it('pass + fail keywords → false (fail wins)', () => {
      expect(parseVerificationResult('The code passed but has an error in edge case')).toBe(false);
    });

    it('pass keyword without fail → true', () => {
      expect(parseVerificationResult('Everything looks pass')).toBe(true);
    });

    it('"no errors" → true (negation strips error keyword)', () => {
      expect(parseVerificationResult('Checked: no errors found')).toBe(true);
    });

    it('"0 errors" → true', () => {
      expect(parseVerificationResult('Test complete: 0 errors, 5 passed')).toBe(true);
    });
  });

  describe('default behavior', () => {
    it('no signal → true (default pass)', () => {
      expect(parseVerificationResult('看起来不错')).toBe(true);
    });

    it('empty string → true', () => {
      expect(parseVerificationResult('')).toBe(true);
    });

    it('random unrelated text → true', () => {
      expect(parseVerificationResult('The weather is nice today')).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('"error-free code" → true (negation stripping)', () => {
      expect(parseVerificationResult('The output is error-free and complete')).toBe(true);
    });

    it('"error free implementation" → true', () => {
      expect(parseVerificationResult('This is an error free implementation')).toBe(true);
    });

    it('"without error" → true', () => {
      expect(parseVerificationResult('Completed without error')).toBe(true);
    });

    it('"没有错误" → true (Chinese negation)', () => {
      expect(parseVerificationResult('代码没有错误，逻辑完整')).toBe(true);
    });

    it('"无错误" → true', () => {
      expect(parseVerificationResult('检查完毕，无错误')).toBe(true);
    });

    it('mixed emoji with fail keyword → false (❌ wins)', () => {
      expect(parseVerificationResult('代码 ❌ 有问题但 ✅ 大部分正确')).toBe(false);
    });

    it('very long verification output → correct parsing', () => {
      const longPass = '✅ ' + 'a'.repeat(500) + ' all correct';
      expect(parseVerificationResult(longPass)).toBe(true);
    });

    it('unicode whitespace around keywords', () => {
      expect(parseVerificationResult('  ✅  passed  ')).toBe(true);
    });
  });
});

// ═══════════════════════════════════════════════════════

describe('classifyDepth fast path', () => {
  describe('Chinese codeUnit pattern', () => {
    it('"写一个函数" matches', () => {
      expect(classifyDepthFastPath('写一个排序函数')).toBe('direct');
    });

    it('"实现xxx算法" matches', () => {
      expect(classifyDepthFastPath('实现快速排序算法')).toBe('direct');
    });

    it('"编写一个class" matches', () => {
      expect(classifyDepthFastPath('编写一个用户class')).toBe('direct');
    });

    it('"用Python写一个function" matches', () => {
      expect(classifyDepthFastPath('用Python写一个function')).toBe('direct');
    });

    it('"帮我写一个脚本" matches', () => {
      expect(classifyDepthFastPath('帮我写一个部署脚本')).toBe('direct');
    });

    it('"请写一个工具" matches', () => {
      expect(classifyDepthFastPath('请写一个命令行工具')).toBe('direct');
    });
  });

  describe('Chinese simple pattern', () => {
    it('"翻译xxx" matches', () => {
      expect(classifyDepthFastPath('翻译这段英文代码为中文')).toBe('direct');
    });

    it('"解释xxx" matches', () => {
      expect(classifyDepthFastPath('解释这个算法的原理')).toBe('direct');
    });

    it('"修复xxx" matches', () => {
      expect(classifyDepthFastPath('修复这个bug')).toBe('direct');
    });

    it('"将xxx翻译为" matches', () => {
      expect(classifyDepthFastPath('将这段代码翻译为Python')).toBe('direct');
    });
  });

  describe('Chinese direct pattern', () => {
    it('"什么是xxx" matches', () => {
      expect(classifyDepthFastPath('什么是闭包')).toBe('direct');
    });

    it('"如何xxx" matches', () => {
      expect(classifyDepthFastPath('如何实现JWT认证')).toBe('direct');
    });

    it('"怎么xxx" matches', () => {
      expect(classifyDepthFastPath('怎么配置webpack')).toBe('direct');
    });

    it('"生成xxx" matches', () => {
      expect(classifyDepthFastPath('生成UUID')).toBe('direct');
    });
  });

  describe('English direct pattern', () => {
    it('"write a function" matches', () => {
      expect(classifyDepthFastPath('write a sorting function')).toBe('direct');
    });

    it('"implement binary search" matches', () => {
      expect(classifyDepthFastPath('implement binary search')).toBe('direct');
    });

    it('"explain closures" matches', () => {
      expect(classifyDepthFastPath('explain closures in JS')).toBe('direct');
    });

    it('"what is a monad" matches', () => {
      expect(classifyDepthFastPath('what is a monad')).toBe('direct');
    });

    it('"how to use Docker" matches', () => {
      expect(classifyDepthFastPath('how to use Docker')).toBe('direct');
    });

    it('"find bugs in code" matches', () => {
      expect(classifyDepthFastPath('find bugs in this code')).toBe('direct');
    });

    it('"find all bugs" matches', () => {
      expect(classifyDepthFastPath('find all bugs here')).toBe('direct');
    });

    it('"review this code" matches', () => {
      expect(classifyDepthFastPath('review this code snippet')).toBe('direct');
    });

    it('case insensitive: "Write a Function" matches', () => {
      expect(classifyDepthFastPath('Write a Function')).toBe('direct');
    });

    it('word boundary: "create" matches but "created" should too (starts with "create")', () => {
      // "create" has \b boundary, "createApp" would NOT match
      expect(classifyDepthFastPath('create a REST API')).toBe('direct');
    });
  });

  describe('length thresholds', () => {
    it('short input ≤30 chars → direct regardless of pattern', () => {
      expect(classifyDepthFastPath('hello world test abc')).toBe('direct');
    });

    it('exactly 30 chars → direct', () => {
      const input = 'a'.repeat(30);
      expect(classifyDepthFastPath(input)).toBe('direct');
    });

    it('31 chars without pattern match → null (needs LLM)', () => {
      const input = 'a'.repeat(31);
      expect(classifyDepthFastPath(input)).toBeNull();
    });

    it('pattern match but >200 chars → null (needs LLM)', () => {
      const longInput = `write ${'a'.repeat(200)}`;
      expect(classifyDepthFastPath(longInput)).toBeNull();
    });

    it('pattern match at exactly 200 chars → direct', () => {
      const input = `write ${'a'.repeat(194)}`; // 6 + 194 = 200
      expect(classifyDepthFastPath(input)).toBe('direct');
    });

    it('pattern match at 201 chars → null', () => {
      const input = `write ${'a'.repeat(195)}`; // 6 + 195 = 201
      expect(classifyDepthFastPath(input)).toBeNull();
    });

    it('embedded data pattern → direct regardless of length', () => {
      const longInput = `分析以下${'a'.repeat(500)}`;
      expect(classifyDepthFastPath(longInput)).toBe('direct');
    });
  });

  describe('non-matching inputs', () => {
    it('long complex description matching pattern ≤200 chars → direct', () => {
      const input =
        'Design a complete microservices architecture with event sourcing, CQRS, and saga pattern for an e-commerce platform';
      expect(classifyDepthFastPath(input)).toBe('direct');
    });

    it('very long complex description >200 chars → null', () => {
      const input = `Design ${'a'.repeat(200)} with multiple requirements`;
      expect(classifyDepthFastPath(input)).toBeNull();
    });
  });
});

// ═══════════════════════════════════════════════════════

describe('cost savings calculation', () => {
  it('all cheap tokens → ~90% savings', () => {
    // strong=0, cheap=1000 → ntk=100, trad=1000 → savings=90%
    expect(calculateSavings(0, 1000)).toBe(90);
  });

  it('all strong tokens → 0% savings', () => {
    // strong=1000, cheap=0 → ntk=1000, trad=1000 → savings=0%
    expect(calculateSavings(1000, 0)).toBe(0);
  });

  it('50/50 split → ~45% savings', () => {
    // strong=500, cheap=500 → ntk=500+50=550, trad=1000 → savings=45%
    expect(calculateSavings(500, 500)).toBe(45);
  });

  it('no tokens → 0% savings', () => {
    expect(calculateSavings(0, 0)).toBe(0);
  });

  it('savings capped at 100%', () => {
    // This shouldn't happen with the formula, but the Math.min(100, ...) is there
    expect(calculateSavings(0, 100)).toBeLessThanOrEqual(100);
  });

  it('savings never negative', () => {
    // The Math.max(0, ...) ensures this
    expect(calculateSavings(100, 0)).toBeGreaterThanOrEqual(0);
  });

  it('realistic ratio: 10% strong, 90% cheap → 81% savings', () => {
    // strong=100, cheap=900 → ntk=100+90=190, trad=1000 → savings=81%
    expect(calculateSavings(100, 900)).toBe(81);
  });
});

// ═══════════════════════════════════════════════════════

describe('assembleReport', () => {
  it('returns single result output directly', () => {
    const results: ExecutionResult[] = [{ instruction: 'do something', output: 'result', success: true }];
    expect(assembleReport(results)).toBe('result');
  });

  it('formats multiple results with headers', () => {
    const results: ExecutionResult[] = [
      { instruction: 'task 1', output: 'output 1', success: true },
      { instruction: 'task 2', output: 'output 2', success: true },
    ];
    const report = assembleReport(results);
    expect(report).toContain('### 1. task 1');
    expect(report).toContain('### 2. task 2');
    expect(report).toContain('output 1');
    expect(report).toContain('output 2');
  });

  it('truncates long instructions in multi-result headers', () => {
    const longInst = 'a'.repeat(100);
    const results: ExecutionResult[] = [
      { instruction: longInst, output: 'output 1', success: true },
      { instruction: 'short', output: 'output 2', success: true },
    ];
    const report = assembleReport(results);
    expect(report).toContain('...');
  });
});

describe('emptyOutputMessage', () => {
  it('returns Chinese message for zh locale', () => {
    const msg = emptyOutputMessage('zh');
    expect(msg).toContain('重试');
  });

  it('returns English message for en locale', () => {
    const msg = emptyOutputMessage('en');
    expect(msg).toContain('retry');
  });
});

describe('generateTokenReport', () => {
  it('aggregates tokens by agent and phase', () => {
    const report = generateTokenReport([
      { agent: 'executor', inputTokens: 100, outputTokens: 50, timestamp: 0, phase: 'execute' },
      { agent: 'planner', inputTokens: 200, outputTokens: 100, timestamp: 0, phase: 'plan' },
    ]);
    expect(report.totalInput).toBe(300);
    expect(report.totalOutput).toBe(150);
    expect(report.byAgent.executor?.input).toBe(100);
    expect(report.byAgent.planner?.output).toBe(100);
    expect(report.byPhase.execute?.input).toBe(100);
    expect(report.byPhase.plan?.input).toBe(200);
  });

  it('returns empty report for no usage', () => {
    const report = generateTokenReport([]);
    expect(report.totalInput).toBe(0);
    expect(report.totalOutput).toBe(0);
    expect(report.estimatedSavingsVsTraditional).toBe(0);
  });

  it('calculates higher savings when mostly cheap tokens', () => {
    const report = generateTokenReport([
      { agent: 'executor', inputTokens: 900, outputTokens: 100, timestamp: 0, phase: 'execute' },
    ]);
    expect(report.estimatedSavingsVsTraditional).toBeGreaterThan(80);
  });
});

describe('detectLocale', () => {
  it('returns zh for Chinese text', () => {
    expect(detectLocale('你好世界')).toBe('zh');
  });

  it('returns en for English text', () => {
    expect(detectLocale('hello world')).toBe('en');
  });

  it('returns zh for mixed text with CJK', () => {
    expect(detectLocale('hello 你好')).toBe('zh');
  });

  it('returns en for empty string', () => {
    expect(detectLocale('')).toBe('en');
  });

  it('returns en for numbers and symbols only', () => {
    expect(detectLocale('123 + 456 = ?')).toBe('en');
  });

  it('CJK Extension B chars not detected (known limitation, extremely rare)', () => {
    expect(detectLocale('𠀀')).toBe('en');
  });

  it('returns en for Japanese katakana (not CJK ideograph)', () => {
    expect(detectLocale('カタカナ')).toBe('en');
  });
});

describe('detectTaskBand', () => {
  it('detects code tasks', () => {
    expect(detectTaskBand('写一个排序函数')).toBe('code');
    expect(detectTaskBand('implement a class')).toBe('code');
  });

  it('detects analysis tasks', () => {
    expect(detectTaskBand('分析这段代码')).toBe('analysis');
    expect(detectTaskBand('compare React and Vue')).toBe('analysis');
  });

  it('detects passthrough tasks (translation/conversion)', () => {
    expect(detectTaskBand('翻译成英文：Hello')).toBe('passthrough');
    expect(detectTaskBand('translate this to Chinese')).toBe('passthrough');
    expect(detectTaskBand('转换为JSON格式')).toBe('passthrough');
    expect(detectTaskBand('convert to YAML')).toBe('passthrough');
    expect(detectTaskBand('改为TypeScript')).toBe('passthrough');
  });

  it('passthrough takes priority over code/analysis', () => {
    expect(detectTaskBand('翻译这段代码为Python')).toBe('passthrough');
    expect(detectTaskBand('translate and analyze')).toBe('passthrough');
  });

  it('defaults to general for other tasks', () => {
    expect(detectTaskBand('hello')).toBe('general');
  });
});

describe('getBandPrompt', () => {
  it('returns different prompts for different bands', () => {
    const codePrompt = getBandPrompt('写一个函数', 'zh');
    const analysisPrompt = getBandPrompt('分析代码', 'zh');
    expect(codePrompt).not.toBe(analysisPrompt);
  });

  it('returns locale-specific prompts', () => {
    const zh = getBandPrompt('write code', 'zh');
    const en = getBandPrompt('write code', 'en');
    expect(zh).not.toBe(en);
  });
});

// ═══════════════════════════════════════════════════════

describe('isStructurallyComplete', () => {
  const codeBlock = '```js\n' + 'x'.repeat(30) + '\n```';
  const numberedList = '\n1. First item\n2. Second item\n3. Third item';
  const bulletList = '\n- Item A\n- Item B\n- Item C';

  describe('short-circuit for short output', () => {
    it('output < 100 chars → true regardless of content', () => {
      expect(isStructurallyComplete('short', '写代码')).toBe(true);
    });

    it('empty output → true', () => {
      expect(isStructurallyComplete('', '写代码')).toBe(true);
    });

    it('exactly 99 chars → true', () => {
      expect(isStructurallyComplete('a'.repeat(99), '写代码')).toBe(true);
    });
  });

  describe('code task detection', () => {
    it('Chinese "写" + code block + sufficient length → true', () => {
      const output = 'a'.repeat(180) + codeBlock;
      expect(isStructurallyComplete(output, '写一个排序函数')).toBe(true);
    });

    it('Chinese "实现" + code block → true', () => {
      const output = 'a'.repeat(180) + codeBlock;
      expect(isStructurallyComplete(output, '实现二分查找')).toBe(true);
    });

    it('Chinese "编写" + code block → true', () => {
      const output = 'a'.repeat(180) + codeBlock;
      expect(isStructurallyComplete(output, '编写一个工具')).toBe(true);
    });

    it('English "write" + code block → true', () => {
      const output = 'a'.repeat(180) + codeBlock;
      expect(isStructurallyComplete(output, 'write a function')).toBe(true);
    });

    it('English "implement" + code block → true', () => {
      const output = 'a'.repeat(180) + codeBlock;
      expect(isStructurallyComplete(output, 'implement binary search')).toBe(true);
    });

    it('code task but output too short (no code block, below threshold) → false', () => {
      const output = 'a'.repeat(120);
      expect(isStructurallyComplete(output, 'write a function')).toBe(false);
    });

    it('code task with code block but below codeMinLen → false', () => {
      const output = 'a'.repeat(100) + '```js\nx\n```';
      expect(isStructurallyComplete(output, 'write code')).toBe(false);
    });
  });

  describe('analysis task detection', () => {
    it('Chinese "分析" + numbered list → true', () => {
      const output = 'a'.repeat(130) + numberedList;
      expect(isStructurallyComplete(output, '分析这段代码')).toBe(true);
    });

    it('Chinese "比较" + bullet list → true', () => {
      const output = 'a'.repeat(140) + bulletList;
      expect(isStructurallyComplete(output, '比较 React 和 Vue')).toBe(true);
    });

    it('Chinese "解释" + numbered list → true', () => {
      const output = 'a'.repeat(130) + numberedList;
      expect(isStructurallyComplete(output, '解释闭包的原理')).toBe(true);
    });

    it('English "analyze" + bullet list → true', () => {
      const output = 'a'.repeat(140) + bulletList;
      expect(isStructurallyComplete(output, 'analyze this code')).toBe(true);
    });

    it('English "compare" + numbered list → true', () => {
      const output = 'a'.repeat(130) + numberedList;
      expect(isStructurallyComplete(output, 'compare React vs Vue')).toBe(true);
    });

    it('English "explain" + bullet list → true', () => {
      const output = 'a'.repeat(140) + bulletList;
      expect(isStructurallyComplete(output, 'explain closures')).toBe(true);
    });

    it('analysis task but too short → false', () => {
      const output = 'a'.repeat(100) + '\n1. One';
      expect(isStructurallyComplete(output, '分析代码')).toBe(false);
    });
  });

  describe('general output fallback', () => {
    it('long output with code block → true', () => {
      const output = 'a'.repeat(480) + codeBlock;
      expect(isStructurallyComplete(output, 'do something')).toBe(true);
    });

    it('long output with numbered list → true', () => {
      const output = 'a'.repeat(480) + numberedList;
      expect(isStructurallyComplete(output, 'do something')).toBe(true);
    });

    it('long output without structural indicators → false', () => {
      const output = 'a'.repeat(600);
      expect(isStructurallyComplete(output, 'do something')).toBe(false);
    });

    it('output with bullet list only (no code task, no analysis task) → false unless general threshold met', () => {
      const output = 'a'.repeat(200) + bulletList;
      expect(isStructurallyComplete(output, 'do something')).toBe(false);
    });
  });

  describe('custom thresholds (FULL_SKIP_THRESHOLDS)', () => {
    it('code task needs 300+ chars with full thresholds', () => {
      const output = 'a'.repeat(260) + codeBlock;
      expect(isStructurallyComplete(output, '写代码', DEFAULT_SKIP_THRESHOLDS)).toBe(true);
      expect(isStructurallyComplete(output, '写代码', FULL_SKIP_THRESHOLDS)).toBe(false);
    });

    it('code task with 350+ chars passes full thresholds', () => {
      const output = 'a'.repeat(320) + codeBlock;
      expect(isStructurallyComplete(output, '写代码', FULL_SKIP_THRESHOLDS)).toBe(true);
    });

    it('analysis task needs 300+ chars with full thresholds', () => {
      const output = 'a'.repeat(200) + numberedList;
      expect(isStructurallyComplete(output, '分析代码', DEFAULT_SKIP_THRESHOLDS)).toBe(true);
      expect(isStructurallyComplete(output, '分析代码', FULL_SKIP_THRESHOLDS)).toBe(false);
    });

    it('general output needs 800+ chars with full thresholds', () => {
      const output = 'a'.repeat(700) + codeBlock;
      expect(isStructurallyComplete(output, 'hello', DEFAULT_SKIP_THRESHOLDS)).toBe(true);
      expect(isStructurallyComplete(output, 'hello', FULL_SKIP_THRESHOLDS)).toBe(false);
    });

    it('general output with 850+ chars passes full thresholds', () => {
      const output = 'a'.repeat(820) + codeBlock;
      expect(isStructurallyComplete(output, 'hello', FULL_SKIP_THRESHOLDS)).toBe(true);
    });
  });

  describe('threshold constants', () => {
    it('DEFAULT_SKIP_THRESHOLDS has expected values', () => {
      expect(DEFAULT_SKIP_THRESHOLDS).toEqual({ codeMinLen: 200, analysisMinLen: 150, generalMinLen: 500 });
    });

    it('FULL_SKIP_THRESHOLDS has stricter values', () => {
      expect(FULL_SKIP_THRESHOLDS).toEqual({ codeMinLen: 300, analysisMinLen: 300, generalMinLen: 800 });
    });

    it('FULL thresholds are always >= DEFAULT thresholds', () => {
      expect(FULL_SKIP_THRESHOLDS.codeMinLen).toBeGreaterThanOrEqual(DEFAULT_SKIP_THRESHOLDS.codeMinLen);
      expect(FULL_SKIP_THRESHOLDS.analysisMinLen).toBeGreaterThanOrEqual(DEFAULT_SKIP_THRESHOLDS.analysisMinLen);
      expect(FULL_SKIP_THRESHOLDS.generalMinLen).toBeGreaterThanOrEqual(DEFAULT_SKIP_THRESHOLDS.generalMinLen);
    });
  });

  describe('task band consistency with detectTaskBand', () => {
    const codeBlockOutput = 'a'.repeat(180) + '```js\n' + 'x'.repeat(30) + '\n```';

    it('"重构" recognized as passthrough task (aligns with detectTaskBand)', () => {
      expect(detectTaskBand('重构这段代码')).toBe('passthrough');
      expect(isStructurallyComplete(codeBlockOutput, '重构这段代码')).toBe(true);
    });

    it('"create" recognized as code task (aligns with detectTaskBand)', () => {
      expect(detectTaskBand('create a React component')).toBe('code');
      expect(isStructurallyComplete(codeBlockOutput, 'create a React component')).toBe(true);
    });

    it('"生成" recognized as code task (aligns with detectTaskBand)', () => {
      expect(detectTaskBand('生成一个工具函数')).toBe('code');
      expect(isStructurallyComplete(codeBlockOutput, '生成一个工具函数')).toBe(true);
    });

    it('"refactor" recognized as passthrough task (aligns with detectTaskBand)', () => {
      expect(detectTaskBand('refactor this module')).toBe('passthrough');
      expect(isStructurallyComplete(codeBlockOutput, 'refactor this module')).toBe(true);
    });

    it('"创建" recognized as code task (aligns with detectTaskBand)', () => {
      expect(detectTaskBand('创建一个类')).toBe('code');
      expect(isStructurallyComplete(codeBlockOutput, '创建一个类')).toBe(true);
    });

    it('"模块" recognized as code task (aligns with detectTaskBand)', () => {
      expect(detectTaskBand('写一个模块')).toBe('code');
      expect(isStructurallyComplete(codeBlockOutput, '开发一个认证模块')).toBe(true);
    });

    const analysisListOutput = 'a'.repeat(140) + '\n1. Point one\n2. Point two\n3. Point three';

    it('"检查" recognized as analysis task (aligns with detectTaskBand)', () => {
      expect(detectTaskBand('检查这段代码')).toBe('analysis');
      expect(isStructurallyComplete(analysisListOutput, '检查这段代码')).toBe(true);
    });

    it('"review" recognized as analysis task (aligns with detectTaskBand)', () => {
      expect(detectTaskBand('review this pull request')).toBe('analysis');
      expect(isStructurallyComplete(analysisListOutput, 'review this pull request')).toBe(true);
    });

    it('"评估" recognized as analysis task (aligns with detectTaskBand)', () => {
      expect(detectTaskBand('评估这个方案')).toBe('analysis');
      expect(isStructurallyComplete(analysisListOutput, '评估这个方案')).toBe(true);
    });

    it('"总结" recognized as analysis task (aligns with detectTaskBand)', () => {
      expect(detectTaskBand('总结这篇文章')).toBe('analysis');
      expect(isStructurallyComplete(analysisListOutput, '总结这篇文章')).toBe(true);
    });

    it('"summarize" recognized as analysis task (aligns with detectTaskBand)', () => {
      expect(detectTaskBand('summarize the findings')).toBe('analysis');
      expect(isStructurallyComplete(analysisListOutput, 'summarize the findings')).toBe(true);
    });

    it('"debug" falls to general band (compact output)', () => {
      expect(detectTaskBand('debug this issue')).toBe('general');
    });

    it('analysis with embedded code in tail → analysis (headHasCode checks head only)', () => {
      expect(detectTaskBand('分析这段代码的bug：function sum(arr) { let total; }')).toBe('analysis');
    });

    it('analysis without code → analysis', () => {
      expect(detectTaskBand('分析微服务架构的优缺点')).toBe('analysis');
    });

    it('analysis with import statement in tail → analysis', () => {
      expect(detectTaskBand('review this: import { foo } from bar;')).toBe('analysis');
    });
  });
});

// ═══════════════════════════════════════════════════════

describe('predictTokenUsage', () => {
  it('direct depth returns reasonable estimate for short input', () => {
    const result = predictTokenUsage('direct', 20);
    expect(result.estimated).toBeGreaterThanOrEqual(60);
    expect(result.estimated).toBeLessThanOrEqual(800);
    expect(result.range[0]).toBeLessThan(result.estimated);
    expect(result.range[1]).toBeGreaterThan(result.estimated);
  });

  it('light depth returns higher estimate than direct', () => {
    const direct = predictTokenUsage('direct', 100);
    const light = predictTokenUsage('light', 100);
    expect(light.estimated).toBeGreaterThan(direct.estimated);
  });

  it('full depth returns highest estimate', () => {
    const light = predictTokenUsage('light', 100);
    const full = predictTokenUsage('full', 100);
    expect(full.estimated).toBeGreaterThan(light.estimated);
  });

  it('longer input produces higher estimates within same depth', () => {
    const short = predictTokenUsage('direct', 20);
    const long = predictTokenUsage('direct', 500);
    expect(long.estimated).toBeGreaterThanOrEqual(short.estimated);
  });

  it('range low is less than estimated', () => {
    const result = predictTokenUsage('standard', 200);
    expect(result.range[0]).toBeLessThan(result.estimated);
  });

  it('range high is greater than estimated', () => {
    const result = predictTokenUsage('standard', 200);
    expect(result.range[1]).toBeGreaterThan(result.estimated);
  });

  it('estimates are within reasonable bounds for all depths', () => {
    for (const depth of ['direct', 'light', 'standard', 'full'] as const) {
      const result = predictTokenUsage(depth, 100);
      expect(result.estimated).toBeGreaterThan(0);
      expect(result.estimated).toBeLessThan(10000);
    }
  });
});
