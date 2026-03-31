import { describe, it, expect, beforeAll } from 'vitest';
import { Planner } from './planner.js';

// We need a mock LLMClient for the constructor
const mockLLM = {
  chat: async () => ({ content: '', usage: { inputTokens: 0, outputTokens: 0, agent: 'planner' as const, phase: 'gather' as const } }),
  getTokenLog: () => [],
  getConfig: () => ({ provider: 'openai', model: 'test', apiKey: 'test' }),
} as any;

describe('Planner.parseInstructions()', () => {
  let planner: Planner;

  beforeAll(() => {
    planner = new Planner(mockLLM);
  });

  // ─── Format 1: Arrow (→ agent: instruction) ─────

  describe('arrow format', () => {
    it('parses → scout: instruction', () => {
      const result = planner.parseInstructions('→ scout: 查找相关资料');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ target: 'scout', instruction: '查找相关资料' });
    });

    it('parses → executor: instruction', () => {
      const result = planner.parseInstructions('→ executor: 实现缓存功能');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ target: 'executor', instruction: '实现缓存功能' });
    });

    it('parses → summarizer: instruction', () => {
      const result = planner.parseInstructions('→ summarizer: 总结研究结果');
      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({ target: 'summarizer', instruction: '总结研究结果' });
    });

    it('falls back to executor for invalid target', () => {
      const result = planner.parseInstructions('→ verifier: 验证结果');
      expect(result).toHaveLength(1);
      expect(result[0].target).toBe('executor');
      expect(result[0].instruction).toBe('验证结果');
    });

    it('handles extra spaces around arrow', () => {
      const result = planner.parseInstructions('→  executor:  write code  ');
      expect(result).toHaveLength(1);
      expect(result[0].instruction).toBe('write code');
    });

    it('parses multiple arrow instructions', () => {
      const input = `→ scout: research APIs
→ executor: implement the API
→ summarizer: write docs`;
      const result = planner.parseInstructions(input);
      expect(result).toHaveLength(3);
      expect(result[0].target).toBe('scout');
      expect(result[1].target).toBe('executor');
      expect(result[2].target).toBe('summarizer');
    });
  });

  // ─── Format 2: Bracket ([agent][...]: instruction) ─

  describe('bracket format', () => {
    it('parses [Agent]: instruction', () => {
      const result = planner.parseInstructions('[CodeAgent]: 实现排序算法');
      expect(result).toHaveLength(1);
      expect(result[0].target).toBe('executor');
      expect(result[0].instruction).toBe('实现排序算法');
    });

    it('parses multi-bracket [Agent][v1]: instruction', () => {
      const result = planner.parseInstructions('[Agent][version1]: write a function');
      expect(result).toHaveLength(1);
      expect(result[0].target).toBe('executor');
      expect(result[0].instruction).toBe('write a function');
    });

    it('supports Chinese colon ：', () => {
      const result = planner.parseInstructions('[执行者]：编写代码实现功能');
      expect(result).toHaveLength(1);
      expect(result[0].instruction).toBe('编写代码实现功能');
    });
  });

  // ─── Format 3: Numbered list ────────────────────

  describe('numbered format', () => {
    it('parses "1. instruction" with length > 20', () => {
      const result = planner.parseInstructions('1. 实现一个完整的用户认证系统包含登录注册');
      expect(result).toHaveLength(1);
      expect(result[0].target).toBe('executor');
      expect(result[0].instruction).toBe('实现一个完整的用户认证系统包含登录注册');
    });

    it('parses "2) instruction"', () => {
      const result = planner.parseInstructions('2) Design the database schema for users and roles');
      expect(result).toHaveLength(1);
      expect(result[0].instruction).toBe('Design the database schema for users and roles');
    });

    it('parses "3、instruction" (Chinese numbering)', () => {
      // Must be > 20 chars total for numbered format to match
      const result = planner.parseInstructions('3、编写完整的错误处理中间件和日志记录系统模块');
      expect(result).toHaveLength(1);
    });

    it('ignores short numbered lines (≤20 chars)', () => {
      const result = planner.parseInstructions('1. short');
      expect(result).toHaveLength(0);
    });

    it('ignores numbered line with exactly 20 chars', () => {
      // "1. " + 17 chars = 20 total
      const result = planner.parseInstructions('1. 12345678901234567');
      expect(result).toHaveLength(0);
    });

    it('accepts numbered line with 21 chars', () => {
      const result = planner.parseInstructions('1. 123456789012345678');
      expect(result).toHaveLength(1);
    });
  });

  // ─── Mixed and edge cases ──────────────────────

  describe('edge cases', () => {
    it('returns empty for empty string', () => {
      expect(planner.parseInstructions('')).toEqual([]);
    });

    it('skips blank lines', () => {
      const input = `→ executor: task1\n\n\n→ executor: task2`;
      const result = planner.parseInstructions(input);
      expect(result).toHaveLength(2);
    });

    it('ignores unrecognized lines', () => {
      const input = `This is just a comment\n→ executor: real task\nAnother comment`;
      const result = planner.parseInstructions(input);
      expect(result).toHaveLength(1);
      expect(result[0].instruction).toBe('real task');
    });

    it('arrow format takes priority over numbered format', () => {
      // This line matches arrow format first, so numbered is never checked
      const result = planner.parseInstructions('→ scout: 1. research the topic thoroughly');
      expect(result).toHaveLength(1);
      expect(result[0].target).toBe('scout');
    });
  });
});
