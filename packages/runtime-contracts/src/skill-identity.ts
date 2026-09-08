const BARE_SKILL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PROJECT_PREFIX = 'skill:';

/** Returns the source name only when the resolution identity matches its declared origin. */
export function bareSkillIdentity(
  identity: string,
  origin: 'canonical' | 'project',
): string | undefined {
  const bare =
    origin === 'project' && identity.startsWith(PROJECT_PREFIX)
      ? identity.slice(PROJECT_PREFIX.length)
      : origin === 'canonical'
        ? identity
        : undefined;
  return bare && BARE_SKILL_ID.test(bare) ? bare : undefined;
}
