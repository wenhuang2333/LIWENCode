import * as fs from 'node:fs';
import { parseModelSpec } from './provider-select';

/**
 * liwen doctor (FR-173): runs with NO provider keys. Checks Node version,
 * workspace writability, config presence and provider env references —
 * printing only whether keys are *set*, never their values (BR-023).
 */

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export function runDoctor(cwd: string): DoctorCheck[] {
  const checks: DoctorCheck[] = [];

  const major = Number(process.versions.node.split('.')[0]);
  checks.push(
    major >= 22
      ? { name: 'node', status: 'ok', detail: `Node ${process.versions.node} (≥22 required)` }
      : { name: 'node', status: 'fail', detail: `Node ${process.versions.node} is below the required 22 LTS` },
  );

  checks.push({ name: 'platform', status: 'ok', detail: `${process.platform} ${process.arch}` });
  checks.push({ name: 'workspace', status: 'ok', detail: cwd });

  try {
    const probe = `${cwd}/.liwencode-doctor-probe`;
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    checks.push({ name: 'workspace-writable', status: 'ok', detail: 'can create files' });
  } catch (e) {
    checks.push({
      name: 'workspace-writable',
      status: 'fail',
      detail: `cannot write: ${e instanceof Error ? e.message : String(e)}`,
    });
  }

  const userConfig = `${process.env.HOME ?? ''}/.liwencode/config.json`;
  const projectConfig = `${cwd}/.liwencode/config.json`;
  const userConfigExists = fs.existsSync(userConfig);
  const projectConfigExists = fs.existsSync(projectConfig);
  checks.push({
    name: 'config-user',
    status: userConfigExists ? 'ok' : 'warn',
    detail: userConfigExists ? `${userConfig} (present)` : `${userConfig} (absent — defaults apply)`,
  });
  checks.push({
    name: 'config-project',
    status: projectConfigExists ? 'warn' : 'ok',
    detail: projectConfigExists
      ? `${projectConfig} present — first-use trust check applies (BR-043, LW-CFG-003)`
      : `${projectConfig} (absent)`,
  });

  const providers: [string, string][] = [
    ['OPENAI_API_KEY', 'openai-compatible'],
    ['DEEPSEEK_API_KEY', 'deepseek'],
    ['ANTHROPIC_API_KEY', 'anthropic'],
  ];
  for (const [envName, label] of providers) {
    const set = process.env[envName] !== undefined && process.env[envName] !== '';
    checks.push({
      name: `provider-${label}`,
      status: set ? 'ok' : 'warn',
      detail: set ? `${envName} is set (value hidden)` : `${envName} not set — use mock: provider for offline runs`,
    });
  }

  try {
    const spec = parseModelSpec(undefined);
    checks.push({ name: 'default-model', status: 'ok', detail: `${spec.provider}:${spec.model}` });
  } catch (e) {
    checks.push({
      name: 'default-model',
      status: 'fail',
      detail: e instanceof Error ? e.message : String(e),
    });
  }

  return checks;
}

export function formatDoctor(checks: DoctorCheck[]): string {
  const icon = { ok: '✔', warn: '!', fail: '✘' } as const;
  return checks.map((c) => `${icon[c.status]} ${c.name.padEnd(20)} ${c.detail}`).join('\n');
}
