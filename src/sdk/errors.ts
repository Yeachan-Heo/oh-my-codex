import type { OmxApiErrorBody } from './types.js';

export class OmxSdkError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'OmxSdkError';
  }
}

export class OmxTimeoutError extends OmxSdkError {
  constructor(message = 'OMX SDK request timed out', options?: ErrorOptions) {
    super(message, options);
    this.name = 'OmxTimeoutError';
  }
}

export class OmxHttpError extends OmxSdkError {
  readonly status: number;
  readonly statusText: string;
  readonly bodyText: string;
  readonly body?: OmxApiErrorBody;

  constructor(options: {
    status: number;
    statusText: string;
    bodyText: string;
    body?: OmxApiErrorBody;
  }) {
    const apiMessage = options.body?.error?.message;
    super(apiMessage || `OMX API request failed with HTTP ${options.status}`);
    this.name = 'OmxHttpError';
    this.status = options.status;
    this.statusText = options.statusText;
    this.bodyText = options.bodyText;
    this.body = options.body;
  }
}

export function parseErrorBody(text: string): OmxApiErrorBody | undefined {
  try {
    const parsed = JSON.parse(text) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as OmxApiErrorBody
      : undefined;
  } catch {
    return undefined;
  }
}
