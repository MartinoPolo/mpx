import { parseStrictJson as parseCoreStrictJson } from "@mpx/core";

export const StrictJsonError = SyntaxError;

export function parseStrictJson(text: string): unknown {
  return parseCoreStrictJson(text);
}
