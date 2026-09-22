import {
  isToolCallEventType,
  type ExtensionAPI,
} from '@earendil-works/pi-coding-agent';

export const DEFAULT_BASH_TIMEOUT_SECONDS = 120;

export default function piBash(pi: ExtensionAPI): void {
  pi.on('tool_call', event => {
    if (isToolCallEventType('bash', event) && event.input.timeout === undefined) {
      event.input.timeout = DEFAULT_BASH_TIMEOUT_SECONDS;
    }
  });
}
