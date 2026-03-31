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
    Object.setPrototypeOf(this, new.target.prototype);
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
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class AllEndpointsFailedError extends LLMClientError {
  readonly endpointCount: number;

  constructor(endpointCount: number) {
    super(`All ${endpointCount} endpoints failed`, 'ALL_ENDPOINTS_FAILED');
    this.name = 'AllEndpointsFailedError';
    this.endpointCount = endpointCount;
    Object.setPrototypeOf(this, new.target.prototype);
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
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ClassifierError extends NTKError {
  constructor(message: string) {
    super(message, 'CLASSIFIER_ERROR');
    this.name = 'ClassifierError';
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class CompressionError extends NTKError {
  readonly originalLength?: number;

  constructor(message: string, originalLength?: number) {
    super(message, 'COMPRESSION_ERROR');
    this.name = 'CompressionError';
    this.originalLength = originalLength;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}
