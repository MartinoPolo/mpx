import { readFile } from "node:fs/promises";
import { MpxError, parseStrictJson } from "@mpx/core";
import { parseInstallIntentV1, parseInstallPlanV1, type InstallOrchestrator } from "@mpx/installer";

export interface InstallCommandInput { readonly action: string | undefined; readonly args: readonly string[]; readonly options: ReadonlyMap<string, string | boolean | string[]> }
export interface InstallCommandContext { readonly orchestrator: InstallOrchestrator }
const value = (input: InstallCommandInput, name: string): string | undefined => {
  const found = input.options.get(name);
  return typeof found === "string" ? found : undefined;
};
const fail = (message: string): never => { throw new MpxError({ code: "INSTALL_USAGE_ERROR", message }); };
const required = (input: InstallCommandInput, name: string): string => value(input, name) ?? fail(`--${name} is required`);
async function json(file: string): Promise<unknown> {
  try { return parseStrictJson(await readFile(file, "utf8")); }
  catch (failure) {
    if (failure instanceof MpxError) throw failure;
    throw new MpxError({ code: "INSTALL_INPUT_UNREADABLE", message: "Install protocol input is unreadable." });
  }
}
export async function executeInstallCommand(input: InstallCommandInput, context: InstallCommandContext): Promise<{ data: unknown }> {
  if (input.args.length) fail("install commands accept no positional arguments");
  if (input.action === "plan") {
    const intent = parseInstallIntentV1(await json(required(input, "intent")));
    return { data: await context.orchestrator.plan(intent) };
  }
  if (input.action === "apply") {
    const plan = parseInstallPlanV1(await json(required(input, "plan")));
    const receipt = await context.orchestrator.apply(plan, required(input, "confirm-plan"));
    return { data: { schemaVersion: 1, kind: "install-apply", receipt } };
  }
  if (input.action === "verify") return { data: await context.orchestrator.verify(input.options.get("strict") === true) };
  if (input.action === "rollback") return { data: await context.orchestrator.rollback(required(input, "transaction"), required(input, "confirm-plan")) };
  if (input.action === "uninstall") return { data: await context.orchestrator.uninstall(required(input, "confirm-plan")) };
  return fail("install requires plan, apply, verify, rollback, or uninstall");
}
