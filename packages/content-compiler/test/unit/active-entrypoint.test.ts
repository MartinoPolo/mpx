import { expect, it } from 'vitest';
import * as activeContent from '@mpx/content-compiler/active';

it('exposes the read-only active-content API without the compiler surface', () => {
  expect(activeContent).toMatchObject({
    loadActiveContentProjection: expect.any(Function),
    classifyCompiledSkillSource: expect.any(Function),
    readActiveSkill: expect.any(Function),
  });
  expect(activeContent).not.toHaveProperty('compileContent');
});
