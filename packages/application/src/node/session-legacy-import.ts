import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  LegacySessionImporter,
  SessionError,
  type IdentityV1,
  type LegacyImportPlanV1,
  type LegacyImportReceiptV1,
  type SessionStore,
} from '@mpx/sessions';
import type {
  SessionLegacyImport,
  SessionLegacyImportRequest,
} from '../session-application-service.js';

export interface NodeSessionLegacyImportDependencies {
  readonly store: SessionStore;
  readonly resolveIdentity: (name: string) => Promise<IdentityV1>;
}

export function createNodeSessionLegacyImport(
  dependencies: NodeSessionLegacyImportDependencies,
): SessionLegacyImport {
  const importer = new LegacySessionImporter(dependencies.store);
  return {
    async plan(
      request: Omit<SessionLegacyImportRequest, 'confirmation'>,
    ): Promise<LegacyImportPlanV1> {
      const accounts = new Map(
        request.accountMappings.map(({ source, identity }) => [source, identity] as const),
      );
      const roots = new Map(
        request.piRootMappings.map(({ identity, nativeRoot }) => [identity, nativeRoot] as const),
      );
      if (!accounts.size) {
        throw new SessionError(
          'SESSION_USAGE_ERROR',
          'legacy import requires explicit --map-account mappings',
        );
      }
      const bindings = await dependencies.store.listNativeBindings();
      const resolved: Record<
        string,
        { identity: IdentityV1; nativeBindingRef: string; nativeRoot?: string }
      > = {};
      for (const [source, identityName] of accounts) {
        const identity = await dependencies.resolveIdentity(identityName);
        const runtime = source.startsWith('pi:') ? 'pi' : 'claude';
        const binding = bindings.find(
          (item) =>
            item.runtime === runtime &&
            item.identity.domain === identity.domain &&
            item.identity.name === identity.name,
        );
        if (!binding) {
          throw new SessionError(
            'LEGACY_MAPPING_REQUIRED',
            `Mapped ${runtime} identity has no native binding`,
          );
        }
        if (runtime === 'pi') {
          const nativeRoot = roots.get(identityName);
          if (!nativeRoot) {
            throw new SessionError(
              'LEGACY_MAPPING_REQUIRED',
              "Mapped Pi source requires its identity's explicit --map-pi-root",
            );
          }
          resolved[source] = { identity, nativeBindingRef: binding.ref, nativeRoot };
        } else {
          resolved[source] = { identity, nativeBindingRef: binding.ref };
          resolved[`claude:${source}`] = resolved[source]!;
        }
      }
      if (![...accounts.keys()].some((key) => key.startsWith('pi:')) && roots.size === 1) {
        const [identityName, nativeRoot] = [...roots.entries()][0]!;
        const identity = await dependencies.resolveIdentity(identityName);
        const binding = bindings.find(
          (item) =>
            item.runtime === 'pi' &&
            item.identity.domain === identity.domain &&
            item.identity.name === identity.name,
        );
        if (!binding) {
          throw new SessionError(
            'LEGACY_MAPPING_REQUIRED',
            'Mapped Pi identity has no native binding',
          );
        }
        resolved.pi = { identity, nativeBindingRef: binding.ref, nativeRoot };
      }
      const files: string[] = [];
      for (const source of request.sources) {
        const info = await lstat(source);
        if (info.isSymbolicLink()) {
          throw new SessionError(
            'LEGACY_SOURCE_UNSAFE',
            'Legacy import source must not be a symlink.',
          );
        }
        if (info.isFile()) {
          files.push(source);
        } else if (info.isDirectory()) {
          const names = (await readdir(source)).filter((name) => name.endsWith('.json')).sort();
          if (names.length > 128) {
            throw new SessionError(
              'LEGACY_SOURCE_LIMIT',
              'Legacy registry directory contains too many entries.',
            );
          }
          const directoryMapping = resolved[`pi:${source}`];
          for (const name of names) {
            const file = path.join(source, name);
            const entry = await lstat(file);
            if (entry.isSymbolicLink() || !entry.isFile()) {
              throw new SessionError(
                'LEGACY_SOURCE_UNSAFE',
                'Legacy registry entries must be regular files.',
              );
            }
            files.push(file);
            if (directoryMapping) {
              resolved[`pi:${file}`] = directoryMapping;
            }
          }
        } else {
          throw new SessionError(
            'LEGACY_SOURCE_UNSAFE',
            'Legacy import source must be a regular file or directory.',
          );
        }
      }
      return importer.planFiles(files, resolved);
    },
    import(plan: LegacyImportPlanV1, confirmation: string): Promise<LegacyImportReceiptV1> {
      return importer.import(plan, confirmation);
    },
  };
}
