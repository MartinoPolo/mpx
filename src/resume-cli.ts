import { createInterface } from 'node:readline/promises';
import type { Account, Harness, Thinking, UserConfig } from './contracts.js';
import { listNativeSessions, readClaudeSession, readPiSession, planResume, type NativeSession, type ResumeOverrides } from './resume.js';
import { prepareResumeLaunch } from './resume-launch.js';
import { confirmLaunch, runLaunch } from './launch.js';

export async function resumeCommand(root: string, config: UserConfig, args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === '--list') {
    console.log(JSON.stringify({ ...await listNativeSessions(config, process.cwd()), launchVerified: false }, null, 2)); return 0;
  }
  const preview = args[0] === '--preview';
  const explicit = preview || args[0] === '--launch';
  const values = new Map<string, string>();
  if (explicit) {
    if (!args[1]) throw new Error('Resume requires an absolute native transcript path.');
    for (let index = 2; index < args.length; index += 2) {
      const flag = args[index]!; const value = args[index + 1];
      if (!['--account', '--harness', '--provider', '--model', '--thinking'].includes(flag) || !value || value.startsWith('--') || values.has(flag)) throw new Error('Invalid or duplicate resume option.');
      values.set(flag, value);
    }
  } else if (args.length) throw new Error('Usage: resume [--list | --preview/--launch <transcript> --account personal|work [--harness pi|claude] [--provider id] [--model id] [--thinking level]]. No arguments opens the combined picker.');
  const overrides: ResumeOverrides = { provider: values.get('--provider'), model: values.get('--model'), thinking: values.get('--thinking') as Thinking | undefined };
  let session: NativeSession;
  if (explicit) {
    const account = values.get('--account') as Account;
    const harness = (values.get('--harness') ?? 'pi') as Harness;
    if (!['personal', 'work'].includes(account) || !['pi', 'claude'].includes(harness)) throw new Error('Resume requires a valid explicit account and harness.');
    const result = await (harness === 'pi' ? readPiSession : readClaudeSession)(args[1]!, account, config.accounts[account][harness]);
    session = result.session;
    if (preview) {
      console.log(JSON.stringify({ plan: await planResume(session, overrides), warnings: result.warnings, launchVerified: false }, null, 2)); return 0;
    }
  } else {
    if (!process.stdin.isTTY) throw new Error('The native resume picker requires an interactive terminal; use --list or --preview.');
    const listing = await listNativeSessions(config, process.cwd());
    for (const warning of listing.warnings) console.error(`Warning: ${warning}`);
    if (listing.sessions.length === 0) { console.log('No readable native sessions.'); return 0; }
    const rl = createInterface({ input: process.stdin, output: process.stderr });
    try {
      listing.sessions.forEach((item, index) => console.error(`${index + 1}. ${item.account.toUpperCase()} · ${item.harness} · ${item.title}\n   ${item.cwd} · ${item.provider ?? (item.harness === 'claude' ? 'native account' : 'unknown')}/${item.model ?? 'unknown'} · effort ${item.thinking ?? 'unknown'}`));
      const answer = await rl.question('Session number (empty cancels): ');
      if (!answer.trim()) return 0;
      const number = Number(answer);
      if (!Number.isSafeInteger(number) || number < 1 || number > listing.sessions.length) throw new Error('Invalid session selection.');
      session = listing.sessions[number - 1]!;
      if (session.harness === 'pi' && !session.provider) overrides.provider = await rl.question('Provider (override; historical state unknown): ');
      if (!session.model) overrides.model = await rl.question('Model (override; historical state unknown): ');
      if (!session.thinking || session.harness === 'claude') overrides.thinking = await rl.question('Effort (override; historical state unknown): ') as Thinking;
      const proceed = await rl.question('Confirm this session is not already open elsewhere. Type resume to launch, or Enter to cancel: ');
      if (proceed !== 'resume') return 0;
    } finally { rl.close(); }
  }
  const prepared = await prepareResumeLaunch({ root, config, session, overrides });
  console.error(prepared.spec.label);
  console.error(`Native session ${session.id}\n${session.cwd}`);
  for (const [name, field] of Object.entries(prepared.plan.fields)) if (field) console.error(`${name}: ${field.value} (${field.provenance})`);
  for (const warning of prepared.spec.warnings) console.error(`Warning: ${warning}`);
  console.error(prepared.verification.verified ? 'Native Pi model/effort availability preflight passed; verify actual resumed state in the native UI.' : `NOT VERIFIED: ${prepared.verification.reason}`);
  await confirmLaunch(prepared.spec);
  return runLaunch(prepared.spec);
}
