export interface PiEventCoordinatorDependencies {
  title(value: string): void;
  compact(instructions: string | null): Promise<void>;
  fullscreen(enabled: boolean): void;
  notify(): void;
}
export interface PiEventCoordinator {
  sessionStarted(): Promise<void>;
  turnSettled(firstUserText: string): Promise<void>;
  beforeCompaction(manualInstructions?: string | null): Promise<void>;
  shutdown(): void;
}
function titleFrom(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().slice(0, 72) || 'Pi session';
}
/** Session-local event coordination. It owns no paths and persists no native Pi state. */
export function createPiEventCoordinator(
  dependencies: PiEventCoordinatorDependencies,
): PiEventCoordinator {
  let titled = false,
    active = true;
  return Object.freeze({
    async sessionStarted() {
      if (active) {
        dependencies.fullscreen(true);
      }
    },
    async turnSettled(firstUserText: string) {
      if (!active) {
        return;
      }
      if (!titled) {
        titled = true;
        dependencies.title(titleFrom(firstUserText));
      }
      dependencies.notify();
    },
    async beforeCompaction(manualInstructions: string | null = null) {
      if (active) {
        await dependencies.compact(manualInstructions);
      }
    },
    shutdown() {
      active = false;
      dependencies.fullscreen(false);
    },
  });
}
/** Structured ask-user tools are intentionally retired; questions remain visible in the ordinary transcript. */
export function formatInlineQuestions(questions: readonly string[]): string {
  if (
    !questions.length ||
    questions.length > 8 ||
    questions.some((question) => !question.trim() || question.length > 1_000)
  ) {
    throw new Error('INLINE_QUESTIONS_INVALID');
  }
  return `Please answer these questions inline:\n${questions.map((question, index) => `${index + 1}. ${question.trim()}`).join('\n')}`;
}
