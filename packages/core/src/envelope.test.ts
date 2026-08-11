import { describe, expect, it } from "vitest";
import { errorEnvelope, successEnvelope } from "./envelope.js";
import { MpxError } from "./errors.js";

describe("API envelopes", () => {
  it("constructs versioned success", () => expect(successEnvelope({ value: 1 })).toEqual({ apiVersion: 1, ok: true, data: { value: 1 }, diagnostics: [] }));
  it("constructs versioned safe errors", () => expect(errorEnvelope(new MpxError({ code: "BAD", message: "Bad" }))).toEqual({ apiVersion: 1, ok: false, error: { code: "BAD", message: "Bad", retryable: false }, diagnostics: [] }));
});
