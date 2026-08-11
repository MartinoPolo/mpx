import type { PublicError } from "./errors.js";
import { serializePublicError } from "./errors.js";
import type { JsonValue } from "./json.js";

export interface Diagnostic {
  code: string;
  message: string;
  severity: "info" | "warning" | "error";
  details?: JsonValue;
}

export interface SuccessEnvelope<T extends JsonValue = JsonValue> {
  apiVersion: 1;
  ok: true;
  data: T;
  warnings: Diagnostic[];
}

export interface ErrorEnvelope {
  apiVersion: 1;
  ok: false;
  error: PublicError;
  warnings: Diagnostic[];
}

export type ApiEnvelope<T extends JsonValue = JsonValue> = SuccessEnvelope<T> | ErrorEnvelope;

export const successEnvelope = <T extends JsonValue>(data: T, warnings: Diagnostic[] = []): SuccessEnvelope<T> =>
  ({ apiVersion: 1, ok: true, data, warnings });

export const errorEnvelope = (error: unknown, warnings: Diagnostic[] = []): ErrorEnvelope =>
  ({ apiVersion: 1, ok: false, error: serializePublicError(error), warnings });
