import { lstat, readFile } from "node:fs/promises";
import { MpxError, parseStrictJson } from "@mpx/core";
import { parseInstallIntentBuildResultV1, parseInstallIntentV1, parseInstallPlanV1, type InstallIntentBuilder, type InstallOrchestrator } from "@mpx/installer";

export interface InstallCommandInput { readonly action: string | undefined; readonly args: readonly string[]; readonly options: ReadonlyMap<string, string | boolean | string[]> }
export interface InstallCommandContext { readonly orchestrator: InstallOrchestrator; readonly builder?: InstallIntentBuilder }
const value = (input: InstallCommandInput, name: string): string | undefined => {
  const found = input.options.get(name);
  return typeof found === "string" ? found : undefined;
};
const fail = (message: string): never => { throw new MpxError({ code: "INSTALL_USAGE_ERROR", message }); };
const required = (input: InstallCommandInput, name: string): string => value(input, name) ?? fail(`--${name} is required`);
async function json(file: string): Promise<unknown> {
  try {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 * 1024) throw new Error("unsafe input");
    return parseStrictJson(await readFile(file, "utf8"));
  } catch (failure) {
    if (failure instanceof MpxError) throw failure;
    throw new MpxError({ code: "INSTALL_INPUT_UNREADABLE", message: "Install protocol input is unreadable." });
  }
}
function requestJson(value: string): Promise<unknown> {
  const trimmed = value.trim();
  if (trimmed.startsWith("{")) {
    if (Buffer.byteLength(value, "utf8") > 1024 * 1024) fail("--request JSON exceeds the 1 MiB protocol bound");
    return Promise.resolve(parseStrictJson(value));
  }
  return json(value);
}
function builder(context: InstallCommandContext): InstallIntentBuilder { return context.builder ?? fail("install intent and prepare require an intent builder"); }
export async function executeInstallCommand(input: InstallCommandInput, context: InstallCommandContext): Promise<{ data: unknown }> {
  if (input.args.length) fail("install commands accept no positional arguments");
  if (input.action === "intent" || input.action === "prepare") {
    const request = await requestJson(required(input, "request"));
    const built = await builder(context).build(request);
    return { data: input.action === "prepare" ? await context.orchestrator.plan(built.intent) : built };
  }
  if (input.action === "plan") {
    const source = await json(required(input, "intent"));
    const intent = source && typeof source === "object" && !Array.isArray(source) && (source as { kind?: unknown }).kind === "install-intent-build-result"
      ? parseInstallIntentBuildResultV1(source).intent
      : parseInstallIntentV1(source);
    return { data: await context.orchestrator.plan(intent) };
  }
  if (input.action === "apply") {
    const plan = parseInstallPlanV1(await json(required(input, "plan")));
    const receipt = await context.orchestrator.apply(plan, required(input, "confirm-plan"));
    return { data: { schemaVersion: 1, kind: "install-apply", receipt } };
  }
  if (input.action === "verify") {
    const externalPlanFile = value(input, "external-plan"), raycastEvidenceFile = value(input, "raycast-post-export");
    if (!externalPlanFile && raycastEvidenceFile) fail("--raycast-post-export requires --external-plan");
    const externalPlan = externalPlanFile ? parseInstallIntentBuildResultV1(await json(externalPlanFile)) : undefined;
    const raycastEvidence = raycastEvidenceFile ? await json(raycastEvidenceFile) : undefined;
    const externalSource = externalPlan ? () => builder(context).verify(externalPlan, raycastEvidence) : undefined;
    return { data: await context.orchestrator.verify(input.options.get("strict") === true, externalSource) };
  }
  if (input.action === "rollback") return { data: await context.orchestrator.rollback(required(input, "transaction"), required(input, "confirm-plan")) };
  if (input.action === "uninstall") return { data: await context.orchestrator.uninstall(required(input, "confirm-plan")) };
  return fail("install requires intent, prepare, plan, apply, verify, rollback, or uninstall");
}
