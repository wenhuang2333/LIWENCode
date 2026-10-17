/**
 * 信息类命令的 TUI 面板内容（/status /cost /tools /permissions /doctor /
 * /model /manage /help）。TUI 通过 printAbove 输出，REPL 直接逐行输出；
 * 纯函数，便于单测。
 */

import { C, badge, bar, kv, panel, section, table } from './tui/panel.js';

export interface StatusData {
  sessionId: string;
  model: string;
  mode: string;
  tier: string;
  activeGroup: string | undefined;
  turns: number;
  historyCount: number;
  contextTokens: number;
  contextWindow: number;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export function statusPanel(d: StatusData): string[] {
  const ratio = d.contextWindow > 0 ? d.contextTokens / d.contextWindow : 0;
  const pct = Math.min(100, Math.round(ratio * 100));
  return panel('status', [
    section('session'),
    kv('session', C.cyan(d.sessionId), 10),
    kv('model', C.bold(d.model), 10),
    kv('mode', `${C.yellow(d.mode)} ${C.dim(`(${d.tier})`)}`, 10),
    ...(d.activeGroup !== undefined ? [kv('agents', `${C.magenta('@' + d.activeGroup)} ${C.dim('(group active)')}`, 10)] : []),
    '',
    section('progress'),
    kv('turns', `${C.bold(String(d.turns))} ${C.dim(`assistant messages · ${d.historyCount} history entries`)}`, 10),
    kv('context', `${C.bold(formatTok(d.contextTokens))} / ${formatTok(d.contextWindow)}  ${bar(ratio, 24, ratio > 0.85 ? 196 : ratio > 0.6 ? 214 : 45)} ${C.dim(`${pct}%`)}`, 10),
    kv('usage', `${C.dim(`${d.requests} requests · ${formatTok(d.inputTokens)} in / ${formatTok(d.outputTokens)} out`)}`, 10),
  ]);
}

export interface CostData {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
  priced: boolean;
}

export function costPanel(d: CostData): string[] {
  const total = d.inputTokens + d.outputTokens + d.cacheReadTokens;
  const share = (n: number) => (total > 0 ? n / total : 0);
  return panel('cost', [
    section('tokens'),
    kv('input', `${C.bold(formatTok(d.inputTokens))}  ${bar(share(d.inputTokens), 20, 45)}`, 10),
    kv('output', `${C.bold(formatTok(d.outputTokens))}  ${bar(share(d.outputTokens), 20, 46)}`, 10),
    kv('cache rd', `${C.bold(formatTok(d.cacheReadTokens))}  ${bar(share(d.cacheReadTokens), 20, 213)}`, 10),
    ...(d.cacheWriteTokens > 0 ? [kv('cache wr', C.bold(formatTok(d.cacheWriteTokens)), 10)] : []),
    kv('total', C.bold(formatTok(total)), 10),
    '',
    section('billing'),
    kv('requests', String(d.requests), 10),
    kv('cost', d.priced ? C.green(`$${d.costUsd.toFixed(4)}`) : C.dim('(provider provides no pricing)'), 10),
  ]);
}

export interface ToolInfo {
  name: string;
  risk: string;
  readOnly: boolean;
  concurrencySafe: boolean;
}

export function toolsPanel(tools: readonly ToolInfo[]): string[] {
  const rows = tools.map((t) => [
    C.cyan(t.name),
    t.risk === 'exec' ? C.yellow(t.risk) : t.risk === 'write' ? C.magenta(t.risk) : C.green(t.risk),
    t.readOnly ? 'yes' : C.dim('no'),
    t.concurrencySafe ? 'yes' : C.dim('no'),
  ]);
  return panel('tools', [section(`${tools.length} registered`), ...table(['name', 'risk', 'readonly', 'parallel'], rows)]);
}

export interface PermRule {
  effect: string;
  tool: string;
  command?: string;
  path?: string;
}

export function permissionsPanel(mode: string, tier: string, rules: readonly PermRule[]): string[] {
  const rows = rules.map((r) => [
    r.effect === 'allow' ? C.green('allow') : C.red('deny'),
    C.cyan(r.tool),
    r.command !== undefined ? C.dim(`cmd=${r.command}`) : '',
    r.path !== undefined ? C.dim(`path=${r.path}`) : '',
  ]);
  return panel('permissions', [
    section('mode'),
    `${badge(mode, mode === 'bypass' ? 46 : mode === 'strict' ? 196 : 214)}  ${C.dim(tier)}`,
    '',
    section(`session rules (${rules.length})`),
    ...(rules.length > 0 ? table(['effect', 'tool', 'match'], rows, { headerColor: 45 }) : [C.dim('(none — use /permissions allow|deny <tool>)')]),
  ]);
}

export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export function doctorPanel(checks: readonly DoctorCheck[]): string[] {
  const rows = checks.map((c) => [
    c.status === 'ok' ? C.green('✔') : c.status === 'warn' ? C.yellow('!') : C.red('✘'),
    C.cyan(c.name),
    c.status === 'fail' ? C.red(c.detail) : C.dim(c.detail),
  ]);
  const failed = checks.filter((c) => c.status === 'fail').length;
  return panel('doctor', [
    section(failed === 0 ? 'all checks passed' : `${failed} check(s) failed`),
    ...table(['', 'check', 'detail'], rows, { divider: false }),
  ]);
}

export interface ModelOverview {
  current: string;
  activeGroup: string | undefined;
  catalog: { id: string; label: string; models: string[]; keySet: boolean }[];
  profiles: { name: string; protocol: string; model: string; keySet: boolean }[];
  groups: { name: string; hyaki: string; sota: string; common: string }[];
}

export function modelPanel(o: ModelOverview): string[] {
  const catRows = o.catalog.map((p) => [
    C.cyan(p.id),
    C.dim(p.models.join(' · ')),
    p.keySet ? C.green('key ✔') : C.yellow('key ✘'),
  ]);
  const profRows = o.profiles.map((p) => [C.magenta(`@${p.name}`), C.dim(p.protocol), p.model, p.keySet ? C.green('✔') : C.yellow('✘')]);
  const groupRows = o.groups.map((g) => [
    `${g.name === o.activeGroup ? C.green('●') : C.dim('○')} ${C.bold('@' + g.name)}`,
    C.c256(45, g.hyaki),
    C.c256(213, g.sota),
    C.c256(46, g.common),
  ]);
  return panel('model', [
    section('current'),
    `${C.bold(o.current)}${o.activeGroup !== undefined ? `   ${C.dim('agents:')} ${C.magenta('@' + o.activeGroup)}` : ''}`,
    '',
    section('built-in providers'),
    ...table(['provider', 'models (select with provider:model)', 'auth'], catRows),
    '',
    section(`custom profiles (${o.profiles.length})`),
    ...(o.profiles.length > 0 ? table(['profile', 'protocol', 'model', 'key'], profRows) : [C.dim('(none — run /setup to create one)')]),
    '',
    section(`agent groups (${o.groups.length})`),
    ...(o.groups.length > 0 ? table(['group', 'hyaki', 'sota', 'common'], groupRows) : [C.dim('(none — run /set-agents to build one)')]),
    '',
    C.dim('/model use <provider:model | @profile | @group>  ·  /setup  ·  /set-agents  ·  /manage'),
  ]);
}

export function managePanel(profiles: { name: string; protocol: string; model: string; keySet: boolean; updatedAt: number }[]): string[] {
  const rows = profiles.map((p) => [
    C.magenta(`@${p.name}`),
    C.dim(p.protocol),
    p.model,
    p.keySet ? C.green('✔') : C.yellow('✘'),
    C.dim(new Date(p.updatedAt).toLocaleString()),
  ]);
  return panel('manage', [
    section(`${profiles.length} model profile(s)`),
    ...table(['profile', 'protocol', 'model', 'key', 'updated'], rows),
    '',
    C.dim('edit / delete: /manage <name>'),
  ]);
}

export interface HelpEntry {
  usage: string;
  summary: string;
}

export function helpPanel(available: readonly HelpEntry[], planned: readonly { name: string; summary: string; since: string }[]): string[] {
  return panel('help', [
    section('commands'),
    ...table(['command', 'summary'], available.map((c) => [C.cyan(c.usage), c.summary])),
    '',
    section('input syntax'),
    ...table(
      ['syntax', 'meaning'],
      [
        [C.cyan('@path'), 'attach file contents to the prompt (max 8 files, 500 lines each)'],
        [C.cyan('!cmd'), 'propose a shell command (still permission-gated)'],
        [C.cyan('/cmd'), 'slash commands: ↑↓ palette · Tab/Enter complete · Esc close'],
        [C.cyan('Ctrl+C'), 'cancel current turn; press twice when idle to quit'],
      ],
      { divider: false },
    ),
    '',
    section('planned'),
    ...table(['command', 'plan'], planned.map((p) => [C.dim(p.name), C.dim(`${p.summary} (${p.since})`)]), { divider: false }),
  ]);
}

function formatTok(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
