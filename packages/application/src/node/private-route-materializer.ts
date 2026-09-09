import { lstat, opendir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { MpxError } from '@mpx/core';
import { parseLaunchDescriptor, type LaunchDescriptor } from '@mpx/launch';
import type { RouteMaterializer } from '@mpx/executors';

function privateRouteError(
  code: 'PRIVATE_ROUTE_LABEL_INVALID' | 'PRIVATE_ROUTE_UNAVAILABLE',
  message: string,
): MpxError {
  return new MpxError({ code, message, retryable: false });
}
function safeOpaqueRouteLabel(value: string): boolean {
  return (
    value === value.normalize('NFC') &&
    value !== '.' &&
    value !== '..' &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/u.test(value) &&
    !value.endsWith('.') &&
    !value.includes('..')
  );
}
function privateRouteSelections(
  descriptor: LaunchDescriptor,
): readonly { key: string; kind: string; label: string }[] {
  const selections = [
    { key: `git:${descriptor.routes.gitAuthor}`, kind: 'git', label: descriptor.routes.gitAuthor },
    ...Object.entries(descriptor.routes.providers).map(([provider, label]) => ({
      key: `provider-${provider}:${label}`,
      kind: `provider-${provider}`,
      label,
    })),
    ...(descriptor.routes.ssh
      ? [{ key: `ssh:${descriptor.routes.ssh}`, kind: 'ssh', label: descriptor.routes.ssh }]
      : []),
    ...descriptor.routes.mcp.allow.map((label) => ({ key: `mcp:${label}`, kind: 'mcp', label })),
  ];
  const ambiguous = new Set<string>();
  for (const selection of selections) {
    if (
      !safeOpaqueRouteLabel(selection.label) ||
      !/^(?:git|ssh|mcp|provider-[a-z0-9][a-z0-9-]{0,31})$/u.test(selection.kind)
    ) {
      throw privateRouteError(
        'PRIVATE_ROUTE_LABEL_INVALID',
        'A selected private route label is invalid.',
      );
    }
    const folded = `${selection.kind}:${selection.label.toLowerCase()}`;
    if (ambiguous.has(folded)) {
      throw privateRouteError(
        'PRIVATE_ROUTE_LABEL_INVALID',
        'Selected private route labels are ambiguous.',
      );
    }
    ambiguous.add(folded);
  }
  return selections;
}
function routeWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  );
}
async function validatePrivateRouteData(root: string): Promise<void> {
  let fileCount = 0,
    directoryCount = 0,
    totalBytes = 0;
  const visit = async (directory: string, depth: number): Promise<void> => {
    const entries = await opendir(directory);
    for await (const entry of entries) {
      const candidate = path.join(directory, entry.name),
        candidateStat = await lstat(candidate);
      if (candidateStat.isSymbolicLink() || !routeWithin(root, await realpath(candidate))) {
        throw new Error('route data link or escape');
      }
      if (candidateStat.isDirectory()) {
        directoryCount += 1;
        if (directoryCount > 128) {
          throw new Error('route data exceeds directory bounds');
        }
        const childDepth = depth + 1;
        if (childDepth > 16) {
          throw new Error('route data exceeds depth bounds');
        }
        await visit(candidate, childDepth);
      } else if (candidateStat.isFile()) {
        fileCount += 1;
        totalBytes += candidateStat.size;
        if (fileCount > 256 || totalBytes > 8 * 1024 * 1024) {
          throw new Error('route data exceeds bounds');
        }
      } else {
        throw new Error('route data special file');
      }
    }
  };
  await visit(root, 0);
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...keys].sort().join(',')
  );
}
async function validateMcpRouteDescriptor(
  value: unknown,
  label: string,
  descriptorFile: string,
  stateRoot: string,
  projectRoot?: string,
): Promise<void> {
  if (!exactKeys(value, ['mcpServers']) || !exactKeys(value.mcpServers, [label])) {
    throw new Error('mcp config shape');
  }
  const server = value.mcpServers[label];
  if (
    !exactKeys(server, ['type', 'command', 'args']) ||
    server.type !== 'stdio' ||
    typeof server.command !== 'string' ||
    server.command.length === 0 ||
    server.command.length > 4096 ||
    /[\0-\x1f\x7f]/u.test(server.command) ||
    (!path.win32.isAbsolute(server.command) && !path.posix.isAbsolute(server.command))
  ) {
    throw new Error('mcp server shape');
  }
  if (
    !Array.isArray(server.args) ||
    server.args.length > 64 ||
    server.args.some(
      (argument) =>
        typeof argument !== 'string' || argument.length > 4096 || /[\0-\x1f\x7f]/u.test(argument),
    )
  ) {
    throw new Error('mcp argument bounds');
  }
  if (
    /\.(?:cmd|bat|ps1)$/iu.test(server.command) ||
    /^(?:sh|bash|zsh|fish|cmd|powershell|pwsh)(?:\.exe)?$/iu.test(path.basename(server.command))
  ) {
    throw new Error('mcp shell command');
  }
  const commandStat = await lstat(server.command),
    command = await realpath(server.command);
  if (
    !commandStat.isFile() ||
    commandStat.isSymbolicLink() ||
    routeWithin(stateRoot, command) ||
    routeWithin(path.dirname(descriptorFile), command) ||
    (projectRoot !== undefined && routeWithin(await realpath(projectRoot), command))
  ) {
    throw new Error('mcp command trust');
  }
}

export class NodePrivateRouteMaterializer implements RouteMaterializer {
  constructor(readonly root: string) {}
  async materialize(
    descriptorInput: LaunchDescriptor,
    projectRoot?: string,
  ): Promise<Readonly<Record<string, string>>> {
    const selections = privateRouteSelections(descriptorInput);
    let descriptor: LaunchDescriptor;
    try {
      descriptor = parseLaunchDescriptor(descriptorInput);
    } catch {
      throw privateRouteError(
        'PRIVATE_ROUTE_UNAVAILABLE',
        'Private route binding validation failed.',
      );
    }
    try {
      if (!path.isAbsolute(this.root)) {
        throw new Error('state root');
      }
      const rootStat = await lstat(this.root);
      if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
        throw new Error('state root shape');
      }
      const canonicalRoot = await realpath(this.root);
      const materialized: Record<string, string> = {};
      for (const selection of selections) {
        const directory = path.join(
          canonicalRoot,
          'private-routes',
          descriptor.identity.name,
          descriptor.runtime,
          selection.kind,
          selection.label,
        );
        const bindingFile = path.join(directory, 'binding.json');
        const data = path.join(directory, 'data');
        const [directoryStat, bindingStat, dataStat] = await Promise.all([
          lstat(directory),
          lstat(bindingFile),
          lstat(data),
        ]);
        if (
          directoryStat.isSymbolicLink() ||
          !directoryStat.isDirectory() ||
          bindingStat.isSymbolicLink() ||
          !bindingStat.isFile() ||
          bindingStat.size > 16_384 ||
          dataStat.isSymbolicLink() ||
          !dataStat.isDirectory()
        ) {
          throw new Error('route shape');
        }
        const canonicalData = await realpath(data);
        if (!routeWithin(canonicalRoot, canonicalData)) {
          throw new Error('route escape');
        }
        await validatePrivateRouteData(canonicalData);
        const binding = JSON.parse(await readFile(bindingFile, 'utf8')) as unknown;
        const expected = {
          schemaVersion: 1,
          runtime: descriptor.runtime,
          identity: descriptor.identity,
          kind: selection.kind,
          label: selection.label,
          ...(selection.kind === 'mcp' ? { launchKey: descriptor.launchKey } : {}),
        };
        if (JSON.stringify(binding) !== JSON.stringify(expected)) {
          throw new Error('route binding');
        }
        if (selection.kind === 'mcp') {
          const descriptorFile = path.join(canonicalData, 'route.json');
          const descriptorStat = await lstat(descriptorFile);
          if (
            descriptorStat.isSymbolicLink() ||
            !descriptorStat.isFile() ||
            descriptorStat.size > 16_384 ||
            !routeWithin(canonicalData, await realpath(descriptorFile))
          ) {
            throw new Error('mcp route descriptor shape');
          }
          await validateMcpRouteDescriptor(
            JSON.parse(await readFile(descriptorFile, 'utf8')),
            selection.label,
            descriptorFile,
            canonicalRoot,
            projectRoot,
          );
          materialized[selection.key] = descriptorFile;
        } else {
          materialized[selection.key] = canonicalData;
        }
      }
      return Object.freeze(materialized);
    } catch {
      throw privateRouteError(
        'PRIVATE_ROUTE_UNAVAILABLE',
        'A selected private route is missing, malformed, or not bound to this launch.',
      );
    }
  }
}
