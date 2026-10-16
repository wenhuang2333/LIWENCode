import { describe, expect, it } from 'vitest';
import {
  PERMISSION_TIERS,
  parsePermissionArg,
  permissionModeShort,
  permissionTierPanel,
} from '../src/slash';

describe('slash /permission 档位解析（三档 + 高级模式 + 别名）', () => {
  it('三个档位名正映射到引擎模式', () => {
    expect(parsePermissionArg('strict')).toEqual({ key: 'strict', mode: 'strict' });
    expect(parsePermissionArg('HuangAura')).toEqual({ key: 'HuangAura', mode: 'default' });
    expect(parsePermissionArg('WenNova')).toEqual({ key: 'WenNova', mode: 'bypass' });
  });

  it('大小写与连字符/下划线不敏感', () => {
    expect(parsePermissionArg('huangaura')!.mode).toBe('default');
    expect(parsePermissionArg('HUANG-AURA')!.mode).toBe('default');
    expect(parsePermissionArg('wen_nova')!.mode).toBe('bypass');
    expect(parsePermissionArg('  Strict  ')!.mode).toBe('strict');
  });

  it('模式别名与高级模式', () => {
    expect(parsePermissionArg('default')!.key).toBe('HuangAura');
    expect(parsePermissionArg('bypass')!.key).toBe('WenNova');
    expect(parsePermissionArg('acceptEdits')!.mode).toBe('acceptEdits');
    expect(parsePermissionArg('plan')!.mode).toBe('plan');
  });

  it('无法识别返回 null（调用方给出用法提示）', () => {
    expect(parsePermissionArg('nope')).toBeNull();
    expect(parsePermissionArg('')).toBeNull();
    expect(parsePermissionArg('mode')).toBeNull();
    expect(parsePermissionArg('allow')).toBeNull();
  });
});

describe('slash /permission 展示文本', () => {
  it('短标签覆盖全部模式', () => {
    expect(permissionModeShort('strict')).toBe('严格档：均需确认');
    expect(permissionModeShort('default')).toBe('部分权限：读免确认');
    expect(permissionModeShort('bypass')).toBe('完全权限：免确认');
    expect(permissionModeShort('plan')).toBe('plan 只读');
    expect(permissionModeShort('acceptEdits')).toBe('acceptEdits');
  });

  it('速查面板列出三档并用 ● 标记当前档位', () => {
    const panel = permissionTierPanel('default').join('\n');
    for (const t of PERMISSION_TIERS) expect(panel).toContain(t.key);
    expect(panel).toMatch(/● HuangAura/); // 当前档位带标记
    expect(panel).not.toMatch(/● strict/);
    expect(panel).toContain('/permission <档位> 直接切换');
  });

  it('高级模式（plan/acceptEdits）下也能标出当前模式', () => {
    expect(permissionTierPanel('plan').join('\n')).toMatch(/● plan/);
    expect(permissionTierPanel('acceptEdits').join('\n')).toMatch(/● acceptEdits/);
  });
});
