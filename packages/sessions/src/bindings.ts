import type { RuntimeName } from '@mpx/runtime-contracts';
import { stableDigest, type Identity } from './schemas.js';

/** The sole stable identity for an MPX native runtime root binding. */
export function deriveNativeBindingRef(
  identity: Identity,
  runtime: RuntimeName,
  recordedRootDigest: string,
): string {
  return `native-${stableDigest({ identity, runtime, recordedRootDigest })}`;
}
