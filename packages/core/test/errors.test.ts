import { describe, expect, it } from 'vitest';
import { ALL_ERROR_CODES, ERROR_REGISTRY, LiwenError, MESSAGES_ZH_CN } from '../src';

describe('error registry governance (09 §9.10)', () => {
  it('has unique, well-formed codes', () => {
    const set = new Set(ALL_ERROR_CODES);
    expect(set.size).toBe(ALL_ERROR_CODES.length);
    for (const code of ALL_ERROR_CODES) {
      expect(code).toMatch(/^LW-[A-Z]{2,4}-\d{3}$/);
    }
  });

  it('LW-DEC-007 gap is intentional and preserved', () => {
    expect(ALL_ERROR_CODES).not.toContain('LW-DEC-007');
    expect(ALL_ERROR_CODES).toContain('LW-DEC-006');
    expect(ALL_ERROR_CODES).toContain('LW-DEC-008');
  });

  it('every active code has a zh-CN message and vice versa', () => {
    for (const code of ALL_ERROR_CODES) {
      expect(MESSAGES_ZH_CN[code], code).toBeDefined();
    }
    for (const code of Object.keys(MESSAGES_ZH_CN)) {
      expect(ALL_ERROR_CODES).toContain(code);
    }
  });

  it('fatal set is exactly {CTX-002, ACP-001, INT-001} and none retryable', () => {
    const fatal = ALL_ERROR_CODES.filter((c) => ERROR_REGISTRY.get(c)?.severity === 'fatal');
    expect(fatal.sort()).toEqual(['LW-ACP-001', 'LW-CTX-002', 'LW-INT-001']);
    for (const c of fatal) expect(ERROR_REGISTRY.get(c)?.retryable).toBe(false);
  });

  it('retryable set matches the registered table (BR-014)', () => {
    const retryable = new Set(ALL_ERROR_CODES.filter((c) => ERROR_REGISTRY.get(c)?.retryable));
    for (const c of [
      'LW-PRV-002', 'LW-PRV-003', 'LW-PRV-007', 'LW-PRV-008', 'LW-PRV-009',
      'LW-TOOL-004', 'LW-CTX-001', 'LW-SES-004', 'LW-MCP-001', 'LW-MCP-005',
      'LW-DEC-001', 'LW-DEC-002', 'LW-AGT-002', 'LW-AGT-005',
    ]) {
      expect(retryable.has(c), c).toBe(true);
    }
    expect(retryable.has('LW-PRV-001')).toBe(false);
    expect(retryable.has('LW-PERM-001')).toBe(false);
  });
});

describe('LiwenError', () => {
  it('serializes to the fixed 7-field shape', () => {
    const e = new LiwenError({ code: 'LW-FS-003', modelMessage: 'match twice' });
    const json = e.toJSON();
    expect(json.code).toBe('LW-FS-003');
    expect(json.category).toBe('fs');
    expect(json.severity).toBe('error');
    expect(json.retryable).toBe(false);
    expect(json.recovery).toBe('fix_input');
    expect(typeof json.message).toBe('string');
    expect(Object.keys(json).sort()).toEqual(['category', 'code', 'message', 'recovery', 'retryable', 'severity']);
  });

  it('is identified by LiwenError.is, not instanceof (cross-copy safety)', () => {
    const e = new LiwenError({ code: 'LW-INT-001' });
    expect(LiwenError.is(e)).toBe(true);
    expect(LiwenError.is(new Error('plain'))).toBe(false);
    expect(LiwenError.is('string')).toBe(false);
    expect(LiwenError.is(null)).toBe(false);
  });

  it('wrap passes LiwenError through and boxes everything else as LW-INT-001', () => {
    const le = new LiwenError({ code: 'LW-PRV-002' });
    expect(LiwenError.wrap(le)).toBe(le);
    const wrapped = LiwenError.wrap(new Error('boom'));
    expect(wrapped.code).toBe('LW-INT-001');
    expect(wrapped.fatal).toBe(true);
  });

  it('rejects unregistered codes at construction', () => {
    expect(() => new LiwenError({ code: 'LW-XXX-999' })).toThrow(/not in registry/);
  });
});
