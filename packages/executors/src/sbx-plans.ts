import { ExecutionError } from './index.js';
import type { SandboxLaunchPlanV1 } from './sandbox-plan.js';
import { buildSbxPolicyPlan } from './sbx-policy.js';

export type SbxArgv = readonly string[];
export interface SbxCommandPlans {
  readonly create: SbxArgv;
  readonly attach: SbxArgv;
  readonly exec: SbxArgv;
  readonly ports: SbxArgv;
  readonly policyApply: readonly SbxArgv[];
  readonly policyChecks: readonly {
    readonly target: string;
    readonly decision: 'allow' | 'deny';
    readonly argv: SbxArgv;
  }[];
  readonly list: SbxArgv;
  readonly delete: SbxArgv;
}
const safePort =
  /^(?:127\.0\.0\.1|\[::1\]):(?:[1-9]\d{0,4}):(?:[1-9]\d{0,4})\/(?:tcp4|tcp6|udp4|udp6)$/u;
export function buildSbxCommandPlans(
  plan: SandboxLaunchPlanV1,
  input: { agent: 'claude' | 'shell'; execArgv: readonly string[]; ports: readonly string[] },
): SbxCommandPlans {
  if (
    input.execArgv.length === 0 ||
    input.execArgv.length > 128 ||
    input.execArgv.some((arg) => !arg || arg.length > 8192 || /[\r\n\0]/u.test(arg))
  ) {
    throw new ExecutionError('SBX_ARGV_INVALID', 'Sandbox exec argv is invalid.');
  }
  if (input.ports.some((port) => !safePort.test(port))) {
    throw new ExecutionError(
      'SBX_PORT_INVALID',
      'Sandbox ports must bind an exact loopback address and protocol.',
    );
  }
  if (!plan.workspaceSource) {
    throw new ExecutionError('SBX_WORKSPACE_INVALID', 'Sandbox workspace source is missing.');
  }
  if (plan.sbxArgv.includes('--profile')) {
    throw new ExecutionError(
      'SBX_ARGV_INVALID',
      'MPX logical policy names must not be passed as sbx profiles.',
    );
  }
  const plannedAgent = plan.sbxArgv[plan.sbxArgv.indexOf(plan.workspaceSource) - 1];
  if (plannedAgent !== input.agent) {
    throw new ExecutionError(
      'SBX_AGENT_MISMATCH',
      'Sandbox agent does not match the reviewed plan.',
    );
  }
  const policy = buildSbxPolicyPlan(
    plan.appName,
    plan.networkPolicy.name as Parameters<typeof buildSbxPolicyPlan>[1],
    plan.networkPolicy.allow,
  );
  return Object.freeze({
    create: Object.freeze([...plan.sbxArgv]),
    attach: Object.freeze(['run', '--name', plan.appName]),
    exec: Object.freeze(['exec', plan.appName, ...input.execArgv]),
    ports: Object.freeze([
      'ports',
      plan.appName,
      ...input.ports.flatMap((port) => ['--publish', port]),
    ]),
    policyApply: policy.apply,
    policyChecks: policy.checks,
    list: Object.freeze(['ls', '--json']),
    delete: Object.freeze(['rm', '--force', plan.appName]),
  });
}
