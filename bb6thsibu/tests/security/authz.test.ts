import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('next/headers', async () => (await import('./ctx')).headersMock);
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/server/request', async () => (await import('./ctx')).requestMock);

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, count, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { guardians, users } from '@/lib/db/schema';
import { can, getPermissionsFor, resolvePermissions } from '@/lib/server/authz';
import { ALL_PERMISSIONS } from '@/lib/server/authz/catalog';
import { appointFirstCaptain } from '@/lib/server/captain';
import {
  changeRank, createUser, getUserDetail, listUsers, resetPassword, setStatus,
} from '@/lib/server/users/service';
import {
  appointCaptainAction, promoteAction, createUserAction, resetPasswordAction, setStatusAction, updateUserAction,
} from '@/app/actions/users';
// 第二阶段：单人改军阶改成批量升阶页面；这里用单人批次代替旧的 changeRankAction
const changeRankAction = (id: string, p: { sectionId: number; rankId: number; reason: string }) => promoteAction({ userIds: [id], ...p });
import { ctx, resetCtx } from './ctx';
import {
  closeDb, ensureUser, errText, loadCU, meta, mint, orgIds, probe, reasonId, redirectOf, revokeQaSessions,
  userRow, validCreate, validUpdate,
} from './fixtures';

let F: Record<string, Awaited<ReturnType<typeof ensureUser>>> = {};
let captain: Awaited<ReturnType<typeof loadCU>>;
let sa: Awaited<ReturnType<typeof loadCU>>;
let org: Awaited<ReturnType<typeof orgIds>>;
const devTok: Record<string, string> = {};
const dev = async (name: string) => (devTok[name] ??= await mint((await loadCU(name)).id));
const as = (t: string) => { ctx.token = t; };
const SA_PW = process.env.SEED_SUPERADMIN_PASSWORD!;
const walk = (dir: string, out: string[] = []) => {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (f === 'node_modules' || f === '.next') continue;
    statSync(p).isDirectory() ? walk(p, out) : /\.(ts|tsx)$/.test(f) && out.push(p);
  }
  return out;
};
const ROOT = path.resolve(__dirname, '../..');

beforeAll(async () => {
  captain = await loadCU('dev.captain');
  sa = await loadCU('superadmin');
  org = await orgIds();
  for (const n of ['mgr', 'peer', 'victim', 'user1', 'role1', 'role2', 'deny', 'allowonly']) F[n] = await ensureUser(n);
}, 120000);
beforeEach(async () => { resetCtx(); await revokeQaSessions(); });
afterAll(async () => {
  await db.execute(sql`update sessions set revoked_at = now() where revoked_at is null and ip = 'qa-mint'`);
  await closeDb();
});

const rankPayload = () => ({ sectionId: org.junior, rankId: org.rk('Junior', 'Assisting Leading Boy'), reason: 'qa' });

describe('Authorization', () => {
  it('SEC-AUTHZ-001 resolvePermissions semantics', () => {
    const s = resolvePermissions(['users.view', 'users.update'], [{ slug: 'users.view', effect: 'deny' }, { slug: 'audit.view', effect: 'allow' }, { slug: 'bogus.perm', effect: 'allow' }]);
    expect([...s].sort()).toEqual(['audit.view', 'users.update']);
    expect(resolvePermissions(['bogus'], []).size).toBe(0);
    expect(resolvePermissions([], []).size).toBe(0);
  });
  it('SEC-AUTHZ-002 can() throws on unknown slug', async () => {
    await expect(can(F.user1, 'users.nope' as any)).rejects.toThrow();
  });
  it('SEC-AUTHZ-003 anonymous redirected on every action', async () => {
    const before = await userRow(F.victim.id);
    const rid = await reasonId();
    const calls = [
      createUserAction(validCreate({ sectionId: org.junior, rankId: org.rk('Junior', 'Member') })),
      updateUserAction(F.victim.id, validUpdate()),
      changeRankAction(F.victim.id, rankPayload()),
      setStatusAction(F.victim.id, { status: 'inactive', reasonId: rid }),
      resetPasswordAction(F.victim.id, { reason: 'x', password: 'Anon-Attack-Pass-2026' }),
      appointCaptainAction(F.mgr.id),
    ];
    const reds = await Promise.all(calls.map((c) => redirectOf(c)));
    expect(reds).toEqual(Array(6).fill('/login'));
    expect((await userRow(F.victim.id)).updatedAt).toEqual(before.updatedAt);
  });
  it('SEC-AUTHZ-004 no-permission user FORBIDDEN on every action', async () => {
    as(await dev('dev.boy'));
    const before = await userRow(F.victim.id);
    const res = await Promise.all([
      createUserAction(validCreate({ sectionId: org.junior, rankId: org.rk('Junior', 'Member') })),
      updateUserAction(F.victim.id, validUpdate()),
      changeRankAction(F.victim.id, rankPayload()),
      setStatusAction(F.victim.id, { status: 'inactive', reasonId: await reasonId() }),
      resetPasswordAction(F.victim.id, { reason: 'x', password: 'Boy-Attack-Pass-2026' }),
      appointCaptainAction(F.mgr.id),
    ]);
    expect(res.map((r) => (r.ok ? 'OK' : r.code))).toEqual(Array(6).fill('FORBIDDEN'));
    expect((await userRow(F.victim.id)).updatedAt).toEqual(before.updatedAt);
  });
  it('SEC-AUTHZ-005 role grant', async () => {
    expect([...(await getPermissionsFor(F.role1))]).toEqual(['users.view']);
  });
  it('SEC-AUTHZ-006 multiple roles union', async () => {
    expect([...(await getPermissionsFor(F.role2))].sort()).toEqual(['users.create', 'users.update', 'users.view']);
  });
  it('SEC-AUTHZ-007 user ALLOW without role; officer-only permission given to a Junior does not take effect', async () => {
    // allowonly 是 Junior，被 ALLOW 了 users.reset_password（只限军官），所以不生效
    expect([...(await getPermissionsFor(F.allowonly))]).toEqual([]);
    expect([...(await getPermissionsFor(F.role2))].sort()).toEqual(['users.create', 'users.update', 'users.view']);
  });
  it('SEC-AUTHZ-008 user DENY beats role', async () => {
    expect((await getPermissionsFor(F.deny)).has('users.view')).toBe(false);
  });
  it('SEC-AUTHZ-009 Captain and Superadmin bypass', async () => {
    expect((await getPermissionsFor(captain)).size).toBe(ALL_PERMISSIONS.length);
    expect((await getPermissionsFor(sa)).size).toBe(ALL_PERMISSIONS.length);
  });
  it('SEC-AUTHZ-010 view-only user cannot mutate', async () => {
    as(await dev('dev.viewer'));
    const before = await userRow(F.victim.id);
    const res = await Promise.all([
      createUserAction(validCreate({ sectionId: org.junior, rankId: org.rk('Junior', 'Member') })),
      updateUserAction(F.victim.id, validUpdate()),
      changeRankAction(F.victim.id, rankPayload()),
      setStatusAction(F.victim.id, { status: 'inactive', reasonId: await reasonId() }),
      resetPasswordAction(F.victim.id, { reason: 'x', password: 'View-Attack-Pass-2026' }),
    ]);
    expect(res.map((r) => (r.ok ? 'OK' : r.code))).toEqual(Array(5).fill('FORBIDDEN'));
    expect((await userRow(F.victim.id)).updatedAt).toEqual(before.updatedAt);
  });
  it('SEC-AUTHZ-011 Member Admin limits', async () => {
    as(await dev('dev.officer'));
    const r1 = await resetPasswordAction(F.victim.id, { reason: 'x', password: 'Off-Attack-Pass-2026' });
    const r2 = await setStatusAction(F.victim.id, { status: 'inactive', reasonId: await reasonId() });
    const r3 = await changeRankAction(F.victim.id, rankPayload());
    expect([r1, r2, r3].map((r) => (r.ok ? 'OK' : r.code))).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN']);
    const r4 = await createUserAction(validCreate({ sectionId: org.junior, rankId: org.rk('Junior', 'Member'), idType: 'mykad', idNumber: '770101135599' }));
    expect(r4.ok).toBe(false);
    expect(!r4.ok && r4.code).toBe('VALIDATION');
  });
  it('SEC-AUTHZ-012 appointCaptainAction refused for non-superadmin', async () => {
    for (const t of [await dev('dev.captain'), await dev('dev.officer'), await dev('dev.boy'), await mint(F.mgr.id)]) {
      as(t);
      const r = await appointCaptainAction(F.peer.id);
      expect(r.ok ? 'OK' : r.code).toBe('FORBIDDEN');
    }
  });
  it('SEC-AUTHZ-013 only the authorised access-control service writes permission tables', () => {
    const files = [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'lib/server'))];
    const re = /(insert|update|delete)\(\s*(rolePermissions|rankPermissions|userRoles|userPermissionOverrides|roles|permissions|permissionChangeRequests)\b/;
    const writers = files.filter((f) => re.test(readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
    expect(writers).toEqual(['lib/server/access/service.ts']);
    // every mutating entry point of the service must gate on a permission / Captain / ownership check
    const src = readFileSync(path.join(ROOT, 'lib/server/access/service.ts'), 'utf8');
    for (const fn of ['saveRole', 'saveRankAccess', 'saveUserAccess', 'decideRequest', 'cancelRequest']) {
      const body = src.split(`export async function ${fn}(`)[1].split('\nexport ')[0];
      expect(/assertCanManageAccess|actor\.isCaptain|requestedBy !== actor\.id/.test(body), fn).toBe(true);
    }
  });
  it('SEC-AUTHZ-014 every exported action authenticates', () => {
    const bad: string[] = [];
    for (const f of ['auth.ts', 'users.ts']) {
      const src = readFileSync(path.join(ROOT, 'app/actions', f), 'utf8');
      for (const part of src.split('export async function ').slice(1)) {
        const name = part.split('(')[0];
        if (name === 'loginAction') continue;
        if (!/(requirePermission|requireUser|getCurrentUser)\(/.test(part)) bad.push(name);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('Escalation and Captain/Superadmin rules', () => {
  it('SEC-ESC-001 reset_password holder cannot reset Captain', async () => {
    as(await mint(F.mgr.id));
    const before = (await userRow(captain.id)).passwordHash;
    const r = await resetPasswordAction(captain.id, { reason: 'takeover', password: 'Hacked-Password-2026' });
    expect(r.ok ? 'OK' : r.code).toBe('FORBIDDEN');
    expect((await userRow(captain.id)).passwordHash).toBe(before);
  });
  it('SEC-ESC-002 cannot update/deactivate/re-rank Captain', async () => {
    as(await mint(F.mgr.id));
    const c = await userRow(captain.id);
    const res = [
      await updateUserAction(captain.id, validUpdate({ username: c.username, email: c.email, fullName: c.fullName, dateOfBirth: c.dateOfBirth, joinDate: c.joinDate })),
      await setStatusAction(captain.id, { status: 'inactive', reasonId: await reasonId() }),
      await changeRankAction(captain.id, { sectionId: org.officer, rankId: org.rk('Officer', 'Lieutenant'), reason: 'demote' }),
    ];
    // rank changes now go through the batch promoteAction: VALIDATION + generic per-member message
    expect(res.map((r) => (r.ok ? 'OK' : r.code))).toEqual(['FORBIDDEN', 'FORBIDDEN', 'VALIDATION']);
    const rr: any = res[2];
    expect(rr.fieldErrors?.[captain.id]).toBe('You cannot change this member.');
    expect(JSON.stringify(rr)).not.toMatch(/select |insert |update "|constraint|postgres/i);
    const after = await userRow(captain.id);
    expect(after.updatedAt).toEqual(c.updatedAt);
    expect(after.rankId).toBe(c.rankId);
  });
  it('SEC-ESC-003 non-superadmin cannot touch Superadmin; same as nonexistent', async () => {
    const saRow = await userRow(sa.id);
    const ghost = randomUUID();
    for (const tok of [await mint(F.mgr.id), await dev('dev.captain')]) {
      as(tok);
      const run = (id: string) => Promise.all([
        resetPasswordAction(id, { reason: 'x', password: SA_PW }),
        setStatusAction(id, { status: 'inactive', reasonId: 1 }),
        changeRankAction(id, rankPayload()),
        updateUserAction(id, validUpdate({ username: 'superadmin' })),
      ]);
      const a: any[] = await run(sa.id), b: any[] = await run(ghost);
      expect(a.map((r) => (r.ok ? 'OK' : r.code))).toEqual(['NOT_FOUND', 'NOT_FOUND', 'VALIDATION', 'NOT_FOUND']);
      // promote path: per-member message identical for Superadmin and a nonexistent id
      expect(Object.values(a[2].fieldErrors)).toEqual(['Member not found.']);
      expect(Object.values(b[2].fieldErrors)).toEqual(['Member not found.']);
      expect(a[2].message).toBe(b[2].message);
      for (const i of [0, 1, 3]) expect(a[i]).toEqual(b[i]);
    }
    expect((await userRow(sa.id)).passwordHash).toBe(saRow.passwordHash);
  });
  it('SEC-ESC-004 Superadmin not targetable by member ops, even by Superadmin', async () => {
    const h = (await userRow(sa.id)).passwordHash;
    await expect(resetPassword(sa, sa.id, { reason: 'x', password: SA_PW }, meta())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(setStatus(sa, sa.id, { status: 'inactive', reasonId: 1 }, meta())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(changeRank(sa, sa.id, rankPayload(), meta())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    expect((await userRow(sa.id)).passwordHash).toBe(h);
  });
  it('SEC-ESC-005 cannot manage a peer with higher permissions', async () => {
    const peer = await userRow(F.peer.id);
    const rej = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e: any) { return e.code; } };
    expect([
      await rej(resetPassword(F.mgr, F.peer.id, { reason: 'x', password: 'Peer-Takeover-Pass-2026' }, meta())),
      await rej(setStatus(F.mgr, F.peer.id, { status: 'inactive', reasonId: await reasonId() }, meta())),
      await rej(changeRank(F.mgr, F.peer.id, { sectionId: org.officer, rankId: org.rk('Officer', 'Helper'), reason: 'x' }, meta())),
    ]).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN']);
    expect((await userRow(F.peer.id)).passwordHash).toBe(peer.passwordHash);
  });
  it('SEC-ESC-006 self reset/deactivate/re-rank forbidden', async () => {
    const rej = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e: any) { return e.code; } };
    expect([
      await rej(resetPassword(F.mgr, F.mgr.id, { reason: 'x', password: 'Self-Reset-Pass-2026' }, meta())),
      await rej(setStatus(F.mgr, F.mgr.id, { status: 'inactive', reasonId: await reasonId() }, meta())),
      await rej(changeRank(F.mgr, F.mgr.id, { sectionId: org.officer, rankId: org.rk('Officer', 'Lieutenant'), reason: 'x' }, meta())),
    ]).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN']);
  });
  it('SEC-ESC-007 Captain rank cannot be assigned', async () => {
    const rej = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e: any) { return e.code; } };
    expect(await rej(changeRank(F.mgr, F.victim.id, { sectionId: org.officer, rankId: org.captainRankId, reason: 'x' }, meta()))).toBe('VALIDATION');
    expect(await rej(changeRank(captain, F.victim.id, { sectionId: org.officer, rankId: org.captainRankId, reason: 'x' }, meta()))).toBe('VALIDATION');
    expect(await rej(createUser(F.mgr, validCreate({ sectionId: org.officer, rankId: org.captainRankId }), meta()))).toBe('VALIDATION');
    const [{ n }] = await db.select({ n: count() }).from(users).where(eq(users.rankId, org.captainRankId));
    expect(n).toBe(1);
  });
  it('SEC-ESC-008 Captain cannot be deactivated', async () => {
    const rej = async (p: Promise<unknown>) => { try { await p; return 'OK'; } catch (e: any) { return e.code; } };
    const rid = await reasonId();
    expect([
      await rej(setStatus(captain, captain.id, { status: 'inactive', reasonId: rid }, meta())),
      await rej(setStatus(sa, captain.id, { status: 'inactive', reasonId: rid }, meta())),
      await rej(setStatus(F.mgr, captain.id, { status: 'inactive', reasonId: rid }, meta())),
    ]).toEqual(['FORBIDDEN', 'FORBIDDEN', 'FORBIDDEN']);
    expect((await userRow(captain.id)).status).toBe('active');
  });
  it('SEC-ESC-009 Captain rank cannot be removed via changeRank', async () => {
    const p = { sectionId: org.officer, rankId: org.rk('Officer', 'Lieutenant'), reason: 'demote' };
    await expect(changeRank(sa, captain.id, p, meta())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(changeRank(captain, captain.id, p, meta())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await userRow(captain.id)).rankId).toBe(org.captainRankId);
  });
  it('SEC-ESC-010 DB triggers protect the single Captain', async () => {
    const GUC = sql`select set_config('app.captain_change','on',true)`;
    const a = await probe(async (tx) => { await tx.execute(GUC); await tx.update(users).set({ rankId: org.captainRankId }).where(eq(users.id, F.mgr.id)); });
    expect(a.failed && /only be one Captain/i.test(a.text), a.text).toBe(true);
    const b = await probe((tx) => tx.update(users).set({ rankId: org.captainRankId }).where(eq(users.id, F.mgr.id)));
    expect(b.failed && /Captain rank can only be changed/i.test(b.text), b.text).toBe(true);
    const c = await probe((tx) => tx.update(users).set({ rankId: org.rk('Officer', 'Lieutenant') }).where(eq(users.id, captain.id)));
    expect(c.failed && /Captain rank can only be changed/i.test(c.text), c.text).toBe(true);
    const rid = await reasonId();
    const d = await probe((tx) => tx.update(users).set({ status: 'inactive', inactiveReasonId: rid }).where(eq(users.id, captain.id)));
    expect(d.failed && /cannot be deactivated/i.test(d.text), d.text).toBe(true);
  });
  it('SEC-ESC-011 DB: account_type/id immutable, users undeletable', async () => {
    const a = await probe((tx) => tx.update(users).set({ accountType: 'superadmin' }).where(eq(users.id, F.victim.id)));
    expect(a.failed, 'account_type change allowed').toBe(true);
    const b = await probe((tx) => tx.execute(sql`update users set id = gen_random_uuid() where id = ${F.victim.id}`));
    expect(b.failed, 'id change allowed').toBe(true);
    const c = await probe((tx) => tx.delete(users).where(eq(users.id, F.victim.id)));
    expect(c.failed && /Deleting from/i.test(c.text), c.text).toBe(true);
  });
  it('SEC-ESC-012 appointFirstCaptain guards', async () => {
    await expect(appointFirstCaptain(sa, F.mgr.id, meta())).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(appointFirstCaptain(F.mgr, F.peer.id, meta())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(appointFirstCaptain(captain, F.peer.id, meta())).rejects.toMatchObject({ code: 'FORBIDDEN' });
    expect((await db.select({ n: count() }).from(users).where(eq(users.rankId, org.captainRankId)))[0].n).toBe(1);
  });
  it('SEC-ESC-013 GUC set only in captain.ts', () => {
    const hits = [...walk(path.join(ROOT, 'app')), ...walk(path.join(ROOT, 'lib'))].filter((f) => {
      const b = path.basename(f);
      return readFileSync(f, 'utf8').includes('app.captain_change') && !/^seed(-dev)?\.ts$/.test(b) && b !== 'migrate.ts';
    }).map((f) => path.relative(ROOT, f).replace(/\\/g, '/'));
    expect(hits).toEqual(['lib/server/captain.ts']);
  });
  it('SEC-ESC-014 mass assignment on update ignored', async () => {
    as(await mint(F.mgr.id));
    const b = await userRow(F.victim.id);
    const r = await updateUserAction(F.victim.id, validUpdate({
      fullName: 'QA Sec victim', guardians: [{ name: 'QA Guardian', relationship: 'father', phone: '+60111222333', email: '' }],
      passwordHash: '$argon2id$evil', accountType: 'superadmin', status: 'inactive', rankId: org.captainRankId, sectionId: org.officer,
      mustChangePassword: true, failedLoginCount: 99, lockedUntil: '2030-01-01', createdBy: captain.id, avatarUrl: 'javascript:alert(1)',
      id: captain.id, inactiveReasonId: 1, idNumberHash: 'x', username: 'qa.sec.victim',
    }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const a = await userRow(F.victim.id);
    for (const k of ['passwordHash', 'accountType', 'status', 'rankId', 'sectionId', 'mustChangePassword', 'failedLoginCount', 'lockedUntil', 'createdBy', 'avatarUrl', 'id', 'inactiveReasonId', 'idNumberHash', 'idNumberEnc'] as const) {
      expect(a[k], k).toEqual(b[k]);
    }
  });
  it('SEC-ESC-015 mass assignment on create ignored', async () => {
    as(await mint(F.mgr.id));
    const r = await createUserAction(validCreate({
      sectionId: org.junior, rankId: org.rk('Junior', 'Member'), accountType: 'superadmin', status: 'inactive', passwordHash: 'x',
      createdBy: captain.id, id: randomUUID(), mustChangePassword: true, avatarUrl: 'javascript:alert(1)',
    }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const row = await userRow(r.data.id);
    expect(row).toMatchObject({ accountType: 'member', status: 'active', passwordHash: null, createdBy: F.mgr.id, avatarUrl: null, mustChangePassword: false });
    expect(row.id).toBe(r.data.id);
  });
  it('SEC-ESC-016 rank/section validation', async () => {
    as(await mint(F.mgr.id));
    const bad: [any, any][] = [
      [org.junior, org.rk('Officer', 'Helper')], [org.junior, 99999], [org.junior, -1], [org.junior, 1.5], [org.junior, 'abc'],
      [99999, org.rk('Junior', 'Member')], [org.officer, org.captainRankId], [0, 0], [null, null],
    ];
    const out: string[] = [];
    for (const [s, r] of bad) {
      const res = await createUserAction(validCreate({ sectionId: s, rankId: r }));
      out.push(res.ok ? 'OK' : res.code);
    }
    expect(out.join(',') + ' for ' + JSON.stringify(bad)).toBe(Array(bad.length).fill('VALIDATION').join(',') + ' for ' + JSON.stringify(bad));
  });
  it('SEC-ESC-017 id forms give NOT_FOUND without raw errors', async () => {
    as(await mint(F.mgr.id));
    const ids: any[] = ['x', '', "' OR 1=1 --", '-'.repeat(36), 'a'.repeat(1000), null, undefined, randomUUID(), '0'.repeat(36), '00000000-0000-0000-0000-00000000000g'];
    const bad: string[] = [];
    for (const id of ids) {
      for (const [n, p] of [
        ['reset', resetPasswordAction(id, { reason: 'x', password: 'Idor-Test-Pass-2026' })],
        ['status', setStatusAction(id, { status: 'inactive', reasonId: 1 })],
        ['rank', changeRankAction(id, rankPayload())],
        ['update', updateUserAction(id, validUpdate())],
      ] as const) {
        const r: any = await p;
        if (n === 'rank') {
          const vals = Object.values(r.fieldErrors ?? {});
          if (r.ok || r.code !== 'VALIDATION' || vals.length !== 1 || vals[0] !== 'Member not found.' || /select |insert |constraint|postgres|invalid input/i.test(JSON.stringify(r))) bad.push(`rank(${JSON.stringify(id)?.slice(0, 12)}) -> ${JSON.stringify(r).slice(0, 150)}`);
          continue;
        }
        if (r.ok || r.code !== 'NOT_FOUND') bad.push(`${n}(${JSON.stringify(id)?.slice(0, 12)}) -> ${r.ok ? 'OK' : r.code + ': ' + r.message}`);
      }
    }
    expect(bad.join(' ; ')).toBe('');
  });
  it('SEC-ESC-018 Superadmin hidden', async () => {
    await expect(getUserDetail(captain, sa.id, meta())).rejects.toMatchObject({ code: 'NOT_FOUND' });
    const l = await listUsers({ q: 'superadmin', status: 'all' });
    expect(l.rows.find((r) => r.username === 'superadmin')).toBeUndefined();
    const all = await listUsers({ status: 'all' });
    const [{ n }] = await db.select({ n: count() }).from(users).where(eq(users.accountType, 'member'));
    expect(all.total).toBe(n);
  });
  it('SEC-ESC-019 list hardening', async () => {
    for (const q of ['%', '%%%', '\\', "' OR 1=1 --", 'x'.repeat(5000)]) {
      const r = await listUsers({ q, status: 'all' });
      expect(r.rows.length, q.slice(0, 10)).toBeLessThanOrEqual(20);
      if (q === '%' || q === '\\') for (const row of r.rows) expect((row.fullName + row.username).includes(q), 'wildcard not escaped: ' + q + ' matched ' + row.username).toBe(true);
    }
    expect((await listUsers({ status: 'all', page: 99999999 })).rows).toEqual([]);
    expect((await listUsers({ status: 'all', page: -5 })).page).toBe(1);
    expect((await listUsers({ status: 'all' })).pageSize).toBe(20);
  });
  it('SEC-ESC-020 tampered IC/guardian fields ignored without view_sensitive', async () => {
    as(await dev('dev.officer'));
    const b = await userRow(F.victim.id);
    const r = await updateUserAction(F.victim.id, validUpdate({
      idType: 'mykad', idNumber: '881122135577', guardians: [{ name: 'Evil Guardian', relationship: 'father', phone: '+60999999999' }],
    }));
    expect(r.ok, JSON.stringify(r)).toBe(true);
    const a = await userRow(F.victim.id);
    expect(a.idNumberHash).toBe(b.idNumberHash);
    expect(a.idNumberEnc).toBe(b.idNumberEnc);
    const g = await db.select().from(guardians).where(eq(guardians.userId, F.victim.id));
    expect(g.map((x) => x.name)).toEqual(['QA Guardian']);
  });
});

void and; void errText;
