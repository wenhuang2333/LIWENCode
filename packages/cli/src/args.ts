/** Minimal hand-rolled arg parsing (no framework dep). Subset of FR-135 for v0.1. */

export interface CliArgs {
  positional: string[];
  print: boolean;
  outputFormat: 'text' | 'json' | 'stream-json';
  model?: string;
  permissionMode?: 'strict' | 'default' | 'acceptEdits' | 'plan' | 'bypass';
  /** Full-permission tier shortcut (maps to bypass). */
  wenNova: boolean;
  /** Partial-permission tier shortcut (reads pass, writes/exec ask; maps to default). */
  huangAura: boolean;
  allowedTools: string[];
  disallowedTools: string[];
  maxTurns?: number;
  maxBudgetUsd?: number;
  cwd?: string;
  verbose: boolean;
  /** Skip the TUI boot animation (FR-137 / TUI). */
  noBoot: boolean;
  command?: 'exec' | 'doctor' | 'config' | 'version' | 'help';
  configSub?: 'list' | 'get' | 'path';
}

export type PermissionTier = 'strict' | 'HuangAura' | 'WenNova' | 'acceptEdits' | 'plan';

/**
 * Three-tier permission mapping:
 *  - no flag  → strict    一切操作（含读取）都需用户确认
 *  - --HuangAura → default 读取免确认；写/删/执行需确认
 *  - --WenNova   → bypass  文件增删改查读全部免确认（危险命令库仍拒绝，BR-006）
 * Precedence: --permission-mode > tier flag > saved user config > strict.
 */
export function resolvePermissionTier(
  args: Pick<CliArgs, 'permissionMode' | 'wenNova' | 'huangAura'>,
  savedMode?: 'strict' | 'default' | 'acceptEdits' | 'plan' | 'bypass',
): { mode: 'strict' | 'default' | 'acceptEdits' | 'plan' | 'bypass'; tier: PermissionTier; source: string } {
  if (args.permissionMode !== undefined) {
    return { mode: args.permissionMode, tier: tierOfMode(args.permissionMode), source: '--permission-mode' };
  }
  if (args.wenNova) return { mode: 'bypass', tier: 'WenNova', source: '--WenNova' };
  if (args.huangAura) return { mode: 'default', tier: 'HuangAura', source: '--HuangAura' };
  if (savedMode !== undefined) return { mode: savedMode, tier: tierOfMode(savedMode), source: 'user-config' };
  return { mode: 'strict', tier: 'strict', source: 'default' };
}

function tierOfMode(mode: 'strict' | 'default' | 'acceptEdits' | 'plan' | 'bypass'): PermissionTier {
  switch (mode) {
    case 'bypass': return 'WenNova';
    case 'default': return 'HuangAura';
    default: return mode; // strict | acceptEdits | plan pass through as their own label
  }
}

export const USAGE = `liwen — LIWENCode coding agent CLI (v0.1 internal)

Usage:
  liwen [options] [prompt]        进入交互模式；带 prompt 则作为首轮输入
  liwen -p "prompt"                非交互运行，输出结果后退出
  liwen exec "prompt"              同 -p
  liwen doctor                     环境与配置诊断
  liwen config list|get|path       查看生效配置
  liwen --version | --help

交互模式内：
  /help /model /permissions /status /cost /tools /compact /clear /resume /doctor /exit
  @路径          引用文件作为上下文      !命令  执行 shell（经权限审批）
  Ctrl+C        生成中=取消本轮；空闲时按两次=退出
  TTY 终端启动时播放粒子动画（--no-boot 跳过），随后进入常驻 TUI
  完整指令集见 docs/COMMANDS.md

权限档位（三选一，互斥）：
  （无参数）                     严格档：一切操作（含读取）都需用户确认
      --HuangAura                部分权限：读取免确认；写、删、执行仍需确认
      --WenNova                  完全权限：文件增删改查读均免确认（危险命令仍拒绝）
  也可用 --permission-mode <strict|default|acceptEdits|plan|bypass> 精确指定

Options:
  -p, --print                      非交互执行
  --output-format <text|json|stream-json>   结果格式（默认 text）
  -m, --model <provider:model>      如 mock:default、deepseek:deepseek-chat、anthropic:claude-sonnet-4
      --allowed-tools <patterns>   空格分隔的工具名/通配符
      --disallowed-tools <pats>    拒绝覆盖（不可放宽内置硬拒绝）
      --max-turns <n>              轮次上限（触发出码 4）
      --max-budget-usd <amount>    费用上限
      --cwd <path>                 工作区目录
      --no-boot                    跳过 TUI 启动动画
      --verbose                    stderr 诊断
`;

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    positional: [],
    print: false,
    outputFormat: 'text',
    wenNova: false,
    huangAura: false,
    allowedTools: [],
    disallowedTools: [],
    verbose: false,
    noBoot: false,
  };
  let i = 0;
  const next = (flag: string): string => {
    i += 1;
    const v = argv[i];
    if (v === undefined) {
      throw new UsageError(`missing value for ${flag}`);
    }
    return v;
  };
  const untilNextFlag = (): string[] => {
    const values: string[] = [];
    while (i + 1 < argv.length && !argv[i + 1]!.startsWith('-')) {
      i += 1;
      values.push(argv[i]!);
    }
    return values;
  };
  for (; i < argv.length; i += 1) {
    const a = argv[i]!;
    switch (a) {
      case '-p':
      case '--print':
        args.print = true;
        break;
      case 'exec':
        args.command = 'exec';
        args.print = true;
        break;
      case 'doctor':
        args.command = 'doctor';
        break;
      case 'config':
        args.command = 'config';
        break;
      case '--version':
        args.command = 'version';
        break;
      case '--help':
      case '-h':
        args.command = 'help';
        break;
      case '--output-format': {
        const v = next(a);
        if (v !== 'text' && v !== 'json' && v !== 'stream-json') {
          throw new UsageError(`invalid --output-format '${v}' (LW-CLI-001)`);
        }
        args.outputFormat = v;
        break;
      }
      case '-m':
      case '--model':
        args.model = next(a);
        break;
      case '--permission-mode': {
        const v = next(a);
        if (v !== 'strict' && v !== 'default' && v !== 'acceptEdits' && v !== 'plan' && v !== 'bypass') {
          throw new UsageError(`invalid --permission-mode '${v}' (LW-CLI-001)`);
        }
        args.permissionMode = v;
        break;
      }
      case '--WenNova':
      case '--wennova':
      case '--wen-nova':
        args.wenNova = true;
        if (args.huangAura) throw new UsageError('--WenNova and --HuangAura are mutually exclusive (LW-CLI-001)');
        break;
      case '--HuangAura':
      case '--huangaura':
      case '--huang-aura':
        args.huangAura = true;
        if (args.wenNova) throw new UsageError('--WenNova and --HuangAura are mutually exclusive (LW-CLI-001)');
        break;
      case '--allowed-tools':
        args.allowedTools.push(...untilNextFlag());
        break;
      case '--disallowed-tools':
        args.disallowedTools.push(...untilNextFlag());
        break;
      case '--max-turns':
        args.maxTurns = Number(next(a));
        break;
      case '--max-budget-usd':
        args.maxBudgetUsd = Number(next(a));
        break;
      case '--cwd':
        args.cwd = next(a);
        break;
      case '--verbose':
        args.verbose = true;
        break;
      case '--no-boot':
        args.noBoot = true;
        break;
      default:
        if (a.startsWith('-')) {
          throw new UsageError(`unknown option '${a}' (LW-CLI-001)`);
        }
        args.positional.push(a);
        break;
    }
  }
  if (args.command === 'config') {
    const sub = args.positional[0];
    if (sub !== 'list' && sub !== 'get' && sub !== 'path') {
      throw new UsageError(`config subcommand must be list | get | path (LW-CLI-001)`);
    }
    args.configSub = sub;
  }
  return args;
}

export class UsageError extends Error {}
