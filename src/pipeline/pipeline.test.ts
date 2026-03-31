import { describe, it, expect } from 'vitest';

/**
 * Test the parseVerificationResult logic extracted from Pipeline.
 * Since it's a private method, we replicate the exact logic here for unit testing.
 */
function parseVerificationResult(payload: string): boolean {
  // Primary: emoji markers
  const hasPass = payload.includes('✅');
  const hasFail = payload.includes('❌');
  if (hasPass && !hasFail) return true;
  if (hasFail) return false;

  // Fallback: keyword matching (case-insensitive)
  const lower = payload.toLowerCase();
  const passKeywords = ['pass', 'passed', 'all correct', 'no issues', '通过', '正确', '没有问题', '无问题'];
  const failKeywords = ['fail', 'failed', 'error', 'incorrect', 'wrong', '失败', '错误', '不正确', '有问题'];

  const hasPassKeyword = passKeywords.some(kw => lower.includes(kw));
  // Strip negation-pass patterns before checking fail keywords
  // to avoid substring conflicts (e.g. "没有问题" contains "有问题")
  let lowerForFailCheck = lower;
  const negationPassPatterns = ['没有问题', '无问题', 'no issues', 'no errors'];
  for (const np of negationPassPatterns) {
    lowerForFailCheck = lowerForFailCheck.replaceAll(np, '');
  }
  const hasFailKeyword = failKeywords.some(kw => lowerForFailCheck.includes(kw));

  if (hasPassKeyword && !hasFailKeyword) return true;
  if (hasFailKeyword) return false;

  // Default: assume pass
  return true;
}

/**
 * Test the classifyDepth regex logic (fast path only, no LLM).
 */
function classifyDepthFastPath(userRequest: string): 'direct' | null {
  const codeUnitPattern = /^(写|实现|编写|创建|用\w+写|帮我写|请写).{0,30}(函数|function|算法|方法|脚本|工具|类|class)/;
  const simplePattern = /^(翻译|转换|解释|计算|修复|重构|分析这段|优化这|改写|将.{0,15}(翻译|转换|改为))/;
  const directPattern = /^(写一个|实现一个|用\w+实现|生成|输出|列出|什么是|如何|怎么)/;
  const directPatternEn = /^(write|implement|create|generate|explain|what is|how to|convert|translate|fix|solve|calculate|find (all )?bugs|given|read the|extract|count|list|sort|return|check|validate|parse|format|output|review|refactor|debug|optimize|describe|define)\b/i;

  if (codeUnitPattern.test(userRequest) || simplePattern.test(userRequest) || directPattern.test(userRequest) || directPatternEn.test(userRequest)) {
    if (userRequest.length > 100) return null; // falls through to LLM
    return 'direct';
  }

  if (userRequest.length <= 30) return 'direct';

  return null; // needs LLM classification
}

/**
 * Test the cost savings calculation from generateTokenReport.
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

    it('pattern match but >100 chars → null (needs LLM)', () => {
      const longInput = 'write ' + 'a'.repeat(100);
      expect(classifyDepthFastPath(longInput)).toBeNull();
    });

    it('pattern match at exactly 100 chars → direct', () => {
      const input = 'write ' + 'a'.repeat(94); // 6 + 94 = 100
      expect(classifyDepthFastPath(input)).toBe('direct');
    });

    it('pattern match at 101 chars → null', () => {
      const input = 'write ' + 'a'.repeat(95); // 6 + 95 = 101
      expect(classifyDepthFastPath(input)).toBeNull();
    });
  });

  describe('non-matching inputs', () => {
    it('long complex description → null', () => {
      const input = 'Design a complete microservices architecture with event sourcing, CQRS, and saga pattern for an e-commerce platform';
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
