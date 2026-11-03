#!/usr/bin/env node
// Set an Orca project's display name, group, icon and colour through the running Orca runtime.
//
// The Orca CLI cannot set these, and Orca rewrites its data file while running, so the
// runtime's own RPC is the only safe route: newline-delimited JSON over the named pipe
// advertised in orca-runtime.json, authenticated by the token stored beside it.

import { readFileSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const REQUEST_TIMEOUT_MILLISECONDS = 15_000;

function runtimeMetadata() {
  const appData = process.env.APPDATA;
  if (!appData) {
    throw new Error('APPDATA is not set — cannot locate orca-runtime.json.');
  }
  const metadata = JSON.parse(readFileSync(join(appData, 'orca', 'orca-runtime.json'), 'utf8'));
  const pipe = metadata.transports?.find((transport) => transport.kind === 'named-pipe')?.endpoint;
  if (!pipe) {
    throw new Error('orca-runtime.json has no named-pipe transport — is Orca running?');
  }
  return { pipe, authToken: metadata.authToken };
}

function call({ pipe, authToken }, method, params) {
  return new Promise((resolvePromise, reject) => {
    const id = randomUUID();
    const socket = createConnection(pipe);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`${method}: no response within ${REQUEST_TIMEOUT_MILLISECONDS} ms`));
    }, REQUEST_TIMEOUT_MILLISECONDS);
    const finish = (settle) => {
      clearTimeout(timer);
      socket.end();
      settle();
    };
    socket.on('connect', () => socket.write(`${JSON.stringify({ id, authToken, method, params })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const frame = JSON.parse(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        if (frame.id !== id) continue;
        if (frame.ok === false) finish(() => reject(new Error(`${method}: ${JSON.stringify(frame.error)}`)));
        else finish(() => resolvePromise(frame.result));
      }
    });
    socket.on('end', () => finish(() => reject(new Error(`${method}: connection closed without a response`))));
    socket.on('error', (error) => finish(() => reject(error)));
  });
}

function normalizePath(path) {
  return resolve(path).replaceAll('\\', '/').toLowerCase();
}

function parseOptions(argumentsList) {
  const options = {};
  for (let index = 0; index < argumentsList.length; index += 2) {
    const flag = argumentsList[index];
    if (!flag.startsWith('--') || argumentsList[index + 1] === undefined) {
      throw new Error(`Expected --flag value, got ${flag}`);
    }
    options[flag.slice(2)] = argumentsList[index + 1];
  }
  return options;
}

async function listGroups(runtime) {
  const { groups } = await call(runtime, 'projectGroup.list');
  const names = new Map(groups.map((group) => [group.id, group.name]));
  return groups.map((group) => ({
    id: group.id,
    path: [names.get(group.parentGroupId), group.name].filter(Boolean).join(' › '),
  }));
}

async function apply(runtime, { path, name, icon, color, group }) {
  if (!path) {
    throw new Error('--path is required');
  }
  const { repos } = await call(runtime, 'repo.list');
  const repo = repos.find((candidate) => normalizePath(candidate.path) === normalizePath(path));
  if (!repo) {
    throw new Error(`Orca has no project at ${path}; add it first with \`orca repo add --path\`.`);
  }

  const updates = {};
  if (name) {
    updates.displayName = name;
  }
  if (icon) {
    const label = icon.split(/[\\/]/).pop();
    updates.repoIcon = {
      type: 'image',
      src: `data:image/png;base64,${readFileSync(icon).toString('base64')}`,
      source: 'upload',
      label,
    };
  }
  if (color) {
    updates.badgeColor = color;
  }
  if (Object.keys(updates).length > 0) {
    await call(runtime, 'repo.update', { repo: repo.id, updates });
  }
  if (group) {
    const match = (await listGroups(runtime)).find((candidate) => candidate.id === group || candidate.path === group);
    if (!match) {
      throw new Error(`No Orca group matches ${group}; run \`groups\` to list them.`);
    }
    await call(runtime, 'projectGroup.moveProject', { repo: repo.id, groupId: match.id });
  }

  const { repos: updatedRepos } = await call(runtime, 'repo.list');
  const updated = updatedRepos.find((candidate) => candidate.id === repo.id);
  return {
    id: updated.id,
    displayName: updated.displayName,
    projectGroupId: updated.projectGroupId,
    badgeColor: updated.badgeColor,
    icon: updated.repoIcon ? `${updated.repoIcon.type}:${updated.repoIcon.source ?? ''}` : null,
  };
}

const [command, ...rest] = process.argv.slice(2);
try {
  const runtime = runtimeMetadata();
  if (command === 'groups') {
    console.log(JSON.stringify(await listGroups(runtime), null, 2));
  } else if (command === 'apply') {
    console.log(JSON.stringify(await apply(runtime, parseOptions(rest)), null, 2));
  } else {
    console.error('Usage: orca-project.mjs groups | apply --path <dir> [--name <display name>] [--icon <png>] [--color <#RRGGBB>] [--group <id or "Parent › Name">]');
    process.exit(2);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
