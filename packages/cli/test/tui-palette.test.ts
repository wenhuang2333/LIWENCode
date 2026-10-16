import { describe, expect, it } from 'vitest';
import { COMMAND_HINTS, PALETTE_MAX, exactIndex, suggestCommands } from '../src/tui/palette';
import { LineEditor } from '../src/tui/editor';

describe('tui/palette 指令联想', () => {
  it('提示表：全部以 / 开头、名字唯一、英文描述非空', () => {
    const names = COMMAND_HINTS.map((h) => h.name);
    expect(new Set(names).size).toBe(names.length);
    for (const h of COMMAND_HINTS) {
      expect(h.name.startsWith('/')).toBe(true);
      expect(h.desc.length).toBeGreaterThan(5);
      expect(h.desc.match(/[\u4e00-\u9fff]/)).toBeNull(); // 英文
    }
  });

  it('前缀过滤："#" 不触发、"/" 全量（截断到上限）、空格后不触发', () => {
    expect(suggestCommands('hello')).toEqual([]);
    expect(suggestCommands('')).toEqual([]);
    expect(suggestCommands('/model use deepseek')).toEqual([]); // 已带参数
    const all = suggestCommands('/');
    expect(all.length).toBe(PALETTE_MAX);
    expect(all[0]!.name).toBe('/help');
  });

  it('前缀过滤：/m → /model+/manage+/mcp；大小写不敏感；新命令在表中', () => {
    expect(suggestCommands('/m').map((h) => h.name)).toEqual(['/model', '/manage', '/mcp']);
    expect(suggestCommands('/MO').map((h) => h.name)).toEqual(['/model']);
    expect(suggestCommands('/c').map((h) => h.name)).toEqual(['/cost', '/compact', '/clear']);
    expect(suggestCommands('/s').map((h) => h.name)).toEqual(['/status', '/setup']);
  });

  it('exactIndex：完整命令名命中', () => {
    const hints = suggestCommands('/mo');
    expect(exactIndex(hints, '/model')).toBe(0);
    expect(exactIndex(hints, '/mo')).toBe(-1);
  });
});

describe('tui/editor 联想键位（nav 捕获 / Esc / Tab / setLine）', () => {
  it('navCapture 关闭（默认）：↑↓ 浏览历史', () => {
    const ed = new LineEditor();
    ed.feed('one\r');
    ed.feed('\x1b[A');
    expect(ed.text()).toBe('one');
  });

  it('navCapture 开启：↑↓ 产生 nav 事件，不改内容', () => {
    const ed = new LineEditor();
    ed.feed('one\r');
    ed.setLine('/');
    ed.setNavCapture(true);
    const up = ed.feed('\x1b[A');
    expect(up).toEqual([{ type: 'nav', dir: 'up' }]);
    const down = ed.feed('\x1b[B');
    expect(down).toEqual([{ type: 'nav', dir: 'down' }]);
    expect(ed.text()).toBe('/'); // 历史未被调入
  });

  it('独立 Esc 与 Tab 事件；Tab 不再插入空格（由 TUI 决定）', () => {
    const ed = new LineEditor();
    expect(ed.feed('\x1b')).toEqual([{ type: 'escape' }]);
    expect(ed.feed('\t')).toEqual([{ type: 'tab' }]);
    expect(ed.text()).toBe('');
  });

  it('setLine 整行替换并清历史浏览状态', () => {
    const ed = new LineEditor();
    ed.feed('old\r');
    ed.setLine('/model ');
    expect(ed.text()).toBe('/model ');
    expect(ed.cursorCol()).toBe(7);
  });
});
