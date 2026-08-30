import { MpxError } from '@mpx/core';
import {
  deriveChildAuthority,
  type ChildLaunchAuthorityV1,
  type ChildLaunchRequestV1,
  type RuntimeCapabilityManifestV1,
} from '@mpx/runtime-contracts';

export function bindChildLaunchAuthority(
  parent: RuntimeCapabilityManifestV1,
  request: ChildLaunchRequestV1,
): ChildLaunchAuthorityV1 {
  return deriveChildAuthority(parent, request);
}
export function assertLaunchBoundAuthority(
  parent: RuntimeCapabilityManifestV1,
  authority: ChildLaunchAuthorityV1,
): ChildLaunchAuthorityV1 {
  const derived = deriveChildAuthority(parent, authority);
  if (derived.childKey !== authority.childKey) {
    throw new MpxError({
      code: 'SUBAGENT_AUTHORITY_STALE',
      message: 'Child authority is not bound to this launch.',
      retryable: false,
    });
  }
  return derived;
}
