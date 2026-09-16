import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels } from '@earendil-works/pi-ai';
import { withoutDeletedHeaders } from './context.js';
import { createPiFooterComponent, type PiFooterComponent } from './pi-footer-runtime.js';
import type { FooterRepository } from './pi-footer-data.js';

export const PI_ACTIVITY_EVENT = 'mpx2:pi-ui:activity';
export const PI_ACTIVITY_REQUEST_EVENT = 'mpx2:pi-ui:activity:request';
export const PI_BACKGROUND_ACTIVITY_EVENT = 'mpx2:pi-ui:background';
export const PI_FOLLOW_UP_ACTIVITY_EVENT = 'mpx2:pi-ui:follow-up';

export type PiActivityState = 'idle' | 'working' | 'human-needed' | 'done' | 'cancelled';

export interface PiActivitySnapshot {
  state: PiActivityState;
  mainActive: boolean;
  activeChildren: number;
  backgroundWork: number;
  pendingFollowUps: number;
  humanNeeded: boolean;
  settling: boolean;
  revision: number;
}

export type PiActivitySink = (snapshot: Readonly<PiActivitySnapshot>) => void;

export interface PiTitleConfig {
  /** Exact provider id. There is deliberately no provider fallback. */
  provider: string;
  /** Exact model id. There is deliberately no model fallback. */
  model: string;
  effort: 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
}

export interface PiUiOptions {
  /** Supplied by the parent runtime from the approved user-config schema. */
  title?: PiTitleConfig;
  /** Authoritative adapter boundary; this slice does not post to Orca itself. */
  activitySink?: PiActivitySink;
  /** Delay prevents a child-completion event preceding its follow-up from flashing done. */
  settleDelayMs?: number;
  environment?: Readonly<Record<string, string | undefined>>;
  readCompactionSettings?: typeof import('./pi-footer-settings.js').readFooterCompactionSettings;
  requestQuota?: typeof import('./pi-footer-quota.js').requestFooterQuota;
  loadRepository?: (cwd: string) => Promise<FooterRepository>;
}

interface Timer {
  cancel(): void;
}

export interface ActivityTiming {
  delay(callback: () => void, milliseconds: number): Timer;
}

const DEFAULT_SETTLE_DELAY_MS = 500;

const defaultTiming: ActivityTiming = {
  delay(callback, milliseconds) {
    const handle = setTimeout(callback, milliseconds);
    handle.unref?.();
    return { cancel: () => clearTimeout(handle) };
  },
};

/** Pure aggregate used by the Pi lifecycle adapter and fixture tests. */
export class PiActivityAggregate {
  private mainActive = false;
  private readonly children = new Set<string>();
  private readonly background = new Set<string>();
  private readonly followUps = new Set<string>();
  private humanPromptDepth = 0;
  private externallyBlocked = false;
  private hadWork = false;
  private cancelled = false;
  private settling = false;
  private revision = 0;
  private completionTimer: Timer | undefined;
  private lastSignature = '';

  constructor(
    private readonly sink: PiActivitySink,
    private readonly settleDelayMs = DEFAULT_SETTLE_DELAY_MS,
    private readonly timing: ActivityTiming = defaultTiming,
  ) {
    this.publish('idle');
  }

  startMain(fresh = true): void {
    if (this.mainActive && !fresh) return;
    this.cancelCompletion();
    this.hadWork = true;
    if (fresh) this.cancelled = false;
    this.mainActive = true;
    this.settling = false;
    const pending = [...this.followUps].find((id) => id.startsWith('native-'));
    if (pending !== undefined) this.followUps.delete(pending);
    this.recompute();
  }

  settleMain(): void {
    // Native agent_settled is authoritative for its own queued input messages,
    // including follow-ups processed inside one agent loop without another agent_start.
    let removedNativeInput = false;
    for (const id of this.followUps) {
      if (id.startsWith('native-')) removedNativeInput = this.followUps.delete(id) || removedNativeInput;
    }
    if (!this.mainActive && !removedNativeInput) return;
    this.mainActive = false;
    this.recompute();
  }

  cancelMain(): void {
    this.cancelCompletion();
    this.mainActive = false;
    for (const id of this.followUps) {
      if (!id.startsWith('subagent-result:')) this.followUps.delete(id);
    }
    this.cancelled = true;
    this.settling = false;
    this.recompute();
  }

  startChild(id: string): void {
    if (!id || this.children.has(id)) return;
    this.cancelCompletion();
    this.hadWork = true;
    this.children.add(id);
    this.settling = false;
    this.recompute();
  }

  finishChild(id: string): void {
    if (!id || !this.children.delete(id)) return;
    this.recompute();
  }

  setBackground(id: string, active: boolean): void {
    if (!id || this.background.has(id) === active) return;
    if (active) {
      this.cancelCompletion();
      this.hadWork = true;
      this.background.add(id);
      this.settling = false;
    } else {
      this.background.delete(id);
    }
    this.recompute();
  }

  setFollowUp(id: string, active: boolean): void {
    if (!id || this.followUps.has(id) === active) return;
    if (active) {
      this.cancelCompletion();
      this.hadWork = true;
      this.followUps.add(id);
      this.settling = false;
    } else {
      this.followUps.delete(id);
    }
    this.recompute();
  }

  startHumanPrompt(): void {
    this.cancelCompletion();
    this.humanPromptDepth += 1;
    this.recompute();
  }

  endHumanPrompt(): void {
    if (this.humanPromptDepth === 0) return;
    this.humanPromptDepth -= 1;
    this.recompute();
  }

  setExternallyBlocked(active: boolean): void {
    if (this.externallyBlocked === active) return;
    this.externallyBlocked = active;
    if (active) this.cancelCompletion();
    this.recompute();
  }

  reset(): void {
    this.cancelCompletion();
    this.mainActive = false;
    this.children.clear();
    this.background.clear();
    this.followUps.clear();
    this.humanPromptDepth = 0;
    this.externallyBlocked = false;
    this.hadWork = false;
    this.cancelled = false;
    this.settling = false;
    this.recompute();
  }

  dispose(): void {
    this.cancelCompletion();
  }

  snapshot(): PiActivitySnapshot {
    return this.buildSnapshot(this.currentState());
  }

  private hasOutstandingWork(): boolean {
    return (
      this.mainActive ||
      this.children.size > 0 ||
      this.background.size > 0 ||
      this.followUps.size > 0
    );
  }

  private hasHumanNeed(): boolean {
    return this.humanPromptDepth > 0 || this.externallyBlocked;
  }

  private currentState(): PiActivityState {
    if (this.hasHumanNeed()) return 'human-needed';
    if (this.hasOutstandingWork() || this.settling) return 'working';
    if (this.cancelled) return 'cancelled';
    return this.hadWork ? 'done' : 'idle';
  }

  private recompute(): void {
    if (this.hasHumanNeed() || this.hasOutstandingWork() || this.cancelled || !this.hadWork) {
      this.cancelCompletion();
      this.settling = false;
      this.publish(this.currentState());
      return;
    }

    if (!this.settling) {
      this.settling = true;
      this.publish('working');
      this.completionTimer = this.timing.delay(() => {
        this.completionTimer = undefined;
        this.settling = false;
        if (!this.hasHumanNeed() && !this.hasOutstandingWork() && !this.cancelled) {
          this.publish('done');
        } else {
          this.recompute();
        }
      }, Math.max(0, this.settleDelayMs));
    }
  }

  private cancelCompletion(): void {
    this.completionTimer?.cancel();
    this.completionTimer = undefined;
  }

  private buildSnapshot(state: PiActivityState): PiActivitySnapshot {
    return {
      state,
      mainActive: this.mainActive,
      activeChildren: this.children.size,
      backgroundWork: this.background.size,
      pendingFollowUps: this.followUps.size,
      humanNeeded: this.hasHumanNeed(),
      settling: this.settling,
      revision: this.revision,
    };
  }

  private publish(state: PiActivityState): void {
    const withoutRevision = {
      state,
      mainActive: this.mainActive,
      activeChildren: this.children.size,
      backgroundWork: this.background.size,
      pendingFollowUps: this.followUps.size,
      humanNeeded: this.hasHumanNeed(),
      settling: this.settling,
    };
    const signature = JSON.stringify(withoutRevision);
    if (signature === this.lastSignature) return;
    this.lastSignature = signature;
    this.revision += 1;
    try {
      this.sink({ ...withoutRevision, revision: this.revision });
    } catch {
      // Status reporting is observational and must never interrupt agent work.
    }
  }
}

export interface FinishedAgent {
  id: string;
  type: string;
  status: string;
  model?: string;
  effort?: string;
  elapsedMs?: number;
  tokens?: number;
  url?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/** Reads only fields actually emitted by pi-subagents; missing values remain unknown. */
export function finishedAgentFromLifecycle(payload: unknown): FinishedAgent | undefined {
  const source = record(payload);
  const id = nonempty(source?.id);
  if (!source || !id) return undefined;
  const tokenSource = record(source.tokens);
  return {
    id,
    type: nonempty(source.type) ?? 'agent',
    status: nonempty(source.status) ?? 'unknown',
    ...(finiteNonNegative(source.durationMs) === undefined
      ? {}
      : { elapsedMs: finiteNonNegative(source.durationMs) }),
    ...(finiteNonNegative(tokenSource?.total) === undefined
      ? {}
      : { tokens: finiteNonNegative(tokenSource?.total) }),
  };
}

/** Correlates public Agent/get_subagent_result details without inventing absent numbers. */
export function mergeFinishedAgentToolResult(
  existing: FinishedAgent | undefined,
  details: unknown,
): FinishedAgent | undefined {
  const source = record(details);
  const id = nonempty(source?.agentId) ?? existing?.id;
  if (!source || !id) return existing;
  const reportedStatus = nonempty(source.status);
  const terminalStatus = reportedStatus && !['background', 'queued', 'running'].includes(reportedStatus) ? reportedStatus : undefined;
  if (!existing && !terminalStatus) {
    return undefined;
  }
  const tags = Array.isArray(source.tags)
    ? source.tags.filter((value): value is string => typeof value === 'string')
    : [];
  const effort = tags
    .map((tag) => /^thinking:\s*(.+)$/i.exec(tag)?.[1]?.trim())
    .find((value): value is string => Boolean(value));
  const elapsedMs = finiteNonNegative(source.durationMs);
  return {
    id,
    type: nonempty(source.subagentType) ?? existing?.type ?? 'agent',
    status: terminalStatus ?? existing?.status ?? 'unknown',
    ...(nonempty(source.modelName) === undefined && existing?.model === undefined
      ? {}
      : { model: nonempty(source.modelName) ?? existing?.model }),
    ...(effort === undefined && existing?.effort === undefined
      ? {}
      : { effort: effort ?? existing?.effort }),
    ...(elapsedMs === undefined && existing?.elapsedMs === undefined
      ? {}
      : { elapsedMs: elapsedMs ?? existing?.elapsedMs }),
    ...(existing?.tokens === undefined ? {} : { tokens: existing.tokens }),
    ...(existing?.url === undefined ? {} : { url: existing.url }),
  };
}

function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      const item = record(part);
      return item?.type === 'text' && typeof item.text === 'string' ? item.text : '';
    })
    .filter(Boolean)
    .join('\n')
    .trim();
}

function firstUserPrompt(ctx: ExtensionContext): string | undefined {
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== 'message' || entry.message.role !== 'user') continue;
    const text = textFromContent(entry.message.content);
    if (text) return text;
  }
  return undefined;
}

const MAX_TITLE_INPUT_CHARACTERS = 4_000;
const MAX_TITLE_CHARACTERS = 80;
const MAX_TITLE_TOKENS = 96;
const TITLE_TIMEOUT_MS = 15_000;
const TITLE_SYSTEM_PROMPT = `Create a concise title for a coding-agent session from the user's first prompt.
Return only a 3-7 word title with no quotes, markdown, label, or trailing punctuation.
Describe the concrete task, preserve important product and file names, and do not answer the prompt.`;

export function fallbackTitle(prompt: string): string {
  const words = prompt
    .replace(/[`*_#>[\](){}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 8);
  const value = words.join(' ').replace(/[.!?,;:]+$/g, '').trim();
  return (value || 'New Pi Session').slice(0, MAX_TITLE_CHARACTERS).trimEnd();
}

export function normalizeGeneratedTitle(value: string): string | undefined {
  const line = value.split(/\r?\n/).map((part) => part.trim()).find(Boolean);
  if (!line) return undefined;
  const title = line
    .replace(/^title\s*:\s*/i, '')
    .replace(/^[`"'*_]+|[`"'*_]+$/g, '')
    .replace(/[.!?,;:]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return title ? title.slice(0, MAX_TITLE_CHARACTERS).trimEnd() : undefined;
}

function validTitleConfig(value: PiTitleConfig | undefined): value is PiTitleConfig {
  return Boolean(
    value &&
      value.provider.trim() &&
      value.model.trim() &&
      ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(value.effort),
  );
}

async function requestTitle(
  prompt: string,
  config: PiTitleConfig | undefined,
  ctx: ExtensionContext,
  signal: AbortSignal,
): Promise<string> {
  if (!validTitleConfig(config)) return fallbackTitle(prompt);
  const model = ctx.modelRegistry.find(config.provider, config.model);
  if (!model || !ctx.modelRegistry.hasConfiguredAuth(model) || !getSupportedThinkingLevels(model).includes(config.effort)) return fallbackTitle(prompt);
  try {
    const provider = ctx.modelRegistry.getProvider(config.provider);
    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!provider || !auth.ok || signal.aborted) return fallbackTitle(prompt);
    const response = await provider.streamSimple(
      auth.baseUrl ? { ...model, baseUrl: auth.baseUrl } : model,
      {
        systemPrompt: TITLE_SYSTEM_PROMPT,
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: prompt.slice(0, MAX_TITLE_INPUT_CHARACTERS) }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: withoutDeletedHeaders(auth.headers),
        env: auth.env,
        ...(config.effort === 'off' ? {} : { reasoning: config.effort }),
        maxTokens: MAX_TITLE_TOKENS,
        cacheRetention: 'none',
        maxRetries: 0,
        timeoutMs: TITLE_TIMEOUT_MS,
        sessionId: randomUUID(),
        signal: AbortSignal.any([signal, AbortSignal.timeout(TITLE_TIMEOUT_MS)]),
      },
    ).result();
    return normalizeGeneratedTitle(textFromContent(response.content)) ?? fallbackTitle(prompt);
  } catch {
    return fallbackTitle(prompt);
  }
}

function generateTitle(prompt: string, config: PiTitleConfig | undefined, ctx: ExtensionContext, signal: AbortSignal): Promise<string> {
  const deadline = new AbortController();
  return new Promise(resolve => {
    const timer = setTimeout(() => { deadline.abort(); resolve(fallbackTitle(prompt)); }, TITLE_TIMEOUT_MS);
    timer.unref?.();
    void requestTitle(prompt, config, ctx, AbortSignal.any([signal, deadline.signal])).then(
      title => { clearTimeout(timer); resolve(title); },
      () => { clearTimeout(timer); resolve(fallbackTitle(prompt)); },
    );
  });
}

function isCancelledAgentEnd(event: { messages?: readonly unknown[] }): boolean {
  for (let index = (event.messages?.length ?? 0) - 1; index >= 0; index -= 1) {
    const message = record(event.messages?.[index]);
    if (message?.role === 'assistant') return message.stopReason === 'aborted';
  }
  return false;
}

export function isPositiveOrcaEnvironment(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  return Boolean(environment.ORCA_PANE_KEY?.trim() || environment.ORCA_TAB_ID?.trim());
}

export function shouldUseThreeLineWheel(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  // Orca inherits WT_SESSION from its own launch environment; its positive marker wins.
  if (isPositiveOrcaEnvironment(environment)) return false;
  return Boolean(environment.WT_SESSION?.trim());
}

interface FullscreenTui {
  mode?: string;
  wheelScrollLines?: number;
}

export function applyThreeLineFullscreenWheel(tui: unknown): boolean {
  const candidate = tui as FullscreenTui;
  if (candidate.mode !== 'fullscreen' || candidate.wheelScrollLines === 3) return false;
  candidate.wheelScrollLines = 3;
  return true;
}

const PROCESS_OWNER = Symbol.for('mpx2:pi-ui:process-owner');
const SUBAGENT_MANAGER = Symbol.for('pi-subagents:manager');

type GlobalWithOwner = typeof globalThis & {
  [PROCESS_OWNER]?: object;
  [SUBAGENT_MANAGER]?: { getRecord?(id: string): unknown };
};

interface PiActivityEnvelope extends PiActivitySnapshot {
  /** Native Pi session identity; deliberately not inferred or persisted. */
  sessionId: string;
  /** Unique to this extension activation, including same-session reloads. */
  activityId: string;
}

/**
 * Compose from extensions/pi-runtime.ts with an explicit title config and, once
 * authorized, the single Orca activity sink. The default sink is bus-only.
 */
export function registerPiUi(pi: ExtensionAPI, options: PiUiOptions = {}): void {
  const token = {};
  let ownsProcess = false;
  let aggregate: PiActivityAggregate | undefined;
  let currentContext: ExtensionContext | undefined;
  let requestRender = () => {};
  let footer: PiFooterComponent | undefined;
  let titleSessionId = '';
  let firstPrompt: string | undefined;
  let titleStarted = false;
  let explicitlyNamed = false;
  let pendingAutomaticName: string | undefined;
  let titleController: AbortController | undefined;
  let followUpSequence = 0;
  let mainWasCancelled = false;
  let activitySessionId = '';
  let activityId = '';
  let currentSnapshot: Readonly<PiActivitySnapshot> | undefined;
  let diagnosticCount = 0;
  const finished = new Map<string, FinishedAgent>();
  const knownSubagents = new Set<string>();
  const terminalSubagents = new Set<string>();
  const reservedSubagentResults = new Set<string>();
  const diagnosedReservations = new Set<string>();

  const emitActivity = (snapshot: Readonly<PiActivitySnapshot>): void => {
    const envelope: PiActivityEnvelope = {
      ...snapshot,
      sessionId: activitySessionId,
      activityId,
    };
    pi.events.emit(PI_ACTIVITY_EVENT, envelope);
  };
  const sink: PiActivitySink = (snapshot) => {
    currentSnapshot = snapshot;
    if (options.activitySink) options.activitySink(snapshot);
    else emitActivity(snapshot);
  };

  const abortTitle = (): void => {
    titleController?.abort();
    titleController = undefined;
  };

  const own = (): boolean => ownsProcess;
  const reservationKey = (id: string): string => `subagent-result:${id}`;

  const diagnoseHeldReservation = (id: string, reason: string): void => {
    const key = `${id}:${reason}`;
    if (diagnosticCount >= 3 || diagnosedReservations.has(key)) return;
    diagnosedReservations.add(key);
    diagnosticCount += 1;
    try {
      currentContext?.ui.notify?.(
        `Holding activity for subagent ${id}: native result state ${reason}.`,
        'warning',
      );
    } catch {
      // Diagnostics are bounded and observational, just like activity publishing.
    }
  };

  const nativeRecord = (id: string): { status?: string; resultConsumed?: boolean; model?: string; effort?: string; url?: string } | undefined => {
    const manager = (globalThis as GlobalWithOwner)[SUBAGENT_MANAGER];
    if (typeof manager?.getRecord !== 'function') return undefined;
    try {
      const source = record(manager.getRecord(id));
      if (!source) return undefined;
      const invocation = record(source.invocation);
      const sessionFile = nonempty(source.sessionFile);
      return {
        model: nonempty(invocation?.modelId) ?? nonempty(invocation?.modelName),
        effort: nonempty(invocation?.thinking),
        url: sessionFile && path.isAbsolute(sessionFile) ? pathToFileURL(sessionFile).href : undefined,
        ...(typeof source.status === 'string' ? { status: source.status } : {}),
        ...(typeof source.resultConsumed === 'boolean'
          ? { resultConsumed: source.resultConsumed }
          : {}),
      };
    } catch {
      return undefined;
    }
  };

  const reserveSubagentResult = (id: string): void => {
    if (reservedSubagentResults.has(id)) return;
    reservedSubagentResults.add(id);
    aggregate?.setFollowUp(reservationKey(id), true);
  };
  const releaseSubagentResult = (id: string): void => {
    if (!reservedSubagentResults.delete(id)) return;
    aggregate?.setFollowUp(reservationKey(id), false);
  };
  const refreshConsumedResults = (): void => {
    if (!own()) return;
    for (const id of [...reservedSubagentResults]) {
      if (!knownSubagents.has(id)) continue;
      const native = nativeRecord(id);
      if (native?.resultConsumed === true) releaseSubagentResult(id);
      else if (!native) diagnoseHeldReservation(id, 'is unavailable');
    }
  };
  const refreshConsumedResultsSoon = (): void => {
    queueMicrotask(refreshConsumedResults);
  };

  const onBackground = (payload: unknown): void => {
    if (!own()) return;
    const source = record(payload);
    const id = nonempty(source?.id);
    if (id && typeof source?.active === 'boolean') aggregate?.setBackground(id, source.active);
  };
  const onFollowUp = (payload: unknown): void => {
    if (!own()) return;
    const source = record(payload);
    const id = nonempty(source?.id);
    if (id && typeof source?.active === 'boolean') aggregate?.setFollowUp(id, source.active);
  };
  const onQuestionBlocked = (payload: unknown): void => {
    if (!own()) return;
    const source = record(payload);
    if (typeof source?.active === 'boolean') aggregate?.setExternallyBlocked(source.active);
  };
  const onActivityRequest = (): void => {
    if (own() && !options.activitySink && currentSnapshot) emitActivity(currentSnapshot);
  };

  const unsubscribeBackground = pi.events.on(PI_BACKGROUND_ACTIVITY_EVENT, onBackground);
  const unsubscribeFollowUp = pi.events.on(PI_FOLLOW_UP_ACTIVITY_EVENT, onFollowUp);
  const unsubscribeQuestion = pi.events.on('rpiv:ask-user:blocked', onQuestionBlocked);
  const unsubscribeActivityRequest = pi.events.on(PI_ACTIVITY_REQUEST_EVENT, onActivityRequest);
  const unsubscribeConsume = pi.events.on('subagents:rpc:consume', refreshConsumedResultsSoon);
  const unsubscribeDelivery = pi.events.on('subagents:result-delivered', refreshConsumedResultsSoon);

  const beginChildRun = (id: string): void => {
    terminalSubagents.delete(id);
    aggregate?.startChild(id);
    releaseSubagentResult(id);
  };
  const onChildCreated = (payload: unknown): void => {
    if (!own()) return;
    const id = nonempty(record(payload)?.id);
    if (!id) return;
    knownSubagents.add(id);
    if (terminalSubagents.has(id)) {
      const status = nativeRecord(id)?.status;
      if (status !== 'queued' && status !== 'running') return;
    }
    beginChildRun(id);
  };
  const onChildStarted = (payload: unknown): void => {
    if (!own()) return;
    const id = nonempty(record(payload)?.id);
    if (!id) return;
    knownSubagents.add(id);
    beginChildRun(id);
  };
  const onChildFinished = (payload: unknown): void => {
    if (!own()) return;
    const agent = finishedAgentFromLifecycle(payload);
    if (!agent) return;
    knownSubagents.add(agent.id);
    const alreadyTerminal = terminalSubagents.has(agent.id);
    terminalSubagents.add(agent.id);
    const native = nativeRecord(agent.id);
    if (native?.resultConsumed === true) releaseSubagentResult(agent.id);
    else if (!alreadyTerminal) {
      reserveSubagentResult(agent.id);
      if (!native) diagnoseHeldReservation(agent.id, 'is unavailable');
    }
    const prior = finished.get(agent.id);
    finished.set(agent.id, {
      ...prior, ...agent,
      model: native?.model ?? prior?.model,
      effort: native?.effort ?? prior?.effort,
      url: native?.url ?? prior?.url,
    });
    aggregate?.finishChild(agent.id);
    requestRender();
  };
  const unsubscribeCreated = pi.events.on('subagents:created', onChildCreated);
  const unsubscribeStarted = pi.events.on('subagents:started', onChildStarted);
  const unsubscribeCompleted = pi.events.on('subagents:completed', onChildFinished);
  const unsubscribeFailed = pi.events.on('subagents:failed', onChildFinished);

  pi.on('session_start', (_event, ctx) => {
    const global = globalThis as GlobalWithOwner;
    if (global[PROCESS_OWNER] === undefined) global[PROCESS_OWNER] = token;
    ownsProcess = global[PROCESS_OWNER] === token;
    if (!ownsProcess) return;

    currentContext = ctx;
    footer?.dispose();
    footer = undefined;
    abortTitle();
    aggregate?.dispose();
    activitySessionId = ctx.sessionManager.getSessionId();
    activityId = randomUUID();
    currentSnapshot = undefined;
    aggregate = new PiActivityAggregate(
      sink,
      Math.min(2_000, Math.max(0, options.settleDelayMs ?? DEFAULT_SETTLE_DELAY_MS)),
    );
    finished.clear();
    knownSubagents.clear();
    terminalSubagents.clear();
    reservedSubagentResults.clear();
    diagnosedReservations.clear();
    diagnosticCount = 0;
    mainWasCancelled = false;
    requestRender();

    titleSessionId = activitySessionId;
    firstPrompt = firstUserPrompt(ctx);
    titleStarted = false;
    explicitlyNamed = pi.getSessionName() !== undefined;
    pendingAutomaticName = undefined;

    if (ctx.mode !== 'tui') return;

    if (shouldUseThreeLineWheel(options.environment)) {
      ctx.ui.setWidget('mpx2-fullscreen-wheel', (tui) => ({
        render: () => {
          applyThreeLineFullscreenWheel(tui);
          return [];
        },
        invalidate: () => {
          applyThreeLineFullscreenWheel(tui);
        },
      }));
    }

    ctx.ui.setFooter((tui, theme, footerData) => {
      footer?.dispose();
      requestRender = () => tui.requestRender();
      footer = createPiFooterComponent(
        pi, currentContext ?? ctx, tui, theme, footerData,
        options.environment ?? process.env, () => [...finished.values()], options.loadRepository, options.readCompactionSettings, options.requestQuota,
      );
      return footer;
    });
  });

  pi.on('message_end', (_event, ctx) => {
    if (own()) { currentContext = ctx; footer?.update(ctx); }
  });
  pi.on('turn_end', (_event, ctx) => {
    if (own()) { currentContext = ctx; footer?.update(ctx, true); }
  });
  pi.on('model_select', (_event, ctx) => {
    if (own()) { currentContext = ctx; footer?.update(ctx); }
  });
  pi.on('thinking_level_select', (_event, ctx) => {
    if (own()) { currentContext = ctx; footer?.update(ctx); }
  });
  pi.on('session_tree', (_event, ctx) => {
    if (own()) { currentContext = ctx; footer?.update(ctx, true); }
  });
  pi.on('session_compact', (event, ctx) => {
    if (own()) { currentContext = ctx; footer?.compacted(event.compactionEntry.id, event.reason, ctx); }
  });
  pi.on('after_provider_response', (event, ctx) => {
    if (own()) footer?.response(event.headers, ctx);
  });

  pi.on('input', (event) => {
    if (!own()) return;
    if (event.source !== 'extension' && firstPrompt === undefined && event.text.trim()) {
      firstPrompt = event.text.trim();
    }
    if (event.streamingBehavior === 'followUp') {
      followUpSequence += 1;
      aggregate?.setFollowUp(`native-${followUpSequence}`, true);
    }
  });

  pi.on('before_agent_start', () => {
    if (!own()) return;
    mainWasCancelled = false;
    aggregate?.startMain(true);
  });

  pi.on('agent_start', () => {
    if (own()) aggregate?.startMain(false);
  });

  pi.on('session_abort', () => {
    if (!own()) return;
    mainWasCancelled = true;
    abortTitle();
    aggregate?.cancelMain();
  });

  pi.on('agent_end', (event) => {
    if (!own() || !isCancelledAgentEnd(event)) return;
    mainWasCancelled = true;
    aggregate?.cancelMain();
  });

  pi.on('agent_settled', (_event, ctx) => {
    if (!own()) return;
    aggregate?.settleMain();
    currentContext = ctx;
    footer?.update(ctx, true);
    if (mainWasCancelled || titleStarted || explicitlyNamed || pi.getSessionName() !== undefined) return;
    firstPrompt ??= firstUserPrompt(ctx);
    if (!firstPrompt) return;

    titleStarted = true;
    const expectedSessionId = titleSessionId;
    const prompt = firstPrompt;
    const controller = new AbortController();
    const titleAggregate = aggregate;
    titleController = controller;
    titleAggregate?.setBackground('automatic-title', true);
    void generateTitle(prompt, options.title, ctx, controller.signal).then((title) => {
      if (
        controller.signal.aborted ||
        titleSessionId !== expectedSessionId ||
        explicitlyNamed ||
        pi.getSessionName() !== undefined
      ) return;
      pendingAutomaticName = title;
      pi.setSessionName(title);
    }).catch(() => { /* Native naming failure must not interrupt the session. */ }).finally(() => {
      if (aggregate === titleAggregate) titleAggregate?.setBackground('automatic-title', false);
    });
  });

  pi.on('ui_prompt_start', () => {
    if (own()) aggregate?.startHumanPrompt();
  });
  pi.on('ui_prompt_end', () => {
    if (own()) aggregate?.endHumanPrompt();
  });

  pi.on('message_start', (event) => {
    if (!own()) return;
    const message = record(event.message);
    if (message?.role !== 'custom' || message.customType !== 'subagent-notification') return;
    const details = record(message.details);
    const delivered = [nonempty(details?.id)];
    if (Array.isArray(details?.others)) {
      for (const other of details.others) delivered.push(nonempty(record(other)?.id));
    }
    for (const id of delivered) {
      if (id && knownSubagents.has(id)) releaseSubagentResult(id);
    }
  });

  pi.on('tool_result', (event) => {
    if (!own() || (event.toolName !== 'Agent' && event.toolName !== 'get_subagent_result')) return;
    refreshConsumedResultsSoon();
    const source = record(event.details);
    const id = nonempty(source?.agentId);
    const merged = mergeFinishedAgentToolResult(id ? finished.get(id) : undefined, event.details);
    if (!merged) return;
    const native = nativeRecord(merged.id);
    finished.set(merged.id, {
      ...merged,
      model: native?.model ?? merged.model,
      effort: native?.effort ?? merged.effort,
      url: native?.url ?? merged.url,
    });
    requestRender();
  });

  pi.on('session_info_changed', (event) => {
    if (!own()) return;
    if (pendingAutomaticName !== undefined && event.name === pendingAutomaticName) {
      pendingAutomaticName = undefined;
      requestRender();
      return;
    }
    explicitlyNamed = true;
    abortTitle();
    requestRender();
  });

  pi.on('session_before_switch', () => {
    if (own()) abortTitle();
  });

  pi.on('session_shutdown', () => {
    if (!own()) return;
    abortTitle();
    footer?.dispose();
    footer = undefined;
    aggregate?.reset();
    aggregate?.dispose();
    aggregate = undefined;
    currentContext = undefined;
    currentSnapshot = undefined;
    mainWasCancelled = false;
    requestRender = () => {};
    const global = globalThis as GlobalWithOwner;
    if (global[PROCESS_OWNER] === token) delete global[PROCESS_OWNER];
    ownsProcess = false;
  });

  // EventBus listeners are factory-scoped rather than session-handler scoped.
  // Pi invalidates the whole extension instance after shutdown; release explicit
  // subscriptions as well so reload never accumulates bus consumers.
  pi.on('session_shutdown', () => {
    unsubscribeBackground();
    unsubscribeFollowUp();
    unsubscribeQuestion();
    unsubscribeActivityRequest();
    unsubscribeConsume();
    unsubscribeDelivery();
    unsubscribeCreated();
    unsubscribeStarted();
    unsubscribeCompleted();
    unsubscribeFailed();
  });
}
