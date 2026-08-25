import { expect, it, vi } from "vitest";
import { activatePiSubagentBridge } from "../src/subagent-bridge.js";

it("registers Agent/result/steer over the provider-neutral lifecycle and preserves fleet surfaces", async () => {
  const tools = new Map<string, { execute(id: string, params: Record<string, unknown>): Promise<{ content: Array<{ text: string }> }> }>();
  const launch = vi.fn(async () => ({ id: "a1", status: "running" })); const result = vi.fn(async () => "done"); const steer = vi.fn();
  activatePiSubagentBridge({ registerTool(tool) { tools.set(tool.name, tool); } }, { lifecycle: { launch, get_subagent_result: result, steer_subagent: steer, list: () => [] }, createLaunchRequest: params => params as never, updateFleet: vi.fn(), notify: vi.fn() });
  expect([...tools.keys()]).toEqual(["Agent", "get_subagent_result", "steer_subagent"]);
  expect((await tools.get("Agent")!.execute("call", { description: "task" })).content[0]!.text).toContain('"id":"a1"');
  await tools.get("get_subagent_result")!.execute("call", { id: "a1" }); expect(result).toHaveBeenCalledWith("a1");
  await tools.get("steer_subagent")!.execute("call", { id: "a1", message: "focus" }); expect(steer).toHaveBeenCalledWith("a1", "focus");
});
