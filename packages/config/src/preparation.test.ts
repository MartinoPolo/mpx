import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { doctor } from './doctor.js';
import { preparationPlan } from './preparation.js';
import { assertValid, validateProject } from './schema.js';
import type { PreparationStep, ProjectConfig } from './types.js';

const base = () => ({
  schemaVersion: 1 as const,
  project: { id: 'acme/app' },
  repository: { provider: 'github' as const, remote: 'origin' },
});
type ConfiguredProject = ProjectConfig & {
  worktrees: {
    postCreate: { execution: 'foreground' | 'background' | 'none'; steps: PreparationStep[] };
  };
};
function configured(
  steps: PreparationStep[],
  execution?: 'foreground' | 'background' | 'none',
): ConfiguredProject;
function configured(steps: unknown[], execution?: 'foreground' | 'background' | 'none'): unknown;
function configured(
  steps: unknown[],
  execution: 'foreground' | 'background' | 'none' = 'foreground',
): unknown {
  return {
    ...base(),
    worktrees: { postCreate: { execution, steps } },
  };
}
const malicious = JSON.parse(
  readFileSync(new URL('../test/fixtures/preparation-malicious.json', import.meta.url), 'utf8'),
) as {
  unsafeArgv: string[][];
  unsafeCwd: string[];
  forbiddenEnvironment: string[];
};
const validSteps = [
  { id: 'install', uses: 'package-install' },
  {
    id: 'generate',
    uses: 'package-script',
    script: 'generate',
    dependsOn: ['install'],
    cwd: 'packages/web',
    timeoutSeconds: 300,
    required: false,
    environment: ['CI', 'NODE_ENV'],
  },
  { id: 'verify', uses: 'executable', argv: ['git', 'status', '--short'], dependsOn: ['generate'] },
];

describe('preparation schema', () => {
  it('accepts all three finite preparation step forms', () => {
    expect(() => assertValid(validateProject, configured(validSteps))).not.toThrow();
  });

  it.each(['foreground', 'background', 'none'] as const)('accepts %s execution', (execution) => {
    expect(() =>
      assertValid(validateProject, configured(execution === 'none' ? [] : validSteps, execution)),
    ).not.toThrow();
  });

  it('rejects dormant steps when execution is none', () => {
    expect(() => assertValid(validateProject, configured(validSteps, 'none'))).toThrow();
  });

  it('rejects empty or control-character executable argv', () => {
    for (const argv of malicious.unsafeArgv) {
      expect(() =>
        assertValid(validateProject, configured([{ id: 'run', uses: 'executable', argv }])),
      ).toThrow();
    }
  });

  it('accepts simple relative cwd values for every preparation step form', () => {
    for (const uses of ['package-install', 'package-script', 'executable'] as const) {
      const step =
        uses === 'package-install'
          ? { id: 'run', uses, cwd: 'ui' }
          : uses === 'package-script'
            ? { id: 'run', uses, script: 'build', cwd: 'js' }
            : { id: 'run', uses, argv: ['node'], cwd: 'ui' };
      expect(() => assertValid(validateProject, configured([step]))).not.toThrow();
    }
  });

  it('rejects absolute and traversing cwd values', () => {
    for (const cwd of malicious.unsafeCwd) {
      expect(() =>
        assertValid(validateProject, configured([{ id: 'run', uses: 'package-install', cwd }])),
      ).toThrow();
    }
    for (const cwd of ['../x', 'x/../y']) {
      expect(() =>
        assertValid(validateProject, configured([{ id: 'run', uses: 'package-install', cwd }])),
      ).toThrow();
    }
  });

  it('rejects out-of-bounds timeouts', () => {
    for (const timeoutSeconds of [0, 3601]) {
      expect(() =>
        assertValid(
          validateProject,
          configured([{ id: 'run', uses: 'package-install', timeoutSeconds }]),
        ),
      ).toThrow();
    }
  });

  it('rejects environment values and secret-bearing environment names', () => {
    expect(() =>
      assertValid(
        validateProject,
        configured([{ id: 'run', uses: 'package-install', environment: { CI: 'true' } }]),
      ),
    ).toThrow();
    for (const name of malicious.forbiddenEnvironment) {
      const project = configured([
        { id: 'run', uses: 'package-install', environment: ['CI', name] },
      ]);
      assertValid(validateProject, project);
      expect(doctor(project)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ code: 'FORBIDDEN_PREPARATION_ENVIRONMENT' }),
        ]),
      );
    }
  });
});

describe('validated preparation plan', () => {
  it('reports duplicate, unknown, and cyclic dependencies', () => {
    const project = configured([
      { id: 'a', uses: 'package-install', dependsOn: ['b'] },
      { id: 'b', uses: 'package-install', dependsOn: ['a'] },
      { id: 'a', uses: 'package-script', script: 'build', dependsOn: ['missing'] },
    ]);
    expect(doctor(project)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'DUPLICATE_STEP_ID' }),
        expect.objectContaining({ code: 'UNKNOWN_STEP_DEPENDENCY' }),
        expect.objectContaining({ code: 'CYCLIC_STEP_DEPENDENCY' }),
      ]),
    );
    expect(() => preparationPlan(project)).toThrow();
  });

  it('returns a deterministic dependency-respecting order and fixed bounded redaction policy', () => {
    const project = configured([
      { id: 'z', uses: 'package-script', script: 'z' },
      { id: 'done', uses: 'package-script', script: 'done', dependsOn: ['z', 'a'] },
      { id: 'a', uses: 'package-install' },
    ]);
    expect(preparationPlan(project)).toMatchObject({
      execution: 'foreground',
      order: ['a', 'z', 'done'],
      logging: { maxOutputBytes: 65536, redactEnvironmentValues: true },
    });
  });

  it('defaults required semantics without mutating committed config', () => {
    const project = configured([
      { id: 'install', uses: 'package-install' },
      { id: 'optional', uses: 'package-install', required: false },
    ]);
    expect(preparationPlan(project).steps.map((step) => step.required)).toEqual([true, false]);
    expect(project.worktrees.postCreate.steps[0]).not.toHaveProperty('required');
  });

  it('rejects shell interpreters as explicit executables', () => {
    const project = configured([
      { id: 'run', uses: 'executable', argv: ['powershell', '-Command', 'echo secret'] },
    ]);
    assertValid(validateProject, project);
    expect(doctor(project)).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'UNSAFE_PREPARATION_EXECUTABLE' })]),
    );
    expect(() => preparationPlan(project)).toThrow();
  });
});
