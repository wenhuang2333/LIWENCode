import { nodeRuntime, type Provider } from '@liwencode/core';
import { createAnthropicProvider, createOpenAICompatibleProvider } from '@liwencode/providers';
import type { Message } from '@liwencode/core';
import type { CliArgs } from './args';

/**
 * Provider resolution for the CLI. `mock:` runs fully offline (scripted by
 * env LIWEN_MOCK_SCRIPT or a default echo); real providers come from env
 * keys and never log or persist them.
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

export function resolveProvider(
  args: CliArgs,
  deps: { mockProvider: (script: (Message | ((req: { messages: Message[] }, turn: number) => Message))[]) => Provider },
): Provider & { model: string } {
  const spec = parseModelSpec(args.model);
  const runtime = nodeRuntime();

  switch (spec.provider) {
    case 'mock': {
      const scripted: Message[] = mockScriptFromEnv();
      const provider = deps.mockProvider(scripted.length > 0 ? scripted : defaultMockScript());
      return Object.assign(provider, { model: spec.model });
    }
    case 'openai-compatible': {
      const apiKey = requireKey('OPENAI_API_KEY');
      return Object.assign(
        createOpenAICompatibleProvider({
          runtime,
          baseUrl: process.env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
          apiKey,
          id: 'openai-compatible',
        }),
        { model: spec.model },
      );
    }
    case 'deepseek': {
      const apiKey = requireKey('DEEPSEEK_API_KEY');
      return Object.assign(
        createOpenAICompatibleProvider({
          runtime,
          baseUrl: process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com/v1',
          apiKey,
          id: 'deepseek',
        }),
        { model: spec.model },
      );
    }
    case 'anthropic': {
      const apiKey = requireKey('ANTHROPIC_API_KEY');
      const baseUrl = process.env.ANTHROPIC_BASE_URL;
      return Object.assign(
        createAnthropicProvider({ runtime, apiKey, ...(baseUrl !== undefined ? { baseUrl } : {}) }),
        { model: spec.model },
      );
    }
    default:
      throw new Error(
        `unknown provider '${spec.provider}' (LW-CLI-001). Supported: mock, openai-compatible, deepseek, anthropic`,
      );
  }
}

function requireKey(envName: string): string {
  const value = process.env[envName];
  if (value === undefined || value === '') {
    throw new Error(`provider requires ${envName} to be set (LW-CFG-002). Use 'mock:' for offline runs or liwen doctor.`);
  }
  return value;
}

function defaultMockScript(): Message[] {
  return [
    {
      id: 'mock_1',
      role: 'assistant',
      content: [{ type: 'text', text: 'MockProvider: no script configured. Set LIWEN_MOCK_SCRIPT=<json array of messages> for deterministic output.' }],
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
