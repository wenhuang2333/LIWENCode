/**
 * 欢迎面板（Welcome Panel）：进入正式工作区时的初始区域（仿 Claude Code /
 * MiMo 的欢迎框，但布局自定）。
 *
 * 布局：一个圆角矩形，左半部分 = 扇动的多彩蝴蝶（持续动画）+ 下方黑白阴影
 * 画风的 LIWENCode 艺术字；右半部分 = 英文欢迎语与指令提示。
 *
 * 纯函数渲染：renderPanel(cols, panelH, tMs, info) → string[]（每行等宽），
 * t 驱动蝴蝶扇翅，便于确定性单测。终端过小返回 []（调用方跳过面板）。
 */

export interface WelcomeInfo {
  version: string;
  model: string;
  tier: string;
}

export function welcomeSupported(cols: number, rows: number): boolean {
  return cols >= 64 && rows >= 20;
}

// ---------- 迷你像素字体（"LIWENCode" 专用，变宽 5 行） ----------

const MINI: Record<string, { w: number; rows: string[] }> = {
  L: { w: 3, rows: ['100', '100', '100', '100', '111'] },
  I: { w: 1, rows: ['1', '1', '1', '1', '1'] },
  W: { w: 5, rows: ['10001', '10001', '10101', '10101', '01010'] },
  E: { w: 4, rows: ['1111', '1000', '1110', '1000', '1111'] },
  N: { w: 4, rows: ['1001', '1101', '1011', '1001', '1001'] },
  C: { w: 4, rows: ['0111', '1000', '1000', '1000', '0111'] },
  o: { w: 4, rows: ['0110', '1001', '1001', '1001', '0110'] },
  d: { w: 4, rows: ['0001', '0111', '1001', '1001', '0111'] },
  e: { w: 3, rows: ['110', '100', '111', '101', '011'] },
};

export interface MiniPoint {
  col: number;
  row: number;
}

/** 迷你字渲染为点阵；spacing 为字间距（放不下时用 0） */
export function miniPoints(text: string, spacing = 1): { points: MiniPoint[]; width: number } {
  const points: MiniPoint[] = [];
  let x = 0;
  for (const ch of text) {
    const g = MINI[ch];
    if (g === undefined) {
      x += 2 + spacing;
      continue;
    }
    for (let r = 0; r < 5; r++) {
      const line = g.rows[r]!;
      for (let c = 0; c < g.w; c++) {
        if (line[c] === '1') points.push({ col: x + c, row: r });
      }
    }
    x += g.w + spacing;
  }
  return { points, width: Math.max(0, x - spacing) };
}

// ---------- 蝴蝶（多彩 + 持续扇翅） ----------

/** 彩虹六色（按曲线角度 θ 分区着色） */
export const RAINBOW = [196, 208, 226, 46, 44, 21];

export const FLAP_CYCLE_MS = 2400;

/** 蝴蝶像素着色（半块坐标系：像素高 = 终端行数×2）。key = y*w+x */
export function butterflyPixels(w: number, h: number, tMs: number): Map<number, number> {
  const px = new Map<number, number>();
  const cx = w / 2;
  const cy = h / 2;
  const scale = Math.min(w * 0.46, h * 0.5) / 3.5;
  const phase = (tMs % FLAP_CYCLE_MS) / FLAP_CYCLE_MS; // 0..1 一个扇翅周期
  const wing = 0.32 + 0.68 * Math.abs(Math.cos(Math.PI * 2 * phase));
  const bob = Math.sin(Math.PI * 2 * phase) * 1.4;

  const put = (x: number, y: number, color: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || xi >= w || yi < 0 || yi >= h) return;
    px.set(yi * w + xi, color);
  };

  // 小画布降采样，避免粒子糊成一团
  const samples = Math.max(70, Math.min(220, Math.floor((w * h) / 6)));
  for (let i = 0; i < samples; i++) {
    const th = (i / samples) * Math.PI * 12;
    const r = Math.exp(Math.sin(th)) - 2 * Math.cos(4 * th) + Math.pow(Math.sin((2 * th - Math.PI) / 24), 5);
    const rx = r * Math.sin(th) * scale;
    const y = cy - r * Math.cos(th) * scale;
    const color = RAINBOW[Math.floor(((i / samples) * 6) % 6)]!;
    put(cx + rx * wing, y + bob, color);
  }
  // 身体（白色竖线，rx=0 不受扇翅缩放影响）+ 触角（不随翅膀缩放）
  const bodyLen = Math.max(5, Math.floor(h * 0.15));
  for (let k = -bodyLen; k <= bodyLen; k++) put(cx, cy + k + bob, 250);
  for (const dir of [-1, 1]) {
    for (let k = 1; k <= 5; k++) put(cx + dir * k * 0.8, cy - bodyLen - k * 1.2 + bob, 45);
  }
  return px;
}

/** 黑白阴影艺术字像素：主字亮白 250，右下偏移（+1 列/+2 像素行）阴影深灰 238。
 * 字形纵向 ×2（半块像素为正方形，1:1 映射会把字压扁）；像素高 = 5×2+2 = 12 = 6 终端行 */
export function artPixels(w: number, text = 'LIWENCode'): Map<number, number> {
  let { points, width } = miniPoints(text, 1);
  if (width > w) {
    const tight = miniPoints(text, 0);
    points = tight.points;
    width = tight.width;
  }
  const px = new Map<number, number>();
  const ox = Math.max(0, Math.floor((w - width - 1) / 2));
  for (const p of points) {
    // 阴影（先行，被主字覆盖处重写）
    px.set((p.row * 2 + 2) * w + (p.col + ox + 1), 238);
    px.set((p.row * 2 + 3) * w + (p.col + ox + 1), 238);
  }
  for (const p of points) {
    px.set((p.row * 2) * w + (p.col + ox), 250);
    px.set((p.row * 2 + 1) * w + (p.col + ox), 250);
  }
  return px;
}

// ---------- 半块渲染（单条带） ----------

function stripOf(px: Map<number, number>, w: number, row: number): string {
  const parts: string[] = [];
  let fg: number | null = null;
  let bg: number | null = null;
  const setFg = (c: number | null) => {
    if (fg !== c) {
      parts.push(c === null ? '\x1b[39m' : `\x1b[38;5;${c}m`);
      fg = c;
    }
  };
  const setBg = (c: number | null) => {
    if (bg !== c) {
      parts.push(c === null ? '\x1b[49m' : `\x1b[48;5;${c}m`);
      bg = c;
    }
  };
  for (let c = 0; c < w; c++) {
    const up = px.get(row * 2 * w + c);
    const down = px.get((row * 2 + 1) * w + c);
    if (up === undefined && down === undefined) {
      setFg(null);
      setBg(null);
      parts.push(' ');
    } else if (down === undefined) {
      setBg(null);
      setFg(up!);
      parts.push('▀');
    } else if (up === undefined) {
      setFg(null);
      setBg(down);
      parts.push('▄');
    } else {
      setFg(up);
      setBg(down);
      parts.push('▀');
    }
  }
  parts.push('\x1b[39m\x1b[49m');
  return parts.join('');
}

// ---------- 面板组装 ----------

const dim = (s: string) => `\x1b[2m${s}\x1b[22m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[22m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[39m`;
const green = (s: string) => `\x1b[32m${s}\x1b[39m`;
const yellow = (s: string) => `\x1b[33m${s}\x1b[39m`;

/** 纯 ASCII 行（右列内容在构造期就控制在宽度内，无需 ANSI 感知截断） */
function rightColumn(info: WelcomeInfo): string[] {
  const hints: [string, string][] = [
    ['/help', 'all commands'],
    ['/model', 'pick model'],
    ['/status', 'session info'],
    ['/exit', 'quit'],
  ];
  const extra: [string, string][] = [
    ['@file', 'attach file'],
    ['!cmd', 'shell (gated)'],
    ['Ctrl+C', 'cancel / x2 quit'],
  ];
  return [
    '',
    bold('Welcome to LIWENCode'),
    dim(`${info.version} · model ${cyan(info.model)}`),
    dim(`permission: ${yellow(info.tier)}`),
    '',
    ...hints.map(([k, v]) => `  ${green(k.padEnd(9))} ${dim(v)}`),
    '',
    ...extra.map(([k, v]) => `  ${green(k.padEnd(9))} ${dim(v)}`),
    '',
    dim('Type / for command palette'),
  ];
}

/**
 * 渲染欢迎面板：返回等宽行数组（不含换行）；终端过小返回 []。
 * panelH 由调用方按可用行数给出（12..22）。
 */
export function renderPanel(cols: number, panelH: number, tMs: number, info: WelcomeInfo): string[] {
  const panelW = Math.min(cols - 2, 88);
  if (!welcomeSupported(cols, panelH + 2) || panelH < 12) return [];
  const innerH = panelH - 2;
  // 内容行结构：│_leftW_│_rightW_│ → 边框2 + 空隙5 = leftW+rightW+7 = panelW
  const leftW = Math.floor((panelW - 7) / 2);
  const rightW = panelW - 7 - leftW;

  // 左列：蝴蝶（上半）+ 空行 + 艺术字（底部 6 行）
  const artH = 6;
  const butterflyRows = innerH - artH - 1;
  const butterfly = butterflyPixels(leftW, butterflyRows * 2, tMs);
  const art = artPixels(leftW);

  // 右列：垂直居中
  const right = rightColumn(info);
  const padTop = Math.max(0, Math.floor((innerH - right.length) / 2));
  const rightAt = (i: number): string => {
    const line = i >= padTop ? right[i - padTop] : undefined;
    return line ?? '';
  };

  const lines: string[] = [];
  const title = ' LIWENCode ';
  const fill = panelW - 2 - title.length;
  const l = Math.floor(fill / 2);
  lines.push(`╭${'─'.repeat(l)}${title}${'─'.repeat(fill - l)}╮`);
  for (let r = 0; r < innerH; r++) {
    let leftCell: string;
    if (r < butterflyRows) leftCell = stripOf(butterfly, leftW, r);
    else if (r === butterflyRows) leftCell = ' '.repeat(leftW);
    else leftCell = stripOf(art, leftW, r - butterflyRows - 1);
    // 右列最长行约 40 列；rightW 不足时置空（面板宽度已由 welcomeSupported 兜底）
    const rt = plainLen(rightAt(r)) > rightW ? '' : rightAt(r);
    const pad = rightW - plainLen(rt);
    lines.push(`│ ${leftCell} │ ${rt}${' '.repeat(Math.max(0, pad))} │`);
  }
  lines.push(`╰${'─'.repeat(panelW - 2)}╯`);
  return lines;
}

/** 右列仅含 ASCII + ANSI 转义：可见长度 = 总长 − 转义序列长 */
function plainLen(s: string): number {
  return s.replace(/\x1b\[[0-9;]*m/g, '').length;
}
