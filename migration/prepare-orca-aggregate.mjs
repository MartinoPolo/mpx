// Migration-only patch preparation. Never edits the supplied Orca source or installs the result.
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
const source = process.argv[2];
if (!source || !path.isAbsolute(source)) throw new Error('Supply the absolute Orca Pi hook source path.');
const original = await readFile(source, 'utf8');
let candidate = original;
function replace(before, after) {
  if (candidate.split(before).length !== 2) throw new Error('Orca source changed: patch anchor is missing or ambiguous.');
  candidate = candidate.replace(before, after);
}
const bridge = `
// Checkout-local candidate: aggregate authority stays in MPX2; this Orca hook is the only sender.
// DEPLOYMENT GATE: the current Pi receiver drops interrupted. Cancellation requires its companion fix.
type MpxActivity = {
  sessionId: string; activityId: string; revision: number;
  state: 'idle' | 'working' | 'human-needed' | 'done' | 'cancelled';
  mainActive: boolean; activeChildren: number; backgroundWork: number; pendingFollowUps: number;
  humanNeeded: boolean; settling: boolean;
}
let mpxActivity: MpxActivity | null = null
let mpxActivityId = ''
let mpxRevision = -1
let mpxAnnouncedState = ''

function acceptMpxActivity(value: unknown): value is MpxActivity {
  if (isOmpRuntime() || !value || typeof value !== 'object') return false
  const a = value as MpxActivity
  if (typeof a.sessionId !== 'string' || a.sessionId !== sessionMetadata.session_id ||
      typeof a.activityId !== 'string' || !a.activityId ||
      !Number.isSafeInteger(a.revision) || a.revision < 0 ||
      !['idle', 'working', 'human-needed', 'done', 'cancelled'].includes(a.state)) return false
  if (![a.activeChildren, a.backgroundWork, a.pendingFollowUps].every(n => Number.isSafeInteger(n) && n >= 0) ||
      ![a.mainActive, a.humanNeeded, a.settling].every(v => typeof v === 'boolean')) return false
  if ((a.state === 'done' || a.state === 'cancelled') &&
      (a.mainActive || a.activeChildren || a.backgroundWork || a.pendingFollowUps || a.humanNeeded || a.settling)) return false
  return true
}

function aggregatePost(event: string, extra: Record<string, unknown>): [string, Record<string, unknown>] | null {
  const a = mpxActivity
  if (!a || isOmpRuntime() || event === 'session_start' || event === 'before_agent_start') return [event, extra]
  const synthetic = event === 'mpx_activity'
  if (a.state === 'idle') return null
  if (a.state === 'done' || a.state === 'cancelled') {
    if (!synthetic || mpxAnnouncedState === a.state) return null
    mpxAnnouncedState = a.state
    return ['agent_end', { ...extra, interrupted: a.state === 'cancelled', mpx_activity: a }]
  }
  if (synthetic && mpxAnnouncedState === a.state) return null
  mpxAnnouncedState = a.state
  const next = synthetic || event === 'agent_end' || event === 'ui_prompt_end' ? 'tool_execution_end' : event
  return [next, { ...extra, ui_prompt_active: a.state === 'human-needed', is_idle: false, mpx_activity: a }]
}
`;
replace('function post(hookEventName: string, extra: Record<string, unknown> = {}): void {', bridge + '\nfunction post(hookEventName: string, extra: Record<string, unknown> = {}): void {\n  const projected = aggregatePost(hookEventName, extra)\n  if (!projected) return\n  ;[hookEventName, extra] = projected');
replace("extra: { ...extra, ...(!ompRuntime && piUiPromptDepth > 0 ? { ui_prompt_active: true } : {}) },", "extra: { ...extra, ...(!ompRuntime && !mpxActivity && piUiPromptDepth > 0 ? { ui_prompt_active: true } : {}) },");
replace('function getPersistedSessionMetadata(): Record<string, unknown> {\n  const sessionFile = sessionMetadata.session_file', 'function getPersistedSessionMetadata(metadata = sessionMetadata): Record<string, unknown> {\n  const sessionFile = metadata.session_file');
replace('return fs.existsSync(sessionFile) ? sessionMetadata : {}', 'return fs.existsSync(sessionFile) ? metadata : {}');
replace('ompRuntime ? metadata : getPersistedSessionMetadata()', 'ompRuntime ? metadata : getPersistedSessionMetadata(metadata)');
replace("  process.env.ORCA_PI_STATUS_OWNED = selfPid\n", `  process.env.ORCA_PI_STATUS_OWNED = selfPid
  let requestingActivity = false
  const unsubscribeActivity = pi.events?.on('mpx2:pi-ui:activity', (value: unknown) => {
    if (!acceptMpxActivity(value)) return
    if (mpxActivityId && value.activityId !== mpxActivityId && !requestingActivity) return
    if (value.activityId === mpxActivityId && value.revision <= mpxRevision) return
    mpxActivityId = value.activityId
    mpxRevision = value.revision
    mpxActivity = value
    clearPendingAgentEndCheck()
    post('mpx_activity')
  })
`);
replace("    piUiPromptDepth = 0\n    // Why: /reload", `    piUiPromptDepth = 0
    mpxActivity = null
    mpxActivityId = ''
    mpxRevision = -1
    mpxAnnouncedState = ''
    requestingActivity = true
    try { pi.events?.emit('mpx2:pi-ui:activity:request', {}) } finally { requestingActivity = false }
    // Why: /reload`);
replace("    // the session_start that follows republishes the corrected state.\n    piUiPromptDepth = 0", "    // the session_start that follows republishes the corrected state.\n    piUiPromptDepth = 0\n    unsubscribeActivity?.()\n    clearPendingAgentEndCheck()\n    pendingPost = null\n    mpxActivity = null");
replace("  function postAgentEndOnce(): void {\n    if (agentEndReported) return", "  function postAgentEndOnce(): void {\n    piTurnInFlight = false\n    if (mpxActivity) return // Only aggregate completion can finish a managed session.\n    if (agentEndReported) return");
const directory = await mkdtemp(path.join(tmpdir(), 'mpx-orca-patch-'));
try {
  const before = path.join(directory, 'before.ts'); const after = path.join(directory, 'after.ts');
  await writeFile(before, original); await writeFile(after, candidate);
  let diff;
  try { diff = execFileSync('git', ['diff', '--no-index', '--no-ext-diff', '--', before, after], { encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024 }); }
  catch (error) { if (error.status !== 1) throw error; diff = String(error.stdout); }
  diff = diff.replace(/^diff --git .*$/m, 'diff --git a/orca-agent-status.ts b/orca-agent-status.ts').replace(/^--- .*$/m, '--- a/orca-agent-status.ts').replace(/^\+\+\+ .*$/m, '+++ b/orca-agent-status.ts');
  const output = path.resolve(import.meta.dirname, '../patches/orca-pi-aggregate.patch');
  await writeFile(output, diff);
  console.log('Prepared checkout-local hook patch; not deployed. Cancellation receiver compatibility remains gated.');
} finally { await rm(directory, { recursive: true, force: true, maxRetries: 3 }); }
