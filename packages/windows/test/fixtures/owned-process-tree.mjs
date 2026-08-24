import { spawn } from "node:child_process";
import { readFile, rename, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";

const [, , mode, readyPath, ownerPidText, signalPath] = process.argv;
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function writeReady(path, value) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(value), "utf8");
  await rename(temporaryPath, path);
}

if (mode === "child" || mode === "adversarial-child") {
  const ownerPid = Number(ownerPidText);
  await writeReady(readyPath, { pid: process.pid });
  let delayedGrandchildStarted = false;
  const startDelayedGrandchild = () => {
    if (delayedGrandchildStarted || mode !== "adversarial-child" || !signalPath || !existsSync(signalPath)) return;
    delayedGrandchildStarted = true;
    // The cancellation request arms a descendant that races the tree snapshot.
    const grandchildReadyPath = `${readyPath}.grandchild`;
    spawn(process.execPath, [import.meta.filename, "grandchild", grandchildReadyPath, String(process.pid)], {
      stdio: "ignore",
      windowsHide: true,
    });
  };
  const ownerWatch = setInterval(() => {
    startDelayedGrandchild();
    try {
      process.kill(ownerPid, 0);
    } catch {
      clearInterval(ownerWatch);
      setTimeout(() => process.exit(0), mode === "adversarial-child" ? 100 : 0);
    }
  }, mode === "adversarial-child" ? 1 : 10);
} else if (mode === "grandchild") {
  const ownerPid = Number(ownerPidText);
  await writeReady(readyPath, { pid: process.pid });
  const ownerWatch = setInterval(() => {
    try {
      process.kill(ownerPid, 0);
    } catch {
      clearInterval(ownerWatch);
      process.exit(0);
    }
  }, 10);
} else if (mode === "parent" || mode === "adversarial-parent") {
  const childMode = mode === "adversarial-parent" ? "adversarial-child" : "child";
  const childReadyPath = `${readyPath}.child`;
  const child = spawn(process.execPath, [import.meta.filename, childMode, childReadyPath, String(process.pid), `${readyPath}.cancel`], {
    stdio: "ignore",
    windowsHide: true,
  });

  const deadline = Date.now() + 5_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Child exited before readiness (${child.exitCode})`);
    try {
      const childReady = JSON.parse(await readFile(childReadyPath, "utf8"));
      await writeReady(readyPath, { parentPid: process.pid, childPid: childReady.pid });
      ready = true;
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
      await sleep(20);
    }
  }
  if (!ready) {
    child.kill();
    throw new Error("Child readiness timed out");
  }
  setInterval(() => undefined, 1_000);
} else {
  throw new Error("Expected parent or child mode");
}
