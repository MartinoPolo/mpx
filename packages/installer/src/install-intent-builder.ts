import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { MpxError, parseStrictJson } from '@mpx/core';
import { parseUserConfig, type UserConfig } from '@mpx/config';
import {
  USER_CONFIG_ARTIFACT_MAX_BYTES,
  canonicalJson,
  installerDigest,
  parseInstallIntentV1,
  type InstallExternalIntegrationV1,
  type InstallIntentV1,
} from './immutable-core.js';
import {
  GitRemotePlanningAdapter,
  type GitCommandPort,
  type GitRemotePlan,
  type GitRemoteRequest,
} from './external-integrations.js';
import {
  createRuntimeRegistrationMatrix,
  type ProjectionRole,
  type RegisteredRuntime,
} from './runtime-registration.js';
import { createPiNativePackageRegistration } from './pi-native-package.js';
import type { CurrentReleaseBuilder } from './orchestration.js';

const MAX_REQUEST_ITEMS = 128;
const MAX_TEXT = 4_096;
export const INSTALL_EXECUTABLE_MAX_BYTES = 512 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const PROJECTION_ROLES = new Set<ProjectionRole>([
  'plugin',
  'hooks',
  'profile',
  'status',
  'settings',
  'canonical-content',
  'agents',
  'licenses',
]);

function fail(message: string, code = 'INSTALL_SCHEMA_INVALID'): never {
  throw new MpxError({ code, message });
}
function exact(
  value: unknown,
  keys: readonly string[],
  label = 'protocol value',
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail(`${label} must be an object.`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join('\0') !== [...keys].sort().join('\0')) {
    fail(`${label} has unknown or missing fields.`);
  }
  return record;
}
function absolute(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TEXT ||
    (!path.win32.isAbsolute(value) && !path.posix.isAbsolute(value)) ||
    /[\0\r\n]/u.test(value)
  ) {
    fail(`${label} must be an absolute bounded path.`);
  }
  return path.normalize(value);
}
function text(value: unknown, label: string, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > MAX_TEXT ||
    /[\0\r\n]/u.test(value)
  ) {
    fail(`${label} is invalid.`);
  }
  return value;
}
function id(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SAFE_ID.test(value)) {
    fail(`${label} must be a safe ID.`);
  }
  return value;
}
function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length > MAX_REQUEST_ITEMS) {
    fail(`${label} exceeds array bounds.`);
  }
  return value;
}
function sortedUnique<T>(items: readonly T[], key: (item: T) => string, label: string): void {
  if (
    new Set(items.map(key)).size !== items.length ||
    items.some((item, index) => index > 0 && key(items[index - 1]!).localeCompare(key(item)) >= 0)
  ) {
    fail(`${label} must be unique and sorted.`);
  }
}
export interface InstallExecutableRequestV1 {
  readonly path: string;
  readonly version: string;
}
export interface InstallProjectionRequestV1 {
  readonly path: string;
  readonly role: ProjectionRole;
}
export interface InstallGitRemoteRequestV1 {
  readonly id: string;
  readonly request: GitRemoteRequest;
}
export interface InstallIntentRequestV1 {
  readonly schemaVersion: 1;
  readonly kind: 'install-intent-request';
  readonly userConfigPath: string;
  readonly identities: { readonly personal: string; readonly work: string };
  readonly providers: { readonly personal: string; readonly work: string };
  readonly executables: {
    readonly claude: InstallExecutableRequestV1;
    readonly pi: InstallExecutableRequestV1;
  };
  readonly projections: {
    readonly claude: readonly InstallProjectionRequestV1[];
    readonly pi: readonly InstallProjectionRequestV1[];
  };
  readonly external: {
    readonly gitRemotes: readonly InstallGitRemoteRequestV1[];
  };
}

function parseSelection(value: unknown, label: string): { personal: string; work: string } {
  const item = exact(value, ['personal', 'work'], label);
  return { personal: id(item.personal, `${label}.personal`), work: id(item.work, `${label}.work`) };
}
function parseExecutable(value: unknown): InstallExecutableRequestV1 {
  const item = exact(value, ['path', 'version'], 'executable request');
  return {
    path: absolute(item.path, 'Executable path'),
    version: text(item.version, 'Executable version'),
  };
}
function parseProjection(value: unknown, label: string): InstallProjectionRequestV1[] {
  const result = array(value, label).map((entry) => {
    const item = exact(entry, ['path', 'role'], 'projection item');
    const relative = text(item.path, 'Projection path');
    if (
      relative.includes('\\') ||
      path.posix.isAbsolute(relative) ||
      path.posix.normalize(relative) !== relative ||
      relative === '..' ||
      relative.startsWith('../')
    ) {
      fail('Projection path is unsafe.');
    }
    if (typeof item.role !== 'string' || !PROJECTION_ROLES.has(item.role as ProjectionRole)) {
      fail('Projection role is invalid.');
    }
    return { path: relative, role: item.role as ProjectionRole };
  });
  sortedUnique(result, (item) => item.path, label);
  return result;
}
function parseGitRequest(value: unknown): GitRemoteRequest {
  const request = exact(value, ['repository', 'proposals'], 'Git remote request'),
    proposals = array(request.proposals, 'Git proposals').map<
      GitRemoteRequest['proposals'][number]
    >((value) => {
      const source = value as Record<string, unknown> | null,
        rename = source?.action === 'rename';
      const proposal = exact(
        value,
        rename ? ['action', 'remote', 'newName'] : ['action', 'remote', 'url'],
        'Git proposal',
      );
      if (proposal.action === 'rename') {
        return {
          action: 'rename' as const,
          remote: id(proposal.remote, 'Git remote'),
          newName: id(proposal.newName, 'Git remote name'),
        };
      }
      if (proposal.action !== 'add' && proposal.action !== 'set-url') {
        fail('Git proposal action is invalid.');
      }
      return {
        action: proposal.action,
        remote: id(proposal.remote, 'Git remote'),
        url: text(proposal.url, 'Git remote URL'),
      };
    });
  if (proposals.length === 0) {
    fail('Git proposals are required.');
  }
  sortedUnique(proposals, canonicalJson, 'Git proposals');
  return { repository: absolute(request.repository, 'Git repository'), proposals };
}
function parseExternal<T>(
  value: unknown,
  child: string,
  parse: (value: unknown) => T,
  label: string,
): ({ id: string } & Record<string, T>)[] {
  const result = array(value, label).map((value) => {
    const item = exact(value, ['id', child], `${label} item`);
    return { id: id(item.id, `${label} ID`), [child]: parse(item[child]) } as {
      id: string;
    } & Record<string, T>;
  });
  sortedUnique(result, (item) => item.id, label);
  return result;
}
export function parseInstallIntentRequestV1(value: unknown): InstallIntentRequestV1 {
  const request = exact(
    value,
    [
      'schemaVersion',
      'kind',
      'userConfigPath',
      'identities',
      'providers',
      'executables',
      'projections',
      'external',
    ],
    'Install intent request',
  );
  if (request.schemaVersion !== 1 || request.kind !== 'install-intent-request') {
    fail('Install intent request header is invalid.');
  }
  const executables = exact(request.executables, ['claude', 'pi'], 'Executables'),
    projections = exact(request.projections, ['claude', 'pi'], 'Projections'),
    external = exact(request.external, ['gitRemotes'], 'External requests');
  const parsed: InstallIntentRequestV1 = {
    schemaVersion: 1,
    kind: 'install-intent-request',
    userConfigPath: absolute(request.userConfigPath, 'User config path'),
    identities: parseSelection(request.identities, 'Identity selections'),
    providers: parseSelection(request.providers, 'Provider selections'),
    executables: {
      claude: parseExecutable(executables.claude),
      pi: parseExecutable(executables.pi),
    },
    projections: {
      claude: parseProjection(projections.claude, 'Claude projections'),
      pi: parseProjection(projections.pi, 'Pi projections'),
    },
    external: {
      gitRemotes: parseExternal(
        external.gitRemotes,
        'request',
        parseGitRequest,
        'Git remote requests',
      ) as unknown as InstallGitRemoteRequestV1[],
    },
  };
  const allIds = parsed.external.gitRemotes.map((item) => item.id);
  if (new Set(allIds).size !== allIds.length) {
    fail('External request IDs must be globally unique.');
  }
  return parsed;
}

export type InstallExternalPlanV1 = {
  readonly id: string;
  readonly adapter: InstallExternalIntegrationV1['adapter'];
  readonly classification: InstallExternalIntegrationV1['classification'];
  readonly planDigest: string;
  readonly verifierRef: string;
  readonly plan: GitRemotePlan;
};
export interface InstallIntentBuildResultV1 {
  readonly schemaVersion: 1;
  readonly kind: 'install-intent-build-result';
  readonly intent: InstallIntentV1;
  readonly externalPlans: readonly InstallExternalPlanV1[];
}
export interface InstallExternalVerificationIntegrationV1 {
  readonly id: string;
  readonly adapter: InstallExternalIntegrationV1['adapter'];
  readonly planDigest: string;
  readonly verifierRef: string;
  readonly healthy: boolean;
  readonly issues: readonly string[];
}
export interface InstallExternalVerificationResultV1 {
  readonly schemaVersion: 1;
  readonly kind: 'install-external-verification';
  readonly integrations: readonly InstallExternalVerificationIntegrationV1[];
}

export function parseInstallExternalVerificationResultV1(
  value: unknown,
): InstallExternalVerificationResultV1 {
  const result = exact(
    value,
    ['schemaVersion', 'kind', 'integrations'],
    'External verification result',
  );
  if (result.schemaVersion !== 1 || result.kind !== 'install-external-verification') {
    fail('External verification result header is invalid.');
  }
  const integrations = array(result.integrations, 'External verification integrations').map(
    (value) => {
      const item = exact(
        value,
        ['id', 'adapter', 'planDigest', 'verifierRef', 'healthy', 'issues'],
        'External verification integration',
      );
      const issues = array(item.issues, 'External verification issues').map((issue) =>
        text(issue, 'External verification issue'),
      );
      sortedUnique(issues, (issue) => issue, 'External verification issues');
      if (
        typeof item.adapter !== 'string' ||
        item.adapter !== 'git-remotes' ||
        typeof item.planDigest !== 'string' ||
        !SHA.test(item.planDigest) ||
        typeof item.verifierRef !== 'string' ||
        item.verifierRef.length > 256 ||
        typeof item.healthy !== 'boolean' ||
        item.healthy !== (issues.length === 0)
      ) {
        fail('External verification integration is invalid.');
      }
      return {
        id: id(item.id, 'External verification integration ID'),
        adapter: item.adapter as InstallExternalIntegrationV1['adapter'],
        planDigest: item.planDigest,
        verifierRef: item.verifierRef,
        healthy: item.healthy,
        issues,
      };
    },
  );
  sortedUnique(integrations, (item) => item.id, 'External verification integrations');
  return { schemaVersion: 1, kind: 'install-external-verification', integrations };
}
function strings(value: unknown, label: string): string[] {
  return array(value, label).map((item) => text(item, label));
}
function confirmation(
  value: unknown,
  scope: string,
  digestValue: string,
): { required: true; scope: string; digest: string } {
  const item = exact(value, ['required', 'scope', 'digest'], 'External confirmation');
  if (item.required !== true || item.scope !== scope || item.digest !== digestValue) {
    fail('External confirmation binding is invalid.');
  }
  return { required: true, scope, digest: digestValue };
}
function snapshot(
  value: unknown,
  expectedPath?: string,
): { path: string; encoding: 'base64'; bytes: string; sha256: string | null } {
  const item = exact(value, ['path', 'encoding', 'bytes', 'sha256'], 'File snapshot'),
    snapshotPath = absolute(item.path, 'Snapshot path');
  if (
    (expectedPath !== undefined && path.normalize(expectedPath) !== snapshotPath) ||
    item.encoding !== 'base64' ||
    typeof item.bytes !== 'string' ||
    item.bytes.length > 349_528 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(item.bytes)
  ) {
    fail('File snapshot is invalid.');
  }
  const bytes = Buffer.from(item.bytes, 'base64'),
    sha256 = item.sha256;
  if (
    (sha256 !== null &&
      (typeof sha256 !== 'string' ||
        !SHA.test(sha256) ||
        sha256 !== createHash('sha256').update(bytes).digest('hex'))) ||
    (sha256 === null && item.bytes !== '')
  ) {
    fail('File snapshot digest is invalid.');
  }
  return { path: snapshotPath, encoding: 'base64', bytes: item.bytes, sha256: sha256 };
}
function parseGitPlan(value: unknown): GitRemotePlan {
  const item = exact(
    value,
    [
      'kind',
      'classification',
      'repository',
      'commands',
      'preservedRemotes',
      'expectedRemotes',
      'confirmation',
      'rollback',
    ],
    'Git plan',
  );
  if (item.kind !== 'git-remotes' || item.classification !== 'confirmation-required') {
    fail('Git plan header is invalid.');
  }
  const repository = absolute(item.repository, 'Git repository');
  const commands = array(item.commands, 'Git commands').map((value) => {
    const command = exact(value, ['executable', 'cwd', 'argv'], 'Git command'),
      argv = strings(command.argv, 'Git argv');
    if (
      command.executable !== 'git' ||
      command.cwd !== repository ||
      argv.length < 3 ||
      argv[0] !== 'remote' ||
      !(
        (argv[1] === 'rename' &&
          argv.length === 4 &&
          argv.slice(2).every((arg) => SAFE_ID.test(arg))) ||
        (['add', 'set-url'].includes(argv[1]!) &&
          argv.length === 4 &&
          SAFE_ID.test(argv[2]!) &&
          safeRelativeOrUrl(argv[3]!))
      )
    ) {
      fail('Git command is invalid.');
    }
    return { executable: 'git' as const, cwd: repository, argv };
  });
  sortedUnique(commands, (command) => command.argv.join('\0'), 'Git commands');
  const preservedRemotes = strings(item.preservedRemotes, 'Preserved remotes');
  if (preservedRemotes.some((remote) => !SAFE_ID.test(remote))) {
    fail('Preserved remote is invalid.');
  }
  sortedUnique(preservedRemotes, (remote) => remote, 'Preserved remotes');
  const expectedRemotes = array(item.expectedRemotes, 'Expected remotes').map<
    GitRemotePlan['expectedRemotes'][number]
  >((value) => {
    const remote = exact(value, ['remote', 'url', 'direction'], 'Expected remote');
    if (
      typeof remote.remote !== 'string' ||
      !SAFE_ID.test(remote.remote) ||
      typeof remote.url !== 'string' ||
      !safeRelativeOrUrl(remote.url) ||
      (remote.direction !== 'fetch' && remote.direction !== 'push')
    ) {
      fail('Expected remote is invalid.');
    }
    return { remote: remote.remote, url: remote.url, direction: remote.direction };
  });
  sortedUnique(expectedRemotes, canonicalJson, 'Expected remotes');
  const rollbackValue = exact(item.rollback, ['automatic', 'snapshot', 'steps'], 'Git rollback'),
    configPath = path.join(repository, '.git', 'config'),
    config = snapshot(rollbackValue.snapshot, configPath),
    steps = strings(rollbackValue.steps, 'Git rollback steps');
  if (rollbackValue.automatic !== false || steps.length === 0) {
    fail('Git rollback is invalid.');
  }
  const digestValue = installerDigest({ repository, config: config.sha256, commands });
  return {
    kind: 'git-remotes',
    classification: 'confirmation-required',
    repository,
    commands,
    preservedRemotes,
    expectedRemotes,
    confirmation: confirmation(item.confirmation, repository, digestValue),
    rollback: { automatic: false, snapshot: config, steps },
  };
}
function safeRelativeOrUrl(value: string): boolean {
  return value.length > 0 && value.length <= MAX_TEXT && !/[\0\r\n]/u.test(value);
}
export function parseInstallIntentBuildResultV1(value: unknown): InstallIntentBuildResultV1 {
  const result = exact(
    value,
    ['schemaVersion', 'kind', 'intent', 'externalPlans'],
    'Install intent build result',
  );
  if (result.schemaVersion !== 1 || result.kind !== 'install-intent-build-result') {
    fail('Install intent build result header is invalid.');
  }
  const intent = parseInstallIntentV1(result.intent),
    integrations = intent.externalIntegrations ?? [];
  const externalPlans = array(result.externalPlans, 'External plans').map((value) => {
    const item = exact(
      value,
      ['id', 'adapter', 'classification', 'planDigest', 'verifierRef', 'plan'],
      'External plan',
    );
    const plan =
      item.adapter === 'git-remotes'
        ? parseGitPlan(item.plan)
        : fail('External plan adapter is invalid.');
    if (
      typeof item.planDigest !== 'string' ||
      !SHA.test(item.planDigest) ||
      item.planDigest !== installerDigest(plan) ||
      typeof item.verifierRef !== 'string' ||
      item.verifierRef !== `${item.adapter}:${item.id}:${item.planDigest}`
    ) {
      fail('External plan digest or verifier is not bound.');
    }
    if (
      !SAFE_ID.test(item.id as string) ||
      item.adapter !== 'git-remotes' ||
      !['confirmation-required', 'manual-only'].includes(item.classification as string)
    ) {
      fail('External plan binding is invalid.');
    }
    if (plan.kind !== item.adapter || plan.classification !== item.classification) {
      fail('External plan adapter or classification binding is invalid.');
    }
    return {
      id: item.id,
      adapter: item.adapter,
      classification: item.classification,
      planDigest: item.planDigest,
      verifierRef: item.verifierRef,
      plan,
    } as InstallExternalPlanV1;
  });
  sortedUnique(externalPlans, (item) => item.id, 'External plans');
  if (
    externalPlans.length !== integrations.length ||
    externalPlans.some(
      (plan, index) =>
        canonicalJson({
          id: plan.id,
          adapter: plan.adapter,
          classification: plan.classification,
          planDigest: plan.planDigest,
          verifierRef: plan.verifierRef,
        }) !== canonicalJson(integrations[index]),
    )
  ) {
    fail('External plans must match and be bound to intent integrations.');
  }
  return { schemaVersion: 1, kind: 'install-intent-build-result', intent, externalPlans };
}

async function regularFileEvidence(
  request: InstallExecutableRequestV1,
): Promise<{ path: string; sha256: string; version: string }> {
  const info = await lstat(request.path).catch(() =>
    fail('Executable is unavailable.', 'INSTALL_EXECUTABLE_INVALID'),
  );
  if (!info.isFile() || info.isSymbolicLink() || info.size > INSTALL_EXECUTABLE_MAX_BYTES) {
    fail(
      'Executable must be a regular non-symlink file of at most 512 MiB.',
      'INSTALL_EXECUTABLE_INVALID',
    );
  }
  return {
    path: request.path,
    sha256: createHash('sha256')
      .update(await readFile(request.path))
      .digest('hex'),
    version: request.version,
  };
}
function selectedIdentity(config: UserConfig, name: string, domain: 'personal' | 'work') {
  const identity = config.identities[name];
  if (!identity || identity.domain !== domain) {
    fail(
      `Selected ${domain} identity must exist in the exact configured domain.`,
      'INSTALL_IDENTITY_INVALID',
    );
  }
  const ssh = identity.sshRoute;
  if (!ssh) {
    fail(`Selected ${domain} identity requires an SSH route.`, 'INSTALL_ROUTE_REQUIRED');
  }
  return { identity, ssh };
}

export interface InstallIntentBuilderOptions {
  readonly releases: CurrentReleaseBuilder;
  readonly environment?: NodeJS.ProcessEnv;
  readonly gitRemotes: Pick<GitRemotePlanningAdapter, 'inspect' | 'plan' | 'verify'>;
}
export class InstallIntentBuilder {
  constructor(private readonly options: InstallIntentBuilderOptions) {}
  async verify(
    buildValue: InstallIntentBuildResultV1 | unknown,
  ): Promise<InstallExternalVerificationResultV1> {
    const build = parseInstallIntentBuildResultV1(buildValue);
    const integrations: InstallExternalVerificationIntegrationV1[] = [];
    for (const external of build.externalPlans) {
      let verification: { readonly healthy: boolean; readonly issues: readonly string[] };
      try {
        verification = await this.options.gitRemotes.verify(external.plan);
      } catch {
        verification = { healthy: false, issues: ['external-verifier-failed'] };
      }
      const issues = [...new Set(verification.issues)].sort((a, b) => a.localeCompare(b));
      integrations.push({
        id: external.id,
        adapter: external.adapter,
        planDigest: external.planDigest,
        verifierRef: external.verifierRef,
        healthy: issues.length === 0 && verification.healthy,
        issues:
          verification.healthy && issues.length === 0
            ? []
            : issues.length
              ? issues
              : ['external-verifier-unhealthy'],
      });
    }
    return parseInstallExternalVerificationResultV1({
      schemaVersion: 1,
      kind: 'install-external-verification',
      integrations,
    });
  }
  async build(value: InstallIntentRequestV1 | unknown): Promise<InstallIntentBuildResultV1> {
    const request = parseInstallIntentRequestV1(value),
      info = await lstat(request.userConfigPath).catch(() =>
        fail('User configuration is unavailable.', 'INSTALL_USER_CONFIG_INVALID'),
      );
    if (!info.isFile() || info.isSymbolicLink() || info.size > USER_CONFIG_ARTIFACT_MAX_BYTES) {
      fail(
        'User configuration must be a regular file of at most 64 KiB.',
        'INSTALL_USER_CONFIG_INVALID',
      );
    }
    const raw = await readFile(request.userConfigPath, 'utf8');
    if (Buffer.byteLength(raw, 'utf8') > USER_CONFIG_ARTIFACT_MAX_BYTES) {
      fail('User configuration exceeds 64 KiB.', 'INSTALL_USER_CONFIG_INVALID');
    }
    parseStrictJson(raw);
    const config = parseUserConfig(raw, this.options.environment ?? process.env),
      manifest = await this.options.releases.build();
    const [claudeExecutable, piExecutable] = await Promise.all([
      regularFileEvidence(request.executables.claude),
      regularFileEvidence(request.executables.pi),
    ]);
    const identities = {
      personal: selectedIdentity(config, request.identities.personal, 'personal'),
      work: selectedIdentity(config, request.identities.work, 'work'),
    };
    const projection = (runtime: RegisteredRuntime) => {
      const inventory = request.projections[runtime],
        files = inventory.map((item) => {
          const manifestFile = manifest.files.find((file) => file.path === item.path);
          if (!manifestFile) {
            fail(
              `Projection ${item.path} is absent from the current manifest.`,
              'INSTALL_PROJECTION_MISMATCH',
            );
          }
          return { ...manifestFile, role: item.role, owner: 'convergence' as const };
        });
      return {
        rootDigest: installerDigest(files),
        files,
        reader: 'canonical' as const,
        activation: 'argv-only' as const,
      };
    };
    const nativePackage = createPiNativePackageRegistration(manifest);
    const matrix = createRuntimeRegistrationMatrix(
      (['claude', 'pi'] as const).flatMap((runtime) =>
        (['personal', 'work'] as const).map((domain) => {
          const selected = identities[domain],
            provider = request.providers[domain],
            providerRoute = selected.identity.providerRoutes?.[provider];
          if (!providerRoute) {
            fail(
              `Selected ${domain} identity requires the selected provider route.`,
              'INSTALL_ROUTE_REQUIRED',
            );
          }
          const common = {
            domain,
            nativeRoot: selected.identity.runtimeRoots[runtime],
            executable: runtime === 'claude' ? claudeExecutable : piExecutable,
            projection: projection(runtime),
            routes: {
              git: `${domain}:${selected.identity.gitAuthorRoute}`,
              provider: `${domain}:${providerRoute}`,
              ssh: `${domain}:${selected.ssh}`,
              mcpSharing: 'isolated' as const,
            },
          };
          return runtime === 'pi'
            ? { ...common, runtime: 'pi' as const, nativePackage }
            : { ...common, runtime: 'claude' as const };
        }),
      ),
    );
    const plans: InstallExternalPlanV1[] = [];
    const add = (
      idValue: string,
      adapter: InstallExternalIntegrationV1['adapter'],
      plan: GitRemotePlan,
    ): void => {
      const planDigest = installerDigest(plan),
        verifierRef = `${adapter}:${idValue}:${planDigest}`;
      plans.push({
        id: idValue,
        adapter,
        classification: plan.classification,
        planDigest,
        verifierRef,
        plan,
      });
    };
    for (const item of request.external.gitRemotes) {
      add(
        item.id,
        'git-remotes',
        await this.options.gitRemotes.plan(await this.options.gitRemotes.inspect(item.request)),
      );
    }
    plans.sort((a, b) => a.id.localeCompare(b.id));
    const externalIntegrations = plans.map(({ plan: _plan, ...integration }) => integration),
      intent = parseInstallIntentV1({
        schemaVersion: 1,
        kind: 'install-intent',
        releaseKey: manifest.releaseKey,
        convergenceHash: manifest.convergenceHash,
        components: ['cli', 'runtime-registrations', 'user-config'],
        userConfigArtifact: {
          target: '%APPDATA%/mpx/config.json',
          content: raw,
          sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
        },
        runtimeRegistrations: matrix,
        ...(externalIntegrations.length ? { externalIntegrations } : {}),
      });
    return parseInstallIntentBuildResultV1({
      schemaVersion: 1,
      kind: 'install-intent-build-result',
      intent,
      externalPlans: plans,
    });
  }
}

export class NodeGitCommandPort implements GitCommandPort {
  constructor(
    private readonly environment: NodeJS.ProcessEnv = process.env,
    private readonly timeoutMilliseconds = 10_000,
    private readonly maxOutputBytes = 1024 * 1024,
  ) {}
  run(
    cwd: string,
    argv: readonly string[],
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    if (argv.length !== 2 || argv[0] !== 'remote' || argv[1] !== '-v' || !path.isAbsolute(cwd)) {
      fail('Git command port permits only argv-only git remote -v.', 'GIT_COMMAND_INVALID');
    }
    const env = Object.fromEntries(
      ['SYSTEMROOT', 'WINDIR', 'PATH', 'PATHEXT', 'TEMP', 'TMP'].flatMap((name) =>
        this.environment[name] === undefined ? [] : [[name, this.environment[name]!]],
      ),
    );
    return new Promise((resolve, reject) =>
      execFile(
        'git',
        [...argv],
        {
          cwd,
          env,
          shell: false,
          windowsHide: true,
          timeout: this.timeoutMilliseconds,
          maxBuffer: this.maxOutputBytes,
          encoding: 'utf8',
        },
        (error, stdout, stderr) => {
          const code =
            error && typeof (error as { code?: unknown }).code === 'number'
              ? (error as { code: number }).code
              : error
                ? undefined
                : 0;
          if (code === undefined) {
            reject(error);
          } else {
            resolve({ stdout, stderr, exitCode: code });
          }
        },
      ),
    );
  }
}
