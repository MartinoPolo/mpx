import { assertValid, validateProject } from './schema.js';
import type { Diagnostic, PreparationPlan, PreparationStep, ProjectConfig } from './types.js';

const FORBIDDEN_ENVIRONMENT_NAME =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIALS?|PRIVATE_KEY|API_KEY|AUTH|COOKIE)(?:_|$)/;
const SHELL_EXECUTABLES = new Set([
  'sh',
  'bash',
  'dash',
  'zsh',
  'fish',
  'cmd',
  'cmd.exe',
  'powershell',
  'powershell.exe',
  'pwsh',
  'pwsh.exe',
]);

export class PreparationPlanError extends Error {
  readonly code = 'PREPARATION_PLAN_INVALID' as const;
  constructor(public readonly diagnostics: readonly Diagnostic[]) {
    super(diagnostics.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join('; '));
    this.name = 'PreparationPlanError';
  }
}

export function preparationDiagnostics(project: ProjectConfig): Diagnostic[] {
  const steps = project.worktrees?.postCreate?.steps ?? [];
  const diagnostics: Diagnostic[] = [];
  const indices = new Map<string, number>();
  const dependencies = new Map<string, Set<string>>();

  for (const [index, step] of steps.entries()) {
    if (indices.has(step.id)) {
      diagnostics.push({
        code: 'DUPLICATE_STEP_ID',
        severity: 'error',
        message: `Duplicate step id ${step.id}`,
        pointer: `/worktrees/postCreate/steps/${index}/id`,
      });
    } else {
      indices.set(step.id, index);
    }
    const collected = dependencies.get(step.id) ?? new Set<string>();
    for (const dependency of step.dependsOn ?? []) {
      collected.add(dependency);
    }
    dependencies.set(step.id, collected);

    for (const name of step.environment ?? []) {
      if (FORBIDDEN_ENVIRONMENT_NAME.test(name)) {
        diagnostics.push({
          code: 'FORBIDDEN_PREPARATION_ENVIRONMENT',
          severity: 'error',
          message: `Preparation environment name ${name} may expose secret material`,
          pointer: `/worktrees/postCreate/steps/${index}/environment`,
        });
      }
    }
    if (step.uses === 'executable' && isUnsafeExecutable(step.argv[0] ?? '')) {
      diagnostics.push({
        code: 'UNSAFE_PREPARATION_EXECUTABLE',
        severity: 'error',
        message: 'Explicit preparation executables must not invoke a shell or contain a path',
        pointer: `/worktrees/postCreate/steps/${index}/argv/0`,
      });
    }
  }

  for (const [index, step] of steps.entries()) {
    for (const dependency of step.dependsOn ?? []) {
      if (!indices.has(dependency)) {
        diagnostics.push({
          code: 'UNKNOWN_STEP_DEPENDENCY',
          severity: 'error',
          message: `Unknown dependency ${dependency}`,
          pointer: `/worktrees/postCreate/steps/${index}/dependsOn`,
        });
      }
    }
  }

  if (hasCycle(dependencies, new Set(indices.keys()))) {
    diagnostics.push({
      code: 'CYCLIC_STEP_DEPENDENCY',
      severity: 'error',
      message: 'Preparation step dependencies contain a cycle',
      pointer: '/worktrees/postCreate/steps',
    });
  }
  return diagnostics.sort(
    (left, right) =>
      (left.pointer ?? '').localeCompare(right.pointer ?? '') ||
      left.code.localeCompare(right.code),
  );
}

export function preparationPlan(project: ProjectConfig): PreparationPlan {
  assertValid(validateProject, project);
  const diagnostics = preparationDiagnostics(project);
  if (diagnostics.some((diagnostic) => diagnostic.severity === 'error')) {
    throw new PreparationPlanError(diagnostics);
  }
  const postCreate = project.worktrees?.postCreate;
  const steps = postCreate?.steps ?? [];
  return {
    execution: postCreate?.execution ?? 'none',
    steps: steps.map((step) => ({ ...step, required: step.required ?? true })),
    order: topologicalOrder(steps),
    logging: { maxOutputBytes: 65536, redactEnvironmentValues: true },
  };
}

function isUnsafeExecutable(executable: string): boolean {
  return (
    executable.includes('/') ||
    executable.includes('\\') ||
    /^[A-Za-z]:/.test(executable) ||
    SHELL_EXECUTABLES.has(executable.toLowerCase())
  );
}

function hasCycle(
  dependencies: ReadonlyMap<string, ReadonlySet<string>>,
  ids: ReadonlySet<string>,
): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) {
      return true;
    }
    if (visited.has(id)) {
      return false;
    }
    visiting.add(id);
    for (const dependency of dependencies.get(id) ?? []) {
      if (ids.has(dependency) && visit(dependency)) {
        return true;
      }
    }
    visiting.delete(id);
    visited.add(id);
    return false;
  };
  return [...ids].some(visit);
}

function topologicalOrder(steps: readonly PreparationStep[]): string[] {
  const remaining = new Map(steps.map((step) => [step.id, new Set(step.dependsOn ?? [])]));
  const order: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter(([, dependencies]) =>
        [...dependencies].every((dependency) => !remaining.has(dependency)),
      )
      .map(([id]) => id)
      .sort();
    if (ready.length === 0) {
      throw new PreparationPlanError([
        {
          code: 'CYCLIC_STEP_DEPENDENCY',
          severity: 'error',
          message: 'Preparation step dependencies contain a cycle',
        },
      ]);
    }
    for (const id of ready) {
      order.push(id);
      remaining.delete(id);
    }
  }
  return order;
}
