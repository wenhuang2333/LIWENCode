import { describe, expect, it } from 'vitest';
import {
  FLAP_CYCLE_MS,
  RAINBOW,
  artPixels,
  butterflyPixels,
  miniPoints,
  renderPanel,
  welcomeSupported,
} from '../src/tui/welcome';

const INFO = { version: 'v0.1.0', model: 'mock:default', tier: 'strict' };
const COLS = 100;
const PANEL_H = 20;

function wingExtent(px: Map<number, number>, w: number): number {
  let max = 0;
  for (const key of px.keys()) {
    const d = Math.abs((key % w) - w / 2);
    if (d > max) max = d;
  }
  return max;
}

describe('tui/welcome 欢迎面板', () => {
  it('miniPoints：LIWENCode 点阵边界与宽度', () => {
    const { points, width } = miniPoints('LIWENCode', 0);
    expect(points.length).toBeGreaterThan(50);
    for (const p of points) {
      expect(p.row).toBeGreaterThanOrEqual(0);
      expect(p.row).toBeLessThan(5);
      expect(p.col).toBeLessThan(width);
    }
    // 紧凑排布 32 列（L3 I1 W5 E4 N4 C4 o4 d4 e3 = 32）
    expect(width).toBe(32);
  });

  it('artPixels：黑白阴影（主字亮白 + 深灰阴影）', () => {
    const px = artPixels(40);
    const colors = new Set(px.values());
    expect(colors.has(250)).toBe(true); // 主字
    expect(colors.has(238)).toBe(true); // 阴影
    expect(colors.size).toBe(2); // 纯黑白灰，无彩色
  });

  it('butterflyPixels：多彩（≥3 种彩虹色）且持续扇翅', () => {
    const W = 36;
    const H = 24;
    const open = butterflyPixels(W, H, 0); // phase 0 = 全开
    const colors = new Set(open.values());
    const rainbowHits = [...colors].filter((c) => RAINBOW.includes(c));
    expect(rainbowHits.length).toBeGreaterThanOrEqual(3); // 多彩
    // 1/4 周期处翅膀收拢最窄（|cos(π/2)| = 0）
    const folded = butterflyPixels(W, H, Math.floor(FLAP_CYCLE_MS / 4));
    expect(wingExtent(folded, W)).toBeLessThan(wingExtent(open, W) * 0.6);
    // 周期性：t 与 t+FLAP_CYCLE_MS 完全一致
    expect(butterflyPixels(W, H, 1234)).toEqual(butterflyPixels(W, H, 1234 + FLAP_CYCLE_MS));
  });

  it('renderPanel：结构、等宽、纯英文', () => {
    const lines = renderPanel(COLS, PANEL_H, 1000, INFO);
    expect(lines.length).toBe(PANEL_H);
    expect(lines[0]!.startsWith('╭')).toBe(true);
    expect(lines[lines.length - 1]!.startsWith('╰')).toBe(true);
    // 每行去掉 ANSI 后显示宽度一致（= panelW）
    const plain = lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
    const w0 = plain[0]!.length;
    for (const l of plain) expect(l.length).toBe(w0);
    // 英文欢迎语与提示
    const joined = plain.join('\n');
    expect(joined).toContain('Welcome to LIWENCode');
    expect(joined).toContain('mock:default');
    expect(joined).toContain('/help');
    expect(joined).toContain('Type / for command palette');
    // 全英文：无 CJK 字符（右侧文本区）
    expect(joined.match(/[\u4e00-\u9fff]/)).toBeNull();
  });

  it('renderPanel：蝴蝶动画驱动帧变化', () => {
    const a = renderPanel(COLS, PANEL_H, 0, INFO).join('');
    const b = renderPanel(COLS, PANEL_H, Math.floor(FLAP_CYCLE_MS / 3), INFO).join('');
    expect(a).not.toBe(b);
  });

  it('终端过小返回空（调用方回退旧横幅）', () => {
    expect(welcomeSupported(63, 30)).toBe(false);
    expect(welcomeSupported(64, 19)).toBe(false);
    expect(welcomeSupported(64, 20)).toBe(true);
    expect(renderPanel(60, 20, 0, INFO)).toEqual([]);
  });
});
