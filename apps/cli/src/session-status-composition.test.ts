import { expect, it } from "vitest";
import { createRuntimeSessionObservationV1 } from "@mpx/runtime-contracts";
import { composeRuntimeSessionObservation } from "./launch-execution.js";
import { composeRuntimeStatusEnvelopeV1 } from "@mpx/status";

it("composes a fresh session observation into the runtime status envelope", () => {
  const generatedAt = "2025-02-02T03:04:05.000Z";
  const binding = { launchKey: "launch", runtimeId: "pi", repositoryId: "repo" };
  const envelope = composeRuntimeStatusEnvelopeV1({ generatedAt, binding, harness: { kind: "pi", version: null, surface: "footer" }, contributions: [] });
  const observation = createRuntimeSessionObservationV1({ runtime: "pi", identityRef: "personal:me", runtimeQualifiedId: "pi:native", displayId: "native", title: "Focused work", resumeState: "resumable", lifecycleState: "active", workflowStatus: "unfinished", inbox: true, dispositionAt: null, capturedAt: generatedAt, freshUntil: "2025-02-02T03:05:05.000Z", source: "sessions:lifecycle", diagnostic: null });

  const composed = composeRuntimeSessionObservation(envelope, observation, "2025-02-02T03:04:30.000Z");

  expect(composed.session).toEqual({ freshness: { state: "current", observedAt: generatedAt, errorCode: null }, elapsedMs: null, turns: null, title: "Focused work" });
});
