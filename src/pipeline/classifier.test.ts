import { describe, expect, it } from 'vitest';
import { classifyDepthFastPath } from './classifier.js';

describe('classifyDepthFastPath', () => {
  describe('CJK threshold', () => {
    it('short CJK (≤12 chars) → direct', () => {
      expect(classifyDepthFastPath('写个排序')).toBe('direct');
      expect(classifyDepthFastPath('翻译这段话')).toBe('direct');
    });

    it('medium CJK (>12 chars without pattern) → null', () => {
      expect(classifyDepthFastPath('针对一个高并发电商系统给出缓存策略方案')).toBeNull();
    });

    it('CJK with pattern match → direct', () => {
      expect(classifyDepthFastPath('用Python写一个排序函数')).toBe('direct');
      expect(classifyDepthFastPath('解释什么是微服务')).toBe('direct');
      expect(classifyDepthFastPath('比较React和Vue')).toBe('direct');
    });

    it('English short (≤30 chars) → direct', () => {
      expect(classifyDepthFastPath('write hello world')).toBe('direct');
      expect(classifyDepthFastPath('sort an array')).toBe('direct');
    });

    it('English pattern match → direct', () => {
      expect(classifyDepthFastPath('design a rate limiter')).toBe('direct');
      expect(classifyDepthFastPath('compare PostgreSQL and MongoDB')).toBe('direct');
    });
  });

  describe('embedded data patterns', () => {
    it('分析以下 → direct regardless of length', () => {
      const long = `分析以下${'a'.repeat(500)}`;
      expect(classifyDepthFastPath(long)).toBe('direct');
    });

    it('review the → direct regardless of length', () => {
      const long = `review the ${'code '.repeat(100)}`;
      expect(classifyDepthFastPath(long)).toBe('direct');
    });
  });

  describe('new Chinese patterns', () => {
    it('帮我 → direct', () => {
      expect(classifyDepthFastPath('帮我写个函数')).toBe('direct');
    });

    it('请 → direct', () => {
      expect(classifyDepthFastPath('请解释一下')).toBe('direct');
    });

    it('给出 → direct', () => {
      expect(classifyDepthFastPath('给出建议')).toBe('direct');
    });

    it('对比 → direct', () => {
      expect(classifyDepthFastPath('对比两种方案')).toBe('direct');
    });

    it('总结 → direct', () => {
      expect(classifyDepthFastPath('总结这段代码')).toBe('direct');
    });
  });

  describe('edge cases', () => {
    it('empty string → direct (≤ threshold)', () => {
      expect(classifyDepthFastPath('')).toBe('direct');
    });

    it('whitespace only → direct (≤ threshold)', () => {
      expect(classifyDepthFastPath('   ')).toBe('direct');
    });

    it('single character → direct', () => {
      expect(classifyDepthFastPath('a')).toBe('direct');
    });

    it('single CJK character → direct', () => {
      expect(classifyDepthFastPath('写')).toBe('direct');
    });

    it('exactly 12 CJK chars without pattern → direct', () => {
      expect(classifyDepthFastPath('一二三四五六七八九十一二')).toBe('direct');
    });

    it('13 CJK chars without pattern → null (needs LLM)', () => {
      expect(classifyDepthFastPath('一二三四五六七八九十一二三')).toBeNull();
    });

    it('mixed CJK + English → CJK threshold applies', () => {
      expect(classifyDepthFastPath('hello世界test')).toBe('direct');
    });

    it('mixed CJK > 12 chars with pattern → direct', () => {
      expect(classifyDepthFastPath('用React写一个todo组件带状态管理')).toBe('direct');
    });

    it('mixed CJK > 12 chars without pattern → null', () => {
      expect(classifyDepthFastPath('这是一个很长的没有明确模式的输入字符串')).toBeNull();
    });

    it('newlines and special chars count toward length', () => {
      expect(classifyDepthFastPath('a\nb\nc')).toBe('direct');
    });

    it('number-heavy input ≤30 chars → direct', () => {
      expect(classifyDepthFastPath('123456789012345678901234567890')).toBe('direct');
    });

    it('URL-like input without pattern > 30 → null', () => {
      expect(classifyDepthFastPath('https://example.com/very/long/path/that/exceeds/threshold')).toBeNull();
    });

    it('emoji input ≤30 chars → direct', () => {
      expect(classifyDepthFastPath('fix this bug 🐛🔧')).toBe('direct');
    });

    it('pattern at end of long input > 200 chars → null', () => {
      const input = 'x'.repeat(195) + ' write code';
      expect(classifyDepthFastPath(input)).toBeNull();
    });
  });

  describe('light depth fast path', () => {
    it('设计API → light', () => {
      expect(classifyDepthFastPath('设计一个用户认证API')).toBe('light');
    });

    it('设计数据库 → light', () => {
      expect(classifyDepthFastPath('设计一个订单表结构')).toBe('light');
    });

    it('完整组件 → light', () => {
      expect(classifyDepthFastPath('完整的登录组件')).toBe('light');
    });

    it('实现完整功能 → light', () => {
      expect(classifyDepthFastPath('实现一个完整的购物车功能')).toBe('light');
    });

    it('design a REST API → light', () => {
      expect(classifyDepthFastPath('design a REST API for user management')).toBe('light');
    });

    it('full component → light', () => {
      expect(classifyDepthFastPath('full React login component with validation')).toBe('light');
    });

    it('implement a complete feature → light', () => {
      expect(classifyDepthFastPath('implement a complete authentication module')).toBe('light');
    });

    it('multi-component ZH → light', () => {
      expect(classifyDepthFastPath('写一个函数包括输入验证、数据转换和错误处理')).toBe('light');
    });

    it('multi-component EN → light', () => {
      expect(classifyDepthFastPath('write a module including validation, transformation, and logging')).toBe('light');
    });
  });
});
