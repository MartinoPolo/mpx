import { writeFile } from "node:fs/promises";
import path from "node:path";

const token = process.env.MPX_PREPARATION_WORKER_TOKEN;
const marker = process.env.MPX_TEST_ACTIVATION_MARKER;
const expiry = setTimeout(() => process.exit(2), 6_000);
process.on("message", async message => {
  if (message?.type === "mpx-preparation-activate" && message.workerToken === token) {
    clearTimeout(expiry);
    if (marker) await writeFile(marker, "activated");
    process.exit(0);
  }
  if (message?.type === "mpx-preparation-abort") process.exit(1);
});
process.send?.({ type: "mpx-preparation-ready", workerToken: token, requestId: path.basename(process.argv.at(-1)) });
