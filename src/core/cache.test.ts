import { describe, expect, it } from 'vitest';
import { ResponseCache } from './cache.js';

describe('ResponseCache', () => {
  it('stores and retrieves cached results', () => {
    const cache = new ResponseCache();
    cache.set('hello world', 'result', 'direct', 100);

    const entry = cache.get('hello world');
    expect(entry).not.toBeNull();
    expect(entry!.result).toBe('result');
    expect(entry!.depth).toBe('direct');
  });

  it('returns null for missing entries', () => {
    const cache = new ResponseCache();
    expect(cache.get('unknown task')).toBeNull();
  });

  it('normalizes task text for matching', () => {
    const cache = new ResponseCache();
    cache.set('  Hello World  ', 'result', 'direct', 50);

    const entry = cache.get('hello world');
    expect(entry).not.toBeNull();
  });

  it('tracks hits and misses', () => {
    const cache = new ResponseCache();
    cache.set('task1', 'result', 'direct', 100);

    cache.get('task1');
    cache.get('task2');
    cache.get('task1');

    const stats = cache.getStats();
    expect(stats.hits).toBe(2);
    expect(stats.misses).toBe(1);
    expect(stats.hitRate).toBeCloseTo(2 / 3);
  });

  it('accumulates tokens saved by hits', () => {
    const cache = new ResponseCache();
    cache.set('task', 'result', 'direct', 200);

    cache.get('task');
    cache.get('task');

    const stats = cache.getStats();
    expect(stats.totalTokensSaved).toBe(400);
  });

  it('evicts oldest entry when full', () => {
    const cache = new ResponseCache(2);
    cache.set('task1', 'r1', 'direct', 10);
    cache.set('task2', 'r2', 'direct', 20);
    cache.set('task3', 'r3', 'direct', 30);

    expect(cache.get('task1')).toBeNull();
    expect(cache.get('task3')).not.toBeNull();
  });

  it('expires entries after TTL', async () => {
    const cache = new ResponseCache(100, 50);
    cache.set('task', 'result', 'direct', 100);

    expect(cache.get('task')).not.toBeNull();
    await new Promise((r) => setTimeout(r, 60));
    expect(cache.get('task')).toBeNull();
  });

  it('clears all entries', () => {
    const cache = new ResponseCache();
    cache.set('task1', 'r1', 'direct', 10);
    cache.set('task2', 'r2', 'direct', 20);

    cache.clear();
    expect(cache.getStats().size).toBe(0);
  });

  it('distinguishes force-depth in cache key', () => {
    const cache = new ResponseCache();
    cache.set('task', 'direct-result', 'direct', 100, 'direct');
    cache.set('task', 'full-result', 'full', 500, 'full');

    expect(cache.get('task', 'direct')!.result).toBe('direct-result');
    expect(cache.get('task', 'full')!.result).toBe('full-result');
  });

  it('clear resets tokensSavedByHits', () => {
    const cache = new ResponseCache();
    cache.set('task', 'result', 'direct', 200);
    cache.get('task');
    expect(cache.getStats().totalTokensSaved).toBe(200);

    cache.clear();
    const stats = cache.getStats();
    expect(stats.totalTokensSaved).toBe(0);
    expect(stats.hits).toBe(0);
    expect(stats.misses).toBe(0);
  });

  it('evicts LRU entry (not FIFO) when full', () => {
    const cache = new ResponseCache(2);
    cache.set('task1', 'r1', 'direct', 10);
    cache.set('task2', 'r2', 'direct', 20);

    // Access task1, making task2 the least recently used
    cache.get('task1');

    // Insert task3 — should evict task2 (LRU), not task1
    cache.set('task3', 'r3', 'direct', 30);

    expect(cache.get('task1')).not.toBeNull();
    expect(cache.get('task2')).toBeNull();
    expect(cache.get('task3')).not.toBeNull();
  });

  describe('task normalization for fuzzy matching', () => {
    it('strips trailing punctuation (。！？.!?)', () => {
      const cache = new ResponseCache();
      cache.set('写一个排序函数。', 'result', 'direct', 100);
      expect(cache.get('写一个排序函数')).not.toBeNull();
      expect(cache.get('写一个排序函数!')).not.toBeNull();
      expect(cache.get('写一个排序函数？')).not.toBeNull();
    });

    it('collapses multiple spaces', () => {
      const cache = new ResponseCache();
      cache.set('write  a   sort function', 'result', 'direct', 100);
      expect(cache.get('write a sort function')).not.toBeNull();
    });

    it('strips common filler: 帮我/请/can you/please', () => {
      const cache = new ResponseCache();
      cache.set('帮我写一个函数', 'result', 'direct', 100);
      expect(cache.get('写一个函数')).not.toBeNull();
      expect(cache.get('请写一个函数')).not.toBeNull();
      expect(cache.get('帮忙写一个函数')).not.toBeNull();
    });

    it('strips English fillers', () => {
      const cache = new ResponseCache();
      cache.set('please write a function', 'result', 'direct', 100);
      expect(cache.get('write a function')).not.toBeNull();
      expect(cache.get('can you write a function')).not.toBeNull();
      expect(cache.get('could you write a function')).not.toBeNull();
    });

    it('combined normalization', () => {
      const cache = new ResponseCache();
      cache.set('请帮我  写一个排序函数。', 'result', 'direct', 100);
      expect(cache.get('写一个排序函数')).not.toBeNull();
    });
  });
});
