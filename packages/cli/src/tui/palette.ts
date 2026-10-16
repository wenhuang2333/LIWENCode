/**
 * 斜杠指令联想（Command Palette）：输入 "/" 触发，前缀过滤，
 * ↑↓ 选择，选中项展示英文说明，Enter/Tab 补全。
 *
 * 纯逻辑模块：suggestCommands(text) 对编辑器当前内容给出候选，
 * 渲染与键位拦截在 tui.ts。
 */

export interface CommandHint {
  name: string;
  args: string;
  desc: string;
}

/** 英文指令提示表（v0.1 可用命令 + 占位命令） */
export const COMMAND_HINTS: readonly CommandHint[] = [
  { name: '/help', args: '[command]', desc: 'Show all commands, or detailed usage of one command' },
  { name: '/model', args: '[list|use|config]', desc: 'Show, switch or configure the active model and API keys' },
  { name: '/permissions', args: '[mode|allow|deny]', desc: 'Show or adjust permission mode and session rules' },
  { name: '/status', args: '', desc: 'Session id, model, mode, turns and context usage' },
  { name: '/cost', args: '', desc: 'Cumulative requests, tokens and cost' },
  { name: '/tools', args: '', desc: 'List registered tools with risk levels' },
  { name: '/compact', args: '', desc: 'Trim old tool results to free context' },
  { name: '/clear', args: '', desc: 'Start a fresh session (history cleared)' },
  { name: '/resume', args: '[id]', desc: 'List recent sessions, or resume one by id' },
  { name: '/doctor', args: '', desc: 'Run environment and config diagnostics' },
  { name: '/setup', args: '', desc: 'Guided model setup wizard: name, url, key, protocol, auth, profile' },
  { name: '/manage', args: '[name]', desc: 'Manage saved model profiles: list, edit or delete' },
  { name: '/exit', args: '', desc: 'Quit liwencode' },
  { name: '/agents', args: '', desc: 'Three-role orchestration (coming soon, M3+)' },
  { name: '/goal', args: '', desc: 'Goal with deterministic acceptance (coming soon, M3+)' },
  { name: '/mcp', args: '', desc: 'MCP server management (coming soon, M4+)' },
  { name: '/rewind', args: '', desc: 'Checkpoint rollback (coming soon, M2+)' },
];

export const PALETTE_MAX = 6;

/**
 * 候选规则：文本以 "/" 开头且尚未出现空格时按前缀过滤；其余情况（普通文本、
 * 已带参数的命令、空行）无候选。
 */
export function suggestCommands(text: string): CommandHint[] {
  if (!text.startsWith('/') || text.includes(' ')) return [];
  const q = text.slice(1).toLowerCase();
  const hits = COMMAND_HINTS.filter((h) => h.name.slice(1).toLowerCase().startsWith(q));
  return hits.slice(0, PALETTE_MAX);
}

/** 候选中第一个与输入完全同名的索引（Enter 直接执行完整命令名时高亮它） */
export function exactIndex(hints: readonly CommandHint[], text: string): number {
  const idx = hints.findIndex((h) => h.name === text);
  return idx;
}
