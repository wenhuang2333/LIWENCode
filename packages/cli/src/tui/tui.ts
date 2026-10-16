/**
 * 常驻 TUI 编码界面（FR-130 / FR-137 / TUI 需求）。
 *
 * 布局（自上而下）：
 *   ── 流式输出区（自然滚动，text.delta 直接追加）
 *   ┌─ liwen (provider:model) · 档位 ────┐  ← 输入框（边框）
 *   │ ❯ 输入…                             │
 *   └─────────────────────────────────────┘
 *    模型 …  上下文 …  轮次 N:M  速度 …  缓存 …  总token …
 *
 * 实现要点：
 * - 底部锚定：ESC7（保存光标）/ ESC8（恢复）+ ESC[J（清除下方），
 *   输出文本在 chrome 上方追加时先撤下 chrome、写完再重画。
 * - chrome 帧差分渲染（消除闪烁）：同高/收缩帧只原位重写变化行（收缩帧贴原帧
 *   底部、上方多余行清空；内容未变时零写入），增高帧才全量重画；整帧写入用
 *   synchronized update（DEC 2026）包裹，支持它的终端原子交换。
 * - 输入：raw 模式 + LineEditor（CJK 安全、历史、光标块）。
 * - 权限审批 / 交互式提问复用同一编辑器（mode 切换，问题显示在框标题）。
 * - 状态栏：StatusTracker 实时指标，150ms 定时刷新（差分渲染下仅变化行重写）。
 */

import { stdin as input, stdout as output } from 'node:process';
import {
  createAgent,
  estimateMessagesTokens,
  FileSessionStore,
  LiwenError,
  nodeRuntime,
  projectHashOf,
  Redactor,
  trimOldToolResults,
  type Agent,
  type AgentEvent,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
  type PermissionRule,
  type Provider,
} from '@liwencode/core';
import { createBuiltinTools } from '@liwencode/tools';
import type { CliArgs } from '../args.js';
import { resolvePermissionTier } from '../args.js';
import { buildProvider, type ProviderSpec } from '../provider-select.js';
import { helpText, parsePermissionArg, parseSlash, permissionModeShort, permissionTierPanel } from '../slash.js';
import {
  catalogEntry,
  envFilePath,
  keyStatusOf,
  liwenHome,
  maskKey,
  PROVIDER_CATALOG,
  readUserConfig,
  resolveDefaultModel,
  writeEnvFile,
  writeUserConfig,
  parseEnvFile,
} from '../model-config.js';
import { formatDoctor, runDoctor } from '../doctor.js';
import { expandAtPaths, summarizeInput } from '../prompt-utils.js';
import { BootAnimation, bootSupported } from './boot.js';
import { LineEditor } from './editor.js';
import { StatusTracker, formatStatusLine } from './status.js';
import { displayWidth, truncateToWidth } from './width.js';
import { renderPanel, welcomeSupported } from './welcome.js';
import { suggestCommands, exactIndex, paletteWindow, type CommandHint } from './palette.js';
import {
  newWizard,
  renderWizard,
  selectOptions,
  submitAnswer,
  wizardIsSecret,
  wizardIsSelect,
  wizardQuestion,
  setExistingNamesProvider,
  type WizardState,
} from './setup-wizard.js';
import {
  deleteProfile,
  listProfiles,
  profileKeyStatus,
  saveProfile,
  PROTOCOL_LABELS,
  AUTH_FIELD_LABELS,
  type ModelProfile,
} from '../model-config.js';

const ANSI = {
  dim: (s: string) => `\x1b[2m${s}\x1b[22m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[22m`,
  red: (s: string) => `\x1b[31m${s}\x1b[39m`,
  green: (s: string) => `\x1b[32m${s}\x1b[39m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[39m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[39m`,
  magenta: (s: string) => `\x1b[35m${s}\x1b[39m`,
};

const SAVE = '\x1b7';
const RESTORE = '\x1b8';
const CLEAR_BELOW = '\x1b[J';
const ERASE_EOL = '\x1b[K';
const CUD1 = '\x1b[1B';
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';
// 同步输出（synchronized update, DEC 2026）：支持它的终端把整帧原子交换，
// 不支持者按未知私有模式忽略——用于消除全量重绘路径的中间空白帧。
const SYNC_ON = '\x1b[?2026h';
const SYNC_OFF = '\x1b[?2026l';

export interface TuiOptions {
  args: CliArgs;
  initialPrompt?: string;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  requests: number;
}

/** 启动动画（按任意键跳过；--no-boot 或终端过小直接跳过） */
async function playBoot(noBoot: boolean): Promise<void> {
  const cols = output.columns ?? 80;
  const rows = output.rows ?? 24;
  if (noBoot || !bootSupported(cols, rows) || input.isTTY !== true) return;
  const anim = new BootAnimation({ cols, rows });
  const t0 = Date.now();
  let skip = false;
  const onKey = () => {
    skip = true;
  };
  input.setRawMode(true);
  input.resume();
  input.on('data', onKey);
  output.write(HIDE_CURSOR);
  try {
    for (;;) {
      const t = Date.now() - t0;
      if (skip || anim.isDone(t)) break;
      output.write(anim.tick(t));
      await sleep(50);
    }
  } finally {
    input.off('data', onKey);
    output.write(RESTORE + CLEAR_BELOW + SHOW_CURSOR);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

class ExitTui extends Error {}

export async function runTui(opts: TuiOptions): Promise<number> {
  const cwd = opts.args.cwd ?? process.cwd();
  const runtime = nodeRuntime();
  const redactor = new Redactor();
  const sessionStore = new FileSessionStore(runtime, `${liwenHome()}/sessions`, String(projectHashOf(cwd)));
  const { tools } = createBuiltinTools();
  const usageTotals: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0, requests: 0 };

  await playBoot(opts.args.noBoot === true);

  let spec: ProviderSpec = (() => {
    const resolved = resolveDefaultModel(opts.args.model);
    return { provider: resolved.provider, model: resolved.name };
  })();
  const tier = resolvePermissionTier(opts.args, readUserConfig().permissionMode);
  let permissionMode: PermissionMode = tier.mode;
  let pendingResume: string | undefined;
  const sessionRules: PermissionRule[] = [
    ...opts.args.allowedTools.map((tool) => ({ effect: 'allow' as const, tool, source: 'user' as const })),
    ...opts.args.disallowedTools.map((tool) => ({ effect: 'deny' as const, tool, source: 'user' as const })),
  ];

  input.setRawMode(true);
  input.resume();

  const editor = new LineEditor();
  const tracker = new StatusTracker({ model: `${spec.provider}:${spec.model}`, contextWindow: safeContextWindow(spec) });

  // ── chrome（输入框 + 状态栏）状态 ──
  let chromeDrawn = false;
  /** 上一帧逐行内容（含 ANSI）；用于差分重绘，null = 屏幕内容已失效需全量重画 */
  let lastFrame: string[] | null = null;
  /** 帧首行相对锚点（ESC7 保存位）的行偏移；收缩帧保持底部锚定时 > 0 */
  let frameInset = 0;
  let busy = false;
  let queuedInput: string | null = null;
  type EditorMode = { kind: 'input' } | { kind: 'permission'; resolve: (a: string) => void } | { kind: 'prompt'; resolve: (a: string) => void };
  let mode: EditorMode = { kind: 'input' };
  let lastSigint = 0;
  let activeAbort: AbortController | undefined;
  let agent = createCurrentAgent();
  let statusTimer: NodeJS.Timeout | undefined;
  // 欢迎面板：进入工作区时显示，首次真实输出（printAbove）后永久收起；
  // 用户敲任意键后蝴蝶立即冻结为静态（防频繁重绘）
  let welcomeActive = false;
  let welcomeFrozen = false;
  // 指令联想：输入 "/" 且未出现空格时激活
  let paletteHints: CommandHint[] = [];
  let paletteIdx = 0;
  // /setup 向导（激活时占用输入框，选择步复用 ↑↓ 导航）
  let wizard: WizardState | null = null;
  setExistingNamesProvider(() => Object.keys(listProfiles()));

  function safeContextWindow(s: ProviderSpec): number | null {
    try {
      return buildProvider(s).capabilities(s.model).contextWindow;
    } catch {
      return null;
    }
  }

  function createCurrentAgent(resumeSessionId?: string): Agent {
    const provider: Provider & { model: string } = buildProvider(spec);
    redactor.register(process.env.DEEPSEEK_API_KEY ?? '', 'deepseek-key');
    redactor.register(process.env.ANTHROPIC_API_KEY ?? '', 'anthropic-key');
    redactor.register(process.env.OPENAI_API_KEY ?? '', 'openai-key');
    const created = createAgent({
      provider,
      model: provider.model,
      cwd,
      tools,
      permissionMode,
      rules: sessionRules,
      permissionHandler: tuiPermissionHandler,
      session: sessionStore,
      runtime,
      limits: {
        ...(opts.args.maxTurns !== undefined ? { maxTurns: opts.args.maxTurns } : {}),
        ...(opts.args.maxBudgetUsd !== undefined ? { maxBudgetUsd: opts.args.maxBudgetUsd } : {}),
      },
    });
    if (resumeSessionId !== undefined) {
      pendingResume = resumeSessionId;
    }
    return created;
  }

  // ── 输出（chrome 感知） ──────────────────────────────────────────────

  /** 在 chrome 上方打印文本（文本以换行结尾时正好贴住 chrome 顶部）。
   * raw 模式下终端不做 NL→CRNL 转换，统一在此归一化。
   * 首次真实输出即收起欢迎面板（工作区开始承接内容）。
   * 注意：清除下方后屏幕 chrome 区域失效 → lastFrame 置空，下次绘制走全量路径。 */
  function printAbove(text: string): void {
    welcomeActive = false;
    const nl = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    const parts: string[] = [];
    if (chromeDrawn) parts.push(RESTORE, CLEAR_BELOW);
    parts.push(nl);
    if (!nl.endsWith('\r\n')) parts.push('\r\n');
    output.write(SYNC_ON + parts.join('') + SYNC_OFF);
    chromeDrawn = false;
    lastFrame = null;
    frameInset = 0;
  }

  function boxTitle(): string {
    const model = `${spec.provider}:${spec.model}`;
    if (mode.kind === 'permission') return `允许执行? ${ANSI.yellow('[y]本次允许 / [s]本次会话均允许 / [n]拒绝 (默认 n)')}`;
    if (mode.kind === 'prompt') return ANSI.bold(promptQuestion);
    if (wizard !== null) return ANSI.bold(wizardQuestion(wizard));
    const tier = permissionModeShort(agent.engine.mode);
    const busyTag = busy ? ANSI.magenta(' · 处理中…') : '';
    const queued = queuedInput !== null ? ANSI.dim(' · 已排队 1 条') : '';
    return `${ANSI.cyan(`liwen (${model})`)}${busyTag}${queued} ${ANSI.dim(`· ${tier}`)}`;
  }

  /** 联想弹层可视行数上限：终端高度扣除输入框(3)/状态(1)/弹层边框等(5)/顶部余量(1) */
  function paletteViewMax(total: number): number {
    const rows = output.rows ?? 24;
    return Math.max(4, Math.min(total, rows - 10));
  }

  /** 指令联想弹层（输入框上方）：全量候选 + 每行中文简介 + 视窗滚动 */
  function renderPalette(cols: number): string[] {
    const w = Math.min(cols, 72);
    const total = paletteHints.length;
    const { start, end } = paletteWindow(total, paletteIdx, paletteViewMax(total));
    const windowed = end - start < total;
    const title = windowed ? ` commands ${start + 1}-${end}/${total} ` : ` commands (${total}) `;
    const lines: string[] = [];
    const fill = w - 2 - title.length;
    lines.push(`╭${'─'.repeat(Math.floor(fill / 2))}${title}${'─'.repeat(fill - Math.floor(fill / 2))}╮`);
    for (let i = start; i < end; i++) {
      const h = paletteHints[i]!;
      const selected = i === paletteIdx;
      const marker = selected ? '❯ ' : '  ';
      const name = h.name.padEnd(13);
      const rowPlain = ` ${marker}${name} ${h.brief}`;
      const pad = w - 2 - plainLenOf(rowPlain);
      const row = selected
        ? `\x1b[7m ${marker}${ANSI.green(name)} ${h.brief}${' '.repeat(Math.max(0, pad))}\x1b[27m`
        : ` ${marker}${ANSI.green(name)} ${ANSI.dim(h.brief)}${' '.repeat(Math.max(0, pad))}`;
      lines.push(`│${row}│`);
    }
    // 选中项用法 + 键位提示
    const sel = paletteHints[paletteIdx]!;
    const usage = `用法: ${sel.name}${sel.args !== '' ? ` ${sel.args}` : ''}`;
    const [usageShown] = truncateToWidth(usage, w - 6);
    lines.push(`├${'─'.repeat(w - 2)}┤`);
    lines.push(`│ ${ANSI.dim(usageShown)}${' '.repeat(Math.max(0, w - 4 - displayWidth(usageShown)))} │`);
    const keys = '↑↓ 选择 · Tab/Enter 补全 · Esc 关闭';
    lines.push(`│ ${ANSI.dim(keys)}${' '.repeat(Math.max(0, w - 4 - displayWidth(keys)))} │`);
    lines.push(`╰${'─'.repeat(w - 2)}╯`);
    return lines;
  }

  function plainLenOf(s: string): number {
    return s.replace(/\x1b\[[0-9;]*m/g, '').length;
  }

  /** 根据编辑器内容刷新联想候选（仅主输入模式；向导激活时不联想） */
  function updatePalette(): void {
    if (mode.kind !== 'input' || wizard !== null) {
      paletteHints = [];
      editor.setNavCapture(wizard !== null && wizardIsSelect(wizard));
      return;
    }
    paletteHints = suggestCommands(editor.text());
    if (paletteHints.length > 0) {
      // 打开联想即收起欢迎面板：弹层要占满输入框上方的空间，
      // 与最高 22 行的欢迎面板叠加会超出屏幕（此时用户已开始指挥工作区，splash 完成使命）
      welcomeActive = false;
    }
    const exact = exactIndex(paletteHints, editor.text());
    paletteIdx = paletteHints.length > 0 ? (exact >= 0 ? exact : 0) : 0;
    editor.setNavCapture(paletteHints.length > 0);
  }

  /** 用选中候选补全输入行（命令名 + 空格，等待参数/回车执行） */
  function completeSelected(): void {
    if (paletteHints.length === 0) return;
    editor.setLine(`${paletteHints[paletteIdx]!.name} `);
    paletteHints = [];
    editor.setNavCapture(false);
  }

  /** 组装 chrome 帧：欢迎面板（可选）+ 向导（可选）+ 联想弹层（可选）+ 输入框(3) + 状态行 */
  function buildChromeFrame(cols: number): { lines: string[]; aboveBox: number; cursorVisCol: number } {
    const lines: string[] = [];

    // 欢迎面板（左：多彩扇翅蝴蝶 + 黑白阴影艺术字；右：英文欢迎与提示；
    // 用户敲任意键后蝴蝶冻结为静态姿态）
    if (welcomeActive) {
      const rowsAvail = (output.rows ?? 24) - 6; // 输入框 3 + 状态 1 + 余量
      const panelH = Math.min(22, Math.max(12, rowsAvail));
      const panel = renderPanel(
        cols,
        panelH,
        Date.now(),
        { version: 'v0.1.0', model: `${spec.provider}:${spec.model}`, tier: permissionModeShort(agent.engine.mode) },
        welcomeFrozen,
      );
      lines.push(...panel);
    }

    // /setup 向导（Vite 式进度线）
    if (wizard !== null) {
      lines.push(...renderWizard(wizard, Math.min(cols, 64)));
    }

    // 指令联想弹层
    if (paletteHints.length > 0) {
      lines.push(...renderPalette(cols));
    }

    const aboveBox = lines.length;

    // 边框宽度按纯文本列宽计算（boxTitle 含 ANSI，先量后截）
    const titlePlain = stripAnsi(boxTitle());
    const titleW = Math.min(displayWidth(titlePlain), cols - 6);
    lines.push(`┌─ ${boxTitle()} ${'─'.repeat(Math.max(1, cols - titleW - 5))}┐`);

    // 内容行：❯ + 可视窗口（横向滚动；向导 APIKey 步掩码显示）
    const inner = Math.max(10, cols - 6);
    const rawText = editor.text();
    const masked = wizard !== null && wizardIsSecret(wizard);
    const text = masked ? '•'.repeat([...rawText].length) : rawText;
    const cursorCol = editor.cursorCol();
    let scroll = 0;
    if (cursorCol > inner - 2) scroll = cursorCol - (inner - 2);
    const [visible] = truncateToWidth(text.slice(idxOfCol(text, scroll)), inner);
    const pad = inner - displayWidth(visible) + 1;
    lines.push(`│ ${ANSI.cyan('❯ ')}${visible}${' '.repeat(Math.max(1, pad))}│`);

    lines.push(`└${'─'.repeat(cols - 2)}┘`);

    const snap = tracker.snapshot(Date.now());
    const status = formatStatusLine(snap, cols - 2);
    lines.push(` ${ANSI.dim(status)}`);

    return { lines, aboveBox, cursorVisCol: Math.min(cursorCol - scroll, inner - 2) };
  }

  /**
   * 绘制 chrome 帧（差分渲染，消除闪烁）：
   * - 同高/收缩帧：逐行比较，只原位重写变化行（不清屏、不整块擦除）；收缩时
   *   保持底部锚定——新帧贴原帧底、上方多余行原位清空；
   * - 增高帧 / 首次 / 屏幕内容失效（printAbove、resize 后）：全量重画；
   * - 内容完全未变：跳过任何写入（空闲零输出，150ms 定时器不再造成周期性闪烁）。
   * 光标定位到输入行（帧内 aboveBox+1 行）文本末尾——旧实现 +2 会让光标落在
   * 框底边框行（已修正）。
   * 全帧写入用 synchronized update 包裹，支持它的终端整帧原子交换。
   */
  function paintChromeFrame(frame: { lines: string[]; aboveBox: number; cursorVisCol: number }): void {
    const { lines, aboveBox, cursorVisCol } = frame;

    if (chromeDrawn && lastFrame !== null && lines.length <= lastFrame.length) {
      const old = lastFrame;
      const d = old.length - lines.length; // 帧收缩 → 顶部空出的行数（保持底部锚定）
      const inset = frameInset + d; // 新帧首行相对锚点的行偏移
      const seq: string[] = [RESTORE];
      let changed = d > 0;
      if (frameInset > 0) seq.push(`\x1b[${frameInset}B`); // 移到旧帧首行
      for (let i = 0; i < d; i++) seq.push('\r', ERASE_EOL, CUD1); // 清空收缩让出的行
      for (let i = 0; i < lines.length; i++) {
        if (lines[i] !== old[d + i]) {
          seq.push('\r', lines[i]!, ERASE_EOL);
          changed = true;
        }
        if (i < lines.length - 1) seq.push(CUD1);
      }
      if (!changed) return; // 内容未变：光标仍在上帧定位处，无需任何写入
      seq.push(RESTORE, `\x1b[${aboveBox + 1 + inset}B`, `\x1b[${4 + cursorVisCol}C`);
      output.write(SYNC_ON + seq.join('') + SYNC_OFF);
      chromeDrawn = true;
      lastFrame = lines;
      frameInset = inset;
      return;
    }

    // 全量路径：首次绘制 / 屏幕内容失效 / 帧增高（必要时自然滚动）
    const seq: string[] = [];
    seq.push(chromeDrawn ? RESTORE : SAVE);
    if (chromeDrawn) seq.push(CLEAR_BELOW);
    for (const line of lines) seq.push(`\r${line}\r\n`);
    seq.push(RESTORE, `\x1b[${aboveBox + 1}B`, `\x1b[${4 + cursorVisCol}C`);
    output.write(SYNC_ON + seq.join('') + SYNC_OFF);
    chromeDrawn = true;
    lastFrame = lines;
    frameInset = 0;
  }

  /** 画欢迎面板（可选）+ 联想弹层（可选）+ 输入框（3 行）+ 状态行，并定位光标 */
  function drawChrome(): void {
    // pty/极窄终端下列数可能为 0，做下限保护（repeat 负数会抛错）
    const cols = Math.max(24, output.columns ?? 80);
    paintChromeFrame(buildChromeFrame(cols));
  }

  /** 计算横向滚动起点对应的码点索引 */
  function idxOfCol(text: string, col: number): number {
    let w = 0;
    let i = 0;
    for (const ch of text) {
      if (w >= col) return i;
      w += displayWidth(ch);
      i += ch.length;
    }
    return i;
  }

  function redraw(): void {
    drawChrome();
  }

  // ── 权限审批（复用编辑器） ───────────────────────────────────────────

  function tuiPermissionHandler(req: PermissionRequest): Promise<PermissionDecision> {
    printAbove(`\n${ANSI.yellow('⚠ 权限请求')} ${previewOfRequest(req)}\n`);
    return new Promise<PermissionDecision>((resolve) => {
      mode = {
        kind: 'permission',
        resolve: (answer) => {
          const a = answer.trim().toLowerCase();
          if (a === 'y') resolve({ decision: 'allow' });
          else if (a === 's') resolve({ decision: 'allow', remember: 'session' });
          else resolve({ decision: 'deny', message: '用户拒绝了该操作。' });
        },
      };
      editor.clear();
      redraw();
    });
  }

  function previewOfRequest(req: PermissionRequest): string {
    const s = req.subject;
    if (s.command !== undefined) return `${req.tool} 执行 ${ANSI.bold(s.command)}（${req.risk}）`;
    if (s.path !== undefined) return `${req.tool} 写入 ${ANSI.bold(s.path)}（${req.risk}）`;
    if (s.url !== undefined) return `${req.tool} 访问 ${ANSI.bold(s.url)}（${req.risk}）`;
    return `${req.tool}（${req.risk}）`;
  }

  /** 通用问答（/model config 等复用）：问题显示在框标题，编辑器提交即回答 */
  let promptQuestion = '';
  function makePrompt(): (q: string) => Promise<string> {
    return (q: string) =>
      new Promise<string>((resolve) => {
        promptQuestion = q;
        mode = { kind: 'prompt', resolve };
        editor.clear();
        redraw();
      });
  }

  // ── 键盘路由 ────────────────────────────────────────────────────────

  input.on('data', (chunk: Buffer) => {
    const events = editor.feed(chunk.toString('utf8'));
    // 任意按键：欢迎蝴蝶立即转为静态（防频繁重绘）
    if (events.length > 0 && welcomeActive) welcomeFrozen = true;
    for (const ev of events) {
      if (ev.type === 'submit') {
        if (wizard !== null) {
          // 注意：feed() 处理 Enter 时已清空缓冲区，必须用事件携带的 text
          handleWizardSubmit(ev.text);
          continue;
        }
        handleSubmit(ev.text);
      } else if (ev.type === 'interrupt') {
        if (wizard !== null) {
          wizard = null;
          editor.clear();
          editor.setNavCapture(false);
          printAbove(`${ANSI.yellow('已取消 /setup 向导。')}\n`);
          redraw();
          continue;
        }
        handleInterrupt();
      } else if (ev.type === 'eof') {
        if (mode.kind === 'input' && !busy && editor.isEmpty()) {
          output.write(RESTORE + CLEAR_BELOW + '\r\n' + ANSI.dim('再见。') + '\r\n');
          cleanup(0);
        }
      } else if (ev.type === 'nav') {
        // 向导选择步优先；否则指令联想选择（均循环滚动）
        if (wizard !== null && wizardIsSelect(wizard)) {
          const n = selectOptions(wizard).length;
          const delta = ev.dir === 'up' ? -1 : 1;
          wizard = { ...wizard, selIdx: (wizard.selIdx + delta + n) % n };
          redraw();
        } else if (paletteHints.length > 0) {
          const delta = ev.dir === 'up' ? -1 : 1;
          paletteIdx = (paletteIdx + delta + paletteHints.length) % paletteHints.length;
          redraw();
        }
      } else if (ev.type === 'escape') {
        if (wizard !== null) {
          wizard = null;
          editor.clear();
          editor.setNavCapture(false);
          printAbove(`${ANSI.yellow('已取消 /setup 向导。')}\n`);
          redraw();
        } else if (paletteHints.length > 0) {
          paletteHints = [];
          editor.setNavCapture(false);
          redraw();
        }
      } else if (ev.type === 'tab') {
        if (wizard !== null) {
          // 向导中 Tab 等同确认当前步
          handleWizardSubmit();
        } else if (paletteHints.length > 0) {
          completeSelected();
          redraw();
        } else {
          editor.insert('  ');
          redraw();
        }
      } else {
        // update：内容/光标变化 → 重算联想并重绘
        updatePalette();
        redraw();
      }
    }
  });

  /** /setup 向导步进：确认当前答案；完成后保存档案并询问是否启用。
   * text 为空时回退到编辑器内容（Tab 确认路径；Enter 路径必须传 ev.text，
   * 因为 feed() 已把缓冲区清空）。 */
  function handleWizardSubmit(text?: string): void {
    if (wizard === null) return;
    const { state: ns, done } = submitAnswer(wizard, text ?? editor.text());
    editor.clear();
    wizard = ns;
    if (done) {
      void finishWizard(ns);
      return;
    }
    editor.setNavCapture(wizardIsSelect(ns));
    redraw();
  }

  async function finishWizard(state: WizardState): Promise<void> {
    const a = state.answers;
    const name = a.profileName ?? '';
    wizard = null;
    editor.setNavCapture(false);
    const existing = listProfiles()[name];
    const apiKeyEnv = `LIWEN_KEY_${name.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
    const profile: ModelProfile = {
      model: a.model ?? '',
      baseUrl: a.baseUrl ?? '',
      protocol: a.protocol ?? 'openai-chat',
      authField: a.authField ?? 'bearer',
      apiKeyEnv,
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    saveProfile(name, profile, a.apiKey);
    const keyStatus = profileKeyStatus(profile);
    printAbove(
      [
        `${ANSI.green(`✔ 模型档案 @${name} 已保存`)}`,
        `  模型:   ${profile.model}`,
        `  地址:   ${profile.baseUrl}`,
        `  协议:   ${PROTOCOL_LABELS[profile.protocol]}`,
        `  认证:   ${AUTH_FIELD_LABELS[profile.authField]}（密钥字段 ${profile.apiKeyEnv}，${keyStatus.set ? `已存入 ~/.liwencode/env（${keyStatus.source === 'env-file' ? 'env 文件' : '进程环境'}）` : '未设置——可稍后用 /manage 编辑补填'}）`,
        profile.protocol === 'openai-responses' || profile.protocol === 'gemini'
          ? `${ANSI.yellow('  注意: 该协议适配器规划于 M2，当前无法实际调用；配置已保存。')}`
          : '',
      ]
        .filter((l) => l !== '')
        .join('\n') + '\n',
    );
    const ask = makePrompt();
    const activate = (await ask(`设为当前模型? [Y/n]: `)).trim().toLowerCase();
    if (activate === '' || activate === 'y') {
      switchModel(`@${name}`, profile.model);
    } else {
      printAbove(`${ANSI.dim(`保持当前模型；之后可用 /model use @${name} 启用。`)}\n`);
    }
    redraw();
  }

  /** /setup：启动向导（/manage 编辑入口复用，带预填） */
  function startWizard(prefill?: Partial<{ model: string; baseUrl: string; protocol: ModelProfile['protocol']; authField: ModelProfile['authField'] }>, editing?: string): void {
    welcomeFrozen = true;
    wizard = newWizard(prefill, editing);
    editor.clear();
    editor.setNavCapture(wizardIsSelect(wizard));
    redraw();
  }

  function handleSubmit(text: string): void {
    if (mode.kind === 'permission') {
      const resolve = mode.resolve;
      mode = { kind: 'input' };
      resolve(text);
      editor.clear();
      redraw();
      return;
    }
    if (mode.kind === 'prompt') {
      const resolve = mode.resolve;
      mode = { kind: 'input' };
      resolve(text);
      editor.clear();
      redraw();
      return;
    }
    // 指令联想激活时：Enter = 补全选中项（输入恰为完整命令名则直接执行）
    if (paletteHints.length > 0) {
      if (exactIndex(paletteHints, text) < 0) {
        completeSelected();
        redraw();
        return;
      }
      paletteHints = [];
      editor.setNavCapture(false);
    }
    // 主输入
    if (busy) {
      queuedInput = text;
      redraw();
      return;
    }
    printAbove(`${ANSI.cyan('❯')} ${text}\n`);
    editor.clear();
    void dispatch(text);
  }

  function handleInterrupt(): void {
    if (busy && activeAbort !== undefined) {
      activeAbort.abort(new Error('interrupt'));
      return;
    }
    if (mode.kind === 'permission') {
      const resolve = mode.resolve;
      mode = { kind: 'input' };
      resolve('n');
      editor.clear();
      redraw();
      return;
    }
    if (mode.kind === 'prompt') {
      const resolve = mode.resolve;
      mode = { kind: 'input' };
      resolve('');
      editor.clear();
      redraw();
      return;
    }
    const now = Date.now();
    if (now - lastSigint < 2000) {
      output.write(RESTORE + CLEAR_BELOW + '\r\n' + ANSI.dim('再见。') + '\r\n');
      cleanup(130);
      return;
    }
    lastSigint = now;
    if (!editor.isEmpty()) {
      editor.clear();
      redraw();
      return;
    }
    printAbove(ANSI.dim('（再按一次 Ctrl+C 退出）') + '\n');
  }

  async function dispatch(raw: string): Promise<void> {
    const trimmed = raw.trim();
    if (trimmed === '') return;
    const slash = parseSlash(trimmed);
    if (slash !== null) {
      try {
        await handleSlash(slash);
      } catch (e) {
        if (e instanceof ExitTui) {
          output.write(RESTORE + CLEAR_BELOW + '\r\n' + ANSI.dim('再见。') + '\r\n');
          cleanup(0);
          return;
        }
        throw e;
      }
      redraw();
      return;
    }
    if (trimmed.startsWith('!')) {
      await runBangCommand(trimmed.slice(1));
      redraw();
      return;
    }
    await runTurn(trimmed);
    redraw();
    if (queuedInput !== null) {
      const next = queuedInput;
      queuedInput = null;
      printAbove(`${ANSI.cyan('❯')} ${next}\n`);
      await dispatch(next);
    }
  }

  // ── 回合执行 ────────────────────────────────────────────────────────

  async function runTurn(prompt: string): Promise<void> {
    const expanded = await expandAtPaths(prompt, cwd, runtime);
    activeAbort = new AbortController();
    busy = true;
    const resumeId = pendingResume;
    pendingResume = undefined;
    let inText = false;
    try {
      const stream = agent.run(expanded, { signal: activeAbort.signal, ...(resumeId !== undefined ? { sessionId: resumeId } : {}) });
      for (;;) {
        const r = await stream.next();
        if (r.done) {
          const summary = r.value;
          if (summary.endReason !== 'completed' && summary.endReason !== 'aborted') {
            printAbove(`${ANSI.yellow(`本轮结束: ${summary.endReason}`)}\n`);
          }
          break;
        }
        handleEvent(r.value);
      }
    } catch (e) {
      printAbove('');
      if (LiwenError.is(e)) printAbove(`${ANSI.red(`错误 ${e.code}: ${e.message}`)}\n`);
      else printAbove(`${ANSI.red(`错误: ${e instanceof Error ? e.message : String(e)}`)}\n`);
    } finally {
      if (inText) printAbove('\n');
      busy = false;
      activeAbort = undefined;
      redraw();
    }

    function handleEvent(ev: AgentEvent): void {
      tracker.onEvent(ev, Date.now());
      switch (ev.type) {
        case 'text.delta':
          inText = true;
          printAbove(ev.text.replace(/\n/g, '\r\n'));
          break;
        case 'tool.start':
          if (inText) {
            printAbove('\r\n');
            inText = false;
          }
          printAbove(`${ANSI.dim(`  ⚙ ${ev.name} ${summarizeInput(ev.input)}`)}\r\n`);
          break;
        case 'tool.result': {
          const first = ev.content.find((c) => c.type === 'text');
          const text = first !== undefined && first.type === 'text' ? first.text : '';
          const oneline = text.split('\n').slice(0, 2).join(' ⏎ ').slice(0, 160);
          printAbove(ev.isError ? `${ANSI.red(`  ✖ ${oneline}`)}\r\n` : `${ANSI.dim(`  ✔ ${oneline}`)}\r\n`);
          break;
        }
        case 'usage': {
          usageTotals.inputTokens += ev.usage.inputTokens;
          usageTotals.outputTokens += ev.usage.outputTokens;
          usageTotals.requests += 1;
          if (ev.costUsd !== undefined) usageTotals.costUsd += ev.costUsd;
          break;
        }
        case 'budget.warning':
          printAbove(`${ANSI.yellow(`  ⚠ 预算已达 ${Math.round(ev.ratio * 100)}%`)}\r\n`);
          break;
        case 'error':
          printAbove(ev.fatal ? `${ANSI.red(`  ✖ ${ev.error.code} ${ev.error.message}`)}\r\n` : `${ANSI.yellow(`  ⚠ ${ev.error.code} ${ev.error.message}`)}\r\n`);
          break;
        default:
          break;
      }
    }
  }

  async function runBangCommand(command: string): Promise<void> {
    const engine = agent.engine;
    const outcome = await engine.checkSubject('bash', 'exec', { command });
    if (outcome.outcome === 'deny') {
      printAbove(`${ANSI.red(`✖ 拒绝 [${outcome.error.code}]: ${outcome.error.modelMessage ?? outcome.error.message}`)}\n`);
      return;
    }
    const proc = runtime.shell.spawn('/bin/sh', ['-c', command], { cwd, timeoutMs: 60_000 });
    let out = '';
    const collect = async (s: AsyncIterable<string>) => {
      for await (const line of s) out += `${line}\n`;
    };
    const code = await Promise.all([proc.exited, collect(proc.stdout), collect(proc.stderr)]).then(([c]) => c);
    printAbove(`${ANSI.dim(`exit=${code}`)}\n${out.slice(0, 2000)}`);
  }

  // ── 斜杠命令（移植自 REPL，交互改用 promptUser） ────────────────────

  async function handleSlash(cmd: { name: string; args: string[] }): Promise<void> {
    switch (cmd.name) {
      case '/help':
        printAbove(`${helpText(cmd.args[0])}\n`);
        return;
      case '/exit':
      case '/quit':
        throw new ExitTui();
      case '/model':
        await cmdModel(cmd.args);
        return;
      case '/permission':
      case '/permissions':
        cmdPermissions(cmd.args, cmd.name);
        return;
      case '/status':
        cmdStatus();
        return;
      case '/cost':
        cmdCost();
        return;
      case '/tools':
        cmdTools();
        return;
      case '/compact':
        cmdCompact();
        return;
      case '/clear':
        agent = createCurrentAgent();
        printAbove(`${ANSI.green('已开启新会话（历史已清空）。')}\n`);
        return;
      case '/resume':
        await cmdResume(cmd.args);
        return;
      case '/doctor':
        printAbove(`${formatDoctor(runDoctor(cwd))}\n`);
        return;
      case '/setup':
        startWizard();
        return;
      case '/manage':
        await cmdManage(cmd.args);
        return;
      case '/agents':
      case '/mcp':
      case '/goal':
      case '/rewind': {
        const doc = { '/agents': '三角色编排（hyaki/sota/common）', '/mcp': 'MCP 服务器管理', '/goal': '目标与确定性验收', '/rewind': '检查点回滚' }[cmd.name];
        printAbove(`${ANSI.yellow(`${cmd.name} 属于后续里程碑（M2+），当前版本为占位。用 /help 查看可用命令。`)}\n${ANSI.dim(`  计划功能：${doc}`)}\n`);
        return;
      }
      default:
        printAbove(`${ANSI.yellow(`未知命令 '${cmd.name}'。输入 /help 查看全部命令。`)}\n`);
        return;
    }
  }

  async function cmdModel(args: string[]): Promise<void> {
    const sub = args[0];
    if (sub === undefined || sub === 'show') {
      const entry = catalogEntry(spec.provider);
      const key = entry !== undefined && entry.apiKeyEnv !== undefined ? keyStatusOf(entry) : undefined;
      printAbove(
        [
          `当前模型: ${ANSI.bold(`${spec.provider}:${spec.model}`)}`,
          entry !== undefined ? `  端点: ${entry.baseUrl === '' ? '(离线)' : entry.baseUrl}` : '',
          key !== undefined ? `  密钥: ${key.set ? `${entry?.apiKeyEnv} 已设置（${key.source === 'env-file' ? '~/.liwencode/env' : '进程环境变量'}）` : `${entry?.apiKeyEnv} 未设置`}` : '  密钥: (无需)',
          '',
          '用法: /model list | /model use <provider:model> | /model config [provider]',
        ]
          .filter((l) => l !== '')
          .join('\n') + '\n',
      );
      return;
    }
    if (sub === 'list') {
      const rows = PROVIDER_CATALOG.map((p) => {
        const key = p.apiKeyEnv !== undefined ? keyStatusOf(p) : { set: true, source: 'none' as const };
        return `  ${(p.id + ':' + p.models.join('|')).padEnd(44)} ${p.label}  密钥: ${key.set ? ANSI.green('✔') : ANSI.yellow('✘')}`;
      });
      printAbove(`Provider 目录：\n${rows.join('\n')}\n  切换: /model use deepseek:deepseek-chat\n`);
      return;
    }
    if (sub === 'use') {
      const target = args[1];
      if (target === undefined || !target.includes(':')) {
        printAbove(`${ANSI.yellow('用法: /model use <provider:model>，例如 /model use deepseek:deepseek-chat')}\n`);
        return;
      }
      const [providerId, name] = target.split(':');
      const entry = catalogEntry(providerId ?? '');
      if (entry === undefined) {
        printAbove(`${ANSI.red(`未知 provider '${providerId}'。/model list 查看目录。`)}\n`);
        return;
      }
      if (entry.needsKey && !keyStatusOf(entry).set) {
        printAbove(`${ANSI.yellow(`${providerId} 需要密钥（${entry.apiKeyEnv}）。先运行 /model config ${providerId}`)}\n`);
        return;
      }
      switchModel(providerId ?? 'mock', name ?? 'default');
      return;
    }
    if (sub === 'config') {
      await cmdModelConfig(args[1]);
      return;
    }
    printAbove(`${ANSI.yellow('用法: /model [list|use|config|show]')}\n`);
  }

  function switchModel(providerId: string, name: string): void {
    const history = [...agent.history];
    spec = { provider: providerId, model: name };
    const previousMode = agent.engine.mode;
    permissionMode = previousMode;
    agent = createCurrentAgent();
    agent.engine.setMode(previousMode);
    agent.history.push(...history);
    tracker.setModel({ model: `${spec.provider}:${spec.model}`, contextWindow: safeContextWindow(spec) });
    writeUserConfig({ ...readUserConfig(), model: { provider: spec.provider, name: spec.model } });
    printAbove(`${ANSI.green(`已切换到 ${spec.provider}:${spec.model}（已保存为默认，历史保留）。`)}\n`);
  }

  async function cmdModelConfig(providerId?: string): Promise<void> {
    const ask = makePrompt();
    let entry = providerId !== undefined ? catalogEntry(providerId) : undefined;
    if (providerId !== undefined && entry === undefined) {
      printAbove(`${ANSI.red(`未知 provider '${providerId}'。可选: ${PROVIDER_CATALOG.map((p) => p.id).join(', ')}`)}\n`);
      return;
    }
    if (entry === undefined) {
      printAbove('配置哪个 Provider?\n');
      PROVIDER_CATALOG.forEach((p, i) => printAbove(`  ${i + 1}. ${p.id.padEnd(18)} ${p.label}\n`));
      const pick = (await ask('序号 [1]: ')).trim();
      entry = PROVIDER_CATALOG[Number(pick || '1') - 1] ?? PROVIDER_CATALOG[0]!;
    }
    if (entry === undefined) return;
    const models = entry.models;
    printAbove(`模型 (${models.join(' / ')}):\n`);
    const modelAnswer = (await ask(`模型名 [${models[0]}]: `)).trim();
    const model = modelAnswer !== '' ? modelAnswer : models[0]!;
    let baseUrl = entry.baseUrl;
    if (entry.baseUrl !== '') {
      const urlAnswer = (await ask(`Base URL [${entry.baseUrl}]: `)).trim();
      if (urlAnswer !== '') baseUrl = urlAnswer;
    }
    const config = readUserConfig();
    config.model = { provider: entry.id, name: model, ...(entry.apiKeyEnv !== undefined ? { apiKeyEnv: entry.apiKeyEnv } : {}) };
    if (baseUrl !== entry.baseUrl) config.model.baseUrl = baseUrl;
    writeUserConfig(config);

    if (entry.apiKeyEnv !== undefined) {
      const keyAnswer = (await ask(`API Key（存入 ~/.liwencode/env，权限 0600；直接回车=跳过）: `)).trim();
      if (keyAnswer !== '') {
        const existing = parseEnvFile((await readFileSafe(envFilePath())) ?? '');
        existing[entry.apiKeyEnv] = keyAnswer;
        writeEnvFile(existing);
        process.env[entry.apiKeyEnv] = keyAnswer;
        printAbove(`${ANSI.green(`密钥已保存到 ~/.liwencode/env（${maskKey(keyAnswer)}）。绝不进入会话文件与日志。`)}\n`);
      }
    }
    switchModel(entry.id, model);
  }

  function cmdPermissions(args: string[], invokedAs = '/permissions'): void {
    if (args.length === 0) {
      const rules = sessionRules.length > 0
        ? sessionRules.map((r) => `  ${r.effect.padEnd(5)} ${r.tool}${r.match?.command !== undefined ? `  cmd=${r.match.command}` : ''}${r.match?.path !== undefined ? `  path=${r.match.path}` : ''}`).join('\n')
        : '  (无临时规则)';
      printAbove(
        [
          `权限模式: ${ANSI.bold(agent.engine.mode)}（当前档位: ${permissionModeShort(agent.engine.mode)}）`,
          ...permissionTierPanel(agent.engine.mode),
          '本会话临时规则:',
          rules,
          `调整: ${invokedAs} <档位> | ${invokedAs} mode <m> | ${invokedAs} allow|deny <tool>`,
        ].join('\n') + '\n',
      );
      return;
    }
    if (args[0] === 'mode') {
      const modeArg = args[1];
      if (modeArg !== 'strict' && modeArg !== 'default' && modeArg !== 'acceptEdits' && modeArg !== 'plan' && modeArg !== 'bypass') {
        printAbove(`${ANSI.yellow('模式必须为 strict | default | acceptEdits | plan | bypass')}\n`);
        return;
      }
      agent.engine.setMode(modeArg);
      permissionMode = modeArg;
      printAbove(`${ANSI.green(`权限模式已切换为 ${modeArg}。`)}\n`);
      return;
    }
    if ((args[0] === 'allow' || args[0] === 'deny') && args[1] !== undefined) {
      const rule: PermissionRule = { effect: args[0], tool: args[1], source: 'user' };
      sessionRules.push(rule);
      agent.engine.addRules([rule]);
      printAbove(`${ANSI.green(`已添加 ${args[0]} 规则: ${args[1]}（仅本次会话）。`)}\n`);
      return;
    }
    // 直接切换档位：/permission strict | HuangAura | WenNova（大小写/连字符不敏感）
    const tier = parsePermissionArg(args[0]!);
    if (tier !== null) {
      agent.engine.setMode(tier.mode);
      permissionMode = tier.mode;
      printAbove(
        `${ANSI.green(`权限档位已切换为 ${tier.key}（${permissionModeShort(tier.mode)}）。`)}${ANSI.dim('仅本次会话；启动默认用 --HuangAura / --WenNova 或配置 permissionMode')}\n`,
      );
      return;
    }
    printAbove(`${ANSI.yellow(`用法: ${invokedAs} [strict|HuangAura|WenNova] | ${invokedAs} mode <m> | ${invokedAs} allow|deny <tool>`)}\n`);
  }

  function cmdStatus(): void {
    const contextTokens = estimateMessagesTokens(agent.history, agent.registry.definitions());
    const windowSize = safeContextWindow(spec) ?? 128_000;
    const turns = agent.history.filter((m) => m.role === 'assistant').length;
    printAbove(
      [
        `会话:   ${agent.sessionId}`,
        `模型:   ${spec.provider}:${spec.model}`,
        `模式:   ${agent.engine.mode}`,
        `轮次:   ${turns}（历史消息 ${agent.history.length} 条）`,
        `上下文: ~${contextTokens} / ${windowSize} tokens（${((contextTokens / windowSize) * 100).toFixed(1)}%）`,
        `请求:   ${usageTotals.requests} 次，${usageTotals.inputTokens} 入 / ${usageTotals.outputTokens} 出 tokens`,
      ].join('\n') + '\n',
    );
  }

  function cmdCost(): void {
    const cost = usageTotals.costUsd > 0 ? `$${usageTotals.costUsd.toFixed(4)}` : '(当前 provider 未提供定价)';
    printAbove(`累计用量: ${usageTotals.requests} 次请求 | 输入 ${usageTotals.inputTokens} tokens | 输出 ${usageTotals.outputTokens} tokens | 费用 ${cost}\n`);
  }

  function cmdTools(): void {
    const rows = agent.registry.list().map(
      (t) => `  ${t.name.padEnd(8)} ${t.risk.padEnd(7)} ${t.readOnly ? '只读' : '可写'}${t.concurrencySafe ? ' · 并发安全' : ''}`,
    );
    printAbove(`已注册工具：\n${rows.join('\n')}\n`);
  }

  function cmdCompact(): void {
    const before = estimateMessagesTokens(agent.history, agent.registry.definitions());
    const compacted = trimOldToolResults(agent.history, 6);
    agent.history.length = 0;
    agent.history.push(...compacted);
    const after = estimateMessagesTokens(agent.history, agent.registry.definitions());
    printAbove(`${ANSI.green(`已压缩: ~${before} → ~${after} tokens（清理了旧工具结果，保留最近 6 轮）。`)}\n`);
  }

  /** /manage：查看/编辑/删除已保存的自定义模型档案 */
  async function cmdManage(args: string[]): Promise<void> {
    const profiles = listProfiles();
    const names = Object.keys(profiles);
    if (names.length === 0) {
      printAbove(`${ANSI.dim('暂无自定义模型档案。运行 /setup 创建第一个。')}\n`);
      return;
    }
    const rows = names.map((n) => {
      const p = profiles[n]!;
      const key = profileKeyStatus(p);
      return `  ${(('@' + n)).padEnd(16)} ${PROTOCOL_LABELS[p.protocol].padEnd(40)} ${p.model.padEnd(18)} 密钥: ${key.set ? ANSI.green('✔') : ANSI.yellow('✘')}`;
    });
    printAbove([`已保存模型档案（${names.length} 个）：`, ...rows].join('\n') + '\n');

    const ask = makePrompt();
    let target = args[0];
    if (target === undefined) {
      target = (await ask('manage which profile? (name, empty = cancel): ')).trim().replace(/^@/, '');
    }
    if (target === '') return;
    const profile = profiles[target];
    if (profile === undefined) {
      printAbove(`${ANSI.yellow(`档案 '@${target}' 不存在。`)}\n`);
      return;
    }
    printAbove(
      [
        `@${target}:`,
        `  模型:   ${profile.model}`,
        `  地址:   ${profile.baseUrl}`,
        `  协议:   ${PROTOCOL_LABELS[profile.protocol]}`,
        `  认证:   ${AUTH_FIELD_LABELS[profile.authField]}（${profile.apiKeyEnv}，${profileKeyStatus(profile).set ? '已设置' : '未设置'}）`,
        `  更新:   ${new Date(profile.updatedAt).toLocaleString()}`,
      ].join('\n') + '\n',
    );
    const action = (await ask('[e]dit / [d]elete / (empty = cancel): ')).trim().toLowerCase();
    if (action === 'e' || action === 'edit') {
      printAbove(`${ANSI.dim(`编辑 @${target}：文本步直接回车 = 沿用当前值；API Key 留空 = 不变更。`)}\n`);
      startWizard(
        { model: profile.model, baseUrl: profile.baseUrl, protocol: profile.protocol, authField: profile.authField },
        target,
      );
      return;
    }
    if (action === 'd' || action === 'delete') {
      const confirm = (await ask(`delete @${target}? [y/N]: `)).trim().toLowerCase();
      if (confirm === 'y') {
        deleteProfile(target);
        printAbove(`${ANSI.green(`已删除档案 @${target}（密钥字段保留在 ~/.liwencode/env，可手动清理）。`)}\n`);
      } else {
        printAbove(`${ANSI.dim('已取消删除。')}\n`);
      }
    }
  }

  async function cmdResume(args: string[]): Promise<void> {
    const sessions = await sessionStore.list({ limit: 5 });
    if (args[0] === undefined) {
      if (sessions.length === 0) {
        printAbove('暂无历史会话。\n');
        return;
      }
      printAbove('最近会话（/resume <id> 恢复）：\n');
      for (const s of sessions) {
        printAbove(`  ${s.sessionId.padEnd(42)} ${new Date(s.updatedAt).toLocaleString()}  ${s.entryCount} 条\n`);
      }
      return;
    }
    const target = sessions.find((s) => s.sessionId === args[0]);
    if (target === undefined) {
      printAbove(`${ANSI.yellow(`会话 '${args[0]}' 不存在（LW-SES-001）。/resume 查看列表。`)}\n`);
      return;
    }
    agent = createCurrentAgent(target.sessionId);
    printAbove(`${ANSI.green(`已恢复会话 ${target.sessionId}，下一条消息将接续该历史。`)}\n`);
  }

  // ── 生命周期 ────────────────────────────────────────────────────────

  function cleanup(code: number): never {
    if (statusTimer !== undefined) clearInterval(statusTimer);
    try {
      input.setRawMode(false);
    } catch {
      // stdin 可能已销毁
    }
    output.write(SHOW_CURSOR);
    process.exit(code);
  }

  function resizeHandler(): void {
    chromeDrawn = false;
    lastFrame = null; // 宽度变化会重排既有行，必须全量重画
    frameInset = 0;
    redraw();
  }
  output.on('resize', resizeHandler);

  // 开场：终端足够大 → 欢迎面板（多彩蝴蝶 + 艺术字 + 英文提示）；否则旧横幅兜底
  if (welcomeSupported(output.columns ?? 80, output.rows ?? 24)) {
    welcomeActive = true;
  } else {
    printAbove(ANSI.bold('LIWENCode v0.1 交互模式') + '\n');
    printAbove(ANSI.dim(`  权限档位: ${tierLongOf(tier.mode)}`) + '\n');
    printAbove(ANSI.dim('  /help 查看命令 · @文件 引用上下文 · !命令 执行 shell · Ctrl+C 取消/退出') + '\n');
  }
  redraw();
  // 欢迎面板蝴蝶扇翅动画 + 状态栏实时速度共用此定时器
  statusTimer = setInterval(() => {
    if (chromeDrawn) redraw();
  }, 150);

  if (opts.initialPrompt !== undefined && opts.initialPrompt.trim().length > 0) {
    printAbove(`${ANSI.cyan('❯')} ${opts.initialPrompt}\n`);
    await dispatch(opts.initialPrompt);
  }

  await new Promise<void>(() => {
    // 常驻：由 cleanup() 结束进程
  });
  return 0;
}

function tierLongOf(mode: PermissionMode): string {
  switch (mode) {
    case 'strict': return '严格档：一切操作均需确认（--HuangAura 升级读取免确认，--WenNova 全免确认）';
    case 'default': return '部分权限（--HuangAura）：读取免确认，写/删/执行需确认';
    case 'acceptEdits': return 'acceptEdits：工作区内写入免确认';
    case 'plan': return 'plan：仅只读';
    case 'bypass': return '完全权限（--WenNova）：文件增删改查读免确认（危险命令仍拒绝）';
  }
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}

async function readFileSafe(path: string): Promise<string | undefined> {
  try {
    const { readFileSync } = await import('node:fs');
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
