import type {
  Executor,
  ModeConfig,
  NetworkPolicyConfig,
  ProjectConfig,
  ResolvedSkillSelection,
  Runtime,
  UserConfig,
  WorkspaceStrategy,
} from '@mpx/config';
import type { JsonValue, SkillArtifactReference } from '@mpx/core';

export interface ElevationApproval {
  readonly reason: string;
  readonly approvalKey: string;
}
export interface HostApproval {
  readonly reason: string;
  readonly approvalKey: string;
}
export type LaunchProvenance =
  'explicit' | 'user-project' | 'user-location' | 'built-in' | 'automatic-fallback';
export type DockerAvailability = 'available' | 'unavailable' | 'unverified';
export type ShortLaunchAlias = 'cc' | 'ccw' | 'pi' | 'piw';
export type SkillArtifactInput = SkillArtifactReference;
export interface LaunchSelection {
  readonly runtime: Runtime;
  readonly identity: { readonly name: string; readonly domain: string };
  readonly mode: { readonly name: string; readonly declaration: Readonly<ModeConfig> };
  readonly selection: ResolvedSkillSelection;
  readonly executor: Executor;
  readonly workspace: WorkspaceStrategy;
  readonly networkPolicy: {
    readonly name: string;
    readonly declaration: Readonly<NetworkPolicyConfig>;
  };
  readonly preset: string | null;
  readonly provenance: Readonly<
    Record<
      'runtime' | 'identity' | 'mode' | 'executor' | 'workspace' | 'networkPolicy',
      LaunchProvenance
    >
  >;
  readonly cwdClassification: {
    readonly domain: string;
    readonly location: string;
    readonly applicableResource?: string;
  };
}
export interface ResolveLaunchSelectionInput {
  readonly userConfig: UserConfig;
  readonly projectConfig?: ProjectConfig;
  readonly runtime?: Runtime;
  readonly cwd: string;
  readonly alias?: ShortLaunchAlias;
  readonly identity?: string;
  readonly mode?: string;
  readonly executor?: Executor;
  readonly workspace?: WorkspaceStrategy;
  readonly networkPolicy?: string;
  readonly preset?: string;
  readonly projectId?: string;
  /** Application-authorized fallback used only when project config discovery returned missing. */
  readonly automaticModeFallback?: 'missing-project-config';
}
export interface ResolveLaunchInput extends ResolveLaunchSelectionInput {
  readonly runtimeArgs?: readonly string[];
  readonly elevationApproval?: Readonly<ElevationApproval>;
  readonly hostApproval?: Readonly<HostApproval>;
  readonly reason?: string;
  readonly dockerAvailability?: DockerAvailability;
  readonly skillArtifact: SkillArtifactInput;
  readonly selectedNativeRuntimeRoot: string;
  readonly repositoryId?: string;
  readonly policyInputs: JsonValue;
}
export type EffectiveExecutor =
  | {
      readonly name: 'host';
      readonly effectiveEnforcement: 'advisory';
      readonly isolation: 'none';
      readonly interception: {
        readonly kind: 'policy-hooks';
        readonly intercepted: readonly ['mpx-mediated-operations'];
        readonly knownBypasses: readonly ['raw-shell', 'direct-filesystem', 'unmanaged-children'];
      };
      readonly mounts: { readonly kind: 'host-direct'; readonly policyEnforced: false };
      readonly confidentiality: {
        readonly isolated: false;
        readonly hostReadable: true;
        readonly limitation: 'No filesystem or confidentiality isolation is enforced.';
      };
    }
  | {
      readonly name: 'docker';
      readonly effectiveEnforcement: 'mount-enforced';
      readonly isolation: 'container';
      readonly interception: {
        readonly kind: 'container-boundary';
        readonly intercepted: readonly ['container-filesystem', 'declared-mounts'];
        readonly knownBypasses: readonly ['host-services', 'direct-extra-mounts'];
      };
      readonly mounts: { readonly kind: 'explicit'; readonly policyEnforced: true };
      readonly confidentiality: {
        readonly isolated: 'mount-dependent';
        readonly hostReadable: true;
        readonly limitation: 'Mounted content, host services, and direct extra mounts remain confidentiality limitations.';
      };
    };

export interface LaunchDescriptor {
  readonly schemaVersion: 3;
  readonly launchKey: string;
  readonly nativeRuntimeRootDigest: string;
  readonly runtime: Runtime;
  readonly runtimeArgs?: readonly string[];
  readonly binding: { readonly projectId: string | null; readonly repositoryId: string };
  readonly identity: { readonly name: string; readonly domain: string };
  readonly mode: string;
  readonly selection: ResolvedSkillSelection;
  readonly executor: EffectiveExecutor & { readonly availability?: DockerAvailability };
  readonly workspace: WorkspaceStrategy;
  readonly networkPolicy: {
    readonly name: string;
    readonly declaration: Readonly<NetworkPolicyConfig>;
  };
  readonly preset: string | null;
  readonly provenance: LaunchSelection['provenance'];
  readonly diagnostics: readonly {
    readonly code: string;
    readonly severity: 'warning';
    readonly status: 'projected' | 'unverified';
    readonly message: string;
    readonly remediation: string;
  }[];
  readonly cwdClassification: LaunchSelection['cwdClassification'];
  readonly routes: {
    readonly gitAuthor: string;
    readonly providers: Readonly<Record<string, string>>;
    readonly ssh: string | null;
    readonly mcp: { readonly allow: readonly string[]; readonly shareNativeAuth: false };
  };
  readonly intendedPolicy: {
    readonly mode: string;
    readonly resources: Readonly<ModeConfig['resources']>;
    readonly inputsDigest: string;
  };
  readonly skillArtifact: Readonly<SkillArtifactInput>;
  readonly elevationAudit: {
    readonly elevated: boolean;
    readonly reason: string | null;
    readonly approvalsDigest: string;
    readonly banner: {
      readonly code: 'ELEVATED_LAUNCH';
      readonly persistent: true;
      readonly message: string;
    } | null;
  };
}
