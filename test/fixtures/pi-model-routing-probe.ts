import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export default function probe(pi: ExtensionAPI): void {
  pi.on('before_provider_request', (_event, context) => {
    const signal = context.signal;
    (globalThis as Record<string, unknown>).__mpxProviderSignal = signal;
    (globalThis as Record<string, unknown>).__mpxSignalAbortedInHook = signal?.aborted;
    const nativeSignal = (globalThis as Record<string, unknown>).__mpxGetNativeSignal;
    if (typeof nativeSignal === 'function') {
      (globalThis as Record<string, unknown>).__mpxSameNativeSignal = signal === nativeSignal();
    }
  });
  pi.on('tool_call', event => {
    if (event.toolName !== 'Agent') return;
    (globalThis as Record<string, unknown>).__mpxRoutingProbe = structuredClone(event.input);
    return { block: true, reason: 'probe complete' };
  });
}
