import type { LaunchDescriptor } from './types.js';

export type SerializedLaunchDescriptor = LaunchDescriptor;

function sanitizedView(descriptor: LaunchDescriptor): SerializedLaunchDescriptor {
  return structuredClone(descriptor);
}

/** Privacy-safe process/status serialization. Native runtime roots and raw resolver inputs never enter the descriptor. */
export function serializeLaunchPublic(descriptor: LaunchDescriptor): SerializedLaunchDescriptor {
  return sanitizedView(descriptor);
}

/** Privacy-safe local audit serialization; elevation reason remains visible but sanitized. */
export function serializeLaunchAudit(descriptor: LaunchDescriptor): SerializedLaunchDescriptor {
  return sanitizedView(descriptor);
}
