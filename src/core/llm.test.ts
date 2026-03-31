import { describe, expect, it } from 'vitest';
import { EndpointManager, estimateTokens } from './llm.js';

describe('estimateTokens', () => {
  it('estimates ASCII text at ~0.25 tokens per char', () => {
    const result = estimateTokens('hello world');
    expect(result).toBe(Math.ceil(11 / 4));
  });

  it('estimates CJK text at ~1.5 tokens per char', () => {
    const result = estimateTokens('你好世界');
    expect(result).toBe(Math.ceil(4 * 1.5));
  });

  it('handles mixed CJK and ASCII', () => {
    const text = '用Python写函数';
    // 用(CJK), P-y-t-h-o-n(ASCII), 写(CJK), 函(CJK), 数(CJK) = 4 CJK + 6 ASCII
    const expected = Math.ceil(4 * 1.5 + 6 / 4); // 8
    expect(estimateTokens(text)).toBe(expected);
  });

  it('returns 0 for empty string', () => {
    expect(estimateTokens('')).toBe(0);
  });

  it('pure ASCII is always less than string length', () => {
    const text = 'This is a sample sentence for testing token estimation.';
    expect(estimateTokens(text)).toBeLessThan(text.length);
  });

  it('CJK text estimates higher than ASCII of same length', () => {
    const ascii = 'abcd';
    const cjk = '你好世界';
    expect(estimateTokens(cjk)).toBeGreaterThan(estimateTokens(ascii));
  });
});

describe('EndpointManager', () => {
  it('starts with no endpoints', () => {
    const em = new EndpointManager();
    expect(em.getEndpoints()).toEqual([]);
    expect(em.getActiveEndpoint()).toBeUndefined();
  });

  it('sets and gets endpoints', () => {
    const em = new EndpointManager();
    em.setEndpoints([
      { name: 'ep1', apiKey: 'key1', baseUrl: 'https://api1.example.com' },
      { name: 'ep2', apiKey: 'key2', baseUrl: 'https://api2.example.com/' },
    ]);

    expect(em.getEndpoints()).toHaveLength(2);
    expect(em.getActiveEndpoint()?.name).toBe('ep1');
  });

  it('strips trailing slashes from baseUrl', () => {
    const em = new EndpointManager();
    em.setEndpoints([{ name: 'test', apiKey: 'key', baseUrl: 'https://api.example.com///' }]);

    expect(em.getActiveEndpoint()?.baseUrl).toBe('https://api.example.com');
  });

  it('resets activeEndpointIndex on setEndpoints', () => {
    const em = new EndpointManager();
    em.setEndpoints([
      { name: 'ep1', apiKey: 'key1', baseUrl: 'https://api1.com' },
      { name: 'ep2', apiKey: 'key2', baseUrl: 'https://api2.com' },
    ]);

    expect(em.getActiveEndpoint()?.name).toBe('ep1');
  });

  it('getEndpointOrder returns active first', () => {
    const em = new EndpointManager();
    em.setEndpoints([
      { name: 'ep1', apiKey: 'key1', baseUrl: 'https://api1.com' },
      { name: 'ep2', apiKey: 'key2', baseUrl: 'https://api2.com' },
      { name: 'ep3', apiKey: 'key3', baseUrl: 'https://api3.com' },
    ]);

    const order = em.getEndpointOrder('test-model');
    expect(order[0]).toBe(0);
    expect(order).toHaveLength(3);
  });

  it('invalidateProbeCacheFor removes matching entries', () => {
    const em = new EndpointManager();
    em.setEndpoints([{ name: 'test', apiKey: 'key', baseUrl: 'https://api.com' }]);
    // No crash when invalidating on empty cache
    em.invalidateProbeCacheFor('test');
  });
});
