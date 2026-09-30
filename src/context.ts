export const MACHINE_ROOT_CUSTOM_TYPE = 'mpx-machine-roots';
export const NO_MACHINE_ROOTS_CONTEXT =
  'Machine roots: no approved MPX roots are currently set; disregard earlier machine-root messages.';
export const STYLE_REINFORCEMENT = 'Response style: answer first, concise, structured.';

const MACHINE_ROOTS = [
  ['MPX_PROJECTS', 'personal projects'],
  ['MPX_WORK', 'work repositories'],
  ['MPX_CLONED', 'cloned OSS repositories'],
  ['MPX_APPS', 'local apps'],
  ['MPX_ONEDRIVE', 'OneDrive root'],
  ['MPX_AI_GENERATED', 'saved AI-generated media and durable tutorials'],
  ['MPX_AI_DUMP', 'general AI scratchpad worth keeping (plans, reports, artifacts)'],
  ['MPX_TEMP', 'disposable temporary files'],
  ['MPX_OBSIDIAN_VAULT', 'Obsidian vault'],
] as const;

export type MachineRootEnvironment = Readonly<Record<string, string | undefined>>;

export function mergeCompactionInstructions(
  manualInstructions: string | undefined,
  canonicalInstructions: string,
): string {
  const canonical = canonicalInstructions.trim();
  if (!canonical) throw new Error('compaction guidance is empty');
  return manualInstructions ? `${manualInstructions}\n\n${canonical}` : canonical;
}

export function withoutDeletedHeaders(
  headers: Readonly<Record<string, string | null>> | undefined,
): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(
    Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null),
  );
}

export function machineRootContext(env: MachineRootEnvironment): string | undefined {
  const found = MACHINE_ROOTS.flatMap(([name, label]) => {
    const value = env[name]?.trim();
    return value ? [[name, value, label] as const] : [];
  });
  if (found.length === 0) return undefined;

  return [
    'Machine roots (from MPX_* env vars — use these instead of guessing paths):',
    ...found.map(([name, value, label]) => `- ${name} = ${value} — ${label}`),
    'This snapshot supersedes earlier machine-root messages.',
    'Paths outside the working directory should be resolved from these variables.',
  ].join('\n');
}

interface ContextEntryLike {
  type?: unknown;
  customType?: unknown;
  content?: unknown;
}

function lastMachineRootContent(contextEntries: readonly ContextEntryLike[]): unknown {
  for (let index = contextEntries.length - 1; index >= 0; index -= 1) {
    const entry = contextEntries[index];
    if (entry?.type === 'custom_message' && entry.customType === MACHINE_ROOT_CUSTOM_TYPE) {
      return entry.content;
    }
  }
  return undefined;
}

export function machineRootMessageToInject(
  contextEntries: readonly ContextEntryLike[],
  currentContext: string | undefined,
): string | undefined {
  const previousContext = lastMachineRootContent(contextEntries);
  const desiredContext = currentContext ??
    (previousContext === undefined ? undefined : NO_MACHINE_ROOTS_CONTEXT);
  if (!desiredContext || previousContext === desiredContext) return undefined;
  return desiredContext;
}

export function appendStyleReinforcement(systemPrompt: string): string {
  return `${systemPrompt}\n\n${STYLE_REINFORCEMENT}`;
}
