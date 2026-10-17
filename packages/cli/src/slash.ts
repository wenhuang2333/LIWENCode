/**
 * Slash-command parsing and metadata (FR-137). Pure logic — unit-testable
 * without a terminal. Handlers live in interactive.ts (REPL) and tui/tui.ts.
 */

import type { PermissionMode } from '@liwencode/core';

export interface SlashCommand {
  name: string;
  args: string[];
  raw: string;
}

export interface CommandDoc {
  name: string;
  usage: string;
  summary: string;
  since: 'v0.1' | 'M2+' | 'M3+' | 'M4+';
}

/** Commands available in v0.1 (implemented) plus planned ones (stubbed). */
export const COMMAND_DOCS: readonly CommandDoc[] = [
  { name: '/help', usage: '/help [命令]', summary: '显示全部命令或某命令的详细用法', since: 'v0.1' },
  { name: '/model', usage: '/model [list|use|config|show]', summary: '查看/切换/配置模型与 Provider', since: 'v0.1' },
  { name: '/permission', usage: '/permission [strict|HuangAura|WenNova]', summary: '查看或切换权限档位（三档，仅本次会话生效）', since: 'v0.1' },
  { name: '/permissions', usage: '/permissions [mode <m>|allow <tool>|deny <tool>]', summary: '查看或调整权限模式与临时规则', since: 'v0.1' },
  { name: '/status', usage: '/status', summary: '会话状态：模型、轮次、上下文占用、事件统计', since: 'v0.1' },
  { name: '/cost', usage: '/cost', summary: 'Token 用量与费用汇总', since: 'v0.1' },
  { name: '/tools', usage: '/tools', summary: '列出已注册工具及风险级别', since: 'v0.1' },
  { name: '/compact', usage: '/compact', summary: '手动压缩历史（清理旧工具结果）', since: 'v0.1' },
  { name: '/clear', usage: '/clear', summary: '清空对话，开启新会话', since: 'v0.1' },
  { name: '/resume', usage: '/resume [id]', summary: '列出或恢复历史会话', since: 'v0.1' },
  { name: '/doctor', usage: '/doctor', summary: '运行环境诊断（同 liwen doctor）', since: 'v0.1' },
  { name: '/setup', usage: '/setup', summary: '模型配置向导：名称/地址/APIKey/协议(4种)/认证字段/档案名，逐步引导保存（TUI）', since: 'v0.1' },
  { name: '/manage', usage: '/manage', summary: '管理已保存的自定义模型档案：查看/编辑/删除（TUI）', since: 'v0.1' },
  { name: '/set-agents', usage: '/set-agents [group]', summary: '配置 agent 群：hyaki 总结 / sota 思考 / common 执行，新建或修改，角色模型从已有模型中选择', since: 'v0.1' },
  { name: '/setting', usage: '/setting', summary: '修改当前激活 agent 群的配置（等价编辑当前群）', since: 'v0.1' },
  { name: '/exit', usage: '/exit', summary: '退出（等价 /quit 或两次 Ctrl+C）', since: 'v0.1' },
  { name: '/agents', usage: '/agents', summary: '多智能体工作模式：按已配置 agent 群分派三角色', since: 'M3+' },
  { name: '/mcp', usage: '/mcp', summary: 'MCP 服务器管理', since: 'M4+' },
  { name: '/goal', usage: '/goal', summary: '目标与确定性验收', since: 'M3+' },
  { name: '/rewind', usage: '/rewind', summary: '回滚到检查点', since: 'M2+' },
];

// ── 权限档位（三档）────────────────────────────────────────────────────
// 与 CLI 参数一一对应：无参数=strict（严格档）/ --HuangAura=default（部分权限）
// / --WenNova=bypass（完全权限）。/permission 指令在会话内直接切换档位。

export interface PermissionTierDef {
  /** 档位名（/permission 指令与命令行参数使用的名字） */
  key: string;
  /** 引擎权限模式 */
  mode: PermissionMode;
  /** 中文短标签 */
  label: string;
  /** 一句话说明 */
  desc: string;
}

export const PERMISSION_TIERS: readonly PermissionTierDef[] = [
  { key: 'strict', mode: 'strict', label: '严格档', desc: '一切操作（含读取）都需确认' },
  { key: 'HuangAura', mode: 'default', label: '部分权限', desc: '读取免确认；写、删、执行需确认' },
  { key: 'WenNova', mode: 'bypass', label: '完全权限', desc: '文件增删改查读全部免确认（危险命令仍拒绝）' },
];

/**
 * 解析 /permission 的参数：接受档位名（strict / HuangAura / WenNova，大小写与
 * 连字符不敏感）、高级模式名（acceptEdits / plan）以及模式别名（default / bypass）。
 * 无法识别返回 null。
 */
export function parsePermissionArg(raw: string): { key: string; mode: PermissionMode } | null {
  const a = raw.trim().toLowerCase().replace(/[-_]/g, '');
  switch (a) {
    case 'strict':
      return { key: 'strict', mode: 'strict' };
    case 'huangaura':
    case 'default':
      return { key: 'HuangAura', mode: 'default' };
    case 'wennova':
    case 'bypass':
      return { key: 'WenNova', mode: 'bypass' };
    case 'acceptedits':
      return { key: 'acceptEdits', mode: 'acceptEdits' };
    case 'plan':
      return { key: 'plan', mode: 'plan' };
    default:
      return null;
  }
}

/** 当前模式的短标签（TUI 标题栏 / 状态输出共用） */
export function permissionModeShort(mode: PermissionMode): string {
  switch (mode) {
    case 'strict': return '严格档：均需确认';
    case 'default': return '部分权限：读免确认';
    case 'acceptEdits': return 'acceptEdits';
    case 'plan': return 'plan 只读';
    case 'bypass': return '完全权限：免确认';
  }
}

/** 档位速查面板（/permission 无参数时显示；● 标记当前档位） */
export function permissionTierPanel(current: PermissionMode): string[] {
  const rows = PERMISSION_TIERS.map(
    (t) => `  ${current === t.mode ? '●' : ' '} ${t.key.padEnd(10)} ${t.label} — ${t.desc}`,
  );
  const advanced =
    current === 'acceptEdits' || current === 'plan'
      ? [`  ● ${current.padEnd(10)} （高级模式：${permissionModeShort(current)}）`]
      : ['   （高级模式 acceptEdits / plan 亦可作为档位参数）'];
  return ['权限档位（/permission <档位> 直接切换，仅本次会话生效）:', ...rows, ...advanced];
}

export function parseSlash(line: string): SlashCommand | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith('/')) return null;
  const parts = trimmed.slice(1).split(/\s+/).filter((p) => p.length > 0);
  if (parts.length === 0) return null;
  return { name: `/${parts[0]}`, args: parts.slice(1), raw: trimmed };
}

export function helpText(filter?: string): string {
  const available = COMMAND_DOCS.filter((c) => c.since === 'v0.1');
  const planned = COMMAND_DOCS.filter((c) => c.since !== 'v0.1');
  if (filter !== undefined) {
    const cmd = COMMAND_DOCS.find((c) => c.name === filter || c.name === `/${filter}`);
    if (cmd === undefined) return `未知命令 '${filter}'。输入 /help 查看全部命令。`;
    return `${cmd.usage}\n  ${cmd.summary}（${cmd.since}）`;
  }
  const line = (c: CommandDoc) => `  ${c.usage.padEnd(46)} ${c.summary}`;
  return [
    '可用命令：',
    ...available.map(line),
    '',
    '输入语法：',
    '  @路径          把文件内容附加进提问（如 总结 @src/agent.ts）',
    '  !命令          提议执行 shell 命令（仍需经过权限审批）',
    '  Ctrl+C         生成中=取消本轮；空闲时按两次=退出',
    '',
    '计划中（当前版本为占位）：',
    ...planned.map((c) => `  ${c.name.padEnd(46)} ${c.summary}（${c.since}）`),
  ].join('\n');
}
