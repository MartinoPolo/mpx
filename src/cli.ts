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
import type { Account, Harness, Thinking } from './contracts.js';
import { listNativeSessions, readPiSession, planResume } from './resume.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...args] = process.argv.slice(2);
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
      } else console.log('Agent links: NOT VERIFIED; no MPX2 user configuration.');
      console.log('Hooks/extensions, interactive discovery and cutover: NOT VERIFIED.');
      return drift.length || missingLinks ? 1 : 0;
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
      const scopes = args.filter(arg => arg === '--agents-only' || arg === '--orca-hooks-only');
      if (scopes.length !== 1 || new Set(args).size !== args.length || args.some(arg => !['--agents-only', '--orca-hooks-only', '--preview'].includes(arg))) {
        throw new Error('Full sync is not ready. Choose one scoped operation: sync --agents-only [--preview] or sync --orca-hooks-only [--preview]. Full MPX runtime registration and cutover remain incomplete; no account files changed.');
      }
      if (scopes[0] === '--orca-hooks-only') {
        const config = await readUserConfig(userConfigPath());
        const result = await mirrorOrcaHooks(config, { preview: args.includes('--preview') });
        console.log('Partial sync: Orca-owned hooks only. Runtime registration, Orca/UI behavior and cutover are NOT VERIFIED.');
        for (const entry of result.results) console.log(`${entry.status}: ${entry.source} -> ${entry.destination}${entry.error ? ` (${entry.error})` : ''}`);
        return result.ok ? 0 : 1;
      }
      const config = await readUserConfig(userConfigPath());
      // Preview must not mutate either projections or native roots.
      if (!args.includes('--preview')) await build(root);
      const plan = await planAgentLinks(root, config);
      console.log('Partial sync: specialist links only. Hooks/extensions and cutover are NOT VERIFIED.');
      if (args.includes('--preview')) {
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
    case 'resume': {
      if (args.length === 1 && args[0] === '--list') {
        const config = await readUserConfig(userConfigPath());
        const result = await listNativeSessions(config, process.cwd());
        console.log(JSON.stringify({ ...result, launchVerified: false }, null, 2));
        return 0;
      }
      if (args[0] !== '--preview' || !args[1]) throw new Error('Resume launch is not yet verified. Available read-only operations: resume --list; resume --preview <absolute Pi transcript> --account <personal|work> [--provider value] [--model value] [--thinking level].');
      const values = new Map<string, string>();
      for (let index = 2; index < args.length; index += 2) {
        const flag = args[index]!;
        const value = args[index + 1];
        if (!['--account', '--provider', '--model', '--thinking'].includes(flag) || value === undefined || value.startsWith('--') || values.has(flag)) throw new Error('Invalid or duplicate resume preview option.');
        values.set(flag, value);
      }
      const account = values.get('--account');
      if (account !== 'personal' && account !== 'work') throw new Error('Resume preview requires an explicit personal/work account.');
      const thinking = values.get('--thinking');
      if (thinking !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(thinking)) throw new Error('Invalid resume thinking override.');
      const config = await readUserConfig(userConfigPath());
      const result = await readPiSession(args[1], account, config.accounts[account].pi);
      const plan = await planResume(result.session, { provider: values.get('--provider'), model: values.get('--model'), thinking: thinking as Thinking | undefined });
      console.log(JSON.stringify({ plan, warnings: result.warnings, launchVerified: false }, null, 2));
      return 0;
    }
    case 'project':
      throw new Error(`${command} is not ready: installation gates remain open. No account or project files changed. See migration/PROGRESS.md.`);
    default:
      console.log('MPX2 development checkout\nCommands: build, status, sync <--agents-only|--orca-hooks-only> [--preview], check-staged-secrets [directory], check-package-manager <command> [directory], resume --list/--preview, launch-preview, launch\nFull installation, native resume, safeguards and live cutover are not yet accepted.');
      return command ? 1 : 0;
  }
}
main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(`MPX2: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
