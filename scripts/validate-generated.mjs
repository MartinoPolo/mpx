import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstat, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildConvergenceManifest,
  compareConvergenceManifests,
  validateConvergenceManifest,
} from './convergence-manifest.mjs';

const TEXT =
  /(?:\.(?:c?js|mjs|ts|tsx|json|md|html|ya?ml|toml|ps1|bash|sh|py|txt)|(?:^|\/)LICENSE)$/iu;
const LOCKFILE =
  /(?:^|\/)(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|bun\.lockb?|pnpm-lock\.yaml)$/iu;
const PRIVATE_STATE =
  /(?:^|\/)(?:\.env(?:\..+)?|(?:credentials?|sessions?|runtime-state|runtime-status)(?:\.(?:json|ya?ml|toml))?)$/iu;
const ACTIVE_ROOT = /^(?:apps|content|packages|runtimes|scripts)\//u;
const IMPORTED = new Set(['imported-rewritten', 'imported-non-normative-history']);
const DISPOSITIONS = new Set([...IMPORTED, 'deferred-inventory-only', 'excluded']);
const CONFIGURED_PATH_MARKER = ['<configured', 'path>'].join('-');
const ACTIVE_COMPATIBILITY_DOCS = new Set([
  'docs/LAUNCH.md',
  'docs/RUNTIME_ADAPTERS.md',
  'MPX_MIGRATION.md',
  'runtimes/claude/runtime-claude/COMPATIBILITY.md',
]);
// Ordinary text validation is intentionally bounded to 1 MiB per file. The generated,
// tracked CLI bundle has its own narrow bound because bundling legitimately exceeds it.
export const MAX_TEXT_FILE_BYTES = 1024 * 1024;
export const MAX_GENERATED_CLI_BUNDLE_BYTES = 2 * 1024 * 1024;
const GENERATED_CLI_BUNDLES = new Set(['bin/mpx.mjs', 'bin/claude-gateway.js']);
export const FILE_READ_CONCURRENCY = 8;

const diagnostic = (code, file, message) => ({ code, file, message });
const digest = (value) => createHash('sha256').update(value).digest('hex');
const normalized = (value) => value.replaceAll('\\', '/');

function isHistorical(file) {
  return file.startsWith('docs/history/');
}

function permitsClaudeVariable(file) {
  return file.startsWith('runtimes/claude/runtime-claude/');
}

export function validateFiles(files, options = {}) {
  const diagnostics = [];
  for (const name of options.generatedPiDiagnostics ?? []) {
    diagnostics.push(
      diagnostic(
        'GENERATED_PI_DRIFT',
        `runtimes/pi/runtime-pi/projection/agents/${name}`,
        'generated Pi agent does not match canonical content',
      ),
    );
  }

  const tracked = new Set(options.trackedFiles ?? files.keys());
  for (const file of tracked) {
    const portable = normalized(file);
    if (LOCKFILE.test(portable) && portable !== 'pnpm-lock.yaml') {
      diagnostics.push(
        diagnostic('NESTED_LOCKFILE', portable, 'only the root pnpm-lock.yaml is permitted'),
      );
    }
    if (PRIVATE_STATE.test(portable)) {
      diagnostics.push(
        diagnostic(
          'TRACKED_PRIVATE_STATE',
          portable,
          'credential, session, environment, and runtime-state files must not be tracked',
        ),
      );
    }
  }

  for (const [rawFile, value] of files) {
    const file = normalized(rawFile);
    const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
    const markerExempt = isHistorical(file) || /(?:^|\/)(?:dist|node_modules)(?:\/|$)/u.test(file);
    if (!markerExempt && text.includes(CONFIGURED_PATH_MARKER)) {
      diagnostics.push(
        diagnostic(
          'CONFIGURED_PATH_MARKER',
          file,
          'active content contains the configured-path corruption marker',
        ),
      );
    }
    if (ACTIVE_COMPATIBILITY_DOCS.has(file)) {
      if (
        /PostToolUse[^\n]*(?:revalidat|integrity|checkpoint|guard)|(?:revalidat|integrity|checkpoint|guard)[^\n]*PostToolUse/iu.test(
          text,
        )
      ) {
        diagnostics.push(
          diagnostic(
            'STALE_CLAUDE_POST_TOOL_CHECKPOINT',
            file,
            'Claude integrity checkpoints do not include PostToolUse',
          ),
        );
      }
      const staleFullStatusClaim = text
        .split(/\r?\n/u)
        .some(
          (line) =>
            !/(?:does|do) not|doesn't/iu.test(line) &&
            /(?:status(?:-line| adapter| command)?[^\n]*(?:revalidat|validat)[^\n]*(?:full|whole|entire) (?:published )?projection)|(?:(?:full|whole|entire) (?:published )?projection[^\n]*(?:revalidat|validat)[^\n]*status)/iu.test(
              line,
            ),
        );
      if (staleFullStatusClaim) {
        diagnostics.push(
          diagnostic(
            'STALE_CLAUDE_FULL_STATUS_REVALIDATION',
            file,
            'Claude status validates live StatusSnapshotV1, not the full projection',
          ),
        );
      }
    }
    if (isHistorical(file) || file.endsWith('.test.mjs') || !ACTIVE_ROOT.test(file)) {
      continue;
    }
    if (
      /^content\/.*\.md$/u.test(file) &&
      /(?:\u00e2\u20ac|\u00e2\u2020|\u00c2\u00a7|\uFFFD)/u.test(text)
    ) {
      diagnostics.push(
        diagnostic(
          'MOJIBAKE',
          file,
          'canonical content contains a known encoding-corruption signature',
        ),
      );
    }
    if (/\/(?:mp|mp-gh|kf):[a-z0-9]/iu.test(text)) {
      diagnostics.push(
        diagnostic('LEGACY_PUBLIC_IDENTITY', file, 'active public identities must use /mpx:'),
      );
    }
    if (/\/mpx:mpx-[a-z0-9]/iu.test(text)) {
      diagnostics.push(
        diagnostic(
          'DOUBLED_MPX_IDENTITY',
          file,
          'canonical identities must not repeat the mpx prefix',
        ),
      );
    }
    if (
      /(?:[A-Za-z]:[\\/](?:_MP_projects[\\/])?|\/(?:[A-Za-z][\\/])?_MP_projects[\\/])mpx-(?:claude-code|pi)(?:[\\/]|$)/iu.test(
        text,
      )
    ) {
      diagnostics.push(
        diagnostic(
          'LEGACY_SOURCE_PATH',
          file,
          'active files must not embed absolute legacy source-repository paths',
        ),
      );
    }
    if (
      /(?:import|from|require|readFile|open)[^\n]{0,160}(?:['"`](?:\.\.\/)+(?:mpx-(?:claude-code|pi))\/|['"`](?:~\/)?\.codex\/|['"`](?:mpx-(?:claude-code|pi))\/)/iu.test(
        text,
      )
    ) {
      diagnostics.push(
        diagnostic(
          'LEGACY_SOURCE_DEPENDENCY',
          file,
          'active files must not import or read legacy runtime roots',
        ),
      );
    }
    if (
      file.startsWith('content/') &&
      /\$\{?CLAUDE_[A-Z0-9_]+\}?/u.test(text) &&
      !permitsClaudeVariable(file)
    ) {
      diagnostics.push(
        diagnostic('CLAUDE_PLACEHOLDER', file, 'canonical content must be runtime-neutral'),
      );
    }
    if (
      file.startsWith('content/instructions/shared/') &&
      (/`(?:gh|glab|kf)\s+(?:issue|pr|mr|label|task|comment|auth)\b/iu.test(text) ||
        /(?:^|[\s`'"(])(?:plugins\/mp|mpx-(?:claude-code|pi)\/|~\/\.(?:claude|codex)\/)/imu.test(
          text,
        ) ||
        /\$\{?CLAUDE_[A-Z0-9_]+\}?/u.test(text))
    ) {
      diagnostics.push(
        diagnostic(
          'SHARED_INSTRUCTION_LEGACY_REFERENCE',
          file,
          'shared instructions must use MPX contracts and runtime-neutral paths and placeholders',
        ),
      );
    }
    if (
      file.startsWith('runtimes/') &&
      /(?:status-map\.json|mp\.config\.json|legacy[-_. ]?(?:status|config))/iu.test(text)
    ) {
      diagnostics.push(
        diagnostic(
          'LEGACY_RUNTIME_READER',
          file,
          'active runtimes must consume current contracts only',
        ),
      );
    }
  }
  return diagnostics;
}

export function validateSharedInstructionLinks(files) {
  const diagnostics = [];
  const sharedRoot = 'content/instructions/shared/';
  const names = new Set([...files.keys()].map(normalized));
  for (const [rawFile, value] of files) {
    const file = normalized(rawFile);
    if (!file.startsWith(sharedRoot) || !file.endsWith('.md')) {
      continue;
    }
    const text = Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
    for (const match of text.matchAll(/\[[^\]]*\]\(([^)]+)\)/gu)) {
      const href = match[1].trim().split(/\s+/u, 1)[0].replace(/^<|>$/gu, '');
      if (!href || href.startsWith('#') || /^[a-z][a-z0-9+.-]*:/iu.test(href)) {
        continue;
      }
      let target;
      try {
        target = decodeURIComponent(href.split('#', 1)[0]);
      } catch {
        diagnostics.push(
          diagnostic(
            'SHARED_INSTRUCTION_LINK_MISSING',
            file,
            `relative link target is invalid: ${href}`,
          ),
        );
        continue;
      }
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(file), target));
      if (!names.has(resolved)) {
        diagnostics.push(
          diagnostic(
            'SHARED_INSTRUCTION_LINK_MISSING',
            file,
            `relative link target is absent: ${href}`,
          ),
        );
      }
    }
  }
  return diagnostics;
}

function expandSource(source, roots) {
  return source.replace(/^\$\{([A-Z0-9_]+)\}/u, (_, name) => roots[name] ?? `\${${name}}`);
}

export async function validateProvenance({
  rootFiles,
  manifest,
  roots,
  readSource,
  verifySources = false,
  destinationAttributes,
}) {
  const diagnostics = [];
  for (const [index, entry] of (manifest.entries ?? []).entries()) {
    const label = entry.destination ?? entry.source ?? `entry ${index}`;
    if (!DISPOSITIONS.has(entry.disposition)) {
      diagnostics.push(
        diagnostic(
          'PROVENANCE_DISPOSITION_INVALID',
          label,
          `unknown disposition '${entry.disposition}'`,
        ),
      );
    }
    if (IMPORTED.has(entry.disposition)) {
      if (
        !/^[a-f0-9]{64}$/u.test(entry.originalSha256 ?? '') ||
        !/^[a-f0-9]{64}$/u.test(entry.destinationSha256 ?? '')
      ) {
        diagnostics.push(
          diagnostic(
            'PROVENANCE_HASH_MISSING',
            label,
            'imported entries require source and destination SHA-256 values',
          ),
        );
      }
      const destinationName = entry.destination ? normalized(entry.destination) : undefined;
      const destination = destinationName ? rootFiles.get(destinationName) : undefined;
      if (destination === undefined) {
        diagnostics.push(
          diagnostic('PROVENANCE_DESTINATION_MISSING', label, 'provenance destination is absent'),
        );
      } else {
        if (destinationAttributes && TEXT.test(destinationName)) {
          const attributes = destinationAttributes.get(destinationName);
          if (
            !attributes ||
            !['auto', 'set'].includes(attributes.text) ||
            attributes.eol !== 'lf'
          ) {
            diagnostics.push(
              diagnostic(
                'PROVENANCE_DESTINATION_ATTRIBUTE_MISSING',
                label,
                'provenance-managed text requires repository Git attributes enforcing LF',
              ),
            );
          }
          if (Buffer.from(destination).includes(Buffer.from('\r\n'))) {
            diagnostics.push(
              diagnostic(
                'PROVENANCE_DESTINATION_NOT_LF',
                label,
                'provenance-managed text contains CRLF bytes',
              ),
            );
          }
        }
        if (digest(destination) !== entry.destinationSha256) {
          diagnostics.push(
            diagnostic(
              'PROVENANCE_DESTINATION_HASH_MISMATCH',
              label,
              'destination no longer matches its recorded SHA-256',
            ),
          );
        }
      }
      if (verifySources) {
        const sourcePath = expandSource(entry.source ?? '', roots);
        const source = await readSource(sourcePath);
        if (source === undefined) {
          diagnostics.push(
            diagnostic('PROVENANCE_SOURCE_MISSING', label, 'provenance source is absent'),
          );
        } else if (digest(source) !== entry.originalSha256) {
          diagnostics.push(
            diagnostic(
              'PROVENANCE_SOURCE_HASH_MISMATCH',
              label,
              'source no longer matches its recorded SHA-256',
            ),
          );
        }
      }
    } else if (
      (entry.disposition === 'excluded' || entry.disposition === 'deferred-inventory-only') &&
      (entry.destination !== null || entry.destinationSha256 !== null)
    ) {
      diagnostics.push(
        diagnostic(
          'PROVENANCE_DISPOSITION_INVALID',
          label,
          'non-imported dispositions cannot claim a destination',
        ),
      );
    }
  }
  return diagnostics;
}

function parseProvenanceManifest(value, file = 'docs/history/SOURCE_PROVENANCE.json') {
  if (value === undefined) {
    return {
      manifest: null,
      diagnostics: [
        diagnostic('PROVENANCE_MANIFEST_MISSING', file, 'source provenance manifest is required'),
      ],
    };
  }
  let manifest;
  try {
    manifest = JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : String(value));
  } catch {
    return {
      manifest: null,
      diagnostics: [
        diagnostic(
          'PROVENANCE_MANIFEST_INVALID',
          file,
          'source provenance manifest is not valid JSON',
        ),
      ],
    };
  }
  const validEntry = (entry) =>
    entry !== null &&
    typeof entry === 'object' &&
    !Array.isArray(entry) &&
    typeof entry.source === 'string' &&
    (entry.destination === null || typeof entry.destination === 'string') &&
    typeof entry.disposition === 'string' &&
    (entry.originalSha256 === null || typeof entry.originalSha256 === 'string') &&
    (entry.destinationSha256 === null || typeof entry.destinationSha256 === 'string');
  if (
    manifest === null ||
    typeof manifest !== 'object' ||
    Array.isArray(manifest) ||
    manifest.schemaVersion !== 1 ||
    !Array.isArray(manifest.entries) ||
    !manifest.entries.every(validEntry) ||
    (manifest.symbolicRoots !== undefined &&
      (manifest.symbolicRoots === null ||
        typeof manifest.symbolicRoots !== 'object' ||
        Array.isArray(manifest.symbolicRoots)))
  ) {
    return {
      manifest: null,
      diagnostics: [
        diagnostic(
          'PROVENANCE_MANIFEST_INVALID',
          file,
          'source provenance manifest must use schemaVersion 1 with structurally valid entries[] and optional symbolicRoots{}',
        ),
      ],
    };
  }
  return { manifest, diagnostics: [] };
}

export function validateCanonicalScriptSyntax(root, names) {
  const diagnostics = [];
  for (const rawName of names) {
    const file = normalized(rawName);
    if (!/^content\/.*\.(?:[cm]?js)$/iu.test(file)) {
      continue;
    }
    const result = spawnSync(process.execPath, ['--check', path.join(root, file)], {
      cwd: root,
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      const detail =
        result.stderr?.trim() ||
        result.stdout?.trim() ||
        result.error?.message ||
        'Node syntax check failed';
      diagnostics.push(diagnostic('CANONICAL_SCRIPT_SYNTAX', file, detail));
    }
  }
  return diagnostics;
}

export function validateConvergenceArtifacts(manifest, files) {
  const diagnostics = [];
  for (const entry of manifest?.entries ?? []) {
    if (entry.completion === 'reviewed' && entry.phase === 'Phase I') {
      continue;
    }
    if (
      !['canonicalized', 'Claude-specific', 'Pi-specific', 'externalized'].includes(
        entry.disposition,
      )
    ) {
      continue;
    }
    if (!files.has(entry.destination)) {
      diagnostics.push(
        diagnostic(
          'CONVERGENCE_DESTINATION_MISSING',
          `${entry.source}:${entry.path}`,
          `destination is absent: ${entry.destination}`,
        ),
      );
      continue;
    }
    for (const evidence of entry.evidence ?? []) {
      if (!['behavior-test', 'generated-artifact'].includes(evidence.kind)) {
        continue;
      }
      const artifact = files.get(evidence.reference);
      if (artifact === undefined) {
        diagnostics.push(
          diagnostic(
            'CONVERGENCE_ARTIFACT_MISSING',
            `${entry.source}:${entry.path}`,
            `evidence artifact is absent: ${evidence.reference}`,
          ),
        );
      } else if (digest(artifact) !== evidence.sha256) {
        diagnostics.push(
          diagnostic(
            'CONVERGENCE_ARTIFACT_HASH_MISMATCH',
            `${entry.source}:${entry.path}`,
            `evidence artifact hash does not match: ${evidence.reference}`,
          ),
        );
      }
    }
  }
  return diagnostics;
}

export async function validateGeneratedRepository({
  root: _root,
  names: _names,
  tracked,
  files,
  generatedPiDiagnostics = [],
  readSource,
  verifySources = false,
  destinationAttributes,
}) {
  const diagnostics = [
    ...validateFiles(files, { trackedFiles: tracked, generatedPiDiagnostics }),
    ...validateSharedInstructionLinks(files),
  ];
  const provenanceFile = 'docs/history/SOURCE_PROVENANCE.json';
  const parsed = parseProvenanceManifest(files.get(provenanceFile), provenanceFile);
  diagnostics.push(...parsed.diagnostics);
  if (parsed.manifest) {
    diagnostics.push(
      ...(await validateProvenance({
        rootFiles: files,
        manifest: parsed.manifest,
        roots: Object.fromEntries(
          Object.keys(parsed.manifest.symbolicRoots ?? {}).map((name) => [name, process.env[name]]),
        ),
        readSource,
        verifySources,
        destinationAttributes,
      })),
    );
  }
  return diagnostics;
}

function repositoryAttributes(root, names) {
  const output = execFileSync(
    'git',
    ['-c', 'core.attributesFile=', 'check-attr', '-z', '--stdin', 'text', 'eol'],
    {
      cwd: root,
      env: { ...process.env, GIT_ATTR_NOSYSTEM: '1' },
      input: `${names.join('\0')}\0`,
    },
  )
    .toString('utf8')
    .split('\0');
  const result = new Map();
  for (let index = 0; index + 2 < output.length; index += 3) {
    const [file, attribute, value] = output.slice(index, index + 3);
    const attributes = result.get(file) ?? {};
    attributes[attribute] = value;
    result.set(file, attributes);
  }
  return result;
}

export async function repositoryFiles(root, names, options = {}) {
  const result = new Map();
  const textualNames = names.filter((name) => TEXT.test(name));
  const outcomes = Array.from({ length: textualNames.length });
  const statPath = options.lstat ?? lstat;
  const openFile = options.open ?? open;
  const configuredMaxFileBytes = options.maxFileBytes;
  const trackedFiles = new Set((options.trackedFiles ?? []).map(normalized));
  const maxBytesFor = (file) =>
    configuredMaxFileBytes ??
    (GENERATED_CLI_BUNDLES.has(file) && trackedFiles.has(file)
      ? MAX_GENERATED_CLI_BUNDLE_BYTES
      : MAX_TEXT_FILE_BYTES);
  const concurrency = Math.min(
    FILE_READ_CONCURRENCY,
    Math.max(1, Math.floor(options.concurrency ?? FILE_READ_CONCURRENCY)),
  );
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < textualNames.length) {
      const index = nextIndex++;
      const name = textualNames[index];
      const file = normalized(name);
      let handle;
      try {
        const filePath = path.join(root, name);
        const maxFileBytes = maxBytesFor(file);
        handle = await openFile(filePath, 'r');
        const stats = await handle.stat();
        if (!stats.isFile() || !Number.isSafeInteger(stats.size) || stats.size < 0) {
          outcomes[index] = {
            error: diagnostic(
              'FILE_READ_FAILED',
              file,
              'enumerated textual file is not a regular non-symlink file',
            ),
          };
        } else if (stats.size > maxFileBytes) {
          outcomes[index] = {
            error: diagnostic(
              'FILE_TOO_LARGE',
              file,
              `enumerated textual file exceeds the ${maxFileBytes}-byte limit`,
            ),
          };
        } else {
          const value = Buffer.alloc(stats.size);
          let offset = 0;
          while (offset < value.length) {
            const { bytesRead } = await handle.read(value, offset, value.length - offset, offset);
            if (bytesRead === 0) {
              throw new Error('file shrank during read');
            }
            offset += bytesRead;
          }
          const probe = Buffer.alloc(1);
          if ((await handle.read(probe, 0, 1, stats.size)).bytesRead !== 0) {
            throw new Error('file grew during read');
          }
          const pathStats = await statPath(filePath);
          if (
            !pathStats.isFile() ||
            pathStats.isSymbolicLink() ||
            String(pathStats.dev) !== String(stats.dev) ||
            String(pathStats.ino) !== String(stats.ino) ||
            pathStats.size !== stats.size
          ) {
            throw new Error('file identity changed during read');
          }
          outcomes[index] = { file, value };
        }
      } catch {
        outcomes[index] = {
          error: diagnostic('FILE_READ_FAILED', file, 'enumerated textual file could not be read'),
        };
      } finally {
        if (handle) {
          try {
            await handle.close();
          } catch {
            outcomes[index] = {
              error: diagnostic(
                'FILE_READ_FAILED',
                file,
                'enumerated textual file could not be read',
              ),
            };
          }
        }
      }
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, textualNames.length) }, () => worker()),
  );
  const diagnostics = [];
  for (const outcome of outcomes) {
    if (outcome.error) {
      diagnostics.push(outcome.error);
    } else {
      result.set(outcome.file, outcome.value);
    }
  }
  Object.defineProperty(result, 'diagnostics', {
    value: Object.freeze(diagnostics),
    enumerable: false,
  });
  return result;
}

async function run() {
  const verifySources = process.argv.includes('--verify-sources');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const output = execFileSync('git', ['ls-files', '-co', '--exclude-standard', '-z'], {
    cwd: root,
  });
  // `git ls-files -c` includes index entries deleted from the worktree. They are
  // intentional deletion candidates, not unreadable current repository files.
  const deleted = new Set(
    execFileSync('git', ['ls-files', '--deleted', '-z'], { cwd: root })
      .toString('utf8')
      .split('\0')
      .filter(Boolean),
  );
  const names = output
    .toString('utf8')
    .split('\0')
    .filter((name) => Boolean(name) && !deleted.has(name));
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root })
    .toString('utf8')
    .split('\0')
    .filter((name) => Boolean(name) && !deleted.has(name));
  const files = await repositoryFiles(root, names, { trackedFiles: tracked });

  const bundles = spawnSync(
    process.execPath,
    [path.join(root, 'scripts/bundle-cli.mjs'), '--check'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  const bundleDiagnostics =
    bundles.status === 0
      ? []
      : (bundles.stderr || bundles.stdout || 'BUNDLE_CHECK_FAILED: bundle check failed')
          .trim()
          .split(/\r?\n/u)
          .filter(Boolean)
          .map((message) => diagnostic('GENERATED_BUNDLE_INVALID', 'bin', message));
  const generated = spawnSync(
    process.execPath,
    [path.join(root, 'runtimes/pi/runtime-pi/scripts/generate-agents.mjs'), '--check'],
    { cwd: root, encoding: 'utf8' },
  );
  const drift =
    generated.status === 0
      ? []
      : [generated.stderr.trim() || generated.stdout.trim() || 'projection'];
  const toolInventory = spawnSync(
    process.execPath,
    [path.join(root, 'scripts/generate-runtime-tool-inventory.mjs'), '--check'],
    { cwd: root, encoding: 'utf8' },
  );
  const toolInventoryDiagnostics =
    toolInventory.status === 0
      ? []
      : [
          diagnostic(
            'RUNTIME_TOOL_INVENTORY_DRIFT',
            'docs/inventory/PHASE_F1_RUNTIME_TOOL_INVENTORY.json',
            toolInventory.stderr.trim() ||
              toolInventory.stdout.trim() ||
              'runtime tool inventory is stale',
          ),
        ];
  const convergenceName = 'docs/history/CONVERGENCE_MANIFEST.json';
  let convergence;
  const convergenceDiagnostics = [];
  try {
    convergence = JSON.parse(files.get(convergenceName)?.toString('utf8') ?? '');
  } catch {
    convergenceDiagnostics.push(
      diagnostic(
        'CONVERGENCE_MANIFEST_INVALID',
        convergenceName,
        'committed convergence manifest is missing or invalid JSON',
      ),
    );
  }
  if (convergence) {
    convergenceDiagnostics.push(
      ...validateConvergenceManifest(convergence),
      ...validateConvergenceArtifacts(convergence, files),
    );
  }
  if (verifySources && convergence && process.env.MPX_PROJECTS) {
    const current = await buildConvergenceManifest({
      sources: [
        {
          id: 'claude',
          root: path.join(process.env.MPX_PROJECTS, 'mpx-claude-code'),
          symbolicRoot: '${MPX_PROJECTS}/mpx-claude-code',
        },
        {
          id: 'pi',
          root: path.join(process.env.MPX_PROJECTS, 'mpx-pi'),
          symbolicRoot: '${MPX_PROJECTS}/mpx-pi',
        },
      ],
    });
    convergenceDiagnostics.push(...compareConvergenceManifests(convergence, current));
  }

  const diagnostics = [
    ...files.diagnostics,
    ...bundleDiagnostics,
    ...toolInventoryDiagnostics,
    ...convergenceDiagnostics,
    ...validateCanonicalScriptSyntax(root, names),
    ...(await validateGeneratedRepository({
      root,
      names,
      tracked,
      files,
      generatedPiDiagnostics: drift,
      readSource: async (source) => {
        try {
          return await readFile(source);
        } catch {
          return undefined;
        }
      },
      verifySources,
      destinationAttributes: repositoryAttributes(root, names),
    })),
  ];

  const parsed = parseProvenanceManifest(files.get('docs/history/SOURCE_PROVENANCE.json'));
  if (diagnostics.length) {
    for (const item of diagnostics) {
      console.error(`${item.code}: ${item.file}: ${item.message}`);
    }
    process.exitCode = 1;
  } else {
    console.log(
      `Validated ${files.size} active/generated files, ${parsed.manifest.entries.length} provenance entries, and ${convergence.entries.length} convergence entries.`,
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await run();
}
