// Usage: node tests/security/_report.mjs <vitest-json-results>
// Fills Actual/Status/Severity columns of docs/test-cases/security.md from a Vitest JSON report.
import { readFileSync, writeFileSync } from 'node:fs';
const SEV = {
  'SEC-SESS-009': 'High', 'SEC-STATIC-008': 'High', 'SEC-LOGIN-011': 'Medium', 'SEC-PWD-004': 'Medium', 'SEC-PWD-007': 'Medium',
  'SEC-DATA-014': 'Medium', 'SEC-AUDIT-005': 'Medium', 'SEC-HTTP-006': 'Medium', 'SEC-HTTP-007': 'Medium', 'SEC-HTTP-008': 'Medium',
  'SEC-HTTP-009': 'Medium', 'SEC-STATIC-010': 'Medium', 'SEC-HTTP-010': 'Low', 'SEC-LOGIN-012': 'Low', 'SEC-LOGIN-015': 'Low',
  'SEC-PWD-002': 'Low', 'SEC-ESC-016': 'Low', 'SEC-ESC-017': 'Low', 'SEC-DATA-007': 'Low', 'SEC-DATA-008': 'Low',
};
const res = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const by = {};
for (const f of res.testResults) for (const t of f.assertionResults) {
  const m = /^(SEC-[A-Z]+-\d+)/.exec(t.title);
  if (!m) continue;
  const msg = (t.failureMessages[0] ?? '').split('\n')[0].replace(/^(Assertion)?Error: /, '').replace(/\|/g, '/').slice(0, 200);
  const blocked = /^BLOCKED/.test(msg);
  by[m[1]] = { status: t.status === 'passed' ? 'PASS' : blocked ? 'BLOCKED' : 'FAIL', msg };
}
const file = 'docs/test-cases/security.md';
const out = readFileSync(file, 'utf8').split('\n').map((line) => {
  const m = /^\| (SEC-[A-Z]+-\d+) \|/.exec(line);
  if (!m || !by[m[1]]) return line;
  const p = line.split('|');
  const r = by[m[1]];
  p[6] = ' ' + (r.status === 'PASS' ? 'as expected' : r.msg) + ' ';
  p[7] = ' ' + r.status + ' ';
  p[8] = ' ' + (r.status === 'FAIL' ? SEV[m[1]] ?? 'Medium' : '') + ' ';
  return p.join('|');
});
writeFileSync(file, out.join('\n'));
const c = { PASS: 0, FAIL: 0, BLOCKED: 0 };
Object.values(by).forEach((r) => c[r.status]++);
console.log(c);
