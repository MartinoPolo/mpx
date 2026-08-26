import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { RUNTIME_TOOL_NAMES, RUNTIME_TOOL_REGISTRY } from "../src/index.js";

const stable = (value: unknown): string => Array.isArray(value) ? `[${value.map(stable).join(",")}]` : value && typeof value === "object" ? `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}` : JSON.stringify(value);
const sha = (value: unknown) => createHash("sha256").update(stable(value)).digest("hex");

describe("code-owned runtime tool inventory", () => {
  it("covers every top-level and child-accessible implementation path in the generated inventory", async () => {
    const file = fileURLToPath(new URL("../../../docs/inventory/PHASE_F1_RUNTIME_TOOL_INVENTORY.json", import.meta.url));
    const inventory = JSON.parse(await readFile(file, "utf8"));
    expect(RUNTIME_TOOL_NAMES).toEqual(["mcp", "web_search", "fetch_content", "get_search_content", "source_check", "dev_server"]);
    expect(new Set(RUNTIME_TOOL_REGISTRY.map(entry => entry.path)).size).toBe(RUNTIME_TOOL_REGISTRY.length);
    expect(inventory.entries).toEqual(RUNTIME_TOOL_REGISTRY);
    expect(inventory.runtimeToolInventorySha256).toBe(sha(RUNTIME_TOOL_REGISTRY));
    expect(inventory.executorEvidenceBindingSha256).toMatch(/^[a-f0-9]{64}$/u);
  });
});
