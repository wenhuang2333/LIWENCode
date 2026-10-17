/**
 * 信息类命令的 TUI 面板内容（/status /cost /tools /permissions /doctor /
 * /model /manage /help）。TUI 通过 printAbove 输出，REPL 直接逐行输出；
 * 纯函数，便于单测。所有标签走 i18n（数据值保持原样）。
 */

import { t } from './i18n/index.js';
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
  return panel(t('panel.status'), [
    section(t('sect.session')),
    kv(t('tbl.session'), C.cyan(d.sessionId), 10),
    kv(t('tbl.model'), C.bold(d.model), 10),
    kv(t('sect.mode'), `${C.yellow(d.mode)} ${C.dim(`(${d.tier})`)}`, 10),
    ...(d.activeGroup !== undefined ? [kv(t('val.agents'), `${C.magenta('@' + d.activeGroup)} ${C.dim(t('val.groupActive'))}`, 10)] : []),
    '',
    section(t('sect.progress')),
    kv(t('tbl.turns'), `${C.bold(String(d.turns))} ${C.dim(t('val.assistantMessages', { n: d.historyCount }))}`, 10),
    kv(t('tbl.context'), `${C.bold(formatTok(d.contextTokens))} / ${formatTok(d.contextWindow)}  ${bar(ratio, 24, ratio > 0.85 ? 196 : ratio > 0.6 ? 214 : 45)} ${C.dim(`${pct}%`)}`, 10),
    kv(t('tbl.usage'), `${C.dim(t('val.requestsInOut', { requests: d.requests, input: formatTok(d.inputTokens), output: formatTok(d.outputTokens) }))}`, 10),
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
  return panel(t('panel.cost'), [
    section(t('sect.tokens')),
    kv(t('tbl.input'), `${C.bold(formatTok(d.inputTokens))}  ${bar(share(d.inputTokens), 20, 45)}`, 10),
    kv(t('tbl.output'), `${C.bold(formatTok(d.outputTokens))}  ${bar(share(d.outputTokens), 20, 46)}`, 10),
    kv(t('tbl.cacheRd'), `${C.bold(formatTok(d.cacheReadTokens))}  ${bar(share(d.cacheReadTokens), 20, 213)}`, 10),
    ...(d.cacheWriteTokens > 0 ? [kv(t('tbl.cacheWr'), C.bold(formatTok(d.cacheWriteTokens)), 10)] : []),
    kv(t('tbl.total'), C.bold(formatTok(total)), 10),
    '',
    section(t('sect.billing')),
    kv(t('tbl.requests'), String(d.requests), 10),
    kv(t('tbl.cost'), d.priced ? C.green(`$${d.costUsd.toFixed(4)}`) : C.dim(t('val.noPricing')), 10),
  ]);
}

export interface ToolInfo {
  name: string;
  risk: string;
  readOnly: boolean;
  concurrencySafe: boolean;
}

export function toolsPanel(tools: readonly ToolInfo[]): string[] {
  const rows = tools.map((tool) => [
    C.cyan(tool.name),
    tool.risk === 'exec' ? C.yellow(tool.risk) : tool.risk === 'write' ? C.magenta(tool.risk) : C.green(tool.risk),
    tool.readOnly ? t('val.yes') : C.dim(t('val.no')),
    tool.concurrencySafe ? t('val.yes') : C.dim(t('val.no')),
  ]);
  return panel(t('panel.tools'), [
    section(t('val.registered', { n: tools.length })),
    ...table([t('tbl.name'), t('tbl.risk'), t('tbl.readonly'), t('tbl.parallel')], rows),
  ]);
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
  return panel(t('panel.permissions'), [
    section(t('sect.mode')),
    `${badge(mode, mode === 'bypass' ? 46 : mode === 'strict' ? 196 : 214)}  ${C.dim(tier)}`,
    '',
    section(t('val.sessionRules', { n: rules.length })),
    ...(rules.length > 0 ? table([t('tbl.effect'), t('tbl.tool'), t('tbl.match')], rows, { headerColor: 45 }) : [C.dim(t('val.noneRules'))]),
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
  return panel(t('panel.doctor'), [
    section(failed === 0 ? t('val.allChecksPassed') : t('val.checksFailed', { n: failed })),
    ...table(['', t('tbl.check'), t('tbl.detail')], rows, { divider: false }),
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
    p.keySet ? C.green(`${t('tbl.key')} ✔`) : C.yellow(`${t('tbl.key')} ✘`),
  ]);
  const profRows = o.profiles.map((p) => [C.magenta(`@${p.name}`), C.dim(p.protocol), p.model, p.keySet ? C.green('✔') : C.yellow('✘')]);
  const groupRows = o.groups.map((g) => [
    `${g.name === o.activeGroup ? C.green('●') : C.dim('○')} ${C.bold('@' + g.name)}`,
    C.c256(45, g.hyaki),
    C.c256(213, g.sota),
    C.c256(46, g.common),
  ]);
  return panel(t('panel.model'), [
    section(t('sect.current')),
    `${C.bold(o.current)}${o.activeGroup !== undefined ? `   ${C.dim(t('val.agents'))} ${C.magenta('@' + o.activeGroup)}` : ''}`,
    '',
    section(t('sect.providers')),
    ...table([t('tbl.provider'), t('tbl.models'), t('tbl.auth')], catRows),
    '',
    section(t('sect.profiles', { n: o.profiles.length })),
    ...(o.profiles.length > 0 ? table([t('tbl.profile'), t('tbl.protocol'), t('tbl.model'), t('tbl.key')], profRows) : [C.dim(t('val.noneProfiles'))]),
    '',
    section(t('sect.groups', { n: o.groups.length })),
    ...(o.groups.length > 0 ? table([t('tbl.group'), 'hyaki', 'sota', 'common'], groupRows) : [C.dim(t('val.noneGroups'))]),
    '',
    C.dim(t('val.modelUseHint')),
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
  return panel(t('panel.manage'), [
    section(t('val.profilesCount', { n: profiles.length })),
    ...table([t('tbl.profile'), t('tbl.protocol'), t('tbl.model'), t('tbl.key'), t('tbl.updated')], rows),
    '',
    C.dim(t('val.manageHint')),
  ]);
}

export interface HelpEntry {
  usage: string;
  summary: string;
}

export function helpPanel(available: readonly HelpEntry[], planned: readonly { name: string; summary: string; since: string }[]): string[] {
  return panel(t('panel.help'), [
    section(t('sect.commands')),
    ...table([t('tbl.command'), t('tbl.summary')], available.map((c) => [C.cyan(c.usage), c.summary])),
    '',
    section(t('sect.syntax')),
    ...table(
      [t('tbl.syntax'), t('tbl.meaning')],
      [
        [C.cyan('@path'), t('val.helpAt')],
        [C.cyan('!cmd'), t('val.helpBang')],
        [C.cyan('/cmd'), t('val.helpSlash')],
        [C.cyan('Ctrl+C'), t('val.helpCtrlC')],
      ],
      { divider: false },
    ),
    '',
    section(t('sect.planned')),
    ...table([t('tbl.command'), t('tbl.plan')], planned.map((p) => [C.dim(p.name), C.dim(t('val.plannedLine', { summary: p.summary, since: p.since }))]), { divider: false }),
  ]);
}

function formatTok(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
