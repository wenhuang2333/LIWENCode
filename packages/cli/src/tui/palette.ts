/**
 * 斜杠指令联想（Command Palette）：输入 "/" 触发，前缀过滤。
 *
 * 显示全部匹配命令（不再截断），每行带中文简短介绍；列表长于视窗时
 * 由 paletteWindow 计算滚动窗口（选中项始终可见，可一路 ↓ 选到底）。
 * ↑↓ 选择，Enter/Tab 补全。
 *
 * 纯逻辑模块：suggestCommands(text) 对编辑器当前内容给出候选、
 * paletteWindow(total, selected, max) 计算视窗；渲染与键位拦截在 tui.ts。
 */

export interface CommandHint {
  name: string;
  args: string;
  /** 英文完整说明（选中项详情/文档用，保持 ASCII） */
  desc: string;
  /** 行内中文简短介绍（列表中每条命令旁的说明） */
  brief: string;
}

/** 指令提示表（v0.1 可用命令 + 占位命令） */
export const COMMAND_HINTS: readonly CommandHint[] = [
  { name: '/help', args: '[command]', brief: '显示全部命令与用法', desc: 'Show all commands, or detailed usage of one command' },
  { name: '/model', args: '[list|use|config]', brief: '查看/切换/配置模型', desc: 'Show, switch or configure the active model and API keys' },
  { name: '/permission', args: '[tier]', brief: '修改权限档位（三档）', desc: 'Switch permission tier: strict / HuangAura / WenNova (session only)' },
  { name: '/permissions', args: '[mode|allow|deny]', brief: '权限模式与临时规则', desc: 'Show or adjust permission mode and session rules' },
  { name: '/status', args: '', brief: '会话与上下文状态', desc: 'Session id, model, mode, turns and context usage' },
  { name: '/cost', args: '', brief: 'Token 用量与费用', desc: 'Cumulative requests, tokens and cost' },
  { name: '/tools', args: '', brief: '列出已注册工具', desc: 'List registered tools with risk levels' },
  { name: '/compact', args: '', brief: '压缩历史释放上下文', desc: 'Trim old tool results to free context' },
  { name: '/clear', args: '', brief: '清空对话开启新会话', desc: 'Start a fresh session (history cleared)' },
  { name: '/resume', args: '[id]', brief: '恢复历史会话', desc: 'List recent sessions, or resume one by id' },
  { name: '/doctor', args: '', brief: '运行环境诊断', desc: 'Run environment and config diagnostics' },
  { name: '/setup', args: '', brief: '模型配置向导', desc: 'Guided model setup wizard: name, url, key, protocol, auth, profile' },
  { name: '/manage', args: '[name]', brief: '管理已保存模型档案', desc: 'Manage saved model profiles: list, edit or delete' },
  { name: '/exit', args: '', brief: '退出', desc: 'Quit liwencode' },
  { name: '/agents', args: '', brief: '三角色编排（M3+）', desc: 'Three-role orchestration (coming soon, M3+)' },
  { name: '/goal', args: '', brief: '目标与验收（M3+）', desc: 'Goal with deterministic acceptance (coming soon, M3+)' },
  { name: '/mcp', args: '', brief: 'MCP 管理（M4+）', desc: 'MCP server management (coming soon, M4+)' },
  { name: '/rewind', args: '', brief: '检查点回滚（M2+）', desc: 'Checkpoint rollback (coming soon, M2+)' },
];

/**
 * 候选规则：文本以 "/" 开头且尚未出现空格时按前缀过滤；其余情况（普通文本、
 * 已带参数的命令、空行）无候选。返回全部匹配项（渲染层按视窗滚动）。
 */
export function suggestCommands(text: string): CommandHint[] {
  if (!text.startsWith('/') || text.includes(' ')) return [];
  const q = text.slice(1).toLowerCase();
  return COMMAND_HINTS.filter((h) => h.name.slice(1).toLowerCase().startsWith(q));
}

/**
 * 计算滚动视窗：返回 [start, end) 区间。选中项始终落在视窗内；
 * max 为可见行数上限（其余由调用方按终端高度决定）。
 */
export function paletteWindow(total: number, selected: number, max: number): { start: number; end: number } {
  const size = Math.max(1, Math.min(total, max));
  if (total <= size) return { start: 0, end: total };
  // 居中跟随：选中项尽量位于视窗中部，向两端收敛
  let start = selected - Math.floor((size - 1) / 2);
  start = Math.max(0, Math.min(start, total - size));
  return { start, end: start + size };
}

/** 候选中第一个与输入完全同名的索引（Enter 直接执行完整命令名时高亮它） */
export function exactIndex(hints: readonly CommandHint[], text: string): number {
  const idx = hints.findIndex((h) => h.name === text);
  return idx;
}
