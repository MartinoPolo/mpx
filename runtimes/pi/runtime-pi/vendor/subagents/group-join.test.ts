import assert from "node:assert/strict";
import test from "node:test";
import { GroupJoinManager } from "./group-join.ts";
import type { AgentRecord } from "./types.ts";

function record(id: string): AgentRecord {
  return { id } as AgentRecord;
}

test("canceling a queued member immediately delivers completed peers", () => {
  const deliveries: Array<{ ids: string[]; partial: boolean }> = [];
  const join = new GroupJoinManager((records, partial) => {
    deliveries.push({ ids: records.map((item) => item.id), partial });
  });

  join.registerGroup("group", ["a", "b"]);
  assert.equal(join.onAgentComplete(record("a")), "held");
  join.cancelAgent("b");

  assert.deepEqual(deliveries, [{ ids: ["a"], partial: false }]);
  assert.equal(join.isGrouped("b"), false);
  join.dispose();
});

test("a remaining member delivers alone when it completes after cancellation", () => {
  const deliveries: Array<{ ids: string[]; partial: boolean }> = [];
  const join = new GroupJoinManager((records, partial) => {
    deliveries.push({ ids: records.map((item) => item.id), partial });
  });

  join.registerGroup("group", ["a", "b"]);
  join.cancelAgent("b");
  assert.deepEqual(deliveries, []);
  assert.equal(join.onAgentComplete(record("a")), "delivered");

  assert.deepEqual(deliveries, [{ ids: ["a"], partial: false }]);
  join.dispose();
});

test("removing every member without completions emits nothing", () => {
  const deliveries: Array<{ ids: string[]; partial: boolean }> = [];
  const join = new GroupJoinManager((records, partial) => {
    deliveries.push({ ids: records.map((item) => item.id), partial });
  });

  join.registerGroup("group", ["a", "b"]);
  join.cancelAgent("a");
  join.cancelAgent("b");

  assert.deepEqual(deliveries, []);
  assert.equal(join.isGrouped("a"), false);
  assert.equal(join.isGrouped("b"), false);
  join.dispose();
});
