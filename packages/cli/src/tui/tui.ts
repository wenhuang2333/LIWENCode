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
 *   输出文本在 chrome 上方追加时先撤下 chrome、写完再重画（无闪烁）。
 * - 输入：raw 模式 + LineEditor（CJK 安全、历史、光标块）。
 * - 权限审批 / 交互式提问复用同一编辑器（mode 切换，问题显示在框标题）。
 * - 状态栏：StatusTracker 实时指标，250ms 定时刷新（流式期间 tok/s 实时变化）。
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
import { helpText, parseSlash } from '../slash.js';
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
const HIDE_CURSOR = '\x1b[?25l';
const SHOW_CURSOR = '\x1b[?25h';

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
  let busy = false;
  let queuedInput: string | null = null;
  type EditorMode = { kind: 'input' } | { kind: 'permission'; resolve: (a: string) => void } | { kind: 'prompt'; resolve: (a: string) => void };
  let mode: EditorMode = { kind: 'input' };
  let lastSigint = 0;
  let activeAbort: AbortController | undefined;
  let agent = createCurrentAgent();
  let statusTimer: NodeJS.Timeout | undefined;

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
   * raw 模式下终端不做 NL→CRNL 转换，统一在此归一化。 */
  function printAbove(text: string): void {
    const nl = text.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    const parts: string[] = [];
    if (chromeDrawn) parts.push(RESTORE, CLEAR_BELOW);
    parts.push(nl);
    if (!nl.endsWith('\r\n')) parts.push('\r\n');
    output.write(parts.join(''));
    chromeDrawn = false;
  }

  function boxTitle(): string {
    const model = `${spec.provider}:${spec.model}`;
    if (mode.kind === 'permission') return `允许执行? ${ANSI.yellow('[y]本次允许 / [s]本次会话均允许 / [n]拒绝 (默认 n)')}`;
    if (mode.kind === 'prompt') return ANSI.bold(promptQuestion);
    const tier = tierShortOf(agent.engine.mode);
    const busyTag = busy ? ANSI.magenta(' · 处理中…') : '';
    const queued = queuedInput !== null ? ANSI.dim(' · 已排队 1 条') : '';
    return `${ANSI.cyan(`liwen (${model})`)}${busyTag}${queued} ${ANSI.dim(`· ${tier}`)}`;
  }

  function tierShortOf(m: PermissionMode): string {
    switch (m) {
      case 'strict': return '严格档：均需确认';
      case 'default': return '部分权限：读免确认';
      case 'acceptEdits': return 'acceptEdits';
      case 'plan': return 'plan 只读';
      case 'bypass': return '完全权限：免确认';
    }
  }

  /** 画输入框（3 行）+ 状态行（1 行），并把光标定位到编辑位置 */
  function drawChrome(): void {
    // pty/极窄终端下列数可能为 0，做下限保护（repeat 负数会抛错）
    const cols = Math.max(24, output.columns ?? 80);
    const seq: string[] = [];
    seq.push(chromeDrawn ? RESTORE : SAVE);
    if (chromeDrawn) seq.push(CLEAR_BELOW);
    chromeDrawn = true;

    // 边框宽度按纯文本列宽计算（boxTitle 含 ANSI，先量后截）
    const titlePlain = stripAnsi(boxTitle());
    const titleW = Math.min(displayWidth(titlePlain), cols - 6);
    seq.push(`\r┌─ ${boxTitle()} ${'─'.repeat(Math.max(1, cols - titleW - 5))}┐\r\n`);

    // 内容行：❯ + 可视窗口（横向滚动）
    const inner = Math.max(10, cols - 6);
    const text = editor.text();
    const cursorCol = editor.cursorCol();
    let scroll = 0;
    if (cursorCol > inner - 2) scroll = cursorCol - (inner - 2);
    const [visible] = truncateToWidth(text.slice(idxOfCol(text, scroll)), inner);
    seq.push(`\r│ ${ANSI.cyan('❯ ')}${visible}`);
    const pad = inner - displayWidth(visible) + 1;
    seq.push(' '.repeat(Math.max(1, pad)));
    seq.push('│\r\n');

    seq.push(`\r└${'─'.repeat(cols - 2)}┘\r\n`);

    const snap = tracker.snapshot(Date.now());
    const status = formatStatusLine(snap, cols - 2);
    seq.push(`\r ${ANSI.dim(status)}\r\n`);

    // 光标定位：回到 chrome 起点 → 下移 2 行 → 右移到输入光标列（反显块）
    seq.push(RESTORE);
    seq.push('\x1b[2B'); // 下移到内容行
    const cursorVisCol = Math.min(cursorCol - scroll, inner - 2);
    seq.push(`\x1b[${2 + 2 + cursorVisCol}C`); // '│ ' + '❯ ' 之后
    output.write(seq.join(''));
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
    for (const ev of events) {
      if (ev.type === 'submit') {
        handleSubmit(ev.text);
      } else if (ev.type === 'interrupt') {
        handleInterrupt();
      } else if (ev.type === 'eof') {
        if (mode.kind === 'input' && !busy && editor.isEmpty()) {
          output.write(RESTORE + CLEAR_BELOW + '\r\n' + ANSI.dim('再见。') + '\r\n');
          cleanup(0);
        }
      } else if (mode.kind === 'input' && !busy) {
        redraw();
      } else {
        redraw();
      }
    }
  });

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
      case '/permissions':
        cmdPermissions(cmd.args);
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

  function cmdPermissions(args: string[]): void {
    if (args.length === 0) {
      const rules = sessionRules.length > 0
        ? sessionRules.map((r) => `  ${r.effect.padEnd(5)} ${r.tool}${r.match?.command !== undefined ? `  cmd=${r.match.command}` : ''}${r.match?.path !== undefined ? `  path=${r.match.path}` : ''}`).join('\n')
        : '  (无临时规则)';
      printAbove(
        [
          `权限模式: ${ANSI.bold(agent.engine.mode)}（当前档位: ${tierShortOf(agent.engine.mode)}）`,
          '临时规则:',
          rules,
          '调整: /permissions mode <mode> | /permissions allow <tool|pattern> | /permissions deny <tool|pattern>',
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
    printAbove(`${ANSI.yellow('用法: /permissions [mode <m> | allow <tool> | deny <tool>]')}\n`);
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
    redraw();
  }
  output.on('resize', resizeHandler);

  // 开场
  printAbove(ANSI.bold('LIWENCode v0.1 交互模式') + '\n');
  printAbove(ANSI.dim(`  权限档位: ${tierLongOf(tier.mode)}`) + '\n');
  printAbove(ANSI.dim('  /help 查看命令 · @文件 引用上下文 · !命令 执行 shell · Ctrl+C 取消/退出') + '\n');
  redraw();
  statusTimer = setInterval(() => {
    if (chromeDrawn) redraw();
  }, 500);

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
