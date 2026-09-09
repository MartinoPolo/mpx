import { isPathWithinRoot, MpxError } from '@mpx/core';
import { realpath } from 'node:fs/promises';
import type {
  ApplicableResourceClassification,
  ConfigurableResource,
  CwdClassification,
  LocationClassification,
  ProjectConfig,
  ProvenanceEntry,
  ResolvedConfig,
  ResolvedSkillSelection,
  UserConfig,
} from './types.js';
import { sortProvenance } from './provenance.js';
import { resolveEffectiveSkillPacks } from './skill-packs.js';

export interface KnownLaunchCwdClassification {
  domain: string;
  location: string;
  applicableResource?: ConfigurableResource;
}

function isMissingRealpathError(error: unknown): boolean {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

type RootMatch = { name: string; canonicalRoot: string };

async function matchingRoots(
  cwd: string,
  groups: Record<string, readonly string[]>,
): Promise<RootMatch[]> {
  const canonicalCwd = await realpath(cwd);
  const matches: RootMatch[] = [];
  for (const [name, roots] of Object.entries(groups).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    for (const configuredRoot of roots) {
      try {
        const canonicalRoot = await realpath(configuredRoot);
        const platform =
          /^[A-Za-z]:[\\/]/u.test(canonicalCwd) || /^[A-Za-z]:[\\/]/u.test(canonicalRoot)
            ? 'win32'
            : process.platform;
        if (isPathWithinRoot(canonicalCwd, canonicalRoot, { platform })) {
          matches.push({ name, canonicalRoot });
        }
      } catch (error) {
        if (!isMissingRealpathError(error)) {
          throw error;
        }
      }
    }
  }
  return matches.sort(
    (left, right) =>
      right.canonicalRoot.length - left.canonicalRoot.length ||
      left.name.localeCompare(right.name) ||
      left.canonicalRoot.localeCompare(right.canonicalRoot),
  );
}

async function bestRoot(
  cwd: string,
  groups: Record<string, readonly string[]>,
  ambiguityCode: string,
): Promise<RootMatch | undefined> {
  const matches = await matchingRoots(cwd, groups);
  const best = matches[0];
  if (
    best &&
    matches.some((match) => match.name !== best.name && match.canonicalRoot === best.canonicalRoot)
  ) {
    throw new MpxError({
      code: ambiguityCode,
      message: `Canonical root '${best.canonicalRoot}' has multiple configured owners.`,
      remediation: 'Remove the duplicate canonical root mapping and relaunch.',
    });
  }
  return best;
}

export async function classifyCwd(cwd: string, userConfig: UserConfig): Promise<CwdClassification> {
  const best = await bestRoot(cwd, userConfig.domains, 'DOMAIN_CLASSIFICATION_AMBIGUOUS');
  return best
    ? { status: 'known', domain: best.name, root: best.canonicalRoot }
    : { status: 'unknown' };
}

export async function classifyLocation(
  cwd: string,
  userConfig: UserConfig,
): Promise<LocationClassification> {
  const groups = Object.fromEntries(
    Object.entries(userConfig.locations).map(([name, location]) => [name, location.roots]),
  );
  const best = await bestRoot(cwd, groups, 'LOCATION_CLASSIFICATION_AMBIGUOUS');
  return best
    ? { status: 'known', location: best.name, canonicalRoot: best.canonicalRoot }
    : { status: 'unknown' };
}

export async function classifyApplicableResource(
  cwd: string,
  userConfig: UserConfig,
): Promise<ApplicableResourceClassification> {
  const best = await bestRoot(
    cwd,
    userConfig.resourceRoots ?? {},
    'RESOURCE_CLASSIFICATION_AMBIGUOUS',
  );
  return best
    ? {
        status: 'known',
        resource: best.name as ConfigurableResource,
        canonicalRoot: best.canonicalRoot,
      }
    : { status: 'unknown' };
}

function safeErrnoCode(error: unknown): string {
  const code =
    typeof error === 'object' && error !== null && 'code' in error
      ? (error as { code?: unknown }).code
      : undefined;
  return typeof code === 'string' && code ? code : 'UNKNOWN';
}

export async function resolveKnownLaunchCwdClassification(
  cwd: string,
  userConfig: UserConfig,
): Promise<KnownLaunchCwdClassification> {
  try {
    const [domain, location, resource] = await Promise.all([
      classifyCwd(cwd, userConfig),
      classifyLocation(cwd, userConfig),
      classifyApplicableResource(cwd, userConfig),
    ]);
    if (domain.status === 'unknown' || location.status === 'unknown') {
      throw new MpxError({
        code: 'CWD_CLASSIFICATION_UNKNOWN',
        message: 'The launch CWD must have known domain and location classifications.',
        remediation: 'Add explicit domain and location roots or choose a known CWD.',
      });
    }
    return {
      domain: domain.domain,
      location: location.location,
      ...(resource.status === 'known' ? { applicableResource: resource.resource } : {}),
    };
  } catch (error) {
    if (error instanceof MpxError) {
      throw error;
    }
    throw new MpxError({
      code: 'CWD_CLASSIFICATION_FAILED',
      message: 'The launch CWD could not be canonically classified.',
      remediation: 'Check filesystem access and configured roots, then relaunch.',
      details: { errno: safeErrnoCode(error) },
    });
  }
}

export async function resolveSkillSelection(
  projectConfig: ProjectConfig | undefined,
  userConfig: UserConfig,
  cwd: string,
  identityName: string,
  projectId?: string,
): Promise<ResolvedSkillSelection> {
  const locationClassification = await classifyLocation(cwd, userConfig);
  if (locationClassification.status === 'unknown') {
    throw new MpxError({
      code: 'LOCATION_UNKNOWN',
      message: 'The launch CWD does not select a configured location.',
      remediation: 'Add a location root with selected skill packs.',
    });
  }
  const identity = userConfig.identities[identityName];
  if (!identity) {
    throw new MpxError({
      code: 'IDENTITY_UNKNOWN',
      message: `Identity '${identityName}' is not configured.`,
      remediation: 'Select an explicit configured identity.',
    });
  }
  const selectedProjectId = projectConfig?.project.id ?? projectId;
  const projectOverride = selectedProjectId ? userConfig.projects?.[selectedProjectId] : undefined;
  const location = userConfig.locations[locationClassification.location]!;
  const selected =
    projectConfig?.skills?.packs ?? projectOverride?.skillPacks ?? location.skillPacks;
  let packs;
  try {
    packs = resolveEffectiveSkillPacks(selected, identity.allowedSkillPacks);
  } catch (error) {
    throw new MpxError({
      code: selected.some((pack) => !identity.allowedSkillPacks.includes(pack))
        ? 'SKILL_PACK_NOT_ALLOWED'
        : 'SKILL_PACK_SELECTION_INVALID',
      message: (error as Error).message,
      remediation: 'Select at least one pack allowed by the explicit identity.',
    });
  }
  return {
    location: {
      name: locationClassification.location,
      canonicalRoot: locationClassification.canonicalRoot,
    },
    packs,
    source: projectConfig?.skills ? 'project' : projectOverride ? 'user-project' : 'user-location',
  };
}

export async function resolveConfig(
  projectConfig: ProjectConfig,
  userConfig: UserConfig,
  cwd: string,
  identityName: string,
): Promise<ResolvedConfig> {
  const [cwdClassification, selection] = await Promise.all([
    classifyCwd(cwd, userConfig),
    resolveSkillSelection(projectConfig, userConfig, cwd, identityName),
  ]);
  if (cwdClassification.status === 'unknown') {
    throw new MpxError({
      code: 'CWD_CLASSIFICATION_UNKNOWN',
      message: 'The launch CWD is outside every configured domain.',
      remediation: 'Add an explicit domain root or choose a known CWD.',
    });
  }
  const provenance: ProvenanceEntry[] = [{ pointer: '/selection/packs', source: selection.source }];
  const project = structuredClone(projectConfig);
  if (!project.issues) {
    project.issues = { provider: 'none' };
    provenance.push({ pointer: '/project/issues', source: 'default' });
  }
  if (!project.tooling) {
    project.tooling = { packageManager: 'auto' };
    provenance.push({ pointer: '/project/tooling', source: 'default' });
  }
  return {
    project,
    cwdClassification,
    selection,
    provenance: sortProvenance(provenance),
  };
}
