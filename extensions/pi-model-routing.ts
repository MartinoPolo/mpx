import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import { getSupportedThinkingLevels, type Api, type Model } from '@earendil-works/pi-ai';
import { readFile } from 'node:fs/promises';
import {
  enforceLunaThinking,
  isPiFamilyModel,
  LUNA_ALLOWED_THINKING,
  LUNA_MINIMUM_THINKING,
  resolvePiModelReference,
  type AvailablePiModel,
} from '../src/pi-model-routing.js';

interface NativeAgentConfig {
  model?: string;
  thinking?: string;
}

interface RoutingDependencies {
  loadCustomAgents(cwd: string): Map<string, NativeAgentConfig>;
  resolveEnabledTypeIn(registry: Map<string, NativeAgentConfig>, requested: unknown): string | undefined;
  resolveModel(input: string, registry: ExtensionContext['modelRegistry']): unknown;
  profiles: Readonly<Record<string, string>>;
}

const AGENT_TOOL_NAME = 'Agent';

function configuredAgent(input: Record<string, unknown>, cwd: string, dependencies: RoutingDependencies): NativeAgentConfig | undefined {
  const registry = dependencies.loadCustomAgents(cwd);
  const type = dependencies.resolveEnabledTypeIn(registry, input.subagent_type);
  return type ? registry.get(type) : undefined;
}

function availablePiModel(value: unknown): AvailablePiModel | undefined {
  if (!value || typeof value !== 'object' || !('id' in value) || !('provider' in value)) return undefined;
  return typeof value.id === 'string' && typeof value.provider === 'string'
    ? { id: value.id, provider: value.provider }
    : undefined;
}

function unknownRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function guardedLunaPayload(
  payload: unknown,
  model: Model<Api>,
  thinking: ReturnType<ExtensionAPI['getThinkingLevel']>,
): { payload?: unknown; error?: string } {
  if (!unknownRecord(payload)) return { error: 'MPX blocked an invalid Luna provider payload' };
  const mappedThinking = model.thinkingLevelMap?.[thinking];
  const effort = typeof mappedThinking === 'string' ? mappedThinking : thinking;

  if (model.api === 'openai-codex-responses' || model.api === 'openai-responses' || model.api === 'azure-openai-responses') {
    const reasoning = unknownRecord(payload.reasoning) ? payload.reasoning : {};
    return { payload: { ...payload, reasoning: { ...reasoning, effort } } };
  }
  if (model.api === 'openai-completions') return { payload: { ...payload, reasoning_effort: effort } };
  if (model.api === 'pi-messages') {
    const options = unknownRecord(payload.options) ? payload.options : {};
    return { payload: { ...payload, options: { ...options, reasoning: thinking } } };
  }
  return { error: `MPX cannot guarantee Luna thinking level ${thinking} for API ${model.api}` };
}

export function registerPiModelRouting(pi: ExtensionAPI, dependencies: RoutingDependencies): void {
  let settingThinking = false;
  const ensureActiveLunaThinking = (model: Model<Api> | undefined): boolean => {
    if (!model || !isPiFamilyModel(model, 'luna')) return true;
    if (LUNA_ALLOWED_THINKING.includes(pi.getThinkingLevel())) return true;
    if (settingThinking || !getSupportedThinkingLevels(model).includes(LUNA_MINIMUM_THINKING)) return false;
    settingThinking = true;
    try {
      pi.setThinkingLevel(LUNA_MINIMUM_THINKING);
    } finally {
      settingThinking = false;
    }
    return LUNA_ALLOWED_THINKING.includes(pi.getThinkingLevel());
  };

  pi.on('tool_call', (event, context) => {
    if (event.toolName !== AGENT_TOOL_NAME || event.input.resume) return;
    const agent = configuredAgent(event.input, context.cwd, dependencies);
    const explicitRequestedModel = typeof event.input.model === 'string' ? event.input.model : undefined;
    const requestedModel = explicitRequestedModel ?? agent?.model;
    let effectiveModel = availablePiModel(context.model);

    if (requestedModel) {
      const availableModels = context.modelRegistry.getAvailable();
      const resolution = resolvePiModelReference(requestedModel, dependencies.profiles, availableModels);
      if (resolution.kind === 'error') return { block: true, reason: resolution.message };
      if (resolution.kind === 'resolved') {
        event.input.model = resolution.model;
        effectiveModel = availableModels.find(model => `${model.provider}/${model.id}` === resolution.model);
      } else {
        const nativeResolution = availablePiModel(dependencies.resolveModel(requestedModel, context.modelRegistry));
        effectiveModel = nativeResolution ?? (explicitRequestedModel ? undefined : effectiveModel);
      }
    }

    if (isPiFamilyModel(effectiveModel, 'luna')) {
      event.input.thinking = enforceLunaThinking(event.input.thinking ?? agent?.thinking);
    }
    return undefined;
  });

  pi.on('session_start', (_event, context) => { ensureActiveLunaThinking(context.model); });
  pi.on('model_select', (event) => { ensureActiveLunaThinking(event.model); });
  pi.on('thinking_level_select', (_event, context) => { ensureActiveLunaThinking(context.model); });
  pi.on('before_agent_start', (_event, context) => { ensureActiveLunaThinking(context.model); });
  pi.on('before_provider_request', (event, context) => {
    const activeModel = context.model;
    if (!activeModel || !isPiFamilyModel(activeModel, 'luna')) return undefined;
    const abortRequest = (message: string): undefined => {
      context.ui.notify(message, 'error');
      context.abort();
      return undefined;
    };
    if (!ensureActiveLunaThinking(activeModel)) {
      return abortRequest(`MPX blocked Luna below thinking level ${LUNA_MINIMUM_THINKING}`);
    }
    const guarded = guardedLunaPayload(event.payload, activeModel, pi.getThinkingLevel());
    return guarded.error ? abortRequest(guarded.error) : guarded.payload;
  });
}

async function loadPiProfiles(): Promise<Readonly<Record<string, string>>> {
  const parsed: unknown = JSON.parse(await readFile(new URL('../content/runtime-profiles.json', import.meta.url), 'utf8'));
  if (!parsed || typeof parsed !== 'object' || !('models' in parsed)) throw new Error('Invalid MPX runtime profiles');
  const models = parsed.models;
  if (!models || typeof models !== 'object' || !('pi' in models)) throw new Error('MPX runtime profiles do not define Pi models');
  const piProfiles = models.pi;
  if (!piProfiles || typeof piProfiles !== 'object' || Array.isArray(piProfiles)) throw new Error('Invalid MPX Pi runtime profiles');
  return Object.fromEntries(Object.entries(piProfiles).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

export default async function piModelRouting(pi: ExtensionAPI): Promise<void> {
  const customAgentsEntry = new URL('../node_modules/@tintinweb/pi-subagents/src/custom-agents.ts', import.meta.url).href;
  const agentTypesEntry = new URL('../node_modules/@tintinweb/pi-subagents/src/agent-types.ts', import.meta.url).href;
  const modelResolverEntry = new URL('../node_modules/@tintinweb/pi-subagents/src/model-resolver.ts', import.meta.url).href;
  const [customAgents, agentTypes, modelResolver, profiles] = await Promise.all([
    import(customAgentsEntry),
    import(agentTypesEntry),
    import(modelResolverEntry),
    loadPiProfiles(),
  ]);
  registerPiModelRouting(pi, {
    loadCustomAgents: customAgents.loadCustomAgents,
    resolveEnabledTypeIn: agentTypes.resolveEnabledTypeIn,
    resolveModel: modelResolver.resolveModel,
    profiles,
  });
}
