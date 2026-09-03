import { MpxError } from '@mpx/core';

export const MAX_RUNTIME_ARGS = 64;
export const MAX_RUNTIME_ARGS_BYTES = 16_384;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/u;

/** Canonicalizes explicit, invocation-scoped runtime argv without interpreting its contents. */
export function canonicalRuntimeArgs(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    value.length > MAX_RUNTIME_ARGS ||
    value.some((argument) => typeof argument !== 'string' || CONTROL_CHARACTER.test(argument)) ||
    new TextEncoder().encode(value.join('')).byteLength > MAX_RUNTIME_ARGS_BYTES
  ) {
    throw new MpxError({
      code: 'RUNTIME_ARGS_INVALID',
      message: `Runtime arguments must contain at most ${MAX_RUNTIME_ARGS} control-free values and ${MAX_RUNTIME_ARGS_BYTES} UTF-8 bytes.`,
    });
  }
  return Object.freeze([...value]);
}
