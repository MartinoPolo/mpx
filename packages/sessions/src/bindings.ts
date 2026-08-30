import type { RuntimeName } from '@mpx/runtime-contracts';
import { stableDigest, type IdentityV1 } from './schemas.js';

/** The sole stable identity for an MPX native runtime root binding. */
export function deriveNativeBindingRef(
  identity: IdentityV1,
  runtime: RuntimeName,
  recordedRootDigest: string,
): string {
  return `native-${stableDigest({ identity, runtime, recordedRootDigest })}`;
}
