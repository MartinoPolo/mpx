import { describe, expect, it } from "vitest";
import { canonicalJson, parseStrictJson, sha256Canonical } from "./json.js";

describe("strict JSON", () => {
  it("parses standard JSON", () => expect(parseStrictJson(String.raw`{"a":[true,null,-1.5e2],"s":"x\n"}`)).toEqual({ a: [true, null, -150], s: "x\n" }));
  it.each([
    '{"a":1,"a":2}', '{"x":{"constructor":1}}', '{"__proto__":{}}', '{"prototype":0}',
    "{'a':1}", '{"a":NaN}', '{"a":Infinity}', '{"a":01}', '{"a":1,}', '[1,]', '{"a":undefined}', 'true false', '"\u0001"',
  ])("rejects malicious or nonstandard input %s", (input) => expect(() => parseStrictJson(input)).toThrow(SyntaxError));
});

describe("canonical JSON", () => {
  it("sorts every object level deterministically", () => {
    const first = { z: 1, a: { y: 2, x: 3 } };
    const second = { a: { x: 3, y: 2 }, z: 1 };
    expect(canonicalJson(first)).toBe('{"a":{"x":3,"y":2},"z":1}');
    expect(canonicalJson(first)).toBe(canonicalJson(second));
    expect(sha256Canonical(first)).toBe(sha256Canonical(second));
    expect(sha256Canonical(first)).toMatch(/^[a-f0-9]{64}$/u);
  });
  it("rejects non-finite numbers", () => expect(() => canonicalJson(Number.NaN)).toThrow(TypeError));
});
