import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createLegacyLaunch } from '../src/legacy.js';
import { RETAINED_NATIVE_PACKAGES } from '../src/native-packages.js';
import type { UserConfig } from '../src/contracts.js';

test('legacy launch requires separate complete resources and excludes duplicate alert registrations', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mpx-legacy-'));
  const config: UserConfig = { accounts: { personal: { pi: join(root, 'personal'), claude: join(root, 'cc') }, work: { pi: join(root, 'work'), claude: join(root, 'ccw') } }, domains: { personal: [], work: [] }, executables: { pi: process.execPath } };
  try {
    for (const value of Object.values(config.accounts).flatMap(Object.values)) await mkdir(value);
    await assert.rejects(createLegacyLaunch(resolve('.'), root, config, { warnings: [] }, []), /configure a separate/);
    config.legacyPi = { accountRoot: config.accounts.personal.pi, checkout: join(root, 'source') };
    await assert.rejects(createLegacyLaunch(resolve('.'), root, config, { warnings: [] }, []), /must not share/);
    config.legacyPi.accountRoot = join(root, 'legacy-account');
    await mkdir(config.legacyPi.accountRoot);
    const source = config.legacyPi.checkout;
    for (const extension of [
      'agent-resurrect.ts', 'auto-title.ts', 'footer.ts', 'guard-hooks.ts',
      'kf-namespace-commands.ts', 'mp-namespace-commands.ts', 'subagents/index.ts',
      'terminal-progress/index.ts', 'dev-server/index.ts', 'worktree/index.ts',
    ]) {
      const file = join(source, 'extensions', extension); await mkdir(join(file, '..'), { recursive: true }); await writeFile(file, 'export default () => {};');
    }
    await assert.rejects(createLegacyLaunch(resolve('.'), root, config, { warnings: [] }, []), /native packages/);
    await writeFile(join(config.legacyPi.accountRoot, 'settings.json'), JSON.stringify({ packages: RETAINED_NATIVE_PACKAGES.map(name => `npm:${name}`) }));
    for (const name of RETAINED_NATIVE_PACKAGES) {
      const directory = join(config.legacyPi.accountRoot, 'npm/node_modules', name); await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'index.ts'), 'export default () => {};');
      await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', pi: { extensions: ['./index.ts'] } }));
    }
    const display = join(root, 'display'); await mkdir(display);
    await writeFile(join(display, 'index.ts'), 'export default () => {};');
    await writeFile(join(display, 'package.json'), JSON.stringify({ name: 'pi-tool-display', pi: { extensions: ['./index.ts'] } }));
    await writeFile(join(source, 'settings.json'), JSON.stringify({ packages: [display] }));
    const spec = await createLegacyLaunch(resolve('.'), root, config, { warnings: [] }, ['--offline']);
    assert.equal(spec.env.PI_CODING_AGENT_DIR, config.legacyPi.accountRoot);
    assert.equal(spec.env.MPX_ACCOUNT, undefined);
    assert.ok(spec.args.includes('--no-extensions'));
    assert.ok(spec.args.includes(join(display, 'index.ts')));
    assert.ok(spec.args.includes(join(source, 'extensions/subagents/index.ts')));
    for (const retained of ['agent-resurrect.ts', 'auto-title.ts', 'kf-namespace-commands.ts', 'mp-namespace-commands.ts']) {
      assert.ok(spec.args.includes(join(source, 'extensions', retained)), `${retained} must remain selected`);
    }
    assert.ok(!spec.args.some(arg => /guard-hooks|terminal-progress|[\\/]dev-server[\\/]|[\\/]worktree[\\/]/.test(arg)), 'retired manager entrypoints must not be selected');
    assert.match(spec.label, /LEGACY.*formatting manual/);
    assert.equal(spec.args.at(-1), '--offline');
    await writeFile(join(source, 'extensions/footer.ts'), 'function agentDirectory(): string { return path.join(homedir(), ".pi", "agent"); }');
    await assert.rejects(createLegacyLaunch(resolve('.'), root, config, { warnings: [] }, []), /hardcodes.*outside the separate legacy account/);
    await writeFile(join(source, 'extensions/footer.ts'), 'export default () => {};');
    await writeFile(join(display, 'package.json'), JSON.stringify({ name: 'pi-tool-display', pi: { extensions: ['./missing.ts'] } }));
    await assert.rejects(createLegacyLaunch(resolve('.'), root, config, { warnings: [] }, []), /Retained legacy tool-display entry is unavailable; no fallback launched/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
