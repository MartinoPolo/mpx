import { InstallerService, SESSION_CAPTURE_COMPONENT, type InstallPlan, type InstalledRunnerEvidence, type UninstallPlan } from "@mpx/installer";
import { MpxError } from "@mpx/core";

export interface InstallCommandInput { readonly action: string | undefined; readonly args: readonly string[]; readonly options: ReadonlyMap<string, string | boolean | string[]> }
export interface InstallCommandContext { readonly service: InstallerService }
const value = (input: InstallCommandInput, name: string): string | undefined => {
  const found = input.options.get(name);
  return typeof found === "string" ? found : undefined;
};
const required = (input: InstallCommandInput, name: string): string => value(input, name) ?? fail(`--${name} is required`);
const fail = (message: string): never => { throw new MpxError({ code: "INSTALL_USAGE_ERROR", message }); };
function component(input: InstallCommandInput): string {
  const selected = required(input, "component");
  if (selected !== SESSION_CAPTURE_COMPONENT) fail("Only --component session-capture is supported");
  return selected;
}
function runner(input: InstallCommandInput): InstalledRunnerEvidence {
  return { path: required(input, "runner"), sha256: required(input, "runner-sha256"), version: required(input, "runner-version") };
}
export async function executeInstallCommand(input: InstallCommandInput, context: InstallCommandContext): Promise<{ data: unknown }> {
  if (input.args.length) fail("install commands accept no positional arguments");
  const selected = component(input), action = input.action;
  if (action === "plan") return { data: await context.service.plan({ componentId: selected, runner: runner(input) }) };
  if (action === "apply") {
    const plan = await context.service.plan({ componentId: selected, runner: runner(input) });
    const confirmation = required(input, "confirm-plan");
    return { data: { schemaVersion: 1, kind: "install-apply", receipt: await context.service.apply(plan as InstallPlan, confirmation) } };
  }
  if (action === "verify") return { data: await context.service.verify(selected) };
  if (action === "uninstall") {
    const plan = await context.service.planUninstall(selected);
    const confirmation = value(input, "confirm-plan");
    if (confirmation === undefined) return { data: plan };
    await context.service.uninstall(plan as UninstallPlan, confirmation);
    return { data: { schemaVersion: 1, kind: "uninstall", removed: true } };
  }
  return fail("install requires plan, apply, verify, or uninstall");
}
