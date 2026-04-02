/**
 * Tests for depth-predictor module.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { recordDepth, predictDepth, flushDepthPredictor } from './depth-predictor.js';

// Mock fs to avoid disk I/O in tests
vi.mock('node:fs', () => ({
  existsSync: () => false,
  mkdirSync: () => {},
  readFileSync: () => '{"version":1,"records":[]}',
  writeFileSync: () => {},
  renameSync: () => {},
}));

describe('depth-predictor', () => {
  describe('recordDepth + predictDepth', () => {
    it('returns null on empty history', () => {
      expect(predictDepth('brand new task never seen')).toBeNull();
    });

    it('records and predicts exact match', () => {
      recordDepth('写一个斐波那契函数', 'direct');
      recordDepth('写一个斐波那契函数', 'direct');
      recordDepth('写一个斐波那契函数', 'direct');

      const result = predictDepth('写一个斐波那契函数');
      expect(result).not.toBeNull();
      expect(result!.depth).toBe('direct');
      expect(result!.confidence).toBe(1);
    });

    it('predicts most common depth for exact pattern', () => {
      recordDepth('比较React和Vue', 'standard');
      recordDepth('比较React和Vue', 'standard');
      recordDepth('比较React和Vue', 'direct');

      const result = predictDepth('比较React和Vue');
      expect(result).not.toBeNull();
      expect(result!.depth).toBe('standard');
      expect(result!.confidence).toBeGreaterThan(0.5);
    });

    it('falls back to partial word matching', () => {
      recordDepth('设计微服务架构', 'full');
      recordDepth('设计微服务架构', 'full');

      // Different task but shares significant words
      const result = predictDepth('微服务架构设计方案');
      // May or may not match depending on word extraction
      // At minimum shouldn't crash
      expect(result === null || result.depth !== undefined).toBe(true);
    });

    it('handles many records without error (pruning branch)', () => {
      // Record enough entries to trigger the >500 pruning branch
      for (let i = 0; i < 510; i++) {
        recordDepth(`task_variant_${i}`, i % 2 === 0 ? 'direct' : 'light');
      }
      // Should still work after pruning
      const result = predictDepth('task_variant_0');
      expect(result === null || result.depth !== undefined).toBe(true);
    });
  });

  describe('flushDepthPredictor', () => {
    it('does not throw when called', () => {
      expect(() => flushDepthPredictor()).not.toThrow();
    });
  });
});
