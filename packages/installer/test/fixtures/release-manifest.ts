import { createHash } from 'node:crypto';
import {
  canonicalJson,
  installerDigest,
  type ReleaseFile,
  type ReleaseManifest,
} from '../../src/immutable-core.js';

export const releasePayload = 'console.log("manifest-fixture-sentinel");\n';

const evidence: ReleaseFile = {
  path: 'bin/mpx.mjs',
  bytes: Buffer.byteLength(releasePayload),
  sha256: createHash('sha256').update(releasePayload).digest('hex'),
};
const releaseKey = installerDigest([evidence]);

export const validReleaseManifest: ReleaseManifest = {
  schemaVersion: 1,
  kind: 'release-manifest',
  releaseKey,
  convergenceHash: releaseKey,
  files: [evidence],
};

const validBody = canonicalJson(validReleaseManifest);

export const maliciousReleaseManifestBodies = [
  validBody.replace('"kind":', '"__proto__":{},"kind":'),
  validBody.replace('"kind":', '"prototype":{},"kind":'),
  validBody.replace('"kind":', '"constructor":{},"kind":'),
  validBody.replace('"kind":', '"kind":"release-manifest","kind":'),
  canonicalJson({
    ...validReleaseManifest,
    files: [{ ...evidence, path: '../bin/mpx.mjs' }],
  }),
  canonicalJson({ ...validReleaseManifest, releaseKey: 'a'.repeat(64) }),
] as const;
