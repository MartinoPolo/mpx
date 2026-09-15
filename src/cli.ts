import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { lstat } from 'node:fs/promises';
import { planAgentLinks, inspectAgentLinks, syncAgentLinks } from './install.js';
import { mirrorOrcaHooks } from './orca.js';
import { scanStagedSecrets } from './safeguards/staged-secrets.js';
import { evaluatePackageManager } from './safeguards/package-manager.js';
import { build, checkOutput } from './compiler.js';
import { readUserConfig, resolveProject, selectPacks } from './config.js';
import { createLaunchSpec, confirmLaunch, runLaunch } from './launch.js';
import type { Account, Harness } from './contracts.js';
import { resumeCommand } from './resume-cli.js';
import { syncRuntime, syncRuntimeScope } from './runtime-install.js';
import { setupProject, orcaProjectSnippet } from './project.js';
import { evaluateDangerousCommand } from './safeguards/dangerous.js';
import { createLegacyLaunch } from './legacy.js';
import { inspectNativePackages } from './native-packages.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...args] = process.argv.slice(2);
const syncSyntax = 'sync [--agents-only|--orca-hooks-only [--harness pi|claude]|--runtime-only [--account personal|work --harness pi|claude]] [--preview]';
function userConfigPath(): string {
  if (!process.env.APPDATA) throw new Error('APPDATA is unset; cannot resolve mpx2/config.json.');
  return join(process.env.APPDATA, 'mpx2', 'config.json');
}
async function optionalUserConfig() {
  if (!process.env.APPDATA) return undefined;
  const file = userConfigPath();
  try { await lstat(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  return readUserConfig(file);
}
async function main(): Promise<number> {
  switch (command) {
    case 'build': {
      const result = await build(root);
      console.log(`Built ${result.files.length} projections; ${result.changed.length} changed.`);
      return 0;
    }
    case 'status': {
      const drift = await checkOutput(root);
      const project = await resolveProject(process.cwd());
      const config = await optionalUserConfig();
      console.log(drift.length ? `Output drift:\n${drift.map(file => `  ${file}`).join('\n')}` : 'Committed projection bytes match canonical source.');
      console.log(`Project: ${project.config?.projectId ?? 'unregistered'}${project.mainCheckout ? ` (${project.mainCheckout})` : ''}`);
      for (const account of ['personal', 'work'] as const) {
        for (const harness of ['pi', 'claude'] as const) {
          const selection = await selectPacks(root, harness, account, project, config);
          console.log(`${account}/${harness}: ${selection.packs.join(', ') || 'native skills only'}`);
          for (const warning of selection.warnings) console.warn(`Warning: ${warning}`);
        }
      }
      let missingLinks = false;
      if (config) {
        console.log('Agent links (read-only inspection):');
        const inspection = await inspectAgentLinks(await planAgentLinks(root, config));
        missingLinks = !inspection.ok;
        for (const error of inspection.errors) console.error(`Agent-link planning failed (${error.harness}, ${error.sourceDirectory}): ${error.error}`);
        for (const entry of inspection.results) {
          console.log(`  ${entry.account}/${entry.harness}: ${entry.status} ${entry.source ?? '(unowned entry)'} -> ${entry.destination}${entry.error ? ` (${entry.error})` : ''}`);
          if (entry.status !== 'linked') missingLinks = true;
        }
        const runtime = await syncRuntime(root, config, true);
        console.log('Runtime registrations/settings (read-only preview):');
        for (const entry of runtime.entries) {
          console.log(`  ${entry.status}: ${entry.source} -> ${entry.destination}${entry.diagnostic ? ` (${entry.diagnostic})` : ''}`);
          if (entry.status !== 'unchanged') missingLinks = true;
        }
        const orca = await mirrorOrcaHooks(config, { preview: true });
        for (const entry of orca.results) console.log(`  Orca ${entry.status}: ${entry.source} -> ${entry.destination}${entry.error ? ` (${entry.error})` : ''}`);
        if (!orca.ok) missingLinks = true;
        const packages = await inspectNativePackages(['personal', 'work'].map(account => ({ account, root: config.accounts[account as Account].pi })));
        for (const item of packages.packages) {
          console.log(`  ${item.account}/${item.packageName}: ${item.status}; ${item.version ?? 'unknown version'}; ${item.loadTargets.join(', ')}${item.missing.length ? ` (${item.missing.join('; ')})` : ''}`);
          if (item.status !== 'ready') missingLinks = true;
        }
        for (const conflict of packages.conflicts) console.log(`  Native package versions differ: ${conflict.packageName} ${conflict.versions.join(' / ')} (preserved; no upgrades)`);
      } else console.log('Agent links: NOT VERIFIED; no MPX2 user configuration.');
      console.log('Hooks/extensions, interactive discovery and cutover: NOT VERIFIED.');
      return drift.length || missingLinks ? 1 : 0;
    }
    case 'legacy-launch': {
      const spec = await createLegacyLaunch(root, process.cwd(), await readUserConfig(userConfigPath()), await resolveProject(process.cwd()), args);
      console.error(spec.label);
      for (const warning of spec.warnings) console.error(`Warning: ${warning}`);
      await confirmLaunch(spec);
      return runLaunch(spec);
    }
    case 'launch':
    case 'launch-preview': {
      const [harnessName, accountName, ...callerArgs] = args;
      if (!['pi', 'claude', 'xpi'].includes(harnessName ?? '') || !['personal', 'work'].includes(accountName ?? '')) {
        throw new Error('Usage: mpx launch[-preview] <pi|claude|xpi> <personal|work> [native arguments...]');
      }
      const harness: Harness = harnessName === 'claude' ? 'claude' : 'pi';
      const account = accountName as Account;
      const config = await readUserConfig(userConfigPath());
      const project = await resolveProject(process.cwd());
      const selection = await selectPacks(root, harness, account, project, config);
      const spec = await createLaunchSpec({ root, cwd: process.cwd(), harness, account, config, project, selection, args: callerArgs, native: harnessName === 'xpi' });
      console.error(spec.label);
      for (const warning of spec.warnings) console.error(`\x1b[33mWarning: ${warning}\x1b[0m`);
      if (command === 'launch-preview') {
        // Never print the full inherited environment: it may contain provider credentials.
        console.log(JSON.stringify({ executable: spec.executable, args: spec.args, cwd: spec.cwd, accountRoot: config.accounts[account][harness], packs: selection.packs, requiresConfirmation: spec.requiresConfirmation }, null, 2));
        return 0;
      }
      await confirmLaunch(spec);
      return runLaunch(spec);
    }
    case 'check-dangerous': {
      if (!args[0]?.trim() || args.length > 2) throw new Error('Usage: mpx check-dangerous <quoted shell command> [directory]. Inspects only.');
      const result = await evaluateDangerousCommand(args[0], resolve(args[1] ?? process.cwd()));
      console.log(`Dangerous-command policy: ${result.decision}`);
      for (const diagnostic of result.diagnostics) console.error(diagnostic);
      return result.decision === 'block' ? 1 : 0;
    }
    case 'check-package-manager': {
      if (!args[0]?.trim() || args.length > 2) throw new Error('Usage: mpx check-package-manager <quoted shell command> [directory]. Inspects only; never executes the command.');
      const result = await evaluatePackageManager(args[0], resolve(args[1] ?? process.cwd()));
      console.log(`Package-manager policy: ${result.decision}`);
      for (const diagnostic of result.diagnostics) console.error(diagnostic);
      return result.decision === 'block' ? 1 : 0;
    }
    case 'check-staged-secrets': {
      if (args.length > 1 || args[0]?.startsWith('--')) throw new Error('Usage: mpx check-staged-secrets [repository-directory]');
      const result = await scanStagedSecrets(resolve(args[0] ?? process.cwd()));
      console.log(`Staged-secret scan: ${result.decision}`);
      for (const diagnostic of result.diagnostics) console.error(diagnostic);
      return result.decision === 'block' ? 1 : 0;
    }
    case 'sync': {
      const usage = `Usage: ${syncSyntax}. No live cutover is performed.`;
      let component: '--agents-only' | '--orca-hooks-only' | '--runtime-only' | undefined;
      let preview = false;
      let account: Account | undefined;
      let harness: Harness | undefined;
      const seen = new Set<string>();
      for (let index = 0; index < args.length; index++) {
        const argument = args[index];
        if (!argument || seen.has(argument)) throw new Error(usage);
        seen.add(argument);
        if (argument === '--preview') { preview = true; continue; }
        if (argument === '--agents-only' || argument === '--orca-hooks-only' || argument === '--runtime-only') {
          if (component) throw new Error(usage);
          component = argument;
          continue;
        }
        if (argument === '--account' || argument === '--harness') {
          const value = args[++index];
          if (!value || value.startsWith('--') || (argument === '--account' ? account !== undefined : harness !== undefined)) throw new Error(usage);
          if (argument === '--account') {
            if (value !== 'personal' && value !== 'work') throw new Error(usage);
            account = value;
          } else {
            if (value !== 'pi' && value !== 'claude') throw new Error(usage);
            harness = value;
          }
          continue;
        }
        throw new Error(usage);
      }
      if (component === '--runtime-only') {
        if ((account === undefined) !== (harness === undefined)) throw new Error(usage);
      } else if (component === '--orca-hooks-only') {
        if (account !== undefined) throw new Error(usage);
      } else if (account !== undefined || harness !== undefined) throw new Error(usage);

      if (!component || component === '--runtime-only') {
        const config = await readUserConfig(userConfigPath());
        const runtimeScope = account !== undefined && harness !== undefined ? { account, harness } : undefined;
        // Scoped runtime sources are already present in the checkout; never rebuild unrelated projections.
        if (!preview && !runtimeScope) await build(root);
        const runtime = runtimeScope
          ? await syncRuntimeScope(root, config, runtimeScope, preview)
          : await syncRuntime(root, config, preview);
        if (!runtimeScope) console.log('Broad runtime scope: personal/work and Pi/Claude roots.');
        for (const entry of runtime.entries) console.log(`${entry.account}/${entry.harness} ${entry.status}: ${entry.source} -> ${entry.destination}${entry.diagnostic ? ` (${entry.diagnostic})` : ''}`);
        let ok = runtime.ok;
        if (!component) {
          const plan = await planAgentLinks(root, config);
          const agents = preview ? await inspectAgentLinks(plan) : await syncAgentLinks(plan);
          const orca = await mirrorOrcaHooks(config, { preview });
          for (const entry of agents.results) console.log(`${entry.status}: ${entry.source ?? '(unowned)'} -> ${entry.destination}${entry.error ? ` (${entry.error})` : ''}`);
          for (const entry of orca.results) console.log(`${entry.status}: ${entry.source} -> ${entry.destination}${entry.error ? ` (${entry.error})` : ''}`);
          ok &&= agents.ok && orca.ok;
        }
        console.log('Owned entries only. Legacy disconnection, installed runtime acceptance and cutover are NOT VERIFIED; no launcher/account switch is performed.');
        return ok ? 0 : 1;
      }
      if (component === '--orca-hooks-only') {
        const config = await readUserConfig(userConfigPath());
        const result = await mirrorOrcaHooks(config, { preview, harness });
        console.log('Partial sync: Orca-owned hooks only. Runtime registration, Orca/UI behavior and cutover are NOT VERIFIED.');
        for (const entry of result.results) console.log(`${entry.status}: ${entry.source} -> ${entry.destination}${entry.error ? ` (${entry.error})` : ''}`);
        return result.ok ? 0 : 1;
      }
      const config = await readUserConfig(userConfigPath());
      // Preview must not mutate either projections or native roots.
      if (!preview) await build(root);
      const plan = await planAgentLinks(root, config);
      console.log('Partial sync: specialist links only. Hooks/extensions and cutover are NOT VERIFIED.');
      if (preview) {
        const inspection = await inspectAgentLinks(plan);
        for (const error of inspection.errors) console.error(`Agent-link planning failed (${error.harness}, ${error.sourceDirectory}): ${error.error}`);
        for (const entry of inspection.results) console.log(`${entry.status}: ${entry.source ?? '(unowned entry)'} -> ${entry.destination}${entry.error ? ` (${entry.error})` : ''}`);
        return inspection.ok ? 0 : 1;
      }
      const result = await syncAgentLinks(plan);
      for (const error of result.errors) console.error(`Agent-link planning failed (${error.harness}, ${error.sourceDirectory}): ${error.error}`);
      for (const entry of result.results) console.log(`${entry.action} (${entry.status}): ${entry.source ?? '(unowned entry)'} -> ${entry.destination}${entry.error ? ` (${entry.error})` : ''}`);
      if (!result.ok) console.error('Partial sync failed for the reported entries; unrelated entries were preserved.');
      return result.ok ? 0 : 1;
    }
    case 'resume':
      return resumeCommand(root, await readUserConfig(userConfigPath()), args);
    case 'project': {
      if (args[0] !== 'setup' || args.slice(2).some(arg => !['--preview', '--non-interactive'].includes(arg))) throw new Error('Usage: mpx project setup <directory> [--preview] [--non-interactive]');
      const result = await setupProject(resolve(args[1] ?? '.'), args.includes('--preview'));
      console.log(`${result.status}: ${result.source} -> ${result.destination}${result.diagnostic ? ` (${result.diagnostic})` : ''}`);
      console.log(orcaProjectSnippet());
      return result.status === 'conflict' ? 1 : 0;
    }
    default:
      console.log(`MPX2 development checkout\nCommands: build, status, ${syncSyntax}, project setup, check-dangerous, check-staged-secrets, check-package-manager, resume [--list|--preview|--launch], launch-preview, launch\nLocal implementation only: installed acceptance and live cutover remain gated.`);
      return command ? 1 : 0;
  }
}
main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(`MPX2: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
