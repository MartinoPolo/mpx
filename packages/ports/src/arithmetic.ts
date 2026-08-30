import { MpxError } from '@mpx/core';

export type PortMode = 'managed' | 'fixed-shared';
export type PortScope = 'checkout' | 'project';
export interface PortServiceDefinition {
  name: string;
  preferred: number;
  mode: PortMode;
  scope: PortScope;
  family?: string;
}
export interface PortFamily {
  id: string;
  width: number;
  minimum: number;
  maximum: number;
  services: readonly PortServiceDefinition[];
}
export interface AllocationOptions {
  occupied?: ReadonlySet<number>;
  reserved?: ReadonlySet<number>;
  ceiling?: number;
  advanceOnConflict?: boolean;
  maximumSlot?: number;
}

function compareDefinition(a: PortServiceDefinition, b: PortServiceDefinition): number {
  return a.preferred - b.preferred || a.name.localeCompare(b.name);
}

export function buildPortFamilies(definitions: readonly PortServiceDefinition[]): PortFamily[] {
  const shiftedDefinitions = definitions.filter(
    ({ mode, scope }) => mode === 'managed' && scope === 'checkout',
  );
  const explicit = new Map<string, PortServiceDefinition[]>();
  const automatic = shiftedDefinitions
    .filter((item) => {
      if (item.family === undefined) {
        return true;
      }
      const members = explicit.get(item.family) ?? [];
      members.push(item);
      explicit.set(item.family, members);
      return false;
    })
    .sort(compareDefinition);
  const groups: Array<{ id: string; members: PortServiceDefinition[] }> = [
    ...explicit.entries(),
  ].map(([id, members]) => ({ id: `explicit:${id}`, members }));
  let current: PortServiceDefinition[] = [];
  for (const definition of automatic) {
    if (current.length && definition.preferred !== current[current.length - 1]!.preferred + 1) {
      groups.push({ id: `auto:${current[0]!.preferred}`, members: current });
      current = [];
    }
    current.push(definition);
  }
  if (current.length) {
    groups.push({ id: `auto:${current[0]!.preferred}`, members: current });
  }
  return groups
    .map(({ id, members }) => {
      members.sort(compareDefinition);
      const minimum = Math.min(...members.map(({ preferred }) => preferred));
      const maximum = Math.max(...members.map(({ preferred }) => preferred));
      return { id, minimum, maximum, width: maximum - minimum + 1, services: members };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
}

function candidate(
  definitions: readonly PortServiceDefinition[],
  slot: number,
): Record<string, number> {
  const output: Record<string, number> = Object.fromEntries(
    definitions
      .filter(({ mode, scope }) => mode !== 'managed' || scope !== 'checkout')
      .map(({ name, preferred }) => [name, preferred]),
  );
  for (const family of buildPortFamilies(definitions)) {
    for (const service of family.services) {
      output[service.name] = service.preferred + slot * family.width;
    }
  }
  return output;
}

function invalidCode(map: Record<string, number>, options: AllocationOptions): string | undefined {
  const ceiling = options.ceiling ?? 65_535;
  const ports = Object.values(map);
  if (ports.some((port) => !Number.isInteger(port) || port < 1 || port > ceiling)) {
    return 'PORT_CEILING_EXCEEDED';
  }
  if (new Set(ports).size !== ports.length) {
    return 'PORT_MAP_OVERLAP';
  }
  if (ports.some((port) => options.reserved?.has(port))) {
    return 'PORT_RESERVED';
  }
  if (ports.some((port) => options.occupied?.has(port))) {
    return 'PORT_CONFLICT';
  }
  return undefined;
}

export function allocatePortMap(
  definitions: readonly PortServiceDefinition[],
  requestedSlot: number,
  options: AllocationOptions = {},
): Record<string, number> {
  if (!Number.isInteger(requestedSlot) || requestedSlot < 0) {
    throw new MpxError({
      code: 'PORT_SLOT_INVALID',
      message: 'Port slot must be a non-negative integer.',
    });
  }
  const maximumSlot = options.maximumSlot ?? 65_535;
  for (let slot = requestedSlot; slot <= maximumSlot; slot++) {
    const map = candidate(definitions, slot);
    const code = invalidCode(map, options);
    if (code === undefined) {
      return Object.fromEntries(Object.entries(map).sort(([a], [b]) => a.localeCompare(b)));
    }
    if (!options.advanceOnConflict || (code !== 'PORT_CONFLICT' && code !== 'PORT_RESERVED')) {
      throw new MpxError({
        code,
        message: `Invalid complete port map: ${code}.`,
        details: { slot },
      });
    }
  }
  throw new MpxError({
    code: 'PORT_ALLOCATION_EXHAUSTED',
    message: 'No complete port map is available.',
  });
}
