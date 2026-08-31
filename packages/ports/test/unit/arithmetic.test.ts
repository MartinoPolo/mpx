import { describe, expect, it } from 'vitest';
import { allocatePortMap, buildPortFamilies, type PortServiceDefinition } from '../../src/index.js';

const service = (name: string, preferred: number, family?: string): PortServiceDefinition => ({
  name,
  preferred,
  scope: 'checkout',
  mode: 'managed',
  ...(family ? { family } : {}),
});

describe('port family arithmetic', () => {
  it('shifts contiguous and distant automatic families by one shared slot', () => {
    expect(allocatePortMap([service('components', 8100), service('docs', 8101)], 1)).toEqual({
      components: 8102,
      docs: 8103,
    });
    expect(allocatePortMap([service('app', 5173), service('storybook', 6006)], 2)).toEqual({
      app: 5175,
      storybook: 6008,
    });
  });

  it('uses explicit family groups and their full numeric width', () => {
    const definitions = [
      service('a', 7000, 'web'),
      service('b', 7002, 'web'),
      service('c', 7001, 'other'),
    ];
    expect(buildPortFamilies(definitions).map(({ id, width }) => ({ id, width }))).toEqual([
      { id: 'explicit:other', width: 1 },
      { id: 'explicit:web', width: 3 },
    ]);
    expect(allocatePortMap(definitions, 1)).toEqual({ a: 7003, b: 7005, c: 7002 });
  });

  it('advances every family when any candidate conflicts', () => {
    const definitions = [service('app', 5173), service('storybook', 6006)];
    expect(
      allocatePortMap(definitions, 1, { occupied: new Set([6007]), advanceOnConflict: true }),
    ).toEqual({ app: 5175, storybook: 6008 });
  });

  it('does not let project-scoped services widen checkout families', () => {
    const project: PortServiceDefinition = {
      name: 'database',
      preferred: 8101,
      scope: 'project',
      mode: 'managed',
    };
    expect(allocatePortMap([service('app', 8100), project], 2)).toEqual({
      app: 8102,
      database: 8101,
    });
  });

  it('rejects overlap and ceiling violations for the complete map', () => {
    expect(() =>
      allocatePortMap([service('a', 7000, 'x'), service('b', 7001, 'x'), service('c', 7002)], 1),
    ).toThrowError(expect.objectContaining({ code: 'PORT_MAP_OVERLAP' }));
    expect(() => allocatePortMap([service('top', 65_535)], 1)).toThrowError(
      expect.objectContaining({ code: 'PORT_CEILING_EXCEEDED' }),
    );
  });
});
