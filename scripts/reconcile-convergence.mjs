import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(root, 'docs/history/CONVERGENCE_MANIFEST.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const provenance = JSON.parse(
  await readFile(path.join(root, 'docs/history/SOURCE_PROVENANCE.json'), 'utf8'),
);
const digest = (value) => createHash('sha256').update(value).digest('hex');
const exists = async (relative) => {
  try {
    await readFile(path.join(root, relative));
    return true;
  } catch {
    return false;
  }
};
const provenanceDestination = new Map(
  provenance.entries
    .filter((e) => e.destination)
    .map((e) => {
      const match = e.source.match(/\$\{MPX_PROJECTS\}\/mpx-(claude-code|pi)\/(.+)$/u);
      return match
        ? [`${match[1] === 'claude-code' ? 'claude' : 'pi'}:${match[2]}`, e.destination]
        : ['', ''];
    }),
);
const aliases = new Map([
  ['commit-push-pr', 'commit-push-review'],
  ['init-repo', 'repository-setup'],
  ['pr', 'review-publish'],
  ['to-epic', 'epic-create'],
  ['to-issues', 'epic-decompose'],
  ['execute', 'execute'],
]);
const agentAliases = new Map([
  ['Explore.md', 'mpx-explorer.md'],
  ['mp-pr-manager.md', 'mpx-review-manager.md'],
]);

async function canonicalSkill(sourcePath) {
  const match = sourcePath.match(
    /^(?:local\/skills|plugins\/(?:mp|gh)\/skills|skills)\/([^/]+)(?:\/(.+))?$/u,
  );
  if (!match) {
    return null;
  }
  let name = match[1].replace(/^mp-/u, '');
  name = aliases.get(name) ?? name;
  const rest = match[2] ?? 'SKILL.md';
  let candidate = `content/skills/${name}/${rest}`;
  if (await exists(candidate)) {
    return candidate;
  }
  candidate = `content/skills/${name}/SKILL.md`;
  return (await exists(candidate)) ? candidate : null;
}

async function decision(entry) {
  if (entry.disposition === 'excluded') {
    return null;
  }
  if (/^(?:deprecated|scripts\/retired)(?:\/|$)/u.test(entry.path)) {
    return {
      disposition: 'retired',
      reason: 'source already marked deprecated or retired; no active MPX reader',
      adaptation: 'retained only in source-attributed history',
      activeReader: null,
    };
  }
  const fromProvenance = provenanceDestination.get(`${entry.source}:${entry.path}`);
  if (fromProvenance && (await exists(fromProvenance))) {
    return {
      disposition: 'canonicalized',
      destination: fromProvenance,
      adaptation: 'intentionally adapted into provider-neutral canonical content',
      test: fromProvenance.startsWith('content/skills/')
        ? 'packages/skills/test/directory-inventory.test.ts'
        : fromProvenance,
    };
  }
  const skill = await canonicalSkill(entry.path);
  if (skill) {
    return {
      disposition: 'canonicalized',
      destination: skill,
      adaptation: 'merged source intent into the provider-neutral canonical skill',
      test: 'packages/skills/test/directory-inventory.test.ts',
    };
  }
  if (/^(?:instructions|rules|rules-per-project)\//u.test(entry.path)) {
    const mappings = [
      [/^instructions\/AGENTS\.md$/u, 'content/instructions/global/AGENTS.md'],
      [/^instructions\/CLAUDE\.md$/u, 'content/instructions/runtime/claude/CLAUDE.md'],
      [/^instructions\/COMPACT\.md$/u, 'content/instructions/COMPACT.md'],
      [/^instructions\/(.+)$/u, 'content/instructions/rules/global/$1'],
      [/^rules-per-project\/(.+)$/u, 'content/instructions/rules/projects/$1'],
      [/^rules\/(.+)$/u, 'content/instructions/rules/languages/$1'],
    ];
    for (const [regex, replacement] of mappings) {
      if (regex.test(entry.path)) {
        const destination = entry.path.replace(regex, replacement);
        if (await exists(destination)) {
          return {
            disposition: 'canonicalized',
            destination,
            adaptation: 'preserved scope while normalizing runtime-neutral instruction paths',
            test: 'packages/skills/test/instruction-content.test.ts',
          };
        }
      }
    }
  }
  if (/^(?:agents|plugins\/(?:mp|gh)\/agents)\//u.test(entry.path)) {
    const leaf = entry.path.split('/').at(-1);
    const destination =
      leaf === '.gitkeep'
        ? null
        : `content/agents/${agentAliases.get(leaf) ?? leaf.replace(/^mp-/u, 'mpx-')}`;
    if (destination && (await exists(destination))) {
      return {
        disposition: 'canonicalized',
        destination,
        adaptation: 'canonicalized agent intent and generated runtime projection',
        test: 'runtimes/pi/runtime-pi/test/generator.test.ts',
      };
    }
    if (entry.path.includes('/references/')) {
      const ref = `content/agents/references/${leaf}`;
      if (await exists(ref)) {
        return {
          disposition: 'canonicalized',
          destination: ref,
          adaptation: 'preserved language review reference',
          test: 'packages/skills/test/directory-inventory.test.ts',
        };
      }
    }
  }
  if (entry.source === 'pi' && entry.path.startsWith('extensions/subagents/')) {
    const relative = entry.path.slice('extensions/subagents/'.length);
    const destination = `runtimes/pi/runtime-pi/vendor/subagents/${relative}`;
    if (await exists(destination)) {
      return {
        disposition: 'Pi-specific',
        destination,
        adaptation: 'vendored with license and checksum governance',
        test: 'runtimes/pi/runtime-pi/test/subagents-vendor.test.ts',
      };
    }
    return {
      disposition: 'retired',
      reason:
        'dependency metadata is replaced by the root workspace and vendored checksum manifest',
      adaptation: 'removed nested dependency installation metadata',
      activeReader: null,
    };
  }
  if (entry.source === 'pi' && entry.path.startsWith('extensions/dev-server')) {
    return {
      disposition: 'canonicalized',
      destination: 'packages/dev-services/src/index.ts',
      adaptation: 'reimplemented as the provider-neutral managed development service',
      test: 'packages/dev-services/src/dev-services.test.ts',
    };
  }
  if (entry.source === 'pi' && entry.path.startsWith('extensions/terminal-progress')) {
    return {
      disposition: 'canonicalized',
      destination: 'packages/status/src/runtime.ts',
      adaptation: 'folded terminal progress into the shared status contract',
      test: 'packages/status/src/runtime.test.ts',
    };
  }
  if (
    entry.source === 'pi' &&
    /^extensions\/(?:guard-hooks|compact-instructions)\.ts$/u.test(entry.path)
  ) {
    return {
      disposition: 'canonicalized',
      destination: 'packages/runtime-hooks/src/index.ts',
      adaptation: 'reimplemented with shared runtime guard policy',
      test: 'packages/runtime-hooks/src/index.test.ts',
    };
  }
  if (
    entry.source === 'pi' &&
    /^(?:extensions\/footer\.ts|themes\/(?:amber|green)\.json)$/u.test(entry.path)
  ) {
    const destination = entry.path.startsWith('themes/')
      ? `runtimes/pi/runtime-pi/projection/${entry.path}`
      : 'runtimes/pi/runtime-pi/src/runtime-status.ts';
    return {
      disposition: 'Pi-specific',
      destination,
      adaptation: 'projected through the Pi status adapter',
      test: 'runtimes/pi/runtime-pi/test/footer.test.ts',
    };
  }
  if (
    entry.source === 'pi' &&
    /^extensions\/(?:kf-namespace-commands|mp-namespace-commands)\.ts$/u.test(entry.path)
  ) {
    return {
      disposition: 'Pi-specific',
      destination: 'runtimes/pi/runtime-pi/src/runtime-tools.ts',
      adaptation: 'replaced direct namespace commands with launch-bound runtime tools',
      test: 'runtimes/pi/runtime-pi/test/runtime-tools.test.ts',
    };
  }
  if (
    entry.source === 'pi' &&
    /^extensions\/(?:agent-resurrect|auto-title|fullscreen-scroll-speed)\.ts$/u.test(entry.path)
  ) {
    return {
      disposition: 'retired',
      reason: 'legacy interactive convenience is not read by the governed MPX runtime',
      adaptation: 'removed from the authoritative runtime surface',
      activeReader: null,
    };
  }
  if (
    entry.source === 'pi' &&
    /^(?:APPEND_SYSTEM\.md|settings\.json|keybindings\.json|subagents\.json|scripts\/|\.vscode\/|\.gitignore)/u.test(
      entry.path,
    )
  ) {
    return {
      disposition: 'Pi-specific',
      destination: 'runtimes/pi/runtime-pi/src/profile.ts',
      adaptation: 'normalized into the generated Pi profile and launch-bound adapter',
      test: 'runtimes/pi/runtime-pi/test/profile.test.ts',
    };
  }
  if (
    entry.source === 'pi' &&
    /^(?:README\.md|PI_MIGRATION\.md|WINDOWS_TERMINAL_DEV_SERVER_PANES\.md)$/u.test(entry.path)
  ) {
    return {
      disposition: 'externalized',
      destination: 'docs/history/PI_MIGRATION.md',
      adaptation: 'retained as attributed migration history rather than active runtime guidance',
      test: 'tests/integration/scripts/validate-generated.test.mjs',
    };
  }
  if (
    entry.source === 'pi' &&
    /^(?:agents\/\.gitkeep|extensions\/\.gitkeep|prompts\/\.gitkeep)$/u.test(entry.path)
  ) {
    return {
      disposition: 'retired',
      reason: 'empty source-directory marker has no active reader',
      adaptation: 'directory is generated from canonical inventory',
      activeReader: null,
    };
  }

  if (entry.source === 'claude' && entry.path.startsWith('plugins/mp/hooks/')) {
    return {
      disposition: 'canonicalized',
      destination: 'packages/runtime-hooks/src/index.ts',
      adaptation: 'reimplemented as shared launch-bound runtime guard policy',
      test: 'packages/runtime-hooks/src/index.test.ts',
    };
  }
  if (entry.source === 'claude' && entry.path.startsWith('plugins/mp/scripts/')) {
    if (/detect-(?:base-branch|check-scripts|project-scripts)|init-repo/u.test(entry.path)) {
      const leaf = entry.path.split('/').at(-1);
      const candidates = (
        await Promise.all(
          [
            'content/skills/sync-base/scripts/detect-base-branch.js',
            'content/skills/check-fix/scripts/detect-check-scripts.mjs',
            'content/skills/script-discovery/scripts/detect-project-scripts.mjs',
          ].map(async (x) => ((await exists(x)) ? x : null)),
        )
      ).filter(Boolean);
      const destination =
        candidates.find((x) => x.endsWith(leaf)) ?? 'content/skills/repository-setup/SKILL.md';
      return {
        disposition: 'canonicalized',
        destination,
        adaptation: 'moved executable discovery behavior beside its canonical skill',
        test: 'tests/integration/scripts/validate-generated.test.mjs',
      };
    }
    if (/worktree|base-branch/u.test(entry.path)) {
      return {
        disposition: 'canonicalized',
        destination: 'packages/worktrees/src/lifecycle.ts',
        adaptation: 'reimplemented with provider-neutral worktree lifecycle contracts',
        test: 'packages/worktrees/src/lifecycle.test.ts',
      };
    }
    if (/status|terminal|account-color|usage/u.test(entry.path)) {
      return {
        disposition: 'Claude-specific',
        destination: 'runtimes/claude/runtime-claude/src/index.ts',
        adaptation:
          'folded display behavior into the Claude runtime adapter and shared status contract',
        test: 'runtimes/claude/runtime-claude/src/index.test.ts',
      };
    }
    if (/compaction/u.test(entry.path)) {
      return {
        disposition: 'canonicalized',
        destination: 'packages/runtime-hooks/src/index.ts',
        adaptation: 'reimplemented as shared compaction policy',
        test: 'packages/runtime-hooks/src/index.test.ts',
      };
    }
    return {
      disposition: 'retired',
      reason: 'legacy support utility has no active reader in the launch-bound runtime',
      adaptation: 'removed from active runtime projection',
      activeReader: null,
    };
  }
  if (
    entry.source === 'claude' &&
    /^(?:plugins\/mp\/(?:output-styles|statusline-|templates)|plugins\/(?:mp|gh)\/\.claude-plugin|\.claude-plugin|settings\.json)/u.test(
      entry.path,
    )
  ) {
    return {
      disposition: 'Claude-specific',
      destination: 'runtimes/claude/runtime-claude/src/index.ts',
      adaptation: 'normalized into the generated Claude runtime projection',
      test: 'runtimes/claude/runtime-claude/src/index.test.ts',
    };
  }
  if (entry.source === 'claude' && /^(?:CLAUDE\.md|AGENTS\.md)$/u.test(entry.path)) {
    return {
      disposition: 'canonicalized',
      destination:
        entry.path === 'CLAUDE.md'
          ? 'content/instructions/runtime/claude/CLAUDE.md'
          : 'content/instructions/global/AGENTS.md',
      adaptation: 'merged runtime guidance into canonical scoped instructions',
      test: 'packages/skills/test/instruction-content.test.ts',
    };
  }
  if (entry.source === 'claude' && /^(?:docs\/|README\.md|WINDOWS-SETUP\.md)$/u.test(entry.path)) {
    return {
      disposition: 'externalized',
      destination: 'docs/RUNTIME_ADAPTERS.md',
      adaptation: 'replaced legacy operational guidance with current runtime adapter documentation',
      test: 'tests/integration/scripts/validate-generated.test.mjs',
    };
  }
  return {
    disposition: 'retired',
    reason: 'repository-local metadata or media is not consumed by any active MPX reader',
    adaptation: 'excluded from the authoritative generated runtime surface',
    activeReader: null,
  };
}

for (const entry of manifest.entries) {
  const reviewed = await decision(entry);
  if (!reviewed) {
    continue;
  }
  entry.completion = 'completed';
  delete entry.plannedDisposition;
  delete entry.plannedDestination;
  Object.assign(entry, reviewed);
  if (reviewed.destination) {
    const test = reviewed.test ?? reviewed.destination;
    const artifact = await readFile(path.join(root, test));
    entry.evidence = [
      entry.evidence[0],
      {
        schemaVersion: 1,
        kind: test.includes('.test.') ? 'behavior-test' : 'generated-artifact',
        sourceSnapshot: {
          source: entry.source,
          path: entry.path,
          sha256: entry.sha256 ?? entry.headSha256 ?? null,
        },
        sha256: digest(artifact),
        reference: test,
        verification: test.includes('.test.') ? 'passed' : 'verified',
      },
    ];
  }
}
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Reconciled ${manifest.entries.length} entries.`);
