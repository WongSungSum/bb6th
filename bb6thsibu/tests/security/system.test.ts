// System security test 2026-11-03: section/platoon scope, OFFICER_ONLY, own profile, platoons, password policy.
// Uses its own sections/platoons (qa.sys.*) and qa.sys.* users; never touches the real Senior platoons.
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('next/headers', async () => (await import('./ctx')).headersMock);
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/server/request', async () => (await import('./ctx')).requestMock);

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { guardians, permissionChangeRequests, platoonActivities, platoons, platoonScores, users, userPermissionOverrides, userRoles } from '@/lib/db/schema';
import { getPermissionsFor, loadPermissions, memberScope } from '@/lib/server/authz';
import type { PermissionSlug } from '@/lib/server/authz/catalog';
import * as acc from '@/lib/server/access/service';
import * as orgSvc from '@/lib/server/org/service';
import * as pl from '@/lib/server/platoons/service';
import { createUser, getUserDetail, listUsers, promoteMembers, resetPassword, setStatus, updateUser } from '@/lib/server/users/service';
import { getOwnProfile } from '@/lib/server/users/profile';
import { updateProfileAction } from '@/app/actions/users';
import { assignMembersAction, saveActivityAction, setLeadersAction } from '@/app/actions/platoons';
import { changeOwnPassword, login } from '@/lib/server/auth/login';
import { checkPasswordPolicy, hashPassword } from '@/lib/server/auth/password';
import { ctx, resetCtx } from './ctx';
import { closeDb, loadCU, meta, mint, orgIds, rand, reasonId, probe, userRow, validCreate } from './fixtures';

type CU = Awaited<ReturnType<typeof loadCU>>;
const PW = 'QaSys-Pass-2026-x1';
const M = () => meta('sys');
const GUARD = [{ name: 'QA Guardian', relationship: 'father', phone: '+60111222333', email: '' }];
const ex = async (p: Promise<unknown>): Promise<any> => { try { return { ok: true, v: await p }; } catch (e: any) { return { ok: false, code: e.code ?? 'ERR', message: String(e.message), fe: e.fieldErrors }; } };
const code = async (p: Promise<unknown>) => { const r = await ex(p); return r.ok ? 'OK' : r.code; };
const ic12 = () => '0' + Array.from({ length: 11 }, () => Math.floor(Math.random() * 10)).join('');
const ROOT = path.resolve(__dirname, '../..');

let captain: CU, sa: CU, org: Awaited<ReturnType<typeof orgIds>>;
let SA = 0, SB = 0, RA = 0, RB = 0, RB_RICH = 0, P1 = 0, P2 = 0;
let jv: CU, jb: CU, allS: CU, off: CU, offPlain: CU, del: CU, offMgr: CU, juniorPerm: CU;
let mP1: CU, mP2: CU, mB: CU, mB_IC = '';
const created: string[] = [];
let pwHash: string | undefined;

async function setOv(userId: string, slug: PermissionSlug, effect: 'allow' | 'deny' = 'allow') {
  await db.insert(userPermissionOverrides).values({ userId, permissionSlug: slug, effect, reason: 'qa.sys' })
    .onConflictDoUpdate({ target: [userPermissionOverrides.userId, userPermissionOverrides.permissionSlug], set: { effect } });
}
async function mk(tag: string, o: { sectionId: number; rankId: number; platoonId?: number; perms?: PermissionSlug[]; ic?: string; officer?: boolean }): Promise<CU> {
  const username = `qa.sys.${tag}${rand(5)}`;
  const r = await createUser(captain, validCreate({
    username, sectionId: o.sectionId, rankId: o.rankId, platoonId: o.platoonId, guardians: o.officer ? [] : GUARD,
    idType: o.ic ? 'mykad' : 'none', idNumber: o.ic,
  }), M());
  pwHash ??= await hashPassword(PW);
  await db.update(users).set({ mustChangePassword: false, passwordHash: pwHash }).where(eq(users.id, r!.id));
  for (const p of o.perms ?? []) await setOv(r!.id, p);
  created.push(r!.id);
  return loadCU(username);
}

beforeAll(async () => {
  captain = await loadCU('dev.captain');
  sa = await loadCU('superadmin');
  org = await orgIds();
  SA = (await orgSvc.createSection(captain, { name: `qa.sys.sa${rand(6)}` }, M()))!.id;
  SB = (await orgSvc.createSection(captain, { name: `qa.sys.sb${rand(6)}` }, M()))!.id;
  RA = (await orgSvc.createRank(captain, { sectionId: SA, name: 'qa.member' }, M()))!.id;
  RB = (await orgSvc.createRank(captain, { sectionId: SB, name: 'qa.member' }, M()))!.id;
  RB_RICH = (await orgSvc.createRank(captain, { sectionId: SB, name: 'qa.rich' }, M()))!.id;
  await acc.saveRankAccess(captain, RB_RICH, { permissions: ['users.update_status', 'users.view'] }, M());
  P1 = (await pl.createPlatoon(captain, { sectionId: SA, name: `qa.sys.p1.${rand(6)}` }, M()))!.id;
  P2 = (await pl.createPlatoon(captain, { sectionId: SA, name: `qa.sys.p2.${rand(6)}` }, M()))!.id;
  const officerRank = org.rk('Officer', 'Helper');
  jv = await mk('jv', { sectionId: SA, rankId: RA, platoonId: P1, perms: ['users.view', 'users.update', 'users.create', 'users.view_sensitive', 'users.update_status'] });
  mP1 = await mk('mp1', { sectionId: SA, rankId: RA, platoonId: P1 });
  mP2 = await mk('mp2', { sectionId: SA, rankId: RA, platoonId: P2 });
  mB_IC = ic12();
  mB = await mk('mb', { sectionId: SB, rankId: RB, ic: mB_IC });
  jb = await mk('jb', { sectionId: SB, rankId: RB, perms: ['users.view', 'users.create'] });
  allS = await mk('all', { sectionId: SB, rankId: RB, perms: ['users.view', 'users.all_sections', 'users.create'] });
  del = await mk('del', { sectionId: SB, rankId: RB, perms: ['permissions.manage', 'users.view'] });
  juniorPerm = await mk('jp', { sectionId: SB, rankId: RB, perms: ['users.view', 'users.change_rank', 'users.reset_password', 'platoons.manage', 'platoons.score'] });
  off = await mk('off', { sectionId: org.officer, rankId: officerRank, officer: true, perms: ['users.view', 'users.change_rank', 'users.create'] });
  offPlain = await mk('offp', { sectionId: org.officer, rankId: officerRank, officer: true });
  offMgr = await mk('offm', { sectionId: org.officer, rankId: officerRank, officer: true, perms: ['platoons.manage', 'platoons.score', 'users.view'] });
}, 240000);
beforeEach(() => resetCtx());
afterAll(async () => {
  try {
    const open = await db.select({ id: permissionChangeRequests.id }).from(permissionChangeRequests)
      .where(and(eq(permissionChangeRequests.status, 'pending'), inArray(permissionChangeRequests.requestedBy, created)));
    for (const r of open) await acc.decideRequest(captain, r.id, 'reject', 'qa cleanup', M()).catch(() => {});
    const rid = await reasonId();
    for (const id of created) await setStatus(captain, id, { status: 'inactive', reasonId: rid }, M()).catch(() => {});
    await db.update(users).set({ platoonId: null, platoonRole: null }).where(inArray(users.id, created));
    for (const p of [P1, P2]) await pl.updatePlatoon(captain, p, { isActive: false }, M()).catch(() => {});
    await acc.saveRankAccess(captain, RB_RICH, { permissions: [] }, M()).catch(() => {});
  } catch {}
  await db.execute(sql`update sessions set revoked_at = now() where revoked_at is null and ip = 'qa-mint'`);
  await closeDb();
});

// ───────────────────────── A. Section / platoon scope ─────────────────────────
describe('System / scope', () => {
  it('SYS-SCOPE-001 platoon member sees only own platoon in lists, filters and search', async () => {
    const scope = await memberScope(jv);
    expect(scope).toEqual({ sections: [SA], platoonId: P1 });
    const all = await listUsers({ status: 'all', pageSize: 100 }, { canSearchIc: true, scope });
    const ids = all.rows.map((r) => r.id);
    expect(ids).toContain(mP1.id);
    expect(ids).not.toContain(mP2.id);
    expect(ids).not.toContain(mB.id);
    expect(all.rows.every((r) => r.sectionId === SA && r.platoonId === P1)).toBe(true);
    expect((await listUsers({ q: mP2.username }, { canSearchIc: true, scope })).total).toBe(0);
    expect((await listUsers({ platoon: P2 }, { canSearchIc: true, scope })).total).toBe(0);
    expect((await listUsers({ section: SB }, { canSearchIc: true, scope })).total).toBe(0);
    // IC search of an out-of-scope member (actor holds view_sensitive)
    expect((await listUsers({ q: mB_IC }, { canSearchIc: true, scope })).total).toBe(0);
    expect((await listUsers({ q: mB_IC.slice(0, 6) + '-' + mB_IC.slice(6, 8) + '-' + mB_IC.slice(8) }, { canSearchIc: true, scope })).total).toBe(0);
  });

  it('SYS-SCOPE-002 out-of-scope detail/update/status look like a missing member', async () => {
    const ghost = randomUUID();
    for (const t of [mP2.id, mB.id, ghost]) {
      const d = await ex(getUserDetail(jv, t, M()));
      expect(d.code).toBe('NOT_FOUND');
      expect(d.message).toBe('Member not found.');
      const u = await ex(updateUser(jv, t, validCreate({ username: 'qa.sys.hijack' + rand(4), guardians: GUARD }) as any, M()));
      expect(u.code).toBe('NOT_FOUND');
      expect(await code(setStatus(jv, t, { status: 'inactive', reasonId: await reasonId() }, M()))).toBe('NOT_FOUND');
    }
    expect((await userRow(mP2.id)).status).toBe('active');
    expect(await code(getUserDetail(jv, mP1.id, M()))).toBe('OK');
  });

  it('SYS-SCOPE-003 create is limited to own section and platoon', async () => {
    const mkIn = (sectionId: number, rankId: number, platoonId?: number) =>
      code(createUser(jv, validCreate({ username: 'qa.sys.c' + rand(6), sectionId, rankId, platoonId, guardians: GUARD }), M()));
    expect(await mkIn(SA, RA, P2)).toBe('NOT_FOUND');
    expect(await mkIn(SB, RB)).toBe('NOT_FOUND');
    expect(await mkIn(org.officer, org.rk('Officer', 'Helper'))).toBe('NOT_FOUND');
    expect(await mkIn(SA, RA, P1)).toBe('OK');
    // section-scoped (no platoon) member
    expect(await code(createUser(jb, validCreate({ username: 'qa.sys.c' + rand(6), sectionId: SA, rankId: RA, platoonId: P1, guardians: GUARD }), M()))).toBe('NOT_FOUND');
  });

  it('SYS-SCOPE-004 platoon-scoped member cannot move a member to another platoon', async () => {
    const before = await userRow(mP1.id);
    const r = await ex(updateUser(jv, mP1.id, { username: before.username, email: before.email, fullName: before.fullName, gender: before.gender, dateOfBirth: before.dateOfBirth, joinDate: before.joinDate, phone: before.phone, guardians: GUARD, platoonId: P2 } as any, M()));
    expect(r.code).toBe('FORBIDDEN');
    expect((await userRow(mP1.id)).platoonId).toBe(P1);
  });

  it('SYS-SCOPE-005 users.all_sections lifts scope; officers see all', async () => {
    expect(await memberScope(allS)).toBe('all');
    expect(await memberScope(offPlain)).toBe('all');
    expect(await code(getUserDetail(allS, mP2.id, M()))).toBe('OK');
  });

  it('SYS-SCOPE-006 delegate (permissions.manage) is scoped too', async () => {
    expect(await code(acc.getUserAccess(del, mP1.id))).toBe('NOT_FOUND');
    expect(await code(acc.saveUserAccess(del, mP1.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow' }] }, M()))).toBe('NOT_FOUND');
    expect(await code(acc.getUserAccess(del, mB.id))).toBe('OK');
  });

  it('SYS-SCOPE-007 [R-40 fixed] non-officer with all_sections cannot create an Officer-section account', async () => {
    const r = await ex(createUser(allS, validCreate({ username: 'qa.sys.fakeoff' + rand(5), sectionId: org.officer, rankId: org.rk('Officer', 'Helper'), tempPassword: PW, guardians: [] }), M()));
    if (r.ok) created.push(r.v.id);
    expect(r.ok).toBe(false);
  });

  it('SYS-SCOPE-008 [R-39 fixed] role detail lists only members inside the delegate scope', async () => {
    const role = await acc.saveRole(captain, null, { name: `qa.sys.role.${rand(6)}`, description: null, isActive: true, permissions: ['users.view'] }, M());
    const roleId = Number(role.targetId);
    await db.insert(userRoles).values({ userId: mP2.id, roleId }).onConflictDoNothing();
    // 页面会传入 del 的范围（app/maintenance/roles/[id]/page.tsx）
    const r = await acc.getRole(roleId, await memberScope(del));
    const leaked = r!.members.some((m) => m.id === mP2.id);
    expect(leaked, 'getRole exposes out-of-scope member names to any permissions.manage holder').toBe(false);
  });
});

// ───────────────────────── B. OFFICER_ONLY ─────────────────────────
describe('System / OFFICER_ONLY', () => {
  it('SYS-OFF-001 user ALLOW of officer-only permissions is stripped for non-officers', async () => {
    const p = await loadPermissions(juniorPerm.id);
    for (const s of ['users.change_rank', 'users.reset_password', 'platoons.manage', 'platoons.score'] as PermissionSlug[]) expect(p.has(s)).toBe(false);
    expect(p.has('users.view')).toBe(true);
    expect(await code(resetPassword(juniorPerm, mB.id, { reason: 'x' }, M()))).toBe('FORBIDDEN');
    expect(await code(promoteMembers(juniorPerm, { userIds: [mB.id], sectionId: SB, rankId: RB_RICH, reason: 'x' }, M()))).toBe('FORBIDDEN');
    expect(await code(pl.createPlatoon(juniorPerm, { sectionId: SB, name: 'qa.sys.x' + rand(5) }, M()))).toBe('FORBIDDEN');
    expect(await code(pl.createActivity(juniorPerm, { name: 'x', activityDate: '2026-01-01', scores: [{ platoonId: P1, points: 1 }] }, M()))).toBe('FORBIDDEN');
  });

  it('SYS-OFF-002 officer-only via role or rank grant is stripped too', async () => {
    const role = await acc.saveRole(captain, null, { name: `qa.sys.rr.${rand(6)}`, description: null, isActive: true, permissions: ['users.reset_password', 'platoons.manage'] }, M());
    const t = await mk('rolet', { sectionId: SB, rankId: RB });
    await db.insert(userRoles).values({ userId: t.id, roleId: Number(role.targetId) });
    const p = await loadPermissions(t.id);
    expect(p.has('users.reset_password')).toBe(false);
    expect(p.has('platoons.manage')).toBe(false);
  });

  it('SYS-OFF-003 non-officer delegate cannot grant officer-only to an officer', async () => {
    const t = await mk('offt', { sectionId: org.officer, rankId: org.rk('Officer', 'Helper'), officer: true });
    const del2 = await mk('del2', { sectionId: SB, rankId: RB, perms: ['permissions.manage', 'users.view', 'users.all_sections', 'users.reset_password'] });
    const r = await ex(acc.saveUserAccess(del2, t.id, { roleIds: [], overrides: [{ slug: 'users.reset_password', effect: 'allow' }] }, M()));
    expect(r.code).toBe('FORBIDDEN');
  });

  it('SYS-OFF-004 [fixed] promotion into Officer activates dormant officer-only grants the promoter lacks', async () => {
    const t = await mk('dorm', { sectionId: SB, rankId: RB });
    await setOv(t.id, 'users.reset_password'); // dormant while not an officer
    expect((await loadPermissions(t.id)).has('users.reset_password')).toBe(false);
    expect((await getPermissionsFor(off)).has('users.reset_password')).toBe(false);
    const r = await ex(promoteMembers(off, { userIds: [t.id], sectionId: org.officer, rankId: org.rk('Officer', 'Helper'), reason: 'qa.sys' }, M()));
    const gained = (await loadPermissions(t.id)).has('users.reset_password');
    expect(r.ok && gained, 'officer without users.reset_password promoted a member and the member gained users.reset_password').toBe(false);
  });

  it('SYS-OFF-005 [fixed] delegate can request a dormant officer-only ALLOW they do not hold', async () => {
    const t = await mk('dreq', { sectionId: SB, rankId: RB });
    expect((await getPermissionsFor(del)).has('users.reset_password')).toBe(false);
    const r = await ex(acc.saveUserAccess(del, t.id, { roleIds: [], overrides: [{ slug: 'users.reset_password', effect: 'allow' }] }, M()));
    expect(r.ok ? 'ACCEPTED' : r.code, 'request granting users.reset_password accepted from a delegate who lacks it').toBe('FORBIDDEN');
  });

  it('SYS-OFF-006 [fixed] createUser into a rank that carries permissions the creator lacks', async () => {
    expect((await getPermissionsFor(off)).has('users.update_status')).toBe(false);
    const username = 'qa.sys.rich' + rand(5);
    const r = await ex(createUser(off, validCreate({ username, sectionId: SB, rankId: RB_RICH, tempPassword: PW, guardians: GUARD }), M()));
    let gained = false;
    if (r.ok) {
      created.push(r.v.id);
      gained = (await loadPermissions(r.v.id)).has('users.update_status');
      const li = await login(username, PW, { ip: 'qa-sys-' + rand(6), userAgent: 'vitest' });
      expect(li.ok).toBe(true); // creator knows the temp password: can sign in as the new account
    }
    expect(r.ok && gained, 'creator without users.update_status created an account holding it').toBe(false);
  });

  it('SYS-OFF-007 rank grants applied via promotion still enforced (R-27 regression)', async () => {
    const t = await mk('r27', { sectionId: SB, rankId: RB });
    const r = await ex(promoteMembers(off, { userIds: [t.id], sectionId: SB, rankId: RB_RICH, reason: 'qa.sys' }, M()));
    expect(r.code).toBe('FORBIDDEN');
  });
});

// ───────────────────────── C. My profile ─────────────────────────
describe('System / my profile', () => {
  it('SYS-PROF-001 mass assignment ignored, only own row changes', async () => {
    const me = await mk('prof', { sectionId: SB, rankId: RB });
    const before = await userRow(me.id);
    const otherBefore = await userRow(mB.id);
    ctx.token = await mint(me.id);
    const r: any = await updateProfileAction({
      email: 'qa.sys@example.test', phone: '+60123456700', address: 'A', school: 'S', guardians: GUARD,
      fullName: 'Hacked', username: 'qa.sys.hacked', sectionId: org.officer, rankId: org.captainRankId, status: 'inactive',
      accountType: 'superadmin', id: mB.id, userId: mB.id, passwordHash: 'x', mustChangePassword: true, platoonId: P1, platoonRole: 'leader',
      idType: 'mykad', idNumber: '010101010101',
    } as any);
    expect(r.ok).toBe(true);
    const after = await userRow(me.id);
    expect(after.email).toBe('qa.sys@example.test');
    for (const k of ['fullName', 'username', 'sectionId', 'rankId', 'status', 'accountType', 'passwordHash', 'mustChangePassword', 'platoonId', 'platoonRole', 'idType', 'idNumberHash'] as const) {
      expect(after[k]).toEqual(before[k]);
    }
    const other = await userRow(mB.id);
    expect(other.email).toBe(otherBefore.email);
    expect(other.updatedAt.toISOString()).toBe(otherBefore.updatedAt.toISOString());
  });

  it('SYS-PROF-002 guardians cannot be injected for officers or Superadmin', async () => {
    for (const u of [offPlain, sa]) {
      ctx.token = await mint(u.id);
      const cur = await userRow(u.id);
      const r: any = await updateProfileAction({ email: cur.email, phone: cur.phone ?? '', address: cur.address, school: cur.school, guardians: GUARD } as any);
      expect(r.ok).toBe(true);
      expect((await db.select().from(guardians).where(eq(guardians.userId, u.id))).length).toBe(0);
    }
  });

  it('SYS-PROF-003 validation: 3 guardians, bad email, oversized fields, unauthenticated', async () => {
    const me = await mk('prof2', { sectionId: SB, rankId: RB });
    ctx.token = await mint(me.id);
    const bad = async (i: any) => ((await updateProfileAction(i)) as any).code;
    expect(await bad({ email: 'x', guardians: [] })).toBe('VALIDATION');
    expect(await bad({ email: 'a@b.co', guardians: [GUARD[0], GUARD[0], GUARD[0]] })).toBe('VALIDATION');
    expect(await bad({ email: 'a@b.co', address: 'x'.repeat(301), guardians: [] })).toBe('VALIDATION');
    expect(await bad({ email: 'a@b.co', guardians: 'nope' })).toBe('VALIDATION');
    ctx.token = undefined;
    let redirected = false;
    try { await updateProfileAction({ email: 'a@b.co', guardians: [] } as any); } catch (e: any) { redirected = String(e?.digest ?? '').includes('/login'); }
    expect(redirected).toBe(true);
    const p = await getOwnProfile(me);
    expect(JSON.stringify(p)).not.toMatch(/passwordHash|idNumberEnc|idNumberHash/);
  });
});

// ───────────────────────── D. Platoons ─────────────────────────
describe('System / platoons', () => {
  it('SYS-PLT-001 every mutator requires an officer with platoons.manage / platoons.score', async () => {
    for (const a of [jv, juniorPerm, offPlain, del]) {
      expect(await code(pl.createPlatoon(a, { sectionId: SA, name: 'qa.sys.n' + rand(5) }, M()))).toBe('FORBIDDEN');
      expect(await code(pl.updatePlatoon(a, P1, { name: 'qa.sys.r' + rand(5) }, M()))).toBe('FORBIDDEN');
      expect(await code(pl.movePlatoon(a, P1, 'up', M()))).toBe('FORBIDDEN');
      expect(await code(pl.getPlatoon(a, P1))).toBe('FORBIDDEN');
      expect(await code(pl.assignMembers(a, P1, { userIds: [mP2.id] }, M()))).toBe('FORBIDDEN');
      expect(await code(pl.removeMembers(a, P1, { userIds: [mP1.id] }, M()))).toBe('FORBIDDEN');
      expect(await code(pl.setPlatoonLeaders(a, P1, { leaderId: mP1.id, assistantId: null }, M()))).toBe('FORBIDDEN');
      expect(await code(pl.createActivity(a, { name: 'x', activityDate: '2026-01-01', scores: [{ platoonId: P1, points: 5 }] }, M()))).toBe('FORBIDDEN');
    }
    // action layer (unauthenticated -> login redirect, member -> FORBIDDEN)
    ctx.token = await mint(jv.id);
    expect(((await assignMembersAction(P1, [mP2.id])) as any).code).toBe('FORBIDDEN');
    expect(((await setLeadersAction(P1, jv.id, null)) as any).code).toBe('FORBIDDEN');
    expect(((await saveActivityAction(null, { name: 'x', activityDate: '2026-01-01', note: '', scores: [{ platoonId: P1, points: '999' }] })) as any).code).toBe('FORBIDDEN');
    expect((await userRow(mP2.id)).platoonId).toBe(P2);
  });

  it('SYS-PLT-002 assign: other section, officer, Superadmin, ghost, inactive, bad ids, batch cap', async () => {
    const c = (ids: unknown) => ex(pl.assignMembers(offMgr, P1, { userIds: ids }, M()));
    const r1 = await c([mB.id]);
    expect(r1.code).toBe('VALIDATION');
    expect(r1.fe[mB.id]).toBe('Member is not in this section.');
    expect((await c([sa.id])).fe[sa.id]).toBe('Member not found.');
    expect((await c([offPlain.id])).code).toBe('VALIDATION');
    expect((await c([randomUUID()])).code).toBe('VALIDATION');
    expect((await c(['1 or 1=1'])).code).toBe('NOT_FOUND');
    expect((await c([])).code).toBe('VALIDATION');
    expect((await c('x')).code).toBe('VALIDATION');
    expect((await c(Array.from({ length: 101 }, () => randomUUID()))).code).toBe('VALIDATION');
    // all-or-nothing: valid + invalid
    const r2 = await c([mP2.id, mB.id]);
    expect(r2.code).toBe('VALIDATION');
    expect((await userRow(mP2.id)).platoonId).toBe(P2);
    // platoon ids
    for (const pid of [0, -1, 1.5, 99999, NaN]) expect(await code(pl.assignMembers(offMgr, pid as number, { userIds: [mP2.id] }, M()))).toBe('NOT_FOUND');
  });

  it('SYS-PLT-003 leaders must be active members of that platoon', async () => {
    const L = (l: unknown, a: unknown) => ex(pl.setPlatoonLeaders(offMgr, P1, { leaderId: l, assistantId: a }, M()));
    expect((await L(mP2.id, null)).code).toBe('VALIDATION');
    expect((await L(mB.id, null)).code).toBe('VALIDATION');
    expect((await L(mP1.id, mP1.id)).code).toBe('VALIDATION');
    expect((await L(sa.id, null)).code).toBe('VALIDATION');
    expect((await L("'; drop table users;--", null)).code).toBe('VALIDATION');
    expect((await L(mP1.id, null)).ok).toBe(true);
    expect((await userRow(mP1.id)).platoonRole).toBe('leader');
    // leader role grants nothing
    expect([...(await loadPermissions(mP1.id))]).toEqual([]);
    expect(await memberScope(await loadCU(mP1.username))).toEqual({ sections: [SA], platoonId: P1 });
    // DB: a second leader in the same platoon is impossible
    const p = await probe((tx) => tx.update(users).set({ platoonRole: 'leader' }).where(eq(users.id, jv.id)));
    expect(p.failed).toBe(true);
    // DB: platoon of another section impossible
    const p2 = await probe((tx) => tx.update(users).set({ platoonId: P1 }).where(eq(users.id, mB.id)));
    expect(p2.failed).toBe(true);
    await L(null, null);
  });

  it('SYS-PLT-004 score validation and tampering', async () => {
    const A = (scores: unknown, extra: Record<string, unknown> = {}) => ex(pl.createActivity(offMgr, { name: 'qa.sys act', activityDate: '2026-01-02', scores, ...extra } as any, M()));
    expect((await A([{ platoonId: P1, points: 1001 }])).code).toBe('VALIDATION');
    expect((await A([{ platoonId: P1, points: -1001 }])).code).toBe('VALIDATION');
    expect((await A([{ platoonId: P1, points: 1.5 }])).code).toBe('VALIDATION');
    expect((await A([{ platoonId: P1, points: '1e3' }])).code).toBe('VALIDATION'); // 2026-11-04 起只接受普通整数
    expect((await A([{ platoonId: P1, points: 'abc' }])).code).toBe('VALIDATION');
    expect((await A([{ platoonId: P1, points: 5 }, { platoonId: P1, points: 5 }])).code).toBe('VALIDATION');
    expect((await A([{ platoonId: 32000, points: 5 }])).code).toBe('VALIDATION');
    expect((await A([])).code).toBe('VALIDATION');
    expect((await A([{ platoonId: P1, points: 5 }], { activityDate: '2999-01-01' })).code).toBe('VALIDATION');
    expect((await A([{ platoonId: P1, points: 5 }], { activityDate: '2026-02-30' })).code).toBe('VALIDATION');
    expect((await A([{ platoonId: P1, points: 5 }], { name: 'x'.repeat(81) })).code).toBe('VALIDATION');
    // DB check constraint
    const p = await probe((tx) => tx.insert(platoonScores).values({ activityId: randomUUID(), platoonId: P1, points: 5000 }));
    expect(p.failed).toBe(true);
  });

  it('SYS-PLT-005 voided activity frozen in service and DB; nothing deletable', async () => {
    const a = await pl.createActivity(offMgr, { name: '<img src=x onerror=alert(1)>', activityDate: '2026-01-03', note: '<script>alert(1)</script>', scores: [{ platoonId: P1, points: 10 }] }, M());
    const [stored] = await db.select().from(platoonActivities).where(eq(platoonActivities.id, a.id));
    expect(stored.name).toBe('<img src=x onerror=alert(1)>'); // stored raw, rendered by React escaping
    expect(await code(pl.voidActivity(offMgr, a.id, { reason: '' }, M()))).toBe('VALIDATION');
    expect(await code(pl.voidActivity(offMgr, a.id, { reason: 'qa' }, M()))).toBe('OK');
    expect(await code(pl.voidActivity(offMgr, a.id, { reason: 'qa' }, M()))).toBe('VALIDATION');
    expect(await code(pl.updateActivity(offMgr, a.id, { name: 'x', activityDate: '2026-01-03', scores: [{ platoonId: P1, points: 999 }] }, M()))).toBe('VALIDATION');
    expect((await probe((tx) => tx.update(platoonActivities).set({ voidedAt: null, voidReason: null }).where(eq(platoonActivities.id, a.id)))).failed).toBe(true);
    expect((await probe((tx) => tx.delete(platoonActivities).where(eq(platoonActivities.id, a.id)))).failed).toBe(true);
    expect((await probe((tx) => tx.delete(platoonScores).where(eq(platoonScores.activityId, a.id)))).failed).toBe(true);
    expect((await probe((tx) => tx.delete(platoons).where(eq(platoons.id, P1)))).failed).toBe(true);
    expect((await probe((tx) => tx.update(platoons).set({ sectionId: SB }).where(eq(platoons.id, P1)))).failed).toBe(true);
    // DB: scores of a voided activity are not protected by trigger (points can still be rewritten by raw SQL)
    const raw = await probe((tx) => tx.update(platoonScores).set({ points: 999 }).where(eq(platoonScores.activityId, a.id)));
    expect(raw.failed, 'raw UPDATE of scores on a voided activity succeeded').toBe(true);
  });

  it('SYS-PLT-006 scoreboard totals ignore voided activities; stale edits rejected', async () => {
    const sb0 = await pl.scoreboard(2026);
    const t0 = sb0.ranking.find((r) => r.id === P2)?.total ?? 0;
    const a = await pl.createActivity(offMgr, { name: 'qa.sys stale', activityDate: '2026-01-04', scores: [{ platoonId: P2, points: 7 }] }, M());
    expect((await pl.scoreboard(2026)).ranking.find((r) => r.id === P2)!.total).toBe(t0 + 7);
    expect(await code(pl.updateActivity(offMgr, a.id, { name: 'x', activityDate: '2026-01-04', scores: [{ platoonId: P2, points: 8 }], expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }, M()))).toBe('CONFLICT');
    await pl.voidActivity(offMgr, a.id, { reason: 'qa' }, M());
    expect((await pl.scoreboard(2026)).ranking.find((r) => r.id === P2)!.total).toBe(t0);
    expect(await code(pl.updateActivity(offMgr, 'not-a-uuid', { name: 'x', activityDate: '2026-01-04', scores: [{ platoonId: P2, points: 8 }] }, M()))).toBe('NOT_FOUND');
  });

  it('SYS-PLT-007 names: length, duplicates, Officer section, deactivate in-use', async () => {
    expect(await code(pl.createPlatoon(offMgr, { sectionId: SA, name: 'x'.repeat(41) }, M()))).toBe('VALIDATION');
    expect(await code(pl.createPlatoon(offMgr, { sectionId: SA, name: '   ' }, M()))).toBe('VALIDATION');
    const p1 = (await db.select().from(platoons).where(eq(platoons.id, P1)))[0];
    expect(await code(pl.createPlatoon(offMgr, { sectionId: SA, name: p1.name.toUpperCase() }, M()))).toBe('VALIDATION');
    expect(await code(pl.createPlatoon(offMgr, { sectionId: org.officer, name: 'qa.sys.o' + rand(5) }, M()))).toBe('VALIDATION');
    expect(await code(pl.updatePlatoon(offMgr, P1, { isActive: false }, M()))).toBe('VALIDATION');
    expect(await code(pl.updatePlatoon(offMgr, P1, { isActive: 'false' }, M()))).toBe('VALIDATION');
  });
});

// ───────────────────────── E. Passwords ─────────────────────────
describe('System / password policy', () => {
  it('SYS-PWD-001 min length 8 at every entry point', async () => {
    expect(checkPasswordPolicy('Ab-1234')).not.toBeNull();
    expect(checkPasswordPolicy('Ab-12345')).toBeNull();
    expect(await code(createUser(captain, validCreate({ username: 'qa.sys.pw' + rand(5), sectionId: SB, rankId: RB, tempPassword: 'Ab-1234', guardians: GUARD }), M()))).toBe('VALIDATION');
    expect(await code(resetPassword(captain, mB.id, { password: 'Ab-1234', reason: 'qa' }, M()))).toBe('VALIDATION');
  });

  it('SYS-PWD-002 own IC (plain and dashed) rejected as new password', async () => {
    const ic = ic12();
    const u = await mk('pwic', { sectionId: SB, rankId: RB, ic });
    const r1 = await ex(changeOwnPassword(u, PW, ic, M()));
    expect(r1.fe?.next).toBe('Password must not match your username or ID.');
    const dashed = `${ic.slice(0, 6)}-${ic.slice(6, 8)}-${ic.slice(8)}`;
    const r2 = await ex(changeOwnPassword(u, PW, dashed, M()));
    if (r2.ok) await db.update(users).set({ passwordHash: pwHash }).where(eq(users.id, u.id));
    expect(r2.ok, 'dashed own IC accepted as password').toBe(false);
  });

  it('SYS-PWD-003 common-list coverage (informational)', () => {
    const weak = ['qwerty123', '22222222', 'abcdefgh', 'password!', 'Passw0rd'];
    const accepted = weak.filter((p) => checkPasswordPolicy(p) === null);
    expect(accepted.length, `weak 8-char passwords accepted: ${accepted.join(', ')}`).toBe(0);
  });
});

// ───────────────────────── F. Static ─────────────────────────
describe('System / static', () => {
  const walk = (dir: string, out: string[] = []) => {
    for (const f of readdirSync(dir)) {
      const p = path.join(dir, f);
      if (f === 'node_modules' || f === '.next') continue;
      statSync(p).isDirectory() ? walk(p, out) : /\.(ts|tsx)$/.test(f) && out.push(p);
    }
    return out;
  };
  it('SYS-STATIC-001 no raw HTML sinks; platoon actions all go through the service guards', () => {
    for (const f of walk(path.join(ROOT, 'app'))) expect(readFileSync(f, 'utf8'), f).not.toMatch(/dangerouslySetInnerHTML/);
    const svc = readFileSync(path.join(ROOT, 'lib/server/platoons/service.ts'), 'utf8');
    for (const fn of ['createPlatoon', 'updatePlatoon', 'movePlatoon', 'getPlatoon', 'assignMembers', 'removeMembers', 'setPlatoonLeaders']) {
      expect(svc).toMatch(new RegExp(`function ${fn}\\([^]*?\\{\\s*await assertPlatoonManager\\(actor\\)`));
    }
    for (const fn of ['createActivity', 'updateActivity', 'voidActivity']) expect(svc).toMatch(new RegExp(`function ${fn}\\([^]*?\\{\\s*await assertScorer\\(actor\\)`));
  });
});
