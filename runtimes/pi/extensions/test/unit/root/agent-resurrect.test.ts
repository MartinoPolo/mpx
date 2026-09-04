import assert from "node:assert/strict";
import { isAbsolute, join, resolve } from "node:path";

import { afterEach, test } from "vitest";

import { registryRoot } from "../../../agent-resurrect.js";

const originalAgentDirectory = process.env.PI_CODING_AGENT_DIR;

afterEach(() => {
  if (originalAgentDirectory === undefined) {
    delete process.env.PI_CODING_AGENT_DIR;
  } else {
    process.env.PI_CODING_AGENT_DIR = originalAgentDirectory;
  }
});

test("registry uses an absolute PI_CODING_AGENT_DIR", () => {
  const configured = resolve("test-fixtures", "pi-agent-root");
  process.env.PI_CODING_AGENT_DIR = configured;

  assert.equal(
    registryRoot(resolve("workspace")),
    join(configured, "agent-resurrect", "active-sessions"),
  );
});

test("registry resolves a relative PI_CODING_AGENT_DIR from the session cwd", () => {
  const cwd = resolve("workspace");
  process.env.PI_CODING_AGENT_DIR = ".runtime/pi";
  const root = registryRoot(cwd);

  assert.equal(root, join(cwd, ".runtime", "pi", "agent-resurrect", "active-sessions"));
  assert.equal(isAbsolute(root), true);
});
