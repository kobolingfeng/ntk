import { describe, expect, it } from 'vitest';
import {
  AllEndpointsFailedError,
  ClassifierError,
  CompressionError,
  LLMClientError,
  NTKError,
  PipelineError,
} from './errors.js';

describe('NTK Error Types', () => {
  it('NTKError has code and instanceof works', () => {
    const err = new NTKError('test', 'TEST');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(NTKError);
    expect(err.code).toBe('TEST');
    expect(err.name).toBe('NTKError');
    expect(err.message).toBe('test');
  });

  it('LLMClientError extends NTKError', () => {
    const err = new LLMClientError('api failed', 'endpoint-1', 503);
    expect(err).toBeInstanceOf(NTKError);
    expect(err).toBeInstanceOf(LLMClientError);
    expect(err.endpoint).toBe('endpoint-1');
    expect(err.statusCode).toBe(503);
  });

  it('AllEndpointsFailedError has endpoint count', () => {
    const err = new AllEndpointsFailedError(5);
    expect(err).toBeInstanceOf(NTKError);
    expect(err).toBeInstanceOf(AllEndpointsFailedError);
    expect(err.endpointCount).toBe(5);
    expect(err.message).toContain('5');
  });

  it('PipelineError has phase and depth', () => {
    const err = new PipelineError('failed', 'execute', 'full');
    expect(err).toBeInstanceOf(NTKError);
    expect(err.phase).toBe('execute');
    expect(err.depth).toBe('full');
  });

  it('ClassifierError has correct code', () => {
    const err = new ClassifierError('bad input');
    expect(err.code).toBe('CLASSIFIER_ERROR');
  });

  it('CompressionError has originalLength', () => {
    const err = new CompressionError('too long', 50000);
    expect(err.originalLength).toBe(50000);
  });
});
