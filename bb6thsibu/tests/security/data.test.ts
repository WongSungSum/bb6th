import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('next/headers', async () => (await import('./ctx')).headersMock);
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/server/request', async () => (await import('./ctx')).requestMock);

import { createHash } from 'node:crypto';
import { and, desc, eq, gt, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLogs, guardians, rankHistory, users } from '@/lib/db/schema';
import { decryptIdNumber, encryptIdNumber, hmac } from '@/lib/server/auth/crypto';
import { env } from '@/lib/server/env';
import {
  changeRank, createUser, getUserDetail, listUsers, resetPassword, setStatus, updateUser,
} from '@/lib/server/users/service';
import { createUserAction } from '@/app/actions/users';
import { createUserSchema } from '@/lib/validation/users';
import { login } from '@/lib/server/auth/login';
import { ctx, resetCtx } from './ctx';
import {
  DEV_PW, QA_PW, VICTIM_IC, closeDb, ensureUser, loadCU, meta, mint, orgIds, probe, reasonId, revokeQaSessions, userRow,
  validCreate, validUpdate,
} from './fixtures';

let F: Record<string, Awaited<ReturnType<typeof ensureUser>>> = {};
let captain: Awaited<ReturnType<typeof loadCU>>;
let viewer: Awaited<ReturnType<typeof loadCU>>;
let org: Awaited<ReturnType<typeof orgIds>>;
const SA_PW = process.env.SEED_SUPERADMIN_PASSWORD!;
const rej = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e: any) { return e.code ?? 'ERR:' + e.message; } };

beforeAll(async () => {
  captain = await loadCU('dev.captain');
  viewer = await loadCU('dev.viewer');
  org = await orgIds();
  for (const n of ['mgr', 'victim', 'race', 'user1']) F[n] = await ensureUser(n);
}, 120000);
beforeEach(async () => { resetCtx(); await revokeQaSessions(); });
afterAll(async () => {
  await db.execute(sql`update sessions set revoked_at = now() where revoked_at is null and ip = 'qa-mint'`);
  await closeDb();
});

const ok = (over: Record<string, unknown>) => createUserSchema.safeParse(validCreate({ sectionId: 1, rankId: 1, ...over })).success;

describe('Sensitive data', () => {
  it('SEC-DATA-001 IC encrypted at rest, keyed hash, separate keys', async () => {
    const r = await userRow(F.victim.id);
    const parts = r.idNumberEnc!.split(':');
    expect(parts.length).toBe(4);
    expect(parts[0]).toBe('v1');
    expect(r.idNumberEnc!.includes(VICTIM_IC)).toBe(false);
    expect(r.idNumberHash).toBe(hmac('mykad:' + VICTIM_IC));
    for (const h of [createHash('sha256').update(VICTIM_IC).digest('base64url'), createHash('sha256').update(VICTIM_IC).digest('hex'), createHash('sha256').update('mykad:' + VICTIM_IC).digest('base64url')]) {
      expect(r.idNumberHash).not.toBe(h);
    }
    expect(decryptIdNumber(r.idNumberEnc!, r.id)).toBe(VICTIM_IC);
    expect(env.IC_ENC_KEY).not.toBe(env.IC_HMAC_KEY);
  });
  it('SEC-DATA-002 AAD binding, tamper detection, random IV', async () => {
    const r = await userRow(F.victim.id);
    expect(() => decryptIdNumber(r.idNumberEnc!, captain.id)).toThrow();
    const [v, iv, ct, tag] = r.idNumberEnc!.split(':');
    const flip = (s: string) => (s[0] === 'A' ? 'B' : 'A') + s.slice(1);
    expect(() => decryptIdNumber([v, iv, ct, flip(tag)].join(':'), r.id)).toThrow();
    expect(() => decryptIdNumber([v, iv, flip(ct), tag].join(':'), r.id)).toThrow();
    expect(() => decryptIdNumber(['v2', iv, ct, tag].join(':'), r.id)).toThrow();
    const a = encryptIdNumber(VICTIM_IC, r.id), b = encryptIdNumber(VICTIM_IC, r.id);
    expect(a).not.toBe(b);
    expect(a.split(':')[1]).not.toBe(b.split(':')[1]);
  });
  it('SEC-DATA-003 viewer sees masked data, DTO has no secrets', async () => {
    for (const target of [F.victim.id, captain.id]) {
      const d = await getUserDetail(viewer, target, meta());
      const dump = JSON.stringify(d);
      expect(d.idNumberVisible).toBe(false);
      expect(d.idNumber).toMatch(/^\*{6}-\*\*-\d{4}$/);
      expect(d.audit).toBeNull();
      for (const bad of ['passwordHash', 'idNumberEnc', 'idNumberHash', '$argon2', 'v1:', VICTIM_IC, '800101135001', 'password_hash']) expect(dump.includes(bad), bad).toBe(false);
      for (const g of d.guardians) expect(String(g.phone ?? '')).not.toMatch(/\d{5}/);
    }
  });
  it('SEC-DATA-004 view_sensitive reveals IC and audits every view', async () => {
    const count = async () => (await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'VIEW_SENSITIVE'), eq(auditLogs.entityId, F.victim.id), eq(auditLogs.actorId, F.mgr.id)))).length;
    const before = await count();
    const d1 = await getUserDetail(F.mgr, F.victim.id, meta());
    await getUserDetail(F.mgr, F.victim.id, meta());
    expect(d1.idNumber).toBe(VICTIM_IC);
    expect(d1.idNumberVisible).toBe(true);
    expect(await count()).toBe(before + 2);
    const [row] = await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'VIEW_SENSITIVE'), eq(auditLogs.entityId, F.victim.id))).orderBy(desc(auditLogs.createdAt)).limit(1);
    expect(JSON.stringify(row).includes(VICTIM_IC)).toBe(false);
  });
  it('SEC-DATA-005 duplicates give friendly errors; duplicate email allowed', async () => {
    const base = { sectionId: org.junior, rankId: org.rk('Junior', 'Member') };
    const e1 = await createUser(F.mgr, validCreate({ ...base, username: 'QA.SEC.VICTIM' }), meta()).catch((e) => e);
    expect(e1.code).toBe('VALIDATION');
    expect(e1.fieldErrors.username).toBeTruthy();
    const e2 = await createUser(F.mgr, validCreate({ ...base, idType: 'mykad', idNumber: '991231-13-5599' }), meta()).catch((e) => e);
    expect(e2.code).toBe('VALIDATION');
    expect(e2.fieldErrors.idNumber).toBeTruthy();
    for (const e of [e1, e2]) expect(JSON.stringify([e.message, e.fieldErrors])).not.toMatch(/constraint|violates|users_|duplicate key|relation/i);
    const email = (await userRow(F.victim.id)).email;
    const c = await createUser(F.mgr, validCreate({ ...base, email }), meta());
    expect(c!.id).toBeTruthy();
  });
  it('SEC-DATA-006 IC format boundaries', () => {
    expect(ok({ idType: 'mykad', idNumber: '123456789012' })).toBe(true);
    expect(ok({ idType: 'mykad', idNumber: '123456-78-9012' })).toBe(true);
    for (const n of ['12345678901', '1234567890123', '12345678901a', '', undefined, '１２３４５６７８９０１２', '123456 78 9012 ']) {
      if (n === '123456 78 9012 ') expect(ok({ idType: 'mykad', idNumber: n })).toBe(true);
      else expect(ok({ idType: 'mykad', idNumber: n }), String(n)).toBe(false);
    }
    expect(ok({ idType: 'passport', idNumber: 'A1234567' })).toBe(true);
    for (const n of ['A1', 'A'.repeat(21), 'A-1234567!', '<script>']) expect(ok({ idType: 'passport', idNumber: n }), n).toBe(false);
    expect(ok({ idType: 'none' })).toBe(true);
    expect(ok({ idType: 'bogus' })).toBe(false);
  });
  it('SEC-DATA-007 username rules', () => {
    for (const u of ['abc', 'a.b-c_d', 'ABC', ' abc ']) expect(ok({ username: u }), u).toBe(true);
    for (const u of ['', 'ab', 'a b', 'ünï', 'a'.repeat(31), '123456789012', "a'b", 'a/b', '<script>', 'a\u0000b']) expect(ok({ username: u }), JSON.stringify(u)).toBe(false);
    expect(ok({ username: '123456-78-9012' }), 'dashed 12-digit username is treated as IC by login and shadows/locks IC bucket').toBe(false);
  });
  it('SEC-DATA-008 field limits', () => {
    expect(ok({ fullName: ' ' })).toBe(false);
    expect(ok({ fullName: 'a'.repeat(100) })).toBe(true);
    expect(ok({ fullName: 'a'.repeat(101) })).toBe(false);
    expect(ok({ fullName: '陈小明' })).toBe(true);
    expect(ok({ address: 'a'.repeat(300) })).toBe(true);
    expect(ok({ address: 'a'.repeat(301) })).toBe(false);
    expect(ok({ email: 'a@b' })).toBe(false);
    expect(ok({ email: 'x'.repeat(250) + '@e.com' })).toBe(false);
    expect(ok({ phone: 'abc' })).toBe(false);
    expect(ok({ phone: '+60 12-345 6789' })).toBe(true);
    expect(ok({ dateOfBirth: '2999-01-01' })).toBe(false);
    expect(ok({ joinDate: '2999-01-01' })).toBe(false);
    expect(ok({ dateOfBirth: '2020-13-01' }), 'month 13').toBe(false);
    expect(ok({ dateOfBirth: '2020-02-30' }), 'impossible calendar date 2020-02-30').toBe(false);
    const g = { name: 'G', relationship: 'father', phone: '+60111222333' };
    expect(ok({ guardians: [g, g] })).toBe(true);
    expect(ok({ guardians: [g, g, g] })).toBe(false);
    expect(ok({ guardians: [{ name: 'G', relationship: 'father' }] })).toBe(false);
    expect(ok({ tempPassword: '1234567' })).toBe(false);
    expect(ok({ tempPassword: 'Abcd-123' })).toBe(true);
  });
  it('SEC-DATA-009 Officer section stores no guardians', async () => {
    const g = [{ name: 'G One', relationship: 'father', phone: '+60111222333', email: '' }];
    const o = await createUser(F.mgr, validCreate({ sectionId: org.officer, rankId: org.rk('Officer', 'Helper'), guardians: g }), meta());
    expect((await db.select().from(guardians).where(eq(guardians.userId, o!.id))).length).toBe(0);
    expect((await db.select().from(guardians).where(eq(guardians.userId, F.victim.id))).length).toBeGreaterThanOrEqual(1);
  });
  it('SEC-DATA-011 SQL injection strings stored literally', async () => {
    const name = "Robert'); DROP TABLE users;--";
    await updateUser(F.mgr, F.victim.id, validUpdate({ fullName: name, address: "' OR '1'='1", guardians: [{ name: 'QA Guardian', relationship: 'father', phone: '+60111222333', email: '' }] }), meta());
    const r = await userRow(F.victim.id);
    expect(r.fullName).toBe(name);
    expect((await listUsers({ q: name, status: 'all' })).total).toBeGreaterThanOrEqual(1);
    expect((await listUsers({ q: "' OR 1=1 --", status: 'all' })).total).toBe(0);
  });
  it('SEC-DATA-012 concurrent create with same username', async () => {
    const u = validCreate({ sectionId: org.junior, rankId: org.rk('Junior', 'Member') });
    const res = await Promise.allSettled([createUser(F.mgr, u, meta()), createUser(F.mgr, u, meta())]);
    expect(res.filter((r) => r.status === 'fulfilled').length).toBe(1);
    const bad = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(bad.reason.code).toBe('VALIDATION');
  });
  it('SEC-DATA-013 concurrent status/reset races', async () => {
    const rid = await reasonId();
    const res = await Promise.allSettled([
      setStatus(F.mgr, F.race.id, { status: 'inactive', reasonId: rid }, meta()),
      setStatus(F.mgr, F.race.id, { status: 'inactive', reasonId: rid }, meta()),
    ]);
    try {
      expect(res.filter((r) => r.status === 'fulfilled').length).toBe(1);
      const bad = res.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(bad.reason.code).toBe('CONFLICT');
    } finally {
      await setStatus(F.mgr, F.race.id, { status: 'active' }, meta()).catch(() => {});
    }
    const rr = await Promise.allSettled([
      resetPassword(F.mgr, F.race.id, { reason: 'qa' }, meta()),
      resetPassword(F.mgr, F.race.id, { reason: 'qa' }, meta()),
    ]);
    expect(rr.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
  });
  it('SEC-DATA-014 DB error: generic response, logs free of submitted data', async () => {
    ctx.token = await mint(F.mgr.id);
    const logged: string[] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a: unknown[]) => { logged.push(a.map(String).join(' ')); });
    const r = await createUserAction(validCreate({
      sectionId: org.junior, rankId: org.rk('Junior', 'Member'), dateOfBirth: '2020-02-30', fullName: 'LeakMarkerName',
      tempPassword: 'LeakyTemp-123456-X', email: 'leakmarker@example.test', idType: 'mykad', idNumber: '960505135511',
    }));
    spy.mockRestore();
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/date\/time|out of range|insert into|users/i);
    const dump = logged.join('\n');
    for (const secret of ['LeakMarkerName', 'LeakyTemp', '$argon2', 'leakmarker@example.test', '960505135511', 'v1:']) {
      expect(dump.includes(secret), `server log contains submitted data: ${secret}`).toBe(false);
    }
  });
  it('SEC-DATA-015 changeRank history + audit and bad input', async () => {
    const to = org.rk('Junior', 'Leading Boy');
    await changeRank(F.mgr, F.race.id, { sectionId: org.junior, rankId: to, reason: 'QA promotion' }, meta());
    const [h] = await db.select().from(rankHistory).where(eq(rankHistory.userId, F.race.id)).orderBy(desc(rankHistory.changedAt)).limit(1);
    expect(h).toMatchObject({ toRankId: to, reason: 'QA promotion', changedBy: F.mgr.id });
    const [a] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, F.race.id), eq(auditLogs.action, 'RANK_CHANGED'))).orderBy(desc(auditLogs.createdAt)).limit(1);
    expect(a.changeSetId).toBe(h.changeSetId);
    expect(a.reason).toBe('QA promotion');
    expect(await rej(changeRank(F.mgr, F.race.id, { sectionId: org.junior, rankId: to, reason: 'again' }, meta()))).toBe('VALIDATION');
    expect(await rej(changeRank(F.mgr, F.race.id, { sectionId: org.junior, rankId: org.rk('Junior', 'Member'), reason: '  ' }, meta()))).toBe('VALIDATION');
    expect(await rej(changeRank(F.mgr, F.race.id, { sectionId: org.junior, rankId: org.rk('Junior', 'Member'), reason: 'x'.repeat(501) }, meta()))).toBe('VALIDATION');
    expect(await rej(changeRank(F.mgr, F.race.id, { sectionId: org.junior, rankId: org.rk('Senior', 'Private'), reason: 'cross' }, meta()))).toBe('VALIDATION');
    await changeRank(F.mgr, F.race.id, { sectionId: org.junior, rankId: org.rk('Junior', 'Member'), reason: 'QA revert' }, meta());
  });
  it('SEC-DATA-016 optimistic lock', async () => {
    expect(await rej(updateUser(F.mgr, F.victim.id, validUpdate({ expectedUpdatedAt: '2000-01-01T00:00:00.000Z', guardians: [{ name: 'QA Guardian', relationship: 'father', phone: '+60111222333', email: '' }] }), meta()))).toBe('CONFLICT');
  });
  it('SEC-DATA-017 avatarUrl not settable', async () => {
    await updateUser(F.mgr, F.victim.id, validUpdate({ avatarUrl: 'javascript:alert(1)', guardians: [{ name: 'QA Guardian', relationship: 'father', phone: '+60111222333', email: '' }] }), meta());
    expect((await userRow(F.victim.id)).avatarUrl).toBeNull();
  });
});

describe('Audit', () => {
  it('SEC-AUDIT-001 events audited with actor, ip, UA', async () => {
    const since = new Date(Date.now() - 1000);
    const IC = '77' + String(Math.floor(Math.random() * 1e10)).padStart(10, '0');
    await updateUser(F.mgr, F.race.id, validUpdate({ username: 'qa.sec.race', fullName: 'QA Sec race', idType: 'mykad', idNumber: IC }), meta('aud'));
    await getUserDetail(F.mgr, F.race.id, meta('aud'));
    await resetPassword(F.mgr, F.race.id, { reason: 'AuditSecret reason', password: 'AuditSecret-Temp-9X2k' }, meta('aud'));
    await setStatus(F.mgr, F.race.id, { status: 'inactive', reasonId: await reasonId() }, meta('aud'));
    await setStatus(F.mgr, F.race.id, { status: 'active', reason: 'qa' }, meta('aud'));
    const rows = (await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, F.race.id), gt(auditLogs.createdAt, since)))).filter((r) => r.ip?.startsWith('aud-'));
    const acts = rows.map((r) => r.action).sort();
    expect(acts).toEqual(['PASSWORD_RESET', 'USER_DEACTIVATED', 'USER_REACTIVATED', 'USER_UPDATED', 'VIEW_SENSITIVE']);
    for (const r of rows) {
      expect(r.actorId).toBe(F.mgr.id);
      expect(r.ip).toMatch(/^aud-/);
      expect(r.userAgent).toBe('vitest');
      expect(r.changeSetId).toMatch(/^[0-9a-f-]{36}$/);
    }
    const upd = rows.find((r) => r.action === 'USER_UPDATED')!;
    expect((upd.after as any).idNumber).toBe('******-**-' + IC.slice(-4));
    expect(JSON.stringify(upd).includes(IC)).toBe(false);
    const l = await login('qa.sec.user1', QA_PW, meta());
    expect(l.ok).toBe(true);
    const ev = await db.select({ a: auditLogs.action }).from(auditLogs).where(gt(auditLogs.createdAt, since));
    expect(ev.some((e) => e.a === 'LOGIN')).toBe(true);
  });
  it('SEC-AUDIT-002 no secrets in audit rows', async () => {
    const rows = await db.select().from(auditLogs).where(gt(auditLogs.createdAt, new Date(Date.now() - 24 * 3600 * 1000)));
    const dump = JSON.stringify(rows);
    for (const s of [QA_PW, DEV_PW, SA_PW, '$argon2', VICTIM_IC, 'AuditSecret-Temp-9X2k', 'Strong-Temp-Pass-2026', 'password_hash', 'passwordHash', 'idNumberEnc', 'id_number_enc']) {
      expect(dump.includes(s), `audit contains ${s}`).toBe(false);
    }
    expect(rows.length).toBeGreaterThan(10);
  });
  it('SEC-AUDIT-003 audit_logs append-only', async () => {
    const [row] = await db.select({ id: auditLogs.id }).from(auditLogs).limit(1);
    const u = await probe((tx) => tx.execute(sql`update audit_logs set reason = 'tamper' where id = ${row.id}`));
    expect(u.failed && /append-only/.test(u.text), u.text).toBe(true);
    const d = await probe((tx) => tx.execute(sql`delete from audit_logs where id = ${row.id}`));
    expect(d.failed && /append-only/.test(d.text), d.text).toBe(true);
    const t = await probe((tx) => tx.execute(sql`truncate table audit_logs`));
    expect(t.failed && /append-only/.test(t.text), t.text).toBe(true);
  });
  it('SEC-AUDIT-004 rank_history append-only', async () => {
    const [row] = await db.select({ id: rankHistory.id }).from(rankHistory).limit(1);
    const u = await probe((tx) => tx.execute(sql`update rank_history set reason = 'tamper' where id = ${row.id}`));
    expect(u.failed, 'update allowed').toBe(true);
    const d = await probe((tx) => tx.execute(sql`delete from rank_history where id = ${row.id}`));
    expect(d.failed, 'delete allowed').toBe(true);
  });
  it('SEC-AUDIT-005 runtime DB role cannot disable triggers (SEC-REQ-50)', async () => {
    const r = await probe((tx) => tx.execute(sql`alter table audit_logs disable trigger audit_logs_append_only`));
    expect(r.failed, 'app DB role can ALTER TABLE ... DISABLE TRIGGER on audit_logs (it owns the table / is superuser)').toBe(true);
  });
});
