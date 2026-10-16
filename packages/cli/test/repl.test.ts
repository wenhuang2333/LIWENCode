import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Piped-stdin REPL smoke tests: drive the real interactive loop through a
 * pipe (non-TTY ⇒ headless permission policy applies, BR-042) and assert on
 * its rendered output. HOME is isolated per test.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const tsx = path.join(repoRoot, 'node_modules', '.bin', 'tsx');
const entry = path.join(repoRoot, 'packages', 'cli', 'src', 'main.ts');

function runRepl(
  commands: string[],
  options: { env?: Record<string, string | undefined>; argv?: string[]; cwd?: string } = {},
): { stdout: string; code: number } {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'liwen-repl-'));
  try {
    const stdout = execFileSync(tsx, [entry, ...(options.argv ?? [])], {
      input: commands.join('\n'),
      encoding: 'utf8',
      timeout: 60_000,
      cwd: options.cwd ?? repoRoot,
      env: {
        ...process.env,
        HOME: home,
        LIWEN_MODEL: 'mock:default',
        ...options.env,
      },
    });
    // strip ANSI escapes so assertions match plain text
    return { stdout: stdout.replace(/\x1b\[[0-9;]*m/g, ''), code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { stdout: (err.stdout ?? '').replace(/\x1b\[[0-9;]*m/g, ''), code: err.status ?? 1 };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

describe('interactive REPL (piped smoke, FR-130/137)', () => {
  it('banner + /help + /status + /exit', () => {
    const { stdout } = runRepl(['/help', '/status', '/exit']);
    expect(stdout).toContain('LIWENCode v0.1 交互模式');
    expect(stdout).toContain('/model');
    expect(stdout).toContain('会话:');
    expect(stdout).toContain('mock:default');
    expect(stdout).toContain('再见');
  }, 90_000);

  it('mock conversation renders streamed reply', () => {
    const script = JSON.stringify([
      { id: 'a1', role: 'assistant', content: [{ type: 'text', text: '你好，来自 mock 的回复' }], meta: { createdAt: 0 } },
    ]);
    const { stdout } = runRepl(['打个招呼', '/exit'], { env: { LIWEN_MOCK_SCRIPT: script } });
    expect(stdout).toContain('你好，来自 mock 的回复');
    expect(stdout).toContain('再见');
  }, 90_000);

  it('headless permission policy denies write with LW-CLI-002 notice (BR-042)', () => {
    const script = JSON.stringify([
      { id: 'a1', role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'write', input: { path: 'x.txt', content: 'nope' } }], meta: { createdAt: 0 } },
      { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '写入被拒' }], meta: { createdAt: 0 } },
    ]);
    const { stdout } = runRepl(['写点东西', '/exit'], { env: { LIWEN_MOCK_SCRIPT: script } });
    expect(stdout).toContain('无人值守');
    expect(stdout).toContain('LW-CLI-002');
  }, 90_000);

  it('/model show + /model list render catalog and key status', () => {
    const { stdout } = runRepl(['/model', '/model list', '/exit']);
    expect(stdout).toContain('当前模型');
    expect(stdout).toContain('deepseek:deepseek-chat');
    expect(stdout).toContain('Provider 目录');
  }, 90_000);

  it('/permissions shows mode and switches it (bare launch starts at strict)', () => {
    const { stdout } = runRepl(['/permissions', '/permissions mode acceptEdits', '/permissions', '/exit']);
    expect(stdout).toContain('权限模式: strict');
    expect(stdout).toContain('已切换为 acceptEdits');
    expect(stdout).toContain('权限模式: acceptEdits');
  }, 90_000);

  it('!command runs read-only shell through the gate; dangerous is refused', () => {
    const { stdout } = runRepl(['!echo liwen-shell-ok', '!rm -rf /', '/exit'], { argv: ['--HuangAura'] });
    expect(stdout).toContain('liwen-shell-ok');
    expect(stdout).toContain('拒绝');
    expect(stdout).toContain('LW-PERM-004');
  }, 90_000);

  it('planned commands are clearly stubbed', () => {
    const { stdout } = runRepl(['/mcp', '/goal', '/exit']);
    expect(stdout).toContain('后续里程碑');
  }, 90_000);

  it('/doctor inside the REPL matches the doctor subcommand', () => {
    const { stdout } = runRepl(['/doctor', '/exit']);
    expect(stdout).toContain('node');
    expect(stdout).toContain('workspace-writable');
  }, 90_000);

  // ── three-tier permission behavior (strict / --HuangAura / --WenNova) ──

  const readScript = JSON.stringify([
    { id: 'a1', role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'read', input: { path: 'tier.txt' } }], meta: { createdAt: 0 } },
    { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '读取完成' }], meta: { createdAt: 0 } },
  ]);
  const writeScript = JSON.stringify([
    { id: 'a1', role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'write', input: { path: 'tier-out.txt', content: 'written' } }], meta: { createdAt: 0 } },
    { id: 'a2', role: 'assistant', content: [{ type: 'text', text: '写入完成' }], meta: { createdAt: 0 } },
  ]);

  it('bare launch (strict tier): even reads are asked → headless auto-deny (LW-CLI-002)', () => {
    const { stdout } = runRepl(['读一下 tier.txt', '/exit'], { env: { LIWEN_MOCK_SCRIPT: readScript } });
    expect(stdout).toContain('无人值守');
    expect(stdout).toContain('LW-CLI-002');
    expect(stdout).toContain('读取完成'); // model still recovers and finishes
  }, 90_000);

  it('--HuangAura: reads pass without asking, writes still ask', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liwen-tier-'));
    try {
      fs.writeFileSync(path.join(dir, 'tier.txt'), 'huang-aura-read-ok\n');
      const read = runRepl(['读一下 tier.txt', '/exit'], {
        argv: ['--HuangAura', '--cwd', dir],
        env: { LIWEN_MOCK_SCRIPT: readScript },
      });
      expect(read.stdout).not.toContain('LW-CLI-002'); // reads never asked
      expect(read.stdout).toContain('huang-aura-read-ok');

      const write = runRepl(['写入 tier-out.txt', '/exit'], {
        argv: ['--HuangAura', '--cwd', dir],
        env: { LIWEN_MOCK_SCRIPT: writeScript },
      });
      expect(write.stdout).toContain('LW-CLI-002'); // writes still ask → deny headless
      expect(fs.existsSync(path.join(dir, 'tier-out.txt'))).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);

  it('--WenNova: writes execute without any asking', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'liwen-tier-'));
    try {
      const write = runRepl(['写入 tier-out.txt', '/exit'], {
        argv: ['--WenNova', '--cwd', dir],
        env: { LIWEN_MOCK_SCRIPT: writeScript },
      });
      expect(write.stdout).not.toContain('LW-CLI-002'); // nothing asked under WenNova
      expect(write.stdout).toContain('Wrote');
      expect(fs.existsSync(path.join(dir, 'tier-out.txt'))).toBe(true);
      expect(fs.readFileSync(path.join(dir, 'tier-out.txt'), 'utf8')).toBe('written');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 90_000);

  it('banner shows the active permission tier', () => {
    const strict = runRepl(['/exit']);
    expect(strict.stdout).toContain('严格档');
    const nova = runRepl(['/exit'], { argv: ['--WenNova'] });
    expect(nova.stdout).toContain('完全权限');
    const aura = runRepl(['/exit'], { argv: ['--HuangAura'] });
    expect(aura.stdout).toContain('部分权限');
  }, 120_000);
});
