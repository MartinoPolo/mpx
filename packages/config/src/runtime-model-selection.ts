import { readFile } from 'node:fs/promises';
import { SKILL_CAPABILITIES, type SkillCapability } from '@mpx/skills/contracts';
import type { Runtime } from './types.js';

export interface RuntimeModelSelection {
  readonly schemaVersion: 1;
  readonly runtime: Runtime;
  readonly provider: string;
  readonly defaultModel: string;
  readonly enabledModels: readonly string[];
}

export type RuntimeAgentModelClass =
  'mechanical' | 'exploration' | 'standard' | 'advanced' | 'frontier';

export interface RuntimeAgentModelMappings {
  readonly schemaVersion: 1;
  readonly runtime: Runtime;
  readonly models: Readonly<Record<RuntimeAgentModelClass, string>>;
}

export type RuntimeFeatureSupport = 'supported' | 'unsupported';
export type RuntimeCapabilityGrantSupport = 'preapproved' | 'unsupported';
export type SemanticSkillCapability = SkillCapability;
export interface RuntimeContentTranslation {
  readonly argumentHint: RuntimeFeatureSupport;
  readonly capabilities: Readonly<{
    readonly support: RuntimeCapabilityGrantSupport;
    readonly mappings: Readonly<Partial<Record<SemanticSkillCapability, readonly string[]>>>;
  }>;
  readonly frontmatter: Readonly<{
    readonly argumentHint: 'argument-hint' | null;
    readonly capabilityGrant: 'allowed-tools' | null;
  }>;
}
export type SemanticAgentCapability =
  'read' | 'search' | 'shell' | 'write' | 'browser' | 'context' | 'web';
export interface RuntimeAgentTranslation {
  readonly aliases: Readonly<Record<string, string>>;
  readonly capabilities: Readonly<{
    readonly mappings: Readonly<Record<SemanticAgentCapability, readonly string[]>>;
  }>;
  readonly frontmatter: Readonly<{
    readonly model: 'model';
    readonly thinking: 'effort' | 'thinking';
    readonly tools: 'tools';
    readonly outputSchema: 'output-schema' | 'output_schema';
    readonly nesting: 'allowed-subagents' | 'allowed_subagents';
  }>;
  readonly separators: Readonly<{ readonly tools: string; readonly nesting: string }>;
  readonly nestingRequiredTools: readonly string[];
}
export interface RuntimeProfiles {
  readonly schemaVersion: 1;
  readonly models: Readonly<{
    readonly claude: Readonly<Record<RuntimeAgentModelClass, string>>;
    readonly pi: Readonly<Record<RuntimeAgentModelClass, string>>;
  }>;
  readonly agentTranslation: Readonly<{
    readonly runtimes: Readonly<Record<Runtime, RuntimeAgentTranslation>>;
  }>;
  readonly contentTranslation: Readonly<{
    readonly nameOnlyDescriptionTemplate: string;
    readonly runtimes: Readonly<Record<Runtime, RuntimeContentTranslation>>;
  }>;
}

const MODEL_CLASSES = ['advanced', 'exploration', 'frontier', 'mechanical', 'standard'] as const;
const RUNTIMES = ['claude', 'pi'] as const;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CLAUDE_ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const NATIVE_TOOL_IDENTIFIER = /^[A-Za-z][A-Za-z0-9_-]{0,127}$/u;
const AGENT_CAPABILITIES = [
  'read',
  'search',
  'shell',
  'write',
  'browser',
  'context',
  'web',
] as const;
const AGENT_IDENTITY = /^mpx-[a-z0-9-]{1,123}$/u;
const AGENT_ALIAS = /^[A-Za-z0-9][A-Za-z0-9-]{0,127}$/u;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function freeze<T extends RuntimeModelSelection>(value: T): T {
  Object.freeze(value.enabledModels);
  return Object.freeze(value);
}

/** Validates the process-local, provider-neutral model selection passed to a runtime adapter. */
export function parseRuntimeModelSelection(value: unknown): RuntimeModelSelection {
  if (!record(value)) {
    throw new TypeError('runtime model selection must be an object');
  }
  const input = value;
  if (
    !exactKeys(input, ['defaultModel', 'enabledModels', 'provider', 'runtime', 'schemaVersion'])
  ) {
    throw new TypeError('runtime model selection has invalid fields');
  }
  if (input.schemaVersion !== 1 || (input.runtime !== 'pi' && input.runtime !== 'claude')) {
    throw new TypeError('runtime model selection schemaVersion/runtime is invalid');
  }
  if (
    typeof input.provider !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(input.provider)
  ) {
    throw new TypeError('runtime model selection provider is invalid');
  }
  if (
    typeof input.defaultModel !== 'string' ||
    !MODEL_ID.test(input.defaultModel) ||
    !input.defaultModel.startsWith(`${input.provider}/`)
  ) {
    throw new TypeError('runtime model selection defaultModel is invalid');
  }
  if (
    !Array.isArray(input.enabledModels) ||
    input.enabledModels.length < 1 ||
    input.enabledModels.length > 64 ||
    input.enabledModels.some(
      (model) =>
        typeof model !== 'string' ||
        !MODEL_ID.test(model) ||
        !model.startsWith(`${input.provider}/`),
    ) ||
    new Set(input.enabledModels).size !== input.enabledModels.length ||
    !input.enabledModels.includes(input.defaultModel)
  ) {
    throw new TypeError('runtime model selection enabledModels/defaultModel is invalid');
  }
  return freeze({
    schemaVersion: 1,
    runtime: input.runtime,
    provider: input.provider,
    defaultModel: input.defaultModel,
    enabledModels: [...input.enabledModels] as string[],
  });
}

/** Parses the single tracked source of semantic-agent mappings for every runtime. */
export function parseRuntimeProfiles(source: string): RuntimeProfiles {
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch (cause) {
    throw new TypeError('runtime profiles must be valid JSON', { cause });
  }
  if (
    !record(input) ||
    !exactKeys(input, ['schemaVersion', 'models', 'agentTranslation', 'contentTranslation']) ||
    input.schemaVersion !== 1
  ) {
    throw new TypeError('runtime profiles have invalid fields');
  }
  if (!record(input.models) || !exactKeys(input.models, RUNTIMES)) {
    throw new TypeError('runtime profiles must exactly cover runtimes');
  }
  const parsed: Record<string, Readonly<Record<RuntimeAgentModelClass, string>>> = {};
  for (const runtime of RUNTIMES) {
    const models = input.models[runtime];
    if (!record(models) || !exactKeys(models, MODEL_CLASSES)) {
      throw new TypeError('runtime profiles must exactly cover semantic model classes');
    }
    const pattern = runtime === 'pi' ? MODEL_ID : CLAUDE_ALIAS;
    if (
      Object.values(models).some(
        (model) => typeof model !== 'string' || model.trim() !== model || !pattern.test(model),
      )
    ) {
      throw new TypeError('runtime profiles contain invalid model mappings');
    }
    parsed[runtime] = Object.freeze({
      mechanical: models.mechanical as string,
      exploration: models.exploration as string,
      standard: models.standard as string,
      advanced: models.advanced as string,
      frontier: models.frontier as string,
    });
  }
  const agentTranslation = input.agentTranslation;
  if (
    !record(agentTranslation) ||
    !exactKeys(agentTranslation, ['runtimes']) ||
    !record(agentTranslation.runtimes) ||
    !exactKeys(agentTranslation.runtimes, RUNTIMES)
  ) {
    throw new TypeError('runtime profiles contain invalid agent translation');
  }
  const agentRuntimeTranslations: Partial<Record<Runtime, RuntimeAgentTranslation>> = {};
  const expectedFields = {
    claude: {
      model: 'model',
      thinking: 'effort',
      tools: 'tools',
      outputSchema: 'output-schema',
      nesting: 'allowed-subagents',
    },
    pi: {
      model: 'model',
      thinking: 'thinking',
      tools: 'tools',
      outputSchema: 'output_schema',
      nesting: 'allowed_subagents',
    },
  } as const;
  for (const runtime of RUNTIMES) {
    const value = agentTranslation.runtimes[runtime];
    if (
      !record(value) ||
      !exactKeys(value, [
        'aliases',
        'capabilities',
        'frontmatter',
        'separators',
        'nestingRequiredTools',
      ]) ||
      !record(value.aliases) ||
      Object.keys(value.aliases).length === 0 ||
      Object.entries(value.aliases).some(
        ([identity, alias]) =>
          !AGENT_IDENTITY.test(identity) ||
          typeof alias !== 'string' ||
          !AGENT_ALIAS.test(alias) ||
          CONTROL.test(alias),
      ) ||
      new Set(Object.values(value.aliases).map((alias) => String(alias).toLowerCase())).size !==
        Object.keys(value.aliases).length ||
      !record(value.capabilities) ||
      !exactKeys(value.capabilities, ['mappings']) ||
      !record(value.capabilities.mappings) ||
      !exactKeys(value.capabilities.mappings, AGENT_CAPABILITIES) ||
      Object.values(value.capabilities.mappings).some(
        (tools) =>
          !Array.isArray(tools) ||
          tools.length === 0 ||
          new Set(tools).size !== tools.length ||
          tools.some((tool) => typeof tool !== 'string' || !NATIVE_TOOL_IDENTIFIER.test(tool)),
      ) ||
      !record(value.frontmatter) ||
      !exactKeys(value.frontmatter, ['model', 'thinking', 'tools', 'outputSchema', 'nesting']) ||
      Object.entries(expectedFields[runtime]).some(
        ([name, expected]) => (value.frontmatter as Record<string, unknown>)[name] !== expected,
      ) ||
      !record(value.separators) ||
      !exactKeys(value.separators, ['tools', 'nesting']) ||
      Object.values(value.separators).some(
        (separator) =>
          typeof separator !== 'string' || separator.length > 8 || CONTROL.test(separator),
      ) ||
      !Array.isArray(value.nestingRequiredTools) ||
      new Set(value.nestingRequiredTools).size !== value.nestingRequiredTools.length ||
      value.nestingRequiredTools.some(
        (tool) => typeof tool !== 'string' || !NATIVE_TOOL_IDENTIFIER.test(tool),
      )
    ) {
      throw new TypeError('runtime profiles contain invalid agent translation');
    }
    agentRuntimeTranslations[runtime] = Object.freeze({
      aliases: Object.freeze({ ...(value.aliases as Record<string, string>) }),
      capabilities: Object.freeze({
        mappings: Object.freeze(
          Object.fromEntries(
            Object.entries(value.capabilities.mappings).map(([capability, tools]) => [
              capability,
              Object.freeze([...(tools as string[])]),
            ]),
          ) as Record<SemanticAgentCapability, readonly string[]>,
        ),
      }),
      frontmatter: Object.freeze({ ...expectedFields[runtime] }),
      separators: Object.freeze({
        tools: value.separators.tools as string,
        nesting: value.separators.nesting as string,
      }),
      nestingRequiredTools: Object.freeze([...(value.nestingRequiredTools as string[])]),
    });
  }

  const translation = input.contentTranslation;
  if (
    !record(translation) ||
    !exactKeys(translation, ['nameOnlyDescriptionTemplate', 'runtimes']) ||
    typeof translation.nameOnlyDescriptionTemplate !== 'string' ||
    !translation.nameOnlyDescriptionTemplate.includes('{{identity}}') ||
    translation.nameOnlyDescriptionTemplate.replaceAll('{{identity}}', '').includes('{{') ||
    translation.nameOnlyDescriptionTemplate.replaceAll('{{identity}}', '').includes('}}') ||
    !record(translation.runtimes) ||
    !exactKeys(translation.runtimes, RUNTIMES)
  ) {
    throw new TypeError('runtime profiles contain invalid content translation');
  }
  const runtimeTranslations: Partial<Record<Runtime, RuntimeContentTranslation>> = {};
  for (const runtime of RUNTIMES) {
    const value = translation.runtimes[runtime];
    if (
      !record(value) ||
      !exactKeys(value, ['argumentHint', 'capabilities', 'frontmatter']) ||
      !['supported', 'unsupported'].includes(value.argumentHint as string) ||
      !record(value.capabilities) ||
      !exactKeys(value.capabilities, ['support', 'mappings']) ||
      !['preapproved', 'unsupported'].includes(value.capabilities.support as string) ||
      !record(value.capabilities.mappings) ||
      Object.values(value.capabilities.mappings).some(
        (tools) =>
          !Array.isArray(tools) ||
          tools.length === 0 ||
          tools.some((tool) => typeof tool !== 'string' || !NATIVE_TOOL_IDENTIFIER.test(tool)),
      ) ||
      !record(value.frontmatter) ||
      !exactKeys(value.frontmatter, ['argumentHint', 'capabilityGrant']) ||
      (value.frontmatter.argumentHint !== null &&
        value.frontmatter.argumentHint !== 'argument-hint') ||
      (value.frontmatter.capabilityGrant !== null &&
        value.frontmatter.capabilityGrant !== 'allowed-tools') ||
      (value.argumentHint === 'supported') !==
        (value.frontmatter.argumentHint === 'argument-hint') ||
      (value.capabilities.support === 'preapproved') !==
        (value.frontmatter.capabilityGrant === 'allowed-tools') ||
      (value.capabilities.support === 'preapproved' &&
        !exactKeys(value.capabilities.mappings, SKILL_CAPABILITIES)) ||
      (value.capabilities.support === 'unsupported' &&
        Object.keys(value.capabilities.mappings).length !== 0)
    ) {
      throw new TypeError('runtime profiles contain invalid content translation');
    }
    runtimeTranslations[runtime] = Object.freeze({
      argumentHint: value.argumentHint as RuntimeFeatureSupport,
      capabilities: Object.freeze({
        support: value.capabilities.support as RuntimeCapabilityGrantSupport,
        mappings: Object.freeze(
          Object.fromEntries(
            Object.entries(value.capabilities.mappings).map(([key, tools]) => [
              key,
              Object.freeze([...(tools as string[])]),
            ]),
          ),
        ),
      }),
      frontmatter: Object.freeze({
        argumentHint: value.frontmatter.argumentHint as 'argument-hint' | null,
        capabilityGrant: value.frontmatter.capabilityGrant as 'allowed-tools' | null,
      }),
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    models: Object.freeze({ claude: parsed.claude!, pi: parsed.pi! }),
    agentTranslation: Object.freeze({
      runtimes: Object.freeze({
        claude: agentRuntimeTranslations.claude!,
        pi: agentRuntimeTranslations.pi!,
      }),
    }),
    contentTranslation: Object.freeze({
      nameOnlyDescriptionTemplate: translation.nameOnlyDescriptionTemplate,
      runtimes: Object.freeze({ claude: runtimeTranslations.claude!, pi: runtimeTranslations.pi! }),
    }),
  });
}

export async function loadRuntimeProfiles(file: string): Promise<RuntimeProfiles> {
  return parseRuntimeProfiles(await readFile(file, 'utf8'));
}

/** Selects one immutable runtime mapping for adapter consumption. */
export function runtimeAgentModelMappings<R extends Runtime>(
  profiles: RuntimeProfiles,
  runtime: R,
): RuntimeAgentModelMappings & { readonly runtime: R } {
  return Object.freeze({ schemaVersion: 1, runtime, models: profiles.models[runtime] });
}

/** Current built-in session selection, independent of semantic agent classes. */
export function defaultRuntimeModelSelection(
  runtime: 'pi',
): RuntimeModelSelection & { readonly runtime: 'pi' };
export function defaultRuntimeModelSelection(
  runtime: 'claude',
): RuntimeModelSelection & { readonly runtime: 'claude' };
export function defaultRuntimeModelSelection(runtime: Runtime): RuntimeModelSelection;
export function defaultRuntimeModelSelection(runtime: Runtime): RuntimeModelSelection {
  const enabledModels =
    runtime === 'pi'
      ? ['openai-codex/gpt-5.6-luna', 'openai-codex/gpt-5.6-sol', 'openai-codex/gpt-5.6-terra']
      : ['anthropic/haiku', 'anthropic/opus', 'anthropic/sonnet'];
  return parseRuntimeModelSelection({
    schemaVersion: 1,
    runtime,
    provider: runtime === 'pi' ? 'openai-codex' : 'anthropic',
    defaultModel: runtime === 'pi' ? 'openai-codex/gpt-5.6-sol' : 'anthropic/opus',
    enabledModels,
  });
}
