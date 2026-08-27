import { expect, it, vi } from "vitest";
import { createPiEventCoordinator, formatInlineQuestions } from "../src/event-coordination.js";

it("coordinates auto-title, compaction, fullscreen, and settled notifications without native state", async () => {
  const title = vi.fn(), compact = vi.fn(async () => undefined), fullscreen = vi.fn(), notify = vi.fn();
  const coordinator = createPiEventCoordinator({ title, compact, fullscreen, notify });
  fullscreen(true); await coordinator.sessionStarted(); await coordinator.turnSettled("Implement runtime wiring"); await coordinator.turnSettled("ignored"); await coordinator.beforeCompaction("manual");
  expect(title).toHaveBeenCalledOnce(); expect(compact).toHaveBeenCalledWith("manual"); expect(notify).toHaveBeenCalledTimes(2);
});

it("formats batched inline questions without a structured ask-user tool", () => {
  expect(formatInlineQuestions(["Which model?", "Create a worktree?"])).toBe("Please answer these questions inline:\n1. Which model?\n2. Create a worktree?");
});
