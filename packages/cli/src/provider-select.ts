import { nodeRuntime, type Provider } from '@liwencode/core';
import { createAnthropicProvider, createOpenAICompatibleProvider } from '@liwencode/providers';
import { MockProvider } from '@liwencode/testing';
import type { Message } from '@liwencode/core';
import type { CliArgs } from './args';
import { catalogEntry, resolveDefaultModel } from './model-config';

/**
 * Provider resolution for the CLI. `mock:` runs fully offline; real providers
 * need their key in process env (secrets from ~/.liwencode/env are merged at
 * startup — see model-config.loadSecretsIntoEnv).
 */

export interface ProviderSpec {
  provider: string;
  model: string;
}

export function parseModelSpec(spec: string | undefined): ProviderSpec {
  const raw = spec ?? process.env.LIWEN_MODEL ?? 'mock:default';
  const idx = raw.indexOf(':');
  if (idx <= 0) {
    throw new Error(`--model must be <provider>:<model>, got '${raw}' (LW-CLI-001)`);
  }
  return { provider: raw.slice(0, idx), model: raw.slice(idx + 1) };
}

function requireKey(envName: string): string {
  const value = process.env[envName];
  if (value === undefined || value === '') {
    throw new Error(`provider requires ${envName} to be set (LW-CFG-002). Use 'mock:' for offline runs, /model config to set it up, or liwen doctor.`);
  }
  return value;
}

/** Build a Provider from a spec, honoring catalog base URLs and env overrides. */
export function buildProvider(spec: ProviderSpec): Provider & { model: string } {
  const entry = catalogEntry(spec.provider);
  if (entry === undefined) {
    throw new Error(
      `unknown provider '${spec.provider}' (LW-CLI-001). Supported: ${catalogEntryList()}. Run /model config for guided setup.`,
    );
  }
  const runtime = nodeRuntime();
  switch (entry.kind) {
    case 'mock': {
      const scripted: Message[] = mockScriptFromEnv();
      return Object.assign(new MockProvider({ script: scripted.length > 0 ? scripted : defaultMockScript() }), { model: spec.model });
    }
    case 'openai-compatible': {
      const apiKey = requireKey(entry.apiKeyEnv ?? '');
      const baseUrl =
        process.env[`${spec.provider.toUpperCase().replace(/-/g, '_')}_BASE_URL`] ??
        process.env.OPENAI_BASE_URL ??
        entry.baseUrl;
      return Object.assign(
        createOpenAICompatibleProvider({ runtime, baseUrl, apiKey, id: spec.provider }),
        { model: spec.model },
      );
    }
    case 'anthropic': {
      const apiKey = requireKey(entry.apiKeyEnv ?? 'ANTHROPIC_API_KEY');
      const baseUrl = process.env.ANTHROPIC_BASE_URL ?? entry.baseUrl;
      return Object.assign(createAnthropicProvider({ runtime, apiKey, baseUrl }), { model: spec.model });
    }
  }
}

function catalogEntryList(): string {
  return 'mock, deepseek, openai-compatible, anthropic';
}

export function resolveProvider(
  args: CliArgs,
  deps: { mockProvider: (script: (Message | ((req: { messages: Message[] }, turn: number) => Message))[]) => Provider },
  overrides?: { spec?: ProviderSpec },
): Provider & { model: string } {
  if (overrides?.spec !== undefined) return buildProvider(overrides.spec);
  const spec = parseModelSpec(args.model);
  if (spec.provider === 'mock') {
    const scripted: Message[] = mockScriptFromEnv();
    const provider = deps.mockProvider(scripted.length > 0 ? scripted : defaultMockScript());
    return Object.assign(provider, { model: spec.model });
  }
  return buildProvider(spec);
}

export { resolveDefaultModel };

function defaultMockScript(): Message[] {
  return [
    {
      id: 'mock_1',
      role: 'assistant',
      content: [{ type: 'text', text: 'MockProvider：未配置剧本。设置 LIWEN_MOCK_SCRIPT=<JSON 消息数组> 可获得确定性输出；或用 /model config 配置真实模型。' }],
      meta: { createdAt: 0 },
    },
  ];
}

function mockScriptFromEnv(): Message[] {
  const raw = process.env.LIWEN_MOCK_SCRIPT;
  if (raw === undefined || raw === '') return [];
  try {
    const parsed = JSON.parse(raw) as Message[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
