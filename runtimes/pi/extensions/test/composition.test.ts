import assert from "node:assert/strict";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";

import {
  composeExtensions,
  DEFAULT_EXTENSION_COMPONENTS,
  type ExtensionComponent,
} from "../index.js";

const EXPECTED_COMPONENTS = [
  "agent-resurrect",
  "auto-title",
  "compact-instructions",
  "footer",
  "fullscreen-scroll-speed",
  "guard-hooks",
  "dev-server",
  "subagents",
  "terminal-progress",
];

test("default composition is static, stable, and unique", () => {
  const names = DEFAULT_EXTENSION_COMPONENTS.map(({ name }) => name);

  assert.deepEqual(names, EXPECTED_COMPONENTS);
  assert.equal(new Set(names).size, names.length);
});

test("composition invokes every component exactly once in order", () => {
  const calls: string[] = [];
  const components: ExtensionComponent[] = EXPECTED_COMPONENTS.map((name) => ({
    name,
    register: () => calls.push(name),
  }));

  composeExtensions({} as ExtensionAPI, components);

  assert.deepEqual(calls, EXPECTED_COMPONENTS);
});
