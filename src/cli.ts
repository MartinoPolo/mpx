import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { build, checkOutput } from './compiler.js';
import { readUserConfig, resolveProject, selectPacks } from './config.js';
import { createLaunchSpec, confirmLaunch, runLaunch } from './launch.js';
import type { Account, Harness } from './contracts.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [command, ...args] = process.argv.slice(2);
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
      console.log(drift.length ? `Output drift:\n${drift.map(file => `  ${file}`).join('\n')}` : 'Committed projection bytes match canonical source.');
      console.log(`Project: ${project.config?.projectId ?? 'unregistered'}${project.mainCheckout ? ` (${project.mainCheckout})` : ''}`);
      for (const account of ['personal', 'work'] as const) {
        for (const harness of ['pi', 'claude'] as const) {
          const selection = await selectPacks(root, harness, account, project);
          console.log(`${account}/${harness}: ${selection.packs.join(', ') || 'native skills only'}`);
          for (const warning of selection.warnings) console.warn(`Warning: ${warning}`);
        }
      }
      console.log('Installed account links/hooks, interactive discovery and cutover: NOT VERIFIED; no installation performed.');
      return drift.length ? 1 : 0;
    }
    case 'launch':
    case 'launch-preview': {
      const [harnessName, accountName, ...callerArgs] = args;
      if (!['pi', 'claude', 'xpi'].includes(harnessName ?? '') || !['personal', 'work'].includes(accountName ?? '')) {
        throw new Error('Usage: mpx launch[-preview] <pi|claude|xpi> <personal|work> [native arguments...]');
      }
      const harness: Harness = harnessName === 'claude' ? 'claude' : 'pi';
      const account = accountName as Account;
      if (!process.env.APPDATA) throw new Error('APPDATA is unset; cannot resolve mpx2/config.json.');
      const config = await readUserConfig(join(process.env.APPDATA, 'mpx2', 'config.json'));
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
    case 'sync':
    case 'project':
    case 'resume':
      throw new Error(`${command} is not ready: installation/resume gates remain open. No account or project files changed. See migration/PROGRESS.md.`);
    default:
      console.log('MPX2 development checkout\nCommands: build, status, launch-preview, launch\nInstallation, native resume, safeguards and live cutover are not yet accepted.');
      return command ? 1 : 0;
  }
}
main().then(code => { process.exitCode = code; }).catch(error => {
  console.error(`MPX2: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
