import path from 'node:path';

import {
  classifyCompiledSkillSource,
  loadActiveContentProjection,
  readActiveSkill,
} from '@mpx/content-compiler/active';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

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

function canonicalEntries(active: ActiveProjection): SkillEntry[] {
  return active.manifest.skills.filter(
    (entry) => classifyCompiledSkillSource(entry) === 'canonical',
  );
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

function invocation(
  identity: string,
  skill: Awaited<ReturnType<typeof readActiveSkill>>,
  args: string,
): string {
  const block = `<skill name="${escapeXml(`mpx:${identity}`)}" location="${escapeXml(skill.filePath)}">\nReferences are relative to ${escapeXml(skill.baseDirectory)}.\n\n${skill.body}\n</skill>`;
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
  const registered = new Set<string>();
  for (const entry of canonicalEntries(initial)) {
    if (registered.has(entry.identity)) {
      continue;
    }
    registered.add(entry.identity);
    pi.registerCommand(`mpx:${entry.identity}`, {
      description: entry.effectiveDescription,
      handler: async (args, context) => {
        const active = await loadActive();
        const skill = await readActiveSkill(active, entry.identity);
        const content = invocation(entry.identity, skill, args);
        if (context.isIdle()) {
          pi.sendUserMessage(content);
        } else {
          pi.sendUserMessage(content, { deliverAs: 'followUp' });
        }
      },
    });
  }

  pi.on('before_agent_start', async (event) => {
    const active = await loadActive();
    const metadata = canonicalMetadata(active);
    return metadata ? { systemPrompt: `${event.systemPrompt}\n\n${metadata}` } : undefined;
  });
}
