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
});
