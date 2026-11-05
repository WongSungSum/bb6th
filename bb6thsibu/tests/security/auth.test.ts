import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('next/headers', async () => (await import('./ctx')).headersMock);
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/server/request', async () => (await import('./ctx')).requestMock);

import { hash as argonHash } from '@node-rs/argon2';
import { and, desc, eq, gt, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLogs, loginAttempts, sessions, users } from '@/lib/db/schema';
import { changeOwnPassword, login } from '@/lib/server/auth/login';
import { getCurrentUser } from '@/lib/server/auth/session';
import { hmac, sha256 } from '@/lib/server/auth/crypto';
import { checkPasswordPolicy, generateTempPassword, hashPassword } from '@/lib/server/auth/password';
import { setStatus, resetPassword } from '@/lib/server/users/service';
import { changePasswordAction, loginAction, logoutAction } from '@/app/actions/auth';
import { createUserAction, resetPasswordAction } from '@/app/actions/users';
import { ctx, resetCtx } from './ctx';
import {
  DEV_PW, QA_PW, VICTIM_IC, closeDb, ensureUser, freshUser, loadCU, meta, mint, orgIds, reasonId, redirectOf,
  revokeQaSessions, sessionRow, setSession, userRow, validCreate,
} from './fixtures';

let F: Record<string, Awaited<ReturnType<typeof ensureUser>>> = {};
let NP2: { id: string; username: string }, BAD: { id: string; username: string }, NP: { id: string; username: string };
let captain: Awaited<ReturnType<typeof loadCU>>;
const GENERIC = 'Incorrect login details or account unavailable. Please try again or contact your Captain.';
const fails = (h: string) => db.select().from(loginAttempts).where(and(eq(loginAttempts.identifierHash, h), eq(loginAttempts.success, false)));

beforeAll(async () => {
  captain = await loadCU('dev.captain');
  BAD = await freshUser('bad');
  NP = await freshUser('np'); NP2 = await freshUser('np2'); await db.update(users).set({ passwordHash: null }).where(eq(users.id, NP2.id));
  await db.update(users).set({ passwordHash: null }).where(eq(users.id, NP.id));
  for (const n of ['user1', 'victim', 'nopw', 'temp', 'rehash', 'deact', 'cap', 'chg', 'rst', 'mgr']) F[n] = await ensureUser(n);
}, 120000);
beforeEach(async () => { resetCtx(); await revokeQaSessions(); });
afterAll(closeDb);

describe('Login', () => {
  it('SEC-LOGIN-001 login by username, token stored hashed', async () => {
    const r = await login('qa.sec.user1', QA_PW, meta());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const rows = await db.select().from(sessions).where(eq(sessions.tokenHash, r.token));
    expect(rows.length).toBe(0);
    const row = await sessionRow(r.token);
    expect(row.platform).toBe('web');
    expect(row.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(12 * 3600 * 1000 + 60000);
  });
  it('SEC-LOGIN-002 username case-insensitive', async () => {
    expect((await login('QA.SEC.USER1', QA_PW, meta())).ok).toBe(true);
  });
  it('SEC-LOGIN-003 IC login with dashes and spaces', async () => {
    for (const id of [VICTIM_IC, '991231-13-5599', ' 9912 3113 5599 ']) expect((await login(id, QA_PW, meta())).ok, id).toBe(true);
  });
  it('SEC-LOGIN-004 wrong password vs unknown user identical', async () => {
    const a = await login(BAD.username, 'wrong-password-1', meta());
    const b = await login('qa.sec.nobody' + Date.now(), 'wrong-password-1', meta());
    const c = await login('123456789012', 'wrong-password-1', meta());
    expect(a).toEqual({ ok: false });
    expect(b).toEqual({ ok: false });
    expect(c).toEqual({ ok: false });
  });
  it('SEC-LOGIN-005 null-password account cannot log in', async () => {
    for (const pw of ['', 'x', 'dummy-password-for-timing', QA_PW]) expect(await login(NP.username, pw, meta())).toEqual({ ok: false });
  });
  it('SEC-LOGIN-006 inactive account cannot log in', async () => {
    const u = await freshUser('ina');
    const rid = await reasonId();
    await setStatus(captain, u.id, { status: 'inactive', reasonId: rid }, meta());
    expect(await login(u.username, QA_PW, meta())).toEqual({ ok: false });
    await setStatus(captain, u.id, { status: 'active' }, meta());
    expect((await login(u.username, QA_PW, meta())).ok).toBe(true);
  });
  it('SEC-LOGIN-007 temp-password account reports mustChangePassword', async () => {
    const r = await login('qa.sec.temp', QA_PW, meta());
    expect(r.ok && r.mustChangePassword).toBe(true);
  });
  it('SEC-LOGIN-008 lockout after 5 failures, correct pw rejected, audited', async () => {
    const u = await freshUser('lk8');
    for (let i = 0; i < 5; i++) expect(await login(u.username, 'wrong-pass-' + i, meta())).toEqual({ ok: false });
    expect(await login(u.username, QA_PW, meta())).toEqual({ ok: false });
    const a = await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'LOGIN_LOCKED'), eq(auditLogs.entityId, u.id)));
    expect(a.length).toBeGreaterThanOrEqual(1);
  });
  it('SEC-LOGIN-009 unknown identifier behaves identically after 5 failures', async () => {
    const name = 'qa.sec.ghost' + Date.now();
    for (let i = 0; i < 7; i++) expect(await login(name, 'wrong-pass-' + i, meta())).toEqual({ ok: false });
  });
  it('SEC-LOGIN-010 login_attempts stores only HMAC', async () => {
    const u = await freshUser('lk10');
    const ic = '980' + String(Date.now()).slice(-9);
    await login(u.username, 'Secret-Wrong-Pass-77', meta());
    await login(ic, 'Secret-Wrong-Pass-77', meta());
    const rows = await db.select().from(loginAttempts).where(inArray(loginAttempts.identifierHash, [hmac('u:' + u.username), hmac('ic:' + ic)]));
    expect(rows.length).toBe(2);
    const dump = JSON.stringify(await db.select().from(loginAttempts).where(gt(loginAttempts.createdAt, new Date(Date.now() - 60000))));
    for (const s of [u.username, ic, 'Secret-Wrong-Pass-77']) expect(dump.includes(s)).toBe(false);
  });
  it('SEC-LOGIN-011 attempts while locked must not extend the lock', async () => {
    const u = await freshUser('lk11');
    for (let i = 0; i < 5; i++) await login(u.username, 'wrong-pass-' + i, meta());
    for (let i = 0; i < 3; i++) await login(u.username, 'wrong-pass-x' + i, meta());
    expect((await fails(hmac('u:' + u.username))).length).toBe(5);
  });
  it('SEC-LOGIN-012 successful login resets failure counter', async () => {
    const u = await freshUser('lk12');
    for (let i = 0; i < 4; i++) await login(u.username, 'wrong-pass-' + i, meta());
    expect((await login(u.username, QA_PW, meta())).ok).toBe(true);
    await login(u.username, 'wrong-pass-after', meta());
    expect((await login(u.username, QA_PW, meta())).ok).toBe(true);
  });
  it('SEC-LOGIN-013 per-IP throttle', async () => {
    const ipA = 'qa-ipA-' + Date.now();
    for (let i = 0; i < 20; i++) await login('qa.sec.nx' + i + Date.now(), 'wrong-pass-' + i, { ip: ipA, userAgent: 'v' });
    expect(await login('qa.sec.user1', QA_PW, { ip: ipA, userAgent: 'v' })).toEqual({ ok: false });
    expect((await login('qa.sec.user1', QA_PW, meta('ipB'))).ok).toBe(true);
  }, 60000);
  it('SEC-LOGIN-014 concurrency', async () => {
    const u = await freshUser('lk14');
    const res = await Promise.all(Array.from({ length: 10 }, (_, i) => login(u.username, 'wrong-pass-' + i, meta())));
    expect(res.every((r) => !r.ok)).toBe(true);
    // 被限流后的尝试不再记录（避免让受害者被永久锁定），所以只有 5 笔
    expect((await fails(hmac('u:' + u.username))).length).toBe(5);
    expect(await login(u.username, QA_PW, meta())).toEqual({ ok: false });
    const v = await freshUser('cc14');
    // 设计取舍：验证中的登录先记为失败（防并发绕过限流），所以同一账号同时超过 5 个登录请求会被拒；4 个以内都应成功
    const ok = await Promise.all(Array.from({ length: 4 }, () => login(v.username, QA_PW, meta())));
    expect(ok.every((r) => r.ok)).toBe(true);
    expect(new Set(ok.map((r) => (r.ok ? r.token : ''))).size).toBe(4);
  }, 60000);
  it('SEC-LOGIN-015 hostile identifiers never throw', async () => {
    const ids = ['', ' ', "' OR '1'='1", "admin'--", 'x'.repeat(1000), '😀😀😀', 'a\u0000b', '%', '_', '1'.repeat(12) + '\n', '../../etc/passwd', '"; DROP TABLE users; --'];
    const out: string[] = [];
    for (const id of ids) {
      try {
        const r = await login(id, 'wrong-password-zz', meta());
        if (r.ok) out.push('OK:' + JSON.stringify(id));
      } catch (e: any) {
        out.push('THROW:' + JSON.stringify(id).slice(0, 20) + ' ' + String(e.cause?.message ?? e.message).slice(0, 80));
      }
    }
    expect(out.join(' ; ')).toBe('');
  }, 60000);
  it('SEC-LOGIN-016 timing equalisation', async () => {
    const u = await freshUser('tim');
    const time = async (id: string) => { const t = performance.now(); await login(id, 'wrong-password-t', meta()); return performance.now() - t; };
    const med = (a: number[]) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const known: number[] = [], unknown: number[] = [], nopw: number[] = [];
    for (let i = 0; i < 3; i++) {
      known.push(await time(u.username));
      unknown.push(await time('qa.sec.unk' + i + Date.now()));
      nopw.push(await time(NP2.username));
    }
    const k = med(known), un = med(unknown), np = med(nopw);
    expect(un / k, `unknown ${un.toFixed(0)}ms known ${k.toFixed(0)}ms`).toBeGreaterThan(0.5);
    expect(un / k).toBeLessThan(2);
    expect(np / k, `nopw ${np.toFixed(0)}ms`).toBeGreaterThan(0.5);
    expect(np / k).toBeLessThan(2);
  }, 60000);
  it('SEC-LOGIN-017 weak hash upgraded on login', async () => {
    const weak = await argonHash(QA_PW, { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    await db.update(users).set({ passwordHash: weak }).where(eq(users.id, F.rehash.id));
    expect((await login('qa.sec.rehash', QA_PW, meta())).ok).toBe(true);
    const r = await userRow(F.rehash.id);
    expect(r.passwordHash!.startsWith('$argon2id$v=19$m=65536,t=3,p=1$')).toBe(true);
  });
  it('SEC-LOGIN-018 hashes are argon2id with config params and random salt', async () => {
    const a = await hashPassword('same-password-123'), b = await hashPassword('same-password-123');
    expect(a).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
    expect(a).not.toBe(b);
  });
  it('SEC-LOGIN-019 loginAction input limits give generic error', async () => {
    const fd = (i: string, p: string) => { const f = new FormData(); f.set('identifier', i); f.set('password', p); return f; };
    expect((await loginAction(undefined, fd('qa.sec.user1', 'x'.repeat(129))))?.error).toBe(GENERIC);
    expect((await loginAction(undefined, fd('', 'abc')))?.error).toBe(GENERIC);
    expect((await loginAction(undefined, fd('qa.sec.user1', '')))?.error).toBe(GENERIC);
  });
  it('SEC-LOGIN-020 loginAction one error text for every failure', async () => {
    const fd = (i: string, p: string) => { const f = new FormData(); f.set('identifier', i); f.set('password', p); return f; };
    const texts = new Set<string>();
    for (const [i, p] of [[BAD.username, 'wrong-pw-zzzz1'], ['qa.sec.nobody' + Date.now(), 'wrong-pw-zzzz1'], [NP.username, QA_PW], ['123456789012', 'wrong-pw-zzzz1']]) {
      resetCtx();
      texts.add(String((await loginAction(undefined, fd(i, p)))?.error));
    }
    expect([...texts]).toEqual([GENERIC]);
  });
  it('SEC-LOGIN-021 loginAction cookie flags and redirect', async () => {
    const fd = (i: string) => { const f = new FormData(); f.set('identifier', i); f.set('password', QA_PW); return f; };
    expect(await redirectOf(loginAction(undefined, fd('qa.sec.user1')))).toBe('/dashboard');
    const c = ctx.cookiesSet.find((x) => x.name === 'bb6_session')!;
    expect(c.opts).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/' });
    expect((c.opts!.expires as Date).getTime() - Date.now()).toBeLessThanOrEqual(12 * 3600 * 1000 + 60000);
    expect(c.opts!.domain).toBeUndefined();
    resetCtx();
    expect(await redirectOf(loginAction(undefined, fd('qa.sec.temp')))).toBe('/change-password');
  });
  it('SEC-LOGIN-022 planted cookie not adopted', async () => {
    ctx.token = 'ATTACKERPLANTEDTOKEN';
    const f = new FormData(); f.set('identifier', 'qa.sec.user1'); f.set('password', QA_PW);
    await redirectOf(loginAction(undefined, f));
    const c = ctx.cookiesSet.find((x) => x.name === 'bb6_session')!;
    expect(c.value).not.toBe('ATTACKERPLANTEDTOKEN');
    expect(await sessionRow('ATTACKERPLANTEDTOKEN')).toBeUndefined();
  });
});

describe('Sessions', () => {
  it('SEC-SESS-001 tokens unique', async () => {
    const toks = new Set<string>();
    for (let i = 0; i < 10; i++) { const r = await login('qa.sec.user1', QA_PW, meta()); if (r.ok) toks.add(r.token); }
    expect(toks.size).toBe(10);
    for (const t of toks) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
  }, 60000);
  it('SEC-SESS-002 valid token resolves, garbage resolves null', async () => {
    const t = await mint(F.user1.id);
    ctx.token = t;
    expect((await getCurrentUser())?.username).toBe('qa.sec.user1');
    for (const bad of ['', 'garbage', 'x'.repeat(101), 'x'.repeat(5000), "' OR 1=1 --", sha256(t), '\u0000']) {
      ctx.token = bad;
      expect(await getCurrentUser(), JSON.stringify(bad).slice(0, 20)).toBeNull();
    }
  });
  it('SEC-SESS-003 revoked rejected', async () => {
    const t = await mint(F.user1.id); ctx.token = t;
    await setSession(t, { revokedAt: new Date() });
    expect(await getCurrentUser()).toBeNull();
  });
  it('SEC-SESS-004 absolute expiry', async () => {
    const t = await mint(F.user1.id); ctx.token = t;
    await setSession(t, { expiresAt: new Date(Date.now() - 1000) });
    expect(await getCurrentUser()).toBeNull();
  });
  it('SEC-SESS-005 idle timeout and touch throttle', async () => {
    const t = await mint(F.user1.id); ctx.token = t;
    await setSession(t, { lastSeenAt: new Date(Date.now() - 31 * 60000) });
    expect(await getCurrentUser()).toBeNull();
    await setSession(t, { lastSeenAt: new Date(Date.now() - 29 * 60000) });
    expect(await getCurrentUser()).not.toBeNull();
    expect(Date.now() - (await sessionRow(t)).lastSeenAt.getTime()).toBeLessThan(5000);
    const old = new Date(Date.now() - 10000);
    await setSession(t, { lastSeenAt: old });
    expect(await getCurrentUser()).not.toBeNull();
    expect((await sessionRow(t)).lastSeenAt.getTime()).toBe(old.getTime());
  });
  it('SEC-SESS-006 deactivation kills sessions', async () => {
    const t1 = await mint(F.deact.id), t2 = await mint(F.deact.id);
    await setStatus(captain, F.deact.id, { status: 'inactive', reasonId: await reasonId() }, meta());
    try {
      for (const t of [t1, t2]) { ctx.token = t; expect(await getCurrentUser()).toBeNull(); expect((await sessionRow(t)).revokedAt).not.toBeNull(); }
    } finally {
      await setStatus(captain, F.deact.id, { status: 'active' }, meta());
    }
  });
  it('SEC-SESS-007 null-password user session rejected', async () => {
    ctx.token = await mint(F.nopw.id);
    expect(await getCurrentUser()).toBeNull();
  });
  it('SEC-SESS-008 logout revokes and clears cookie', async () => {
    const t = await mint(F.user1.id); ctx.token = t;
    expect(await redirectOf(logoutAction())).toBe('/login');
    expect((await sessionRow(t)).revokedAt).not.toBeNull();
    expect(ctx.cookiesSet.some((c) => c.name === 'bb6_session' && c.deleted)).toBe(true);
    expect(await getCurrentUser()).toBeNull();
    resetCtx();
    expect(await redirectOf(logoutAction())).toBe('/login');
  });
  it('SEC-SESS-009 max 10 live sessions', async () => {
    const toks: string[] = [];
    for (let i = 0; i < 12; i++) toks.push(await mint(F.cap.id));
    const live = await db.select().from(sessions).where(and(eq(sessions.userId, F.cap.id), sql`${sessions.revokedAt} is null`));
    expect(live.length).toBeLessThanOrEqual(10);
    expect((await sessionRow(toks[0])).revokedAt).not.toBeNull();
    expect((await sessionRow(toks[11])).revokedAt).toBeNull();
  });
  it('SEC-SESS-010 own password change revokes others, issues new', async () => {
    const C = await freshUser('chg');
    const ts = [await mint(C.id), await mint(C.id), await mint(C.id)];
    ctx.token = ts[0];
    const NEW = 'Brand-New-Pass-2026-q';
    const r = await changePasswordAction({ current: QA_PW, next: NEW, confirm: NEW });
    expect(r.ok).toBe(true);
    for (const t of ts) { ctx.token = t; expect(await getCurrentUser()).toBeNull(); }
    const nc = ctx.cookiesSet.find((c) => c.name === 'bb6_session')!;
    ctx.token = nc.value; expect((await getCurrentUser())?.username).toBe(C.username);
    expect(await login(C.username, QA_PW, meta())).toEqual({ ok: false });
    expect((await login(C.username, NEW, meta())).ok).toBe(true);
    
  });
  it('SEC-SESS-011 must_change_password blocks every action', async () => {
    ctx.token = await mint(F.temp.id);
    const org = await orgIds();
    const calls = [
      createUserAction(validCreate({ sectionId: org.junior, rankId: org.rk('Junior', 'Member') })),
      resetPasswordAction(F.user1.id, { reason: 'x' }),
    ];
    for (const c of calls) expect(await redirectOf(c)).toBe('/change-password');
    const r = await changePasswordAction({ current: 'wrong-current-pw', next: 'Another-Pass-2026-z', confirm: 'Another-Pass-2026-z' });
    expect(r.ok).toBe(false);
    expect((r as any).code).toBe('VALIDATION');
  });
  it('SEC-SESS-012 admin reset revokes all target sessions', async () => {
    const R = await freshUser('rst');
    const ts = [await mint(R.id), await mint(R.id)];
    const res = await resetPassword(F.mgr, R.id, { reason: 'QA reset' }, meta());
    for (const t of ts) { ctx.token = t; expect(await getCurrentUser()).toBeNull(); }
    expect(await login(R.username, QA_PW, meta())).toEqual({ ok: false });
    const r = await login(R.username, res.tempPassword, meta());
    expect(r.ok && r.mustChangePassword).toBe(true);
  });
  it('SEC-SESS-013 platform always web', async () => {
    const rows = await db.select().from(sessions).where(eq(sessions.userId, F.user1.id));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.platform === 'web')).toBe(true);
  });
  it('SEC-SESS-014 flags derived from DB', async () => {
    ctx.token = await mint(F.mgr.id);
    expect(await getCurrentUser()).toMatchObject({ isCaptain: false, isSuperadmin: false });
    ctx.token = await mint(captain.id);
    expect(await getCurrentUser()).toMatchObject({ isCaptain: true, isSuperadmin: false });
  });
});

describe('Passwords', () => {
  it('SEC-PWD-001 policy', () => {
    expect(checkPasswordPolicy('short')).not.toBeNull();
    expect(checkPasswordPolicy('Ab-1234')).not.toBeNull(); // 7 字
    expect(checkPasswordPolicy('Ab-12345')).toBeNull(); // 8 字
    expect(checkPasswordPolicy('12345678')).not.toBeNull(); // 常见密码
    expect(checkPasswordPolicy('x'.repeat(129))).not.toBeNull();
    expect(checkPasswordPolicy('Ab1-'.repeat(32))).toBeNull(); // 128 字
    expect(checkPasswordPolicy('x'.repeat(128))).not.toBeNull(); // 同一个字重复
    expect(checkPasswordPolicy('Password123')).not.toBeNull();
    expect(checkPasswordPolicy('qa.sec.user1', ['qa.sec.user1'])).not.toBeNull();
    expect(checkPasswordPolicy('Correct-Horse-9', [])).toBeNull();
  });
  it('SEC-PWD-002 policy rejects own IC as password (with or without dashes)', async () => {
    // 原本的测试用的是别人的 IC，又靠前一个测试留下的登入失败次数才「通过」（R-43）。
    // 改成直接检查规则；完整流程（用户自己的 IC）由 tests/security/system.test.ts SYS-PWD-002 测试。
    const ic = VICTIM_IC.replace(/-/g, '');
    const dashed = `${ic.slice(0, 6)}-${ic.slice(6, 8)}-${ic.slice(8)}`;
    expect(checkPasswordPolicy(ic, ['someone', ic])).not.toBeNull();
    expect(checkPasswordPolicy(dashed, ['someone', ic])).not.toBeNull();
    expect(checkPasswordPolicy(ic, ['someone', dashed])).not.toBeNull();
  });
  it('SEC-PWD-003 changeOwnPassword validation', async () => {
    const tryIt = async (c: string, n: string) => { try { await changeOwnPassword(F.chg, c, n, meta()); return 'OK'; } catch (e: any) { return e.code; } };
    expect(await tryIt('wrong-current-1', 'Valid-New-Pass-77')).toBe('VALIDATION');
    expect(await tryIt(QA_PW, QA_PW)).toBe('VALIDATION');
    expect(await tryIt(QA_PW, 'short')).toBe('VALIDATION');
    expect(await tryIt(QA_PW, 'password1234')).toBe('VALIDATION');
    expect(await tryIt(QA_PW, 'qa.sec.chg')).toBe('VALIDATION');
  });
  it('SEC-PWD-004 current-password guesses are throttled', async () => {
    let throttled = false;
    for (let i = 0; i < 12; i++) {
      try { await changeOwnPassword(F.chg, 'guess-' + i + '-xxxx', 'Valid-New-Pass-77', meta()); } catch (e: any) { if (e.message !== 'Please fix the highlighted fields.') throttled = true; }
    }
    // correct current password after 12 wrong guesses
    let finalOk = true;
    try { await changeOwnPassword(F.chg, QA_PW, 'Valid-New-Pass-77', meta()); } catch { finalOk = false; }
    await db.update(users).set({ passwordHash: await hashPassword(QA_PW) }).where(eq(users.id, F.chg.id));
    expect(throttled || !finalOk, '12 wrong current-password guesses were not throttled').toBe(true);
  }, 60000);
  it('SEC-PWD-005 temp password generator', () => {
    const s = new Set<string>();
    for (let i = 0; i < 200; i++) { const p = generateTempPassword(); expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9]{14}$/); s.add(p); }
    expect(s.size).toBe(200);
  });
  it('SEC-PWD-006 admin-supplied temp password policy', async () => {
    await expect(resetPassword(F.mgr, F.rst.id, { password: 'short', reason: 'qa' }, meta())).rejects.toMatchObject({ code: 'VALIDATION' });
    await expect(resetPassword(F.mgr, F.rst.id, { password: 'qa.sec.rst', reason: 'qa' }, meta())).rejects.toMatchObject({ code: 'VALIDATION' });
    const r = await resetPassword(F.mgr, F.rst.id, { password: 'Strong-Temp-Pass-2026', reason: 'qa' }, meta());
    expect(r.tempPassword).toBe('Strong-Temp-Pass-2026');
    expect((await userRow(F.rst.id)).mustChangePassword).toBe(true);
    await db.update(users).set({ passwordHash: await hashPassword(QA_PW), mustChangePassword: false }).where(eq(users.id, F.rst.id));
  });
  it('SEC-PWD-007 reset clears lockout', async () => {
    const u = await freshUser('lk7');
    for (let i = 0; i < 5; i++) await login(u.username, 'wrong-pass-' + i, meta());
    expect(await login(u.username, QA_PW, meta())).toEqual({ ok: false });
    await resetPassword(F.mgr, u.id, { password: 'Fresh-Temp-Pass-2026', reason: 'qa unlock' }, meta());
    const r = await login(u.username, 'Fresh-Temp-Pass-2026', meta());
    expect(r.ok, 'user still locked out after admin reset (login_attempts window not cleared)').toBe(true);
  });
});

void DEV_PW; void desc;
