import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRuntimeContext } from '@mpx/runtime-contracts';
import {
  createRuntimeSkillArtifact,
  createSkillProjectionPlan,
  inventoryCanonical,
  resolveManifest,
} from '@mpx/skills';
import { createPiRuntimeProfile } from '../../src/profile.js';
import { loadRuntimeProfiles } from '@mpx/config';
import { compileContent } from '@mpx/content-compiler';

const exposures = [
  ['full', 'full', 'Full skill', 'full trigger'],
  ['named', 'name-only', 'Named skill', ''],
  ['explicit', 'explicit-only', 'Explicit skill', ''],
  ['excluded', 'full', 'Excluded skill', ''],
] as const;
export async function fixture() {
  const canonicalRoot = await mkdtemp(path.join(tmpdir(), 'pi-skills-'));
  for (const [name, exposure, description, triggers] of exposures) {
    const dir = path.join(canonicalRoot, name);
    await mkdir(dir);
    await writeFile(
      path.join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n${triggers ? `triggers: ${triggers}\n` : ''}metadata:\n  mpx:\n    schemaVersion: 1\n    skillPacks: [${name === 'excluded' ? 'personal' : 'development'}]\n    defaultExposure: ${exposure}\n---\n# ${name}\n`,
    );
  }
  const catalog = await inventoryCanonical(canonicalRoot);
  const currentBinding = {
    projectId: 'p',
    repositoryId: 'repo',
    identity: 'id',
    selection: {
      location: { name: 'scope', canonicalRoot },
      packs: ['development'] as const,
      source: 'project' as const,
    },
  };
  const manifest = resolveManifest(catalog, {
    repositoryId: currentBinding.repositoryId,
    projectId: currentBinding.projectId,
    identity: currentBinding.identity,
    selection: currentBinding.selection,
  });
  const artifact = createRuntimeSkillArtifact(manifest, catalog, { runtime: 'pi' });
  const skillPlan = await createSkillProjectionPlan({
    manifest,
    artifact,
    catalog,
    canonicalRoot,
  });
  const sharedInstructionRoot = fileURLToPath(
    new URL('../../../../../content/instructions/shared/', import.meta.url),
  );
  const runtimeProfiles = await loadRuntimeProfiles(
    fileURLToPath(new URL('../../../../../content/runtime-profiles.json', import.meta.url)),
  );
  const agentRoot = fileURLToPath(new URL('../../../../../content/agents/', import.meta.url));
  const compiledContent = await compileContent({
    runtime: 'pi',
    plan: skillPlan,
    runtimeProfiles,
    sharedInstructionRoot,
    agentRoot,
  });
  const context = createRuntimeContext({
    launchKey: 'launch',
    launchDescriptor: { reference: 'launch.json', digest: 'digest' },
    manifestKey: manifest.manifestKey,
    runtimeArtifact: artifact.reference,
    binding: currentBinding,
  });
  const piRuntimeProfile = createPiRuntimeProfile(
    {
      schemaVersion: 1,
      runtime: 'pi',
      provider: 'openai-codex',
      defaultModel: 'openai-codex/gpt-5.6-sol',
      enabledModels: [
        'openai-codex/gpt-5.6-luna',
        'openai-codex/gpt-5.6-sol',
        'openai-codex/gpt-5.6-terra',
      ],
    },
    [],
  );
  return {
    context,
    piRuntimeProfile,
    manifest,
    artifact,
    skillPlan,
    compiledContent,
    runtimeProfiles,
    sharedInstructionRoot,
    agentRoot,
    catalog,
    canonicalRoot,
    currentBinding,
    expectedLaunch: { launchKey: 'launch', descriptorDigest: 'digest' },
  };
}
