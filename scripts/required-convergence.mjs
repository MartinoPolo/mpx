import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const verifier = path.join(repositoryRoot, "scripts", "generate-convergence-manifest.mjs");
const exec = promisify(execFile);

async function available(directory) {
  try { await access(directory); return true; } catch { return false; }
}

export async function runRequiredConvergence(environment = process.env, dependencies = {}) {
  const write = dependencies.write ?? ((message) => process.stdout.write(`${message}\n`));
  const run = dependencies.run ?? (async (executable, argv, options) => {
    const result = await exec(executable, argv, { ...options, encoding: "utf8", windowsHide: true });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    return { exitCode: 0 };
  });
  const projects = environment.MPX_PROJECTS;
  if (!projects) {
    const reason = "MPX_PROJECTS is not configured";
    if (environment.CI) {
      const code = "MPX_PROJECTS_REQUIRED";
      write(`ERROR convergence:verify [${code}] — ${reason}.`);
      return { status: "failed", code, reason };
    }
    write(`SKIP convergence:verify — ${reason}; legacy source drift cannot be checked.`);
    return { status: "skipped", reason };
  }
  const required = [path.join(projects, "mpx-claude-code"), path.join(projects, "mpx-pi")];
  const missing = [];
  for (const root of required) if (!await available(root)) missing.push(root);
  if (missing.length) {
    const reason = `legacy source roots are unavailable: ${missing.join(", ")}`;
    if (environment.CI) {
      const code = "LEGACY_SOURCE_ROOTS_REQUIRED";
      write(`ERROR convergence:verify [${code}] — ${reason}.`);
      return { status: "failed", code, reason, missing };
    }
    write(`SKIP convergence:verify — ${reason}.`);
    return { status: "skipped", reason, missing };
  }
  await run(process.execPath, [verifier, "--check"], { cwd: repositoryRoot, env: { ...environment, MPX_PROJECTS: projects } });
  return { status: "verified", sourceRoots: required };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runRequiredConvergence();
  if (result.status === "failed") process.exitCode = 1;
}
