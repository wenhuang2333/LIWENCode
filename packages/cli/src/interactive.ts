import * as readline from 'node:readline/promises';
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
import type { CliArgs } from './args.js';
import { resolvePermissionTier } from './args.js';
import { buildProvider, type ProviderSpec } from './provider-select.js';
import { helpText, parseSlash } from './slash.js';
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
} from './model-config.js';
import { formatDoctor, runDoctor } from './doctor.js';
import { expandAtPaths, summarizeInput } from './prompt-utils.js';

/**
 * Interactive REPL (FR-130 / FR-137 subset). Readline-based: streaming
 * rendering, terminal permission approval, @path expansion, !command shell
 * pass-through — every shell command still goes through the permission gate.
 */

const ANSI = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
  red: (s: string) => `\x1b[31m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
};

export interface InteractiveOptions {
  args: CliArgs;
  initialPrompt?: string;
}

interface UsageTotals {
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  requests: number;
}

export async function runInteractive(opts: InteractiveOptions): Promise<number> {
  const cwd = opts.args.cwd ?? process.cwd();
  const runtime = nodeRuntime();
  const redactor = new Redactor();
  const sessionStore = new FileSessionStore(runtime, `${liwenHome()}/sessions`, String(projectHashOf(cwd)));
  const { tools } = createBuiltinTools();
  const usageTotals: UsageTotals = { inputTokens: 0, outputTokens: 0, costUsd: 0, requests: 0 };

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

  const rl = readline.createInterface({ input, output, prompt: promptOf() });
  const isTTY = input.isTTY === true;
  let rlClosed = false;
  rl.on('close', () => {
    rlClosed = true;
  });
  const safePrompt = () => {
    if (!rlClosed) rl.prompt(true);
  };
  let lastSigint = 0;
  let activeAbort: AbortController | undefined;
  let agent = createCurrentAgent();

  function promptOf(): string {
    return ANSI.cyan(`liwen (${spec.provider}:${spec.model}) ❯ `);
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
      permissionHandler: terminalPermissionHandler,
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

  async function terminalPermissionHandler(req: PermissionRequest): Promise<PermissionDecision> {
    const preview = previewOfRequest(req);
    if (!isTTY) {
      // Headless (piped stdin): BR-042 — ask resolves to deny, never block.
      output.write(ANSI.yellow(`⚠ 权限请求（无人值守模式自动拒绝）: ${preview}\n`));
      return { decision: 'deny', message: 'Non-interactive session: approval unavailable (LW-CLI-002). Pre-approve via /permissions allow or --allowed-tools.' };
    }
    output.write(`\n${ANSI.yellow('⚠ 权限请求')} ${preview}\n`);
    rl.resume();
    if (rlClosed) return { decision: 'deny', message: '输入已关闭，无法审批，按拒绝处理。' };
    const answer = (await rl.question('  允许执行? [y]本次允许 / [s]本次会话均允许 / [n]拒绝 (默认 n): ')).trim().toLowerCase();
    rl.pause();
    if (answer === 'y') return { decision: 'allow' };
    if (answer === 's') return { decision: 'allow', remember: 'session' };
    return { decision: 'deny', message: '用户拒绝了该操作。' };
  }

  function previewOfRequest(req: PermissionRequest): string {
    const s = req.subject;
    if (s.command !== undefined) return `${req.tool} 执行 ${ANSI.bold(s.command)}（${req.risk}）`;
    if (s.path !== undefined) return `${req.tool} 写入 ${ANSI.bold(s.path)}（${req.risk}）`;
    if (s.url !== undefined) return `${req.tool} 访问 ${ANSI.bold(s.url)}（${req.risk}）`;
    return `${req.tool}（${req.risk}）`;
  }

  // ── run one turn ───────────────────────────────────────────────────────

  async function runTurn(prompt: string): Promise<void> {
    const expanded = await expandAtPaths(prompt);
    activeAbort = new AbortController();
    rl.pause();
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
            output.write(`\n${ANSI.yellow(`本轮结束: ${summary.endReason}`)}\n`);
          }
          break;
        }
        const ev = r.value;
        handleEvent(ev);
      }
    } catch (e) {
      output.write('\n');
      if (LiwenError.is(e)) output.write(ANSI.red(`错误 ${e.code}: ${e.message}\n`));
      else output.write(ANSI.red(`错误: ${e instanceof Error ? e.message : String(e)}\n`));
    } finally {
      if (inText) output.write('\n');
      activeAbort = undefined;
      output.write('\n');
      rl.resume();
      rl.setPrompt(promptOf());
      safePrompt();
    }

    function handleEvent(ev: AgentEvent): void {
      switch (ev.type) {
        case 'text.delta':
          inText = true;
          output.write(ev.text);
          break;
        case 'tool.start':
          if (inText) {
            output.write('\n');
            inText = false;
          }
          output.write(ANSI.dim(`  ⚙ ${ev.name} ${summarizeInput(ev.input)}\n`));
          break;
        case 'tool.result': {
          const first = ev.content.find((c) => c.type === 'text');
          const text = first !== undefined && first.type === 'text' ? first.text : '';
          const oneline = text.split('\n').slice(0, 2).join(' ⏎ ').slice(0, 160);
          output.write(ev.isError ? ANSI.red(`  ✖ ${oneline}\n`) : ANSI.dim(`  ✔ ${oneline}\n`));
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
          output.write(ANSI.yellow(`  ⚠ 预算已达 ${Math.round(ev.ratio * 100)}%\n`));
          break;
        case 'error':
          output.write(ev.fatal ? ANSI.red(`  ✖ ${ev.error.code} ${ev.error.message}\n`) : ANSI.yellow(`  ⚠ ${ev.error.code} ${ev.error.message}\n`));
          break;
        default:
          break;
      }
    }
  }

  function summarizeInput(input: unknown): string {
    const json = JSON.stringify(input ?? {});
    return json.length > 80 ? `${json.slice(0, 77)}…` : json;
  }

  /** @path expansion (FR-134): attach referenced file contents to the prompt. */
  async function expandAtPaths(prompt: string): Promise<string> {
    const refs = [...prompt.matchAll(/(?:^|\s)@([^\s]+)/g)].map((m) => m[1]!).slice(0, 8);
    if (refs.length === 0) return prompt;
    const parts: string[] = [prompt];
    for (const ref of refs) {
      const abs = ref.startsWith('/') ? ref : `${cwd}/${ref}`;
      try {
        const content = await runtime.fs.readFile(abs);
        const truncated = content.split('\n').slice(0, 500).join('\n');
        parts.push(`--- @${ref} ---\n${truncated}${content.split('\n').length > 500 ? '\n… [截断至 500 行]' : ''}`);
      } catch {
        parts.push(`--- @${ref} --- (文件不存在或不可读，已跳过)`);
      }
    }
    return parts.join('\n\n');
  }

  /** !command (FR-134): propose a shell command; still permission-gated. */
  async function runBangCommand(command: string): Promise<void> {
    const engine = agent.engine;
    const outcome = await engine.checkSubject('bash', 'exec', { command });
    if (outcome.outcome === 'deny') {
      output.write(ANSI.red(`✖ 拒绝 [${outcome.error.code}]: ${outcome.error.modelMessage ?? outcome.error.message}\n`));
      return;
    }
    const proc = runtime.shell.spawn('/bin/sh', ['-c', command], { cwd, timeoutMs: 60_000 });
    let out = '';
    const collect = async (s: AsyncIterable<string>) => {
      for await (const line of s) out += `${line}\n`;
    };
    const code = await Promise.all([proc.exited, collect(proc.stdout), collect(proc.stderr)]).then(([c]) => c);
    output.write(ANSI.dim(`exit=${code}\n${out.slice(0, 2000)}`));
  }

  // ── slash handlers ─────────────────────────────────────────────────────

  async function handleSlash(cmd: { name: string; args: string[] }): Promise<void> {
    switch (cmd.name) {
      case '/help':
        output.write(`${helpText(cmd.args[0])}\n`);
        return;
      case '/exit':
      case '/quit':
        throw new ExitRepl();
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
        output.write(ANSI.green('已开启新会话（历史已清空）。\n'));
        return;
      case '/resume':
        await cmdResume(cmd.args);
        return;
      case '/doctor':
        output.write(`${formatDoctor(runDoctor(cwd))}\n`);
        return;
      case '/agents':
      case '/mcp':
      case '/goal':
      case '/rewind': {
        const doc = { '/agents': '三角色编排（hyaki/sota/common）', '/mcp': 'MCP 服务器管理', '/goal': '目标与确定性验收', '/rewind': '检查点回滚' }[cmd.name];
        output.write(ANSI.yellow(`${cmd.name} 属于后续里程碑（M2+），当前版本为占位。用 /help 查看可用命令。\n  计划功能：${doc}\n`));
        return;
      }
      default:
        output.write(ANSI.yellow(`未知命令 '${cmd.name}'。输入 /help 查看全部命令。\n`));
        return;
    }
  }

  async function cmdModel(args: string[]): Promise<void> {
    const sub = args[0];
    if (sub === undefined || sub === 'show') {
      const entry = catalogEntry(spec.provider);
      const key = entry !== undefined && entry.apiKeyEnv !== undefined ? keyStatusOf(entry) : undefined;
      output.write(
        [
          `当前模型: ${ANSI.bold(`${spec.provider}:${spec.model}`)}`,
          entry !== undefined ? `  端点: ${entry.baseUrl === '' ? '(离线)' : entry.baseUrl}` : '',
          key !== undefined ? `  密钥: ${key.set ? `${entry?.apiKeyEnv} 已设置（${key.source === 'env-file' ? '~/.liwencode/env' : '进程环境变量'}）` : `${entry?.apiKeyEnv} 未设置`}` : '  密钥: (无需)',
          '',
          '用法: /model list | /model use <provider:model> | /model config [provider]',
        ].filter((l) => l !== '').join('\n') + '\n',
      );
      return;
    }
    if (sub === 'list') {
      const rows = PROVIDER_CATALOG.map((p) => {
        const key = p.apiKeyEnv !== undefined ? keyStatusOf(p) : { set: true, source: 'none' as const };
        return `  ${(p.id + ':' + p.models.join('|')).padEnd(44)} ${p.label}  密钥: ${key.set ? ANSI.green('✔') : ANSI.yellow('✘')}`;
      });
      output.write(`Provider 目录：\n${rows.join('\n')}\n  切换: /model use deepseek:deepseek-chat\n`);
      return;
    }
    if (sub === 'use') {
      const target = args[1];
      if (target === undefined || !target.includes(':')) {
        output.write(ANSI.yellow('用法: /model use <provider:model>，例如 /model use deepseek:deepseek-chat\n'));
        return;
      }
      const [providerId, name] = target.split(':');
      const entry = catalogEntry(providerId ?? '');
      if (entry === undefined) {
        output.write(ANSI.red(`未知 provider '${providerId}'。/model list 查看目录。\n`));
        return;
      }
      if (entry.needsKey && !keyStatusOf(entry).set) {
        output.write(ANSI.yellow(`${providerId} 需要密钥（${entry.apiKeyEnv}）。先运行 /model config ${providerId}\n`));
        return;
      }
      const history = [...agent.history];
      spec = { provider: providerId ?? 'mock', model: name ?? 'default' };
      const previousMode = agent.engine.mode;
      permissionMode = previousMode;
      agent = createCurrentAgent();
      agent.engine.setMode(previousMode);
      agent.history.push(...history);
      writeUserConfig({ ...readUserConfig(), model: { provider: spec.provider, name: spec.model } });
      output.write(ANSI.green(`已切换到 ${spec.provider}:${spec.model}（已保存为默认，历史保留）。\n`));
      return;
    }
    if (sub === 'config') {
      await cmdModelConfig(args[1]);
      return;
    }
    output.write(ANSI.yellow('用法: /model [list|use|config|show]\n'));
  }

  async function cmdModelConfig(providerId?: string): Promise<void> {
    if (!isTTY) {
      output.write(ANSI.yellow('/model config 需要交互式终端。可手动编辑 ~/.liwencode/config.json 与 ~/.liwencode/env。\n'));
      return;
    }
    let entry = providerId !== undefined ? catalogEntry(providerId) : undefined;
    if (providerId !== undefined && entry === undefined) {
      output.write(ANSI.red(`未知 provider '${providerId}'。可选: ${PROVIDER_CATALOG.map((p) => p.id).join(', ')}\n`));
      return;
    }
    if (entry === undefined) {
      output.write('配置哪个 Provider?\n');
      PROVIDER_CATALOG.forEach((p, i) => output.write(`  ${i + 1}. ${p.id.padEnd(18)} ${p.label}\n`));
      const pick = (await rl.question('序号 [1]: ')).trim();
      entry = PROVIDER_CATALOG[Number(pick || '1') - 1] ?? PROVIDER_CATALOG[0]!;
    }
    if (entry === undefined) return;
    const models = entry.models;
    output.write(`模型 (${models.join(' / ')}):\n`);
    const modelAnswer = (await rl.question(`模型名 [${models[0]}]: `)).trim();
    const model = modelAnswer !== '' ? modelAnswer : models[0]!;
    let baseUrl = entry.baseUrl;
    if (entry.baseUrl !== '') {
      const urlAnswer = (await rl.question(`Base URL [${entry.baseUrl}]: `)).trim();
      if (urlAnswer !== '') baseUrl = urlAnswer;
    }
    const config = readUserConfig();
    config.model = { provider: entry.id, name: model, ...(entry.apiKeyEnv !== undefined ? { apiKeyEnv: entry.apiKeyEnv } : {}) };
    if (baseUrl !== entry.baseUrl) config.model.baseUrl = baseUrl;
    writeUserConfig(config);

    if (entry.apiKeyEnv !== undefined) {
      const keyAnswer = (await rl.question(`API Key（存入 ~/.liwencode/env，权限 0600；直接回车=跳过，改为在 shell 中 export ${entry.apiKeyEnv}）: `)).trim();
      if (keyAnswer !== '') {
        const existing = parseEnvFile(await readFileSafe(envFilePath()) ?? '');
        existing[entry.apiKeyEnv] = keyAnswer;
        writeEnvFile(existing);
        process.env[entry.apiKeyEnv] = keyAnswer;
        output.write(ANSI.green(`密钥已保存到 ~/.liwencode/env（${maskKey(keyAnswer)}）。绝不进入会话文件与日志。\n`));
      }
    }
    spec = { provider: entry.id, model };
    const history = [...agent.history];
    const previousMode = agent.engine.mode;
    agent = createCurrentAgent();
    agent.engine.setMode(previousMode);
    agent.history.push(...history);
    output.write(ANSI.green(`配置完成，已切换到 ${entry.id}:${model}。\n`));
  }

  function cmdPermissions(args: string[]): void {
    if (args.length === 0) {
      const rules = sessionRules.length > 0
        ? sessionRules.map((r) => `  ${r.effect.padEnd(5)} ${r.tool}${r.match?.command !== undefined ? `  cmd=${r.match.command}` : ''}${r.match?.path !== undefined ? `  path=${r.match.path}` : ''}`).join('\n')
        : '  (无临时规则)';
      output.write(
        [
          `权限模式: ${ANSI.bold(agent.engine.mode)}（当前档位: ${tierLabelOf(agent.engine.mode)}）`,
          '临时规则:',
          rules,
          '调整: /permissions mode <mode> | /permissions allow <tool|pattern> | /permissions deny <tool|pattern>',
        ].join('\n') + '\n',
      );
      return;
    }
    if (args[0] === 'mode') {
      const mode = args[1];
      if (mode !== 'strict' && mode !== 'default' && mode !== 'acceptEdits' && mode !== 'plan' && mode !== 'bypass') {
        output.write(ANSI.yellow('模式必须为 strict | default | acceptEdits | plan | bypass\n'));
        return;
      }
      agent.engine.setMode(mode);
      permissionMode = mode;
      output.write(ANSI.green(`权限模式已切换为 ${mode}。\n`));
      return;
    }
    if ((args[0] === 'allow' || args[0] === 'deny') && args[1] !== undefined) {
      const rule: PermissionRule = { effect: args[0], tool: args[1], source: 'user' };
      sessionRules.push(rule);
      agent.engine.addRules([rule]);
      output.write(ANSI.green(`已添加 ${args[0]} 规则: ${args[1]}（仅本次会话）。\n`));
      return;
    }
    output.write(ANSI.yellow('用法: /permissions [mode <m> | allow <tool> | deny <tool>]\n'));
  }

  function cmdStatus(): void {
    const contextTokens = estimateMessagesTokens(agent.history, agent.registry.definitions());
    const windowSize = safeContextWindow();
    const turns = agent.history.filter((m) => m.role === 'assistant').length;
    output.write(
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

  function safeContextWindow(): number {
    try {
      return buildProvider(spec).capabilities(spec.model).contextWindow;
    } catch {
      return 128_000;
    }
  }

  function cmdCost(): void {
    const cost = usageTotals.costUsd > 0 ? `$${usageTotals.costUsd.toFixed(4)}` : '(当前 provider 未提供定价)';
    output.write(
      `累计用量: ${usageTotals.requests} 次请求 | 输入 ${usageTotals.inputTokens} tokens | 输出 ${usageTotals.outputTokens} tokens | 费用 ${cost}\n`,
    );
  }

  function cmdTools(): void {
    const rows = agent.registry.list().map(
      (t) => `  ${t.name.padEnd(8)} ${t.risk.padEnd(7)} ${t.readOnly ? '只读' : '可写'}${t.concurrencySafe ? ' · 并发安全' : ''}`,
    );
    output.write(`已注册工具：\n${rows.join('\n')}\n`);
  }

  function cmdCompact(): void {
    const before = estimateMessagesTokens(agent.history, agent.registry.definitions());
    const compacted = trimOldToolResults(agent.history, 6);
    agent.history.length = 0;
    agent.history.push(...compacted);
    const after = estimateMessagesTokens(agent.history, agent.registry.definitions());
    output.write(ANSI.green(`已压缩: ~${before} → ~${after} tokens（清理了旧工具结果，保留最近 6 轮）。\n`));
  }

  async function cmdResume(args: string[]): Promise<void> {
    const sessions = await sessionStore.list({ limit: 5 });
    if (args[0] === undefined) {
      if (sessions.length === 0) {
        output.write('暂无历史会话。\n');
        return;
      }
      output.write('最近会话（/resume <id> 恢复）：\n');
      for (const s of sessions) {
        output.write(`  ${s.sessionId.padEnd(42)} ${new Date(s.updatedAt).toLocaleString()}  ${s.entryCount} 条\n`);
      }
      return;
    }
    const target = sessions.find((s) => s.sessionId === args[0]);
    if (target === undefined) {
      output.write(ANSI.yellow(`会话 '${args[0]}' 不存在（LW-SES-001）。/resume 查看列表。\n`));
      return;
    }
    agent = createCurrentAgent(target.sessionId);
    output.write(ANSI.green(`已恢复会话 ${target.sessionId}，下一条消息将接续该历史。\n`));
  }

  // ── main loop ──────────────────────────────────────────────────────────

  process.on('SIGINT', () => {
    const now = Date.now();
    if (activeAbort !== undefined) {
      activeAbort.abort(new Error('SIGINT'));
      output.write(ANSI.yellow('\n⏹ 已取消本轮（再按 Ctrl+C 退出）\n'));
      return;
    }
    if (now - lastSigint < 2000) {
      rl.close();
      process.exit(130);
    }
    lastSigint = now;
    output.write(ANSI.yellow('\n（再按一次 Ctrl+C 退出）\n'));
    safePrompt();
  });

  output.write(banner(tierLabelOf(tier.mode)));
  if (!isTTY) output.write(ANSI.dim('（检测到管道输入：权限请求将按无人值守策略自动拒绝）\n'));

  safePrompt();

  if (opts.initialPrompt !== undefined && opts.initialPrompt.trim().length > 0) {
    await runTurn(opts.initialPrompt);
  }

  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (trimmed === '') {
        safePrompt();
        continue;
      }
      const slash = parseSlash(trimmed);
      if (slash !== null) {
        try {
          await handleSlash(slash);
        } catch (e) {
          if (e instanceof ExitRepl) break;
          throw e;
        }
        safePrompt();
        continue;
      }
      if (trimmed.startsWith('!')) {
        await runBangCommand(trimmed.slice(1));
        safePrompt();
        continue;
      }
      await runTurn(trimmed);
    }
  } finally {
    output.write(ANSI.dim('\n再见。\n'));
    rl.close();
  }
  return 0;
}

class ExitRepl extends Error {}

function banner(tierText: string): string {
  return [
    ANSI.bold('LIWENCode v0.1 交互模式'),
    ANSI.dim(`  权限档位: ${tierText}`),
    ANSI.dim('  /help 查看命令 · @文件 引用上下文 · !命令 执行 shell · Ctrl+C 取消/退出'),
    '',
  ].join('\n');
}

export function tierLabelOf(mode: 'strict' | 'default' | 'acceptEdits' | 'plan' | 'bypass'): string {
  switch (mode) {
    case 'strict': return '严格档：一切操作均需确认（--HuangAura 升级读取免确认，--WenNova 全免确认）';
    case 'default': return '部分权限（--HuangAura）：读取免确认，写/删/执行需确认';
    case 'acceptEdits': return 'acceptEdits：工作区内写入免确认';
    case 'plan': return 'plan：仅只读';
    case 'bypass': return '完全权限（--WenNova）：文件增删改查读免确认（危险命令仍拒绝）';
  }
}

async function readFileSafe(path: string): Promise<string | undefined> {
  try {
    const { readFileSync } = await import('node:fs');
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}
