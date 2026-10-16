/**
 * Slash-command parsing and metadata (FR-137). Pure logic — unit-testable
 * without a terminal. Handlers live in interactive.ts.
 */

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
  { name: '/exit', usage: '/exit', summary: '退出（等价 /quit 或两次 Ctrl+C）', since: 'v0.1' },
  { name: '/agents', usage: '/agents', summary: '三角色编排（hyaki/sota/common）', since: 'M3+' },
  { name: '/mcp', usage: '/mcp', summary: 'MCP 服务器管理', since: 'M4+' },
  { name: '/goal', usage: '/goal', summary: '目标与确定性验收', since: 'M3+' },
  { name: '/rewind', usage: '/rewind', summary: '回滚到检查点', since: 'M2+' },
];

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
