import { LocalIssueStore } from "../dist/index.js";

const [mode, root] = process.argv.slice(2);
if (!mode || !root || !process.send) process.exit(2);

let unblock;
const blocked = new Promise(resolve => { unblock = resolve; });
const store = new LocalIssueStore(root, {
  staleLockMilliseconds: 2_000,
  lockHeartbeatMilliseconds: 10,
  onChanged: async () => {
    process.send?.({ type: "locked" });
    if (mode === "crash") process.exit(0);
    await blocked;
  },
});
process.on("message", message => { if (message === "release") unblock?.(); });
await store.create({ title: mode, body: "" });
process.send({ type: "finished" });
