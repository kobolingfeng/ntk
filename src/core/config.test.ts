import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildConfig, discoverEndpoints } from './config.js';
import { EndpointManager } from './llm.js';

describe('discoverEndpoints', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('discovers numbered endpoints', () => {
    vi.stubEnv('API_ENDPOINT_1_KEY', 'key1');
    vi.stubEnv('API_ENDPOINT_1_URL', 'https://api1.com');
    vi.stubEnv('API_ENDPOINT_1_NAME', 'ep1');

    const endpoints = discoverEndpoints();
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].name).toBe('ep1');
    expect(endpoints[0].apiKey).toBe('key1');
    expect(endpoints[0].baseUrl).toBe('https://api1.com');
  });

  it('uses default name when not specified', () => {
    vi.stubEnv('API_ENDPOINT_2_KEY', 'key2');
    vi.stubEnv('API_ENDPOINT_2_URL', 'https://api2.com');

    const endpoints = discoverEndpoints();
    expect(endpoints.some((e) => e.name === 'endpoint-2')).toBe(true);
  });

  it('skips slots without both KEY and URL', () => {
    vi.stubEnv('API_ENDPOINT_1_KEY', 'key1');
    // No URL for slot 1
    vi.stubEnv('API_ENDPOINT_3_KEY', 'key3');
    vi.stubEnv('API_ENDPOINT_3_URL', 'https://api3.com');

    const endpoints = discoverEndpoints();
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].name).toBe('endpoint-3');
  });

  it('falls back to UNIFIED_API_KEY', () => {
    vi.stubEnv('UNIFIED_API_KEY', 'unified-key');

    const endpoints = discoverEndpoints();
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].name).toBe('default');
    expect(endpoints[0].baseUrl).toBe('https://api.openai.com/v1');
  });

  it('uses custom UNIFIED_BASE_URL', () => {
    vi.stubEnv('UNIFIED_API_KEY', 'key');
    vi.stubEnv('UNIFIED_BASE_URL', 'https://custom.api.com/v1');

    const endpoints = discoverEndpoints();
    expect(endpoints[0].baseUrl).toBe('https://custom.api.com/v1');
  });

  it('returns empty if no endpoints configured', () => {
    const endpoints = discoverEndpoints();
    expect(endpoints).toHaveLength(0);
  });

  it('prefers numbered endpoints over unified', () => {
    vi.stubEnv('API_ENDPOINT_1_KEY', 'key1');
    vi.stubEnv('API_ENDPOINT_1_URL', 'https://api1.com');
    vi.stubEnv('UNIFIED_API_KEY', 'unified-key');

    const endpoints = discoverEndpoints();
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].name).toBe('endpoint-1');
  });

  it('skips endpoints with invalid URLs', () => {
    vi.stubEnv('API_ENDPOINT_1_KEY', 'key1');
    vi.stubEnv('API_ENDPOINT_1_URL', 'not-a-url');
    vi.stubEnv('API_ENDPOINT_2_KEY', 'key2');
    vi.stubEnv('API_ENDPOINT_2_URL', 'https://valid.com');

    const endpoints = discoverEndpoints();
    expect(endpoints).toHaveLength(1);
    expect(endpoints[0].baseUrl).toBe('https://valid.com');
  });
});

describe('buildConfig', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('builds config from active endpoint', () => {
    const em = new EndpointManager();
    em.setEndpoints([{ name: 'test', apiKey: 'testkey', baseUrl: 'https://test.com' }]);

    const config = buildConfig(em);
    expect(config.planner.apiKey).toBe('testkey');
    expect(config.planner.baseUrl).toBe('https://test.com');
    expect(config.compressor.apiKey).toBe('testkey');
  });

  it('throws when no active endpoint', () => {
    const em = new EndpointManager();
    expect(() => buildConfig(em)).toThrow('No active endpoint');
  });

  it('uses override models', () => {
    const em = new EndpointManager();
    em.setEndpoints([{ name: 'test', apiKey: 'key', baseUrl: 'https://test.com' }]);

    const config = buildConfig(em, { plannerModel: 'gpt-5', compressorModel: 'gpt-5-mini' });
    expect(config.planner.model).toBe('gpt-5');
    expect(config.compressor.model).toBe('gpt-5-mini');
  });

  it('reads models from env when no overrides', () => {
    vi.stubEnv('PLANNER_MODEL', 'env-planner');
    vi.stubEnv('COMPRESSOR_MODEL', 'env-compressor');

    const em = new EndpointManager();
    em.setEndpoints([{ name: 'test', apiKey: 'key', baseUrl: 'https://test.com' }]);

    const config = buildConfig(em);
    expect(config.planner.model).toBe('env-planner');
    expect(config.compressor.model).toBe('env-compressor');
  });

  it('falls back to MODEL env var', () => {
    vi.stubEnv('MODEL', 'fallback-model');

    const em = new EndpointManager();
    em.setEndpoints([{ name: 'test', apiKey: 'key', baseUrl: 'https://test.com' }]);

    const config = buildConfig(em);
    expect(config.planner.model).toBe('fallback-model');
    expect(config.compressor.model).toBe('fallback-model');
  });

  it('uses debug override', () => {
    const em = new EndpointManager();
    em.setEndpoints([{ name: 'test', apiKey: 'key', baseUrl: 'https://test.com' }]);

    const config = buildConfig(em, { debug: true });
    expect(config.debug).toBe(true);
  });

  it('has correct default token budgets', () => {
    const em = new EndpointManager();
    em.setEndpoints([{ name: 'test', apiKey: 'key', baseUrl: 'https://test.com' }]);

    const config = buildConfig(em);
    expect(config.tokenBudget?.planner).toBe(1024);
    expect(config.tokenBudget?.executor).toBe(4096);
  });
});
