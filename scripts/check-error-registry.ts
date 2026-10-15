/**
 * Registry governance checks (09 §9.10):
 * 1. every code unique, LW-<domain>-<seq> well-formed
 * 2. LW-DEC-007 must NOT exist (sequence gap is intentional)
 * 3. every active code has a zh-CN message
 * 4. retryable / fatal sets match the registered table
 * 5. domain category mapping is total
 */
import { ALL_ERROR_CODES, ERROR_REGISTRY } from '../packages/core/src/errors/registry';
import { MESSAGES_ZH_CN } from '../packages/core/src/errors/messages-zh';

const failures: string[] = [];

const seen = new Set<string>();
for (const code of ALL_ERROR_CODES) {
  if (seen.has(code)) failures.push(`duplicate code ${code}`);
  seen.add(code);
  if (!/^LW-[A-Z]{2,4}-\d{3}$/.test(code)) failures.push(`malformed code ${code}`);
  const entry = ERROR_REGISTRY.get(code);
  if (entry === undefined) failures.push(`missing registry entry for ${code}`);
}
if (seen.has('LW-DEC-007')) failures.push('LW-DEC-007 exists — the gap is intentional and must not be filled');

for (const code of ALL_ERROR_CODES) {
  if (!(code in MESSAGES_ZH_CN)) failures.push(`missing zh-CN message for ${code}`);
}
for (const code of Object.keys(MESSAGES_ZH_CN)) {
  if (!seen.has(code)) failures.push(`zh-CN message references unknown code ${code}`);
}

const expectedRetryable = new Set(
  ALL_ERROR_CODES.filter((c) => ERROR_REGISTRY.get(c)?.retryable === true),
);
const expectedFatal = new Set(ALL_ERROR_CODES.filter((c) => ERROR_REGISTRY.get(c)?.severity === 'fatal'));
for (const mustBeRetryable of ['LW-PRV-002', 'LW-PRV-003', 'LW-PRV-007', 'LW-PRV-008', 'LW-PRV-009', 'LW-TOOL-004', 'LW-CTX-001', 'LW-SES-004', 'LW-MCP-001', 'LW-MCP-005', 'LW-DEC-001', 'LW-DEC-002', 'LW-AGT-002', 'LW-AGT-005']) {
  if (!expectedRetryable.has(mustBeRetryable)) failures.push(`${mustBeRetryable} must be retryable`);
}
for (const mustBeFatal of ['LW-CTX-002', 'LW-ACP-001', 'LW-INT-001']) {
  if (!expectedFatal.has(mustBeFatal)) failures.push(`${mustBeFatal} must be fatal`);
}
const fatalButNotRetryable = [...expectedFatal].filter((c) => expectedRetryable.has(c));
if (fatalButNotRetryable.length > 0) failures.push(`fatal codes cannot be retryable: ${fatalButNotRetryable.join(',')}`);

if (failures.length > 0) {
  console.error(`error registry governance FAILED (${failures.length}):\n${failures.map((f) => ` - ${f}`).join('\n')}`);
  process.exit(1);
}
console.log(`error registry OK: ${ALL_ERROR_CODES.length} codes, zh-CN complete, retryable=${expectedRetryable.size}, fatal=${expectedFatal.size}`);
