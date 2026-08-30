type PollState = { status?: unknown; steps?: unknown } | null | undefined;

const active = new Set(['preparing', 'cancelling']);
const pause = (milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export async function pollPreparationTerminal<T extends PollState>(
  load: () => Promise<T>,
  options: { deadline: number; intervalMs: number },
): Promise<T> {
  let state = await load();
  while (state && active.has(String(state.status)) && Date.now() < options.deadline) {
    await pause(options.intervalMs);
    state = await load();
  }
  return state;
}

function clean(value: unknown): string {
  return String(value ?? 'unknown')
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .slice(0, 120);
}

export function shouldRetryUnknownPreparation(attempt: number, state: PollState): boolean {
  return attempt === 1 && state?.status === 'unknown';
}

export async function cleanupPreparationWorker(
  state: PollState,
  cancel: () => Promise<unknown>,
): Promise<void> {
  if (
    state?.status === 'preparing' ||
    state?.status === 'cancelling' ||
    state?.status === 'unknown'
  ) {
    await cancel();
  }
}

export function preparationDiagnostic(state: PollState): string {
  const steps = Array.isArray(state?.steps)
    ? state.steps.slice(0, 12).map((step) => {
        const value = step && typeof step === 'object' ? (step as Record<string, unknown>) : {};
        return {
          id: clean(value.id),
          status: clean(value.status),
          hasLog: typeof value.logPath === 'string' && value.logPath.length > 0,
        };
      })
    : [];
  return `status=${clean(state?.status)}; steps=${JSON.stringify(steps)}`.slice(0, 1_024);
}
