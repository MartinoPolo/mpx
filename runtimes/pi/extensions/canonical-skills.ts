import path from 'node:path';

import {
  classifyCompiledSkillSource,
  loadActiveContentProjection,
  readActiveSkill,
} from '@mpx/content-compiler/active';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { findSkillReferenceAtCursor, findSubmittedSkillReferences } from './skill-references.js';

type Environment = Readonly<Record<string, string | undefined>>;
type ActiveProjection = Awaited<ReturnType<typeof loadActiveContentProjection>>;
type SkillEntry = ActiveProjection['manifest']['skills'][number];

interface ManifestIntegrity {
  readonly sha256: string;
  readonly byteCount: number;
}

function manifestIntegrity(value: string | undefined): ManifestIntegrity {
  if (!value) {
    throw new Error('MPX active content manifest integrity is required.');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('MPX active content manifest integrity is invalid.');
  }
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join('\0') !== 'byteCount\0sha256' ||
    typeof (parsed as { sha256?: unknown }).sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/u.test((parsed as { sha256: string }).sha256) ||
    !Number.isSafeInteger((parsed as { byteCount?: unknown }).byteCount) ||
    ((parsed as { byteCount: number }).byteCount ?? -1) < 0
  ) {
    throw new Error('MPX active content manifest integrity is invalid.');
  }
  return parsed as unknown as ManifestIntegrity;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function activeLoader(environment: Environment): () => Promise<ActiveProjection> {
  const expectedIntegrity = manifestIntegrity(environment.MPX_ACTIVE_CONTENT_MANIFEST_INTEGRITY);
  return () =>
    loadActiveContentProjection({
      root: environment.MPX_ACTIVE_CONTENT_ROOT,
      manifestPath: environment.MPX_ACTIVE_CONTENT_MANIFEST,
      expected: { runtime: 'pi', manifestFile: expectedIntegrity },
    });
}

function entriesBySource(active: ActiveProjection, source: 'canonical' | 'project'): SkillEntry[] {
  return active.manifest.skills.filter((entry) => classifyCompiledSkillSource(entry) === source);
}

function canonicalEntries(active: ActiveProjection): SkillEntry[] {
  return entriesBySource(active, 'canonical');
}

function projectEntries(active: ActiveProjection): SkillEntry[] {
  return entriesBySource(active, 'project');
}

function bareProjectIdentity(entry: SkillEntry): string | undefined {
  return entry.identity.startsWith('skill:') ? entry.identity.slice('skill:'.length) : undefined;
}

function metadataLocation(active: ActiveProjection, entry: SkillEntry): string {
  return path.resolve(active.root, ...entry.generatedPath.split('/')).replaceAll('\\', '/');
}

function canonicalMetadata(active: ActiveProjection): string | undefined {
  const visible = canonicalEntries(active).filter(
    ({ exposure }) => exposure === 'full' || exposure === 'name-only',
  );
  if (visible.length === 0) {
    return undefined;
  }
  const lines = [
    'The following canonical MPX skills provide specialized instructions for specific tasks.',
    'Use /mpx:<name> to invoke one. Use the read tool to load the listed file when a task matches.',
    'When a skill references a relative path, resolve it against the skill directory and use that absolute path in tool calls.',
    '',
    '<available_mpx_skills>',
  ];
  for (const entry of visible) {
    lines.push('  <skill>');
    lines.push(`    <name>${escapeXml(`/mpx:${entry.identity}`)}</name>`);
    if (entry.exposure === 'full') {
      lines.push(`    <description>${escapeXml(entry.canonicalDescription)}</description>`);
    }
    lines.push(`    <location>${escapeXml(metadataLocation(active, entry))}</location>`);
    lines.push('  </skill>');
  }
  lines.push('</available_mpx_skills>');
  return lines.join('\n');
}

function completionItems(values: readonly string[], prefix: string) {
  return values
    .filter((value) => value.startsWith(prefix))
    .sort()
    .map((value) => ({ value, label: value }));
}

function normalizedAbsolutePath(value: string): string {
  const normalized = path.resolve(value).replaceAll('\\', '/');
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function representsManagedEntry(
  active: ActiveProjection,
  entry: SkillEntry,
  command: ReturnType<ExtensionAPI['getCommands']>[number],
): boolean {
  return (
    normalizedAbsolutePath(command.sourceInfo.path) ===
    normalizedAbsolutePath(metadataLocation(active, entry))
  );
}

function invocation(
  namespace: 'mpx' | 'skill',
  identity: string,
  skill: Awaited<ReturnType<typeof readActiveSkill>>,
  args: string,
): string {
  const block = `<skill name="${escapeXml(`${namespace}:${identity}`)}" location="${escapeXml(skill.filePath)}">\nReferences are relative to ${escapeXml(skill.baseDirectory)}.\n\n${skill.body}\n</skill>`;
  return args ? `${block}\n\n${args}` : block;
}

export default async function canonicalSkills(
  pi: ExtensionAPI,
  environment: Environment = process.env,
): Promise<void> {
  if (environment.MPX_RUNTIME !== 'pi') {
    return;
  }

  const loadActive = activeLoader(environment);
  const initial = await loadActive();
  let canonicalCompletionNames: string[] = [];
  let nativeProjectCompletionNames: string[] = [];
  let acceptedManagedProjectPaths = new Map<string, string>();
  let acceptedManagedProjectEntries = new Map<string, SkillEntry>();
  const updateCompletionInventory = (active: ActiveProjection) => {
    canonicalCompletionNames = canonicalEntries(active).map((entry) => `/mpx:${entry.identity}`);
    acceptedManagedProjectEntries = new Map(
      projectEntries(active).flatMap((entry) => {
        const identity = bareProjectIdentity(entry);
        const acceptedPath = identity ? acceptedManagedProjectPaths.get(identity) : undefined;
        return identity && acceptedPath === normalizedAbsolutePath(metadataLocation(active, entry))
          ? [[identity, entry] as const]
          : [];
      }),
    );
  };
  const clearCompletionInventory = () => {
    canonicalCompletionNames = [];
    nativeProjectCompletionNames = [];
    acceptedManagedProjectPaths = new Map();
    acceptedManagedProjectEntries = new Map();
  };
  const refreshActive = async () => {
    try {
      const active = await loadActive();
      updateCompletionInventory(active);
      return active;
    } catch (error) {
      clearCompletionInventory();
      throw error;
    }
  };
  updateCompletionInventory(initial);

  const registered = new Set<string>();
  const register = (
    entry: SkillEntry,
    namespace: 'mpx' | 'skill',
    identity: string,
    source: 'canonical' | 'project',
  ) => {
    const commandName = `${namespace}:${identity}`;
    if (registered.has(commandName)) {
      return;
    }
    registered.add(commandName);
    pi.registerCommand(commandName, {
      description: entry.effectiveDescription,
      handler: async (args, context) => {
        const active = await refreshActive();
        if (source === 'project' && !acceptedManagedProjectEntries.has(identity)) {
          throw new Error(
            `Managed project skill /skill:${identity} is not accepted in this session.`,
          );
        }
        const skill = await readActiveSkill(active, identity, source);
        const content = invocation(namespace, identity, skill, args);
        if (context.isIdle()) {
          pi.sendUserMessage(content);
        } else {
          pi.sendUserMessage(content, { deliverAs: 'followUp' });
        }
      },
    });
  };
  for (const entry of canonicalEntries(initial)) {
    register(entry, 'mpx', entry.identity, 'canonical');
  }

  let autocompleteRegistered = false;
  pi.on('session_start', async (_event, context) => {
    try {
      const active = await refreshActive();
      const sessionCommands = pi.getCommands();
      const nativeSkillCommands = sessionCommands.filter((command) => command.source === 'skill');
      nativeProjectCompletionNames = nativeSkillCommands
        .filter(
          (command) => command.sourceInfo.scope === 'project' && command.name.startsWith('skill:'),
        )
        .map((command) => `/${command.name}`);
      const acceptedPaths = new Map<string, string>();
      for (const entry of projectEntries(active)) {
        const identity = bareProjectIdentity(entry);
        if (!identity) {
          continue;
        }
        const commandName = `skill:${identity}`;
        const collision = nativeSkillCommands.find((command) => command.name === commandName);
        if (collision && !representsManagedEntry(active, entry, collision)) {
          continue;
        }
        acceptedPaths.set(identity, normalizedAbsolutePath(metadataLocation(active, entry)));
        if (!collision) {
          register(entry, 'skill', identity, 'project');
        }
      }
      acceptedManagedProjectPaths = acceptedPaths;
      updateCompletionInventory(active);
    } catch {
      clearCompletionInventory();
    }
    if (autocompleteRegistered) {
      return;
    }
    autocompleteRegistered = true;
    context.ui.addAutocompleteProvider((current) => ({
      triggerCharacters: ['/'],
      async getSuggestions(lines, line, column, options) {
        const reference = findSkillReferenceAtCursor(lines, line, column);
        if (!reference) {
          return current.getSuggestions(lines, line, column, options);
        }
        try {
          await refreshActive();
        } catch {
          return { prefix: reference.prefix, items: [] };
        }
        const values =
          reference.namespace === 'mpx'
            ? canonicalCompletionNames
            : [
                ...new Set([
                  ...[...acceptedManagedProjectEntries.keys()].map((name) => `/skill:${name}`),
                  ...nativeProjectCompletionNames,
                ]),
              ];
        return {
          prefix: reference.prefix,
          items: completionItems(values, `/${reference.namespace}:${reference.partial}`),
        };
      },
      applyCompletion(lines, line, column, item, prefix) {
        const reference = findSkillReferenceAtCursor(lines, line, column);
        if (!reference || reference.prefix !== prefix) {
          return current.applyCompletion(lines, line, column, item, prefix);
        }
        const updated = [...lines];
        const currentLine = updated[line] ?? '';
        updated[line] =
          `${currentLine.slice(0, reference.startColumn)}${item.value}${currentLine.slice(reference.endColumn)}`;
        return {
          lines: updated,
          cursorLine: line,
          cursorCol: reference.startColumn + item.value.length,
        };
      },
      shouldTriggerFileCompletion(lines, line, column) {
        return current.shouldTriggerFileCompletion?.(lines, line, column) ?? true;
      },
    }));
  });

  pi.on('input', async (event) => {
    if (event.source === 'extension') {
      return { action: 'continue' };
    }
    const active = await refreshActive();
    const accepted = {
      mpx: new Set(canonicalEntries(active).map((entry) => entry.identity)),
      skill: new Set(acceptedManagedProjectEntries.keys()),
    };
    const references = findSubmittedSkillReferences(event.text, accepted);
    if (references.length === 0) {
      return { action: 'continue' };
    }
    const loaded = new Map<string, Awaited<ReturnType<typeof readActiveSkill>>>();
    for (const reference of references) {
      const key = `${reference.namespace}:${reference.identity}`;
      if (!loaded.has(key)) {
        const source = reference.namespace === 'mpx' ? 'canonical' : 'project';
        loaded.set(key, await readActiveSkill(active, reference.identity, source));
      }
    }
    let text = event.text;
    for (const reference of references.toReversed()) {
      const skill = loaded.get(`${reference.namespace}:${reference.identity}`)!;
      text = `${text.slice(0, reference.start)}${invocation(reference.namespace, reference.identity, skill, '')}${text.slice(reference.end)}`;
    }
    return { action: 'transform', text };
  });

  pi.on('before_agent_start', async (event) => {
    const active = await refreshActive();
    const metadata = canonicalMetadata(active);
    return metadata ? { systemPrompt: `${event.systemPrompt}\n\n${metadata}` } : undefined;
  });
}
