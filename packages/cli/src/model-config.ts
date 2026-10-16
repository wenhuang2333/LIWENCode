import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Provider catalog + user-facing model configuration (FR-135 /model).
 *
 * Storage layout (never committed; secrets never enter the repo or sessions):
 * - ~/.liwencode/config.json  — non-secret: default model, apiKeyEnv ref, baseUrl
 * - ~/.liwencode/env          — KEY=VALUE secrets, chmod 0600, loaded at startup
 */

export interface ProviderCatalogEntry {
  id: string;
  label: string;
  kind: 'mock' | 'openai-compatible' | 'anthropic';
  apiKeyEnv: string | undefined;
  baseUrl: string;
  models: string[];
  needsKey: boolean;
}

export const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    id: 'mock',
    label: 'Mock（离线脚本，无需密钥）',
    kind: 'mock',
    apiKeyEnv: undefined,
    baseUrl: '',
    models: ['default'],
    needsKey: false,
  },
  {
    id: 'deepseek',
    label: 'DeepSeek（OpenAI 兼容）',
    kind: 'openai-compatible',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    needsKey: true,
  },
  {
    id: 'openai-compatible',
    label: 'OpenAI 及兼容端点',
    kind: 'openai-compatible',
    apiKeyEnv: 'OPENAI_API_KEY',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini'],
    needsKey: true,
  },
  {
    id: 'anthropic',
    label: 'Anthropic（原生 Messages）',
    kind: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com/v1',
    models: ['claude-sonnet-4', 'claude-haiku-4'],
    needsKey: true,
  },
];

export function catalogEntry(providerId: string): ProviderCatalogEntry | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === providerId);
}

// ── paths ────────────────────────────────────────────────────────────────

export function liwenHome(envHome: string | undefined = process.env.HOME): string {
  return path.join(envHome ?? '.', '.liwencode');
}
export function userConfigPath(home?: string): string {
  return path.join(liwenHome(home), 'config.json');
}
export function envFilePath(home?: string): string {
  return path.join(liwenHome(home), 'env');
}

// ── user config (non-secret) ─────────────────────────────────────────────

export interface UserModelConfig {
  provider: string;
  name: string;
  apiKeyEnv?: string;
  baseUrl?: string;
}

export interface UserConfigFile {
  model?: UserModelConfig;
  permissionMode?: 'strict' | 'default' | 'acceptEdits' | 'plan' | 'bypass';
}

export function readUserConfig(home?: string): UserConfigFile {
  const file = userConfigPath(home);
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as UserConfigFile;
  } catch {
    return {};
  }
}

export function writeUserConfig(config: UserConfigFile, home?: string): void {
  const dir = liwenHome(home);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(userConfigPath(home), `${JSON.stringify(config, null, 2)}\n`);
}

/** Resolve the default model spec: flag > env > user config > mock. */
export function resolveDefaultModel(flagModel: string | undefined, home?: string): { provider: string; name: string } {
  if (flagModel !== undefined && flagModel.includes(':')) {
    const [provider, name] = flagModel.split(':');
    return { provider: provider ?? 'mock', name: name ?? 'default' };
  }
  const env = process.env.LIWEN_MODEL;
  if (env !== undefined && env.includes(':')) {
    const [provider, name] = env.split(':');
    return { provider: provider ?? 'mock', name: name ?? 'default' };
  }
  const saved = readUserConfig(home).model;
  if (saved !== undefined) return { provider: saved.provider, name: saved.name };
  return { provider: 'mock', name: 'default' };
}

// ── secrets file (KEY=VALUE, 0600) ───────────────────────────────────────

/** Parse KEY=VALUE lines; '#' comments and blanks ignored. */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (key.length > 0) out[key] = value;
  }
  return out;
}

export function formatEnvFile(entries: Record<string, string>): string {
  return Object.entries(entries)
    .map(([k, v]) => `${k}=${v}\n`)
    .join('');
}

export function writeEnvFile(entries: Record<string, string>, home?: string): void {
  const dir = liwenHome(home);
  fs.mkdirSync(dir, { recursive: true });
  const file = envFilePath(home);
  fs.writeFileSync(file, formatEnvFile(entries), { mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    /* best-effort on exotic filesystems */
  }
}

/** Merge ~/.liwencode/env into process env without overriding real env (BR-024 spirit). */
export function loadSecretsIntoEnv(home?: string): number {
  let count = 0;
  try {
    const parsed = parseEnvFile(fs.readFileSync(envFilePath(home), 'utf8'));
    for (const [k, v] of Object.entries(parsed)) {
      if (process.env[k] === undefined || process.env[k] === '') {
        process.env[k] = v;
        count += 1;
      }
    }
  } catch {
    /* no env file — fine */
  }
  return count;
}

export function maskKey(value: string | undefined): string {
  if (value === undefined || value === '') return '(未设置)';
  if (value.length <= 10) return `${value.slice(0, 2)}****`;
  return `${value.slice(0, 5)}…${value.slice(-4)} (已设置)`;
}

export function keyStatusOf(entry: ProviderCatalogEntry, home?: string): { set: boolean; source: 'process-env' | 'env-file' | 'none' } {
  if (!entry.needsKey || entry.apiKeyEnv === undefined) return { set: true, source: 'process-env' };
  const name = entry.apiKeyEnv;
  if (process.env[name] !== undefined && process.env[name] !== '') return { set: true, source: 'process-env' };
  try {
    const parsed = parseEnvFile(fs.readFileSync(envFilePath(home), 'utf8'));
    if (parsed[name] !== undefined && parsed[name] !== '') return { set: true, source: 'env-file' };
  } catch {
    /* no file */
  }
  return { set: false, source: 'none' };
}
