/**
 * NTK Error Types — Structured error hierarchy.
 *
 * Enables downstream consumers to catch and handle
 * specific error types rather than generic Error.
 */

export class NTKError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'NTKError';
    this.code = code;
  }
}

export class LLMClientError extends NTKError {
  readonly endpoint?: string;
  readonly statusCode?: number;

  constructor(message: string, endpoint?: string, statusCode?: number) {
    super(message, 'LLM_ERROR');
    this.name = 'LLMClientError';
    this.endpoint = endpoint;
    this.statusCode = statusCode;
  }
}

export class AllEndpointsFailedError extends LLMClientError {
  readonly endpointCount: number;

  constructor(endpointCount: number) {
    super(`All ${endpointCount} endpoints failed`, 'ALL_ENDPOINTS_FAILED');
    this.name = 'AllEndpointsFailedError';
    this.endpointCount = endpointCount;
  }
}

export class PipelineError extends NTKError {
  readonly phase?: string;
  readonly depth?: string;

  constructor(message: string, phase?: string, depth?: string) {
    super(message, 'PIPELINE_ERROR');
    this.name = 'PipelineError';
    this.phase = phase;
    this.depth = depth;
  }
}

export class ClassifierError extends NTKError {
  constructor(message: string) {
    super(message, 'CLASSIFIER_ERROR');
    this.name = 'ClassifierError';
  }
}

export class CompressionError extends NTKError {
  readonly originalLength?: number;

  constructor(message: string, originalLength?: number) {
    super(message, 'COMPRESSION_ERROR');
    this.name = 'CompressionError';
    this.originalLength = originalLength;
  }
}
