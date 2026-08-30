import type { JsonValue } from './json.js';

export interface MpxErrorOptions {
  code: string;
  message: string;
  retryable?: boolean;
  capability?: string;
  remediation?: string;
  details?: JsonValue;
}

export interface PublicError {
  code: string;
  message: string;
  retryable: boolean;
  capability?: string;
  remediation?: string;
  details?: JsonValue;
}

export class MpxError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly capability?: string;
  readonly remediation?: string;
  readonly details?: JsonValue;

  constructor(options: MpxErrorOptions) {
    super(options.message);
    this.name = 'MpxError';
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    if (options.capability !== undefined) {
      this.capability = options.capability;
    }
    if (options.remediation !== undefined) {
      this.remediation = options.remediation;
    }
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }

  toPublic(): PublicError {
    return {
      code: this.code,
      message: this.message,
      retryable: this.retryable,
      ...(this.capability === undefined ? {} : { capability: this.capability }),
      ...(this.remediation === undefined ? {} : { remediation: this.remediation }),
      ...(this.details === undefined ? {} : { details: this.details }),
    };
  }
}

export function serializePublicError(error: unknown): PublicError {
  if (error instanceof MpxError) {
    return error.toPublic();
  }
  return { code: 'INTERNAL_ERROR', message: 'An internal error occurred.', retryable: false };
}
