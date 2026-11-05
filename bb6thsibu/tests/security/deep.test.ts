// Deep adversarial security test 2026-11-04 (SEC-DEEP-*).
// Calls the real server actions (with a forged/minted session cookie) and services directly, like an attacker
// POSTing crafted arguments. Uses its own sections/platoons (qa.deep.*) and users (qa.deep.*); never touches real data
// except reading the Captain / Superadmin rows. Tests assert SECURE behaviour: a failing test is a candidate finding.
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('next/headers', async () => (await import('./ctx')).headersMock);
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/server/request', async () => (await import('./ctx')).requestMock);

import { randomUUID } from 'node:crypto';
import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  auditLogs, permissionChangeRequests, platoonActivities, platoons, rankHistory, rankPermissions, ranks, roles, sessions, users, userPermissionOverrides, userRoles,
} from '@/lib/db/schema';
import { ALL_PERMISSIONS, type PermissionSlug } from '@/lib/server/authz/catalog';
import { loadPermissions, memberScope } from '@/lib/server/authz';
import * as acc from '@/lib/server/access/service';
import * as orgSvc from '@/lib/server/org/service';
import * as pl from '@/lib/server/platoons/service';
import * as us from '@/lib/server/users/service';
import { getOwnProfile } from '@/lib/server/users/profile';
import { allowCaptainChange, appointFirstCaptain } from '@/lib/server/captain';
import { login } from '@/lib/server/auth/login';
import { hashPassword } from '@/lib/server/auth/password';
import * as accessA from '@/app/actions/access';
import * as authA from '@/app/actions/auth';
import * as orgA from '@/app/actions/org';
import * as plA from '@/app/actions/platoons';
import * as usersA from '@/app/actions/users';
import { ctx, resetCtx } from './ctx';
import { closeDb, loadCU, meta, mint, orgIds, rand, reasonId, probe, userRow, validCreate } from './fixtures';

type CU = Awaited<ReturnType<typeof loadCU>>;
const PW = 'QaDeep-Pass-2026-x9';
const PW2 = 'QaDeep-Next-2026-y7';
const M = () => meta('deep');
const GUARD = [{ name: 'QA Guardian', relationship: 'father', phone: '+60111222333', email: '' }];
const ic12 = () => '0' + Array.from({ length: 11 }, () => Math.floor(Math.random() * 10)).join('');
const DENIED = ['FORBIDDEN', 'NOT_FOUND', 'REDIRECT:/login'];

/** Service call → 'OK' | AppError code | 'THROW:<msg>' */
const ex = async (p: Promise<unknown>): Promise<any> => {
  try { return { ok: true, code: 'OK', v: await p }; } catch (e: any) {
    const isApp = typeof e?.code === 'string' && /^[A-Z_]+$/.test(e.code);
    return { ok: false, code: isApp ? e.code : /deadlock/i.test(String(e?.cause?.message ?? e?.message)) ? 'DEADLOCK' : 'THROW', message: String(e?.message), fe: e?.fieldErrors };
  }
};
const code = async (p: Promise<unknown>) => (await ex(p)).code;

/** Action call as `who` (null = no cookie). Returns normalised outcome + raw result. */
async function act(who: CU | null, fn: () => Promise<unknown>): Promise<{ out: string; r?: any }> {
  ctx.token = who ? await mint(who.id) : undefined;
  try {
    const r: any = await fn();
    if (r && typeof r === 'object' && 'ok' in r) return { out: r.ok ? 'OK' : r.code, r };
    return { out: 'OK', r };
  } catch (e: any) {
    const d = String(e?.digest ?? '');
    if (d.startsWith('NEXT_REDIRECT')) return { out: 'REDIRECT:' + d.split(';')[2] };
    return { out: 'THROW:' + String(e?.message).slice(0, 80) };
  }
}

let captain: CU, sa: CU, org: Awaited<ReturnType<typeof orgIds>>;
let SA = 0, SB = 0, RA = 0, RA2 = 0, RB = 0, RB2 = 0, RICH = 0, P1 = 0, P2 = 0, ROLE = 0, ROLE_AUDIT = 0;
let low: CU, xsec: CU, xplt: CU, ofo: CU, allS: CU, offAll: CU, offPlain: CU, offPlain2: CU, offMgr: CU, offDel: CU, offCR: CU, del: CU, noSens: CU;
let mP1: CU, mP2: CU, mB: CU, mB2: CU, mB_IC = '';
let REQ = '', ACT = '';
const created: string[] = [];
let pwHash: string | undefined;
let firstOfficerRank = 0;

async function setOv(userId: string, slug: PermissionSlug, effect: 'allow' | 'deny' = 'allow') {
  await db.insert(userPermissionOverrides).values({ userId, permissionSlug: slug, effect, reason: 'qa.deep' })
    .onConflictDoUpdate({ target: [userPermissionOverrides.userId, userPermissionOverrides.permissionSlug], set: { effect } });
}
async function mk(tag: string, o: { sectionId: number; rankId: number; platoonId?: number; perms?: readonly PermissionSlug[]; ic?: string; officer?: boolean; fullName?: string }): Promise<CU> {
  const username = `qa.deep.${tag}${rand(5)}`;
  const r = await us.createUser(captain, validCreate({
    username, sectionId: o.sectionId, rankId: o.rankId, platoonId: o.platoonId, guardians: o.officer ? [] : GUARD,
    idType: o.ic ? 'mykad' : 'none', idNumber: o.ic, fullName: o.fullName ?? `QA Deep ${tag}`,
  }), M());
  pwHash ??= await hashPassword(PW);
  await db.update(users).set({ mustChangePassword: false, passwordHash: pwHash }).where(eq(users.id, r!.id));
  for (const p of o.perms ?? []) await setOv(r!.id, p);
  created.push(r!.id);
  return loadCU(username);
}
const mkOff = (tag: string, perms: readonly PermissionSlug[] = []) => mk(tag, { sectionId: org.officer, rankId: firstOfficerRank, officer: true, perms });
const snap = async (id: string) => {
  const u = await userRow(id);
  return { st: u.status, rk: u.rankId, sec: u.sectionId, pl: u.platoonId, role: u.platoonRole, pw: u.passwordHash, up: u.updatedAt.toISOString(), em: u.email, un: u.username };
};

beforeAll(async () => {
  captain = await loadCU('dev.captain');
  sa = await loadCU('superadmin');
  org = await orgIds();
  firstOfficerRank = org.rk('Officer', 'Helper');
  SA = (await orgSvc.createSection(captain, { name: `qa.deep.sa${rand(6)}` }, M()))!.id;
  SB = (await orgSvc.createSection(captain, { name: `qa.deep.sb${rand(6)}` }, M()))!.id;
  RA = (await orgSvc.createRank(captain, { sectionId: SA, name: 'qa.member' }, M()))!.id;
  RA2 = (await orgSvc.createRank(captain, { sectionId: SA, name: 'qa.member2' }, M()))!.id;
  RB = (await orgSvc.createRank(captain, { sectionId: SB, name: 'qa.member' }, M()))!.id;
  RB2 = (await orgSvc.createRank(captain, { sectionId: SB, name: 'qa.member2' }, M()))!.id;
  RICH = (await orgSvc.createRank(captain, { sectionId: SB, name: 'qa.rich' }, M()))!.id;
  await acc.saveRankAccess(captain, RICH, { permissions: ['users.update_status', 'users.view', 'audit.view'] }, M());
  P1 = (await pl.createPlatoon(captain, { sectionId: SA, name: `qa.deep.p1.${rand(6)}` }, M()))!.id;
  P2 = (await pl.createPlatoon(captain, { sectionId: SA, name: `qa.deep.p2.${rand(6)}` }, M()))!.id;
  ROLE = Number((await acc.saveRole(captain, null, { name: `qa.deep.role.${rand(6)}`, description: null, isActive: true, permissions: ['users.view'] }, M())).targetId);
  ROLE_AUDIT = Number((await acc.saveRole(captain, null, { name: `qa.deep.ra.${rand(6)}`, description: null, isActive: true, permissions: ['users.view', 'audit.view'] }, M())).targetId);

  const USERS: PermissionSlug[] = ['users.view', 'users.create', 'users.update', 'users.update_status', 'users.view_sensitive'];
  const OFFONLY: PermissionSlug[] = ['users.change_rank', 'users.reset_password', 'platoons.manage', 'platoons.score'];
  mP1 = await mk('mp1', { sectionId: SA, rankId: RA, platoonId: P1 });
  mP2 = await mk('mp2', { sectionId: SA, rankId: RA, platoonId: P2 });
  mB_IC = ic12();
  mB = await mk('mb', { sectionId: SB, rankId: RB, ic: mB_IC, fullName: 'QA Deep 100% Sure_x\\y' });
  mB2 = await mk('mb2', { sectionId: SB, rankId: RB });
  low = await mk('low', { sectionId: SA, rankId: RA, platoonId: P1 });
  xsec = await mk('xsec', { sectionId: SB, rankId: RB, perms: USERS });
  xplt = await mk('xplt', { sectionId: SA, rankId: RA, platoonId: P1, perms: USERS });
  ofo = await mk('ofo', { sectionId: SB, rankId: RB, perms: [...OFFONLY, 'users.view'] });
  allS = await mk('alls', { sectionId: SB, rankId: RB, perms: ['users.view', 'users.all_sections', 'users.update', 'users.update_status'] });
  del = await mk('del', { sectionId: SB, rankId: RB, perms: ['permissions.manage', 'users.view'] });
  noSens = await mk('nos', { sectionId: SB, rankId: RB, perms: ['users.view', 'users.update', 'audit.view'] });
  offAll = await mkOff('offall', ALL_PERMISSIONS);
  offPlain = await mkOff('offp');
  offPlain2 = await mkOff('offp2');
  offMgr = await mkOff('offm', ['platoons.manage', 'platoons.score', 'users.view']);
  offDel = await mkOff('offdel', ['permissions.manage', 'users.view', 'users.update']);
  offCR = await mkOff('offcr', ['users.view', 'users.create', 'users.reset_password', 'users.change_rank']);
  REQ = (await acc.saveUserAccess(del, mB2.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow' }] }, M()) as any).requestId;
  ACT = (await pl.createActivity(captain, { name: 'qa.deep act', activityDate: '2026-01-02', scores: [{ platoonId: P1, points: 5 }] }, M())).id;
}, 300000);
beforeEach(() => resetCtx());
afterAll(async () => {
  try {
    const open = await db.select({ id: permissionChangeRequests.id }).from(permissionChangeRequests)
      .where(and(eq(permissionChangeRequests.status, 'pending'), inArray(permissionChangeRequests.requestedBy, created)));
    for (const r of open) await acc.decideRequest(captain, r.id, 'reject', 'qa cleanup', M()).catch(() => {});
    const rid = await reasonId();
    for (const id of created) await us.setStatus(captain, id, { status: 'inactive', reasonId: rid }, M()).catch(() => {});
    await db.update(users).set({ platoonId: null, platoonRole: null }).where(inArray(users.id, created));
    for (const p of [P1, P2]) await pl.updatePlatoon(captain, p, { isActive: false }, M()).catch(() => {});
    await acc.saveRankAccess(captain, RICH, { permissions: [] }, M()).catch(() => {});
    const extraRoles = (await db.select({ id: roles.id }).from(roles).where(and(sql`${roles.name} like 'qa.deep.%'`, eq(roles.isActive, true)))).map((r) => r.id);
    for (const r of [...new Set([ROLE, ROLE_AUDIT, ...extraRoles])]) {
      const g = await acc.getRole(r);
      if (g?.isActive) await acc.saveRole(captain, r, { name: g.name, description: null, isActive: false, permissions: g.permissions }, M()).catch(() => {});
    }
  } catch {}
  await db.execute(sql`update sessions set revoked_at = now() where revoked_at is null and ip = 'qa-mint'`);
  await closeDb();
});

// ───────────────────────── 1. Every server action × attacker ─────────────────────────
type Atk = { name: string; who: () => CU | null; T: () => string; sec: () => number; rank: () => number; rank2: () => number; plt: () => number | undefined };
const ATTACKERS: Atk[] = [
  { name: 'no session', who: () => null, T: () => mP1.id, sec: () => SA, rank: () => RA, rank2: () => RA2, plt: () => P1 },
  { name: 'low-rank member (no perms)', who: () => low, T: () => mP1.id, sec: () => SA, rank: () => RA, rank2: () => RA2, plt: () => P1 },
  { name: 'member of another section', who: () => xsec, T: () => mP1.id, sec: () => SA, rank: () => RA, rank2: () => RA2, plt: () => P1 },
  { name: 'member of another platoon', who: () => xplt, T: () => mP2.id, sec: () => SA, rank: () => RA, rank2: () => RA2, plt: () => P2 },
  { name: 'non-officer ALLOWed officer-only', who: () => ofo, T: () => mB.id, sec: () => SB, rank: () => RB, rank2: () => RB2, plt: () => undefined },
];

function calls(a: Atk): [string, () => Promise<unknown>][] {
  const T = a.T();
  const n = 'qa.deep.x' + rand(6);
  const cur = { username: '', email: 'qa@example.test', fullName: 'Hijacked', gender: 'male', dateOfBirth: '2012-05-05', joinDate: '2022-01-01', phone: '', guardians: GUARD } as any;
  return [
    ['saveRoleAction(new)', () => accessA.saveRoleAction(null, { name: n, description: '', isActive: true, permissions: ['users.view'] })],
    ['saveRoleAction(existing)', () => accessA.saveRoleAction(ROLE, { name: n, description: '', isActive: true, permissions: ['users.view', 'audit.view'] })],
    ['saveRankAccessAction', () => accessA.saveRankAccessAction(a.rank(), { permissions: ['users.view'] })],
    ['saveUserAccessAction', () => accessA.saveUserAccessAction(T, { roleIds: [ROLE], overrides: [{ slug: 'users.view', effect: 'allow' }] })],
    ['decideRequestAction', () => accessA.decideRequestAction(REQ, 'approve')],
    ['cancelRequestAction', () => accessA.cancelRequestAction(REQ)],
    ['createSectionAction', () => orgA.createSectionAction(n)],
    ['createRankAction', () => orgA.createRankAction(a.sec(), n)],
    ['updateOrgItemAction', () => orgA.updateOrgItemAction('section', a.sec(), { isActive: false })],
    ['moveOrgItemAction', () => orgA.moveOrgItemAction('rank', a.rank(), 'up')],
    ['createPlatoonAction', () => plA.createPlatoonAction(SA, n)],
    ['updatePlatoonAction', () => plA.updatePlatoonAction(P1, { name: n })],
    ['movePlatoonAction', () => plA.movePlatoonAction(P1, 'down')],
    ['assignMembersAction', () => plA.assignMembersAction(P2, [mP1.id])],
    ['removeMembersAction', () => plA.removeMembersAction(P1, [mP1.id])],
    ['setLeadersAction', () => plA.setLeadersAction(P1, mP1.id, null)],
    ['saveActivityAction(new)', () => plA.saveActivityAction(null, { name: 'x', activityDate: '2026-01-01', note: '', scores: [{ platoonId: P1, points: '999' }] })],
    ['saveActivityAction(edit)', () => plA.saveActivityAction(ACT, { name: 'x', activityDate: '2026-01-01', note: '', scores: [{ platoonId: P1, points: '999' }] })],
    ['voidActivityAction', () => plA.voidActivityAction(ACT, 'qa')],
    ['createUserAction', () => usersA.createUserAction(validCreate({ username: n, sectionId: a.sec(), rankId: a.rank(), platoonId: a.plt(), guardians: GUARD, tempPassword: PW }))],
    ['updateUserAction', async () => { cur.username = (await userRow(T)).username; return usersA.updateUserAction(T, cur); }],
    ['promoteAction', () => usersA.promoteAction({ userIds: [T], sectionId: a.sec(), rankId: a.rank2(), reason: 'qa' })],
    ['setStatusAction', async () => usersA.setStatusAction(T, { status: 'inactive', reasonId: await reasonId() })],
    ['resetPasswordAction', () => usersA.resetPasswordAction(T, { reason: 'qa', password: PW2 })],
    ['appointCaptainAction', () => usersA.appointCaptainAction(offPlain.id)],
  ];
}

describe('Deep / 1. action authorization matrix', () => {
  ATTACKERS.forEach((a, i) => {
    it(`SEC-DEEP-00${i + 1} every server action refuses: ${a.name}`, async () => {
      const start = new Date(Date.now() - 1000);
      const watch = [mP1.id, mP2.id, mB.id, mB2.id, offPlain.id, captain.id];
      const before = await Promise.all(watch.map(snap));
      const bad: string[] = [];
      for (const [name, fn] of calls(a)) {
        const { out, r } = await act(a.who(), fn);
        const ok = a.who() === null ? out === 'REDIRECT:/login' : DENIED.includes(out);
        if (!ok) bad.push(`${name} -> ${out}`);
        if (r && r.ok === false && /select|insert|update |failed query|violates/i.test(String(r.message))) bad.push(`${name} leaks DB text`);
        if (r?.data) bad.push(`${name} returned data`);
      }
      expect(bad, bad.join('; ')).toEqual([]);
      expect(await Promise.all(watch.map(snap))).toEqual(before);
      const [req] = await db.select().from(permissionChangeRequests).where(eq(permissionChangeRequests.id, REQ));
      expect(req.status).toBe('pending');
      const [a1] = await db.select().from(platoonActivities).where(eq(platoonActivities.id, ACT));
      expect(a1.voidedAt).toBeNull();
      if (a.who()) {
        const writes = await db.select({ action: auditLogs.action }).from(auditLogs)
          .where(and(eq(auditLogs.actorId, a.who()!.id), gte(auditLogs.createdAt, start), sql`${auditLogs.action} not in ('LOGIN','LOGOUT','VIEW_SENSITIVE')`));
        expect(writes.map((w) => w.action)).toEqual([]);
      }
    });
  });

  it('SEC-DEEP-006 unauthenticated auth/profile actions and forged cookies', async () => {
    expect((await act(null, () => usersA.updateProfileAction({ email: 'a@b.co', guardians: [] } as any))).out).toBe('REDIRECT:/login');
    expect((await act(null, () => authA.changePasswordAction({ current: PW, next: PW2, confirm: PW2 }))).out).toBe('REDIRECT:/login');
    expect((await act(null, () => authA.logoutAction())).out).toBe('REDIRECT:/login');
    // forged / malformed cookies
    for (const t of ['x', 'a'.repeat(101), '', "' or 1=1 --", randomUUID(), '\u0000abc', 'ﾠ'.repeat(40)]) {
      ctx.token = t;
      let out = '';
      try { const r: any = await usersA.setStatusAction(mB.id, { status: 'inactive', reasonId: 1 }); out = r.ok ? 'OK' : r.code; } catch (e: any) { out = String(e?.digest ?? e?.message); }
      expect(out, `cookie ${JSON.stringify(t).slice(0, 20)}`).toContain('/login');
    }
  });
});

// ───────────────────────── 2. Mass assignment ─────────────────────────
describe('Deep / 2. mass assignment', () => {
  const EXTRA = (o: Record<string, unknown> = {}) => ({
    rankId: org.captainRankId, sectionId: org.officer, platoonId: P2, status: 'inactive', isCaptain: true, passwordHash: 'x', password_hash: 'x',
    platoonRole: 'leader', accountType: 'superadmin', mustChangePassword: true, inactiveReasonId: 1, idNumberHash: 'x', idNumberEnc: 'x',
    createdBy: captain.id, updatedBy: captain.id, failedLoginCount: 99, lockedUntil: new Date(Date.now() + 1e9), __proto__: { admin: true }, ...o,
  });

  it('SEC-DEEP-010 updateProfileAction ignores identity/privilege fields', async () => {
    const b = await userRow(low.id);
    const { out } = await act(low, () => usersA.updateProfileAction({ email: 'qa.deep@example.test', phone: '', address: 'addr', school: '', guardians: GUARD, ...EXTRA({ id: mP1.id, userId: mP1.id, fullName: 'Pwned', username: 'qa.deep.pwned' }) } as any));
    expect(out).toBe('OK');
    const a = await userRow(low.id);
    for (const k of ['rankId', 'sectionId', 'platoonId', 'status', 'passwordHash', 'platoonRole', 'accountType', 'mustChangePassword', 'fullName', 'username', 'idNumberHash', 'failedLoginCount', 'lockedUntil', 'createdBy'] as const) {
      expect(a[k], k).toEqual(b[k]);
    }
    expect(a.address).toBe('addr');
    expect((await userRow(mP1.id)).email).not.toBe('qa.deep@example.test');
  });

  it('SEC-DEEP-011 updateUserAction ignores rank/section/status/password/platoonRole/accountType', async () => {
    const b = await userRow(mB.id);
    const { out } = await act(xsec, () => usersA.updateUserAction(mB.id, {
      username: b.username, email: b.email, fullName: b.fullName, gender: b.gender, dateOfBirth: b.dateOfBirth, joinDate: b.joinDate, phone: b.phone ?? '',
      guardians: GUARD, ...EXTRA({ id: randomUUID(), platoonId: undefined }),
    } as any));
    expect(out).toBe('OK');
    const a = await userRow(mB.id);
    for (const k of ['id', 'rankId', 'sectionId', 'platoonId', 'status', 'passwordHash', 'platoonRole', 'accountType', 'mustChangePassword', 'idNumberHash', 'idNumberEnc', 'failedLoginCount', 'inactiveReasonId', 'createdBy'] as const) {
      expect(a[k], k).toEqual(b[k]);
    }
    // a non-officer sending platoonId is refused, not applied
    const r = await act(xplt, async () => usersA.updateUserAction(mP1.id, { username: (await userRow(mP1.id)).username, email: 'qa@example.test', fullName: 'x', gender: 'male', dateOfBirth: '2012-05-05', joinDate: '2022-01-01', guardians: GUARD, platoonId: P2 } as any));
    expect(r.out).toBe('FORBIDDEN');
    expect((await userRow(mP1.id)).platoonId).toBe(P1);
  });

  it('SEC-DEEP-012 createUserAction ignores id/accountType/status/passwordHash/mustChange/platoonRole/createdBy', async () => {
    const forcedId = randomUUID();
    const username = 'qa.deep.ma' + rand(6);
    const { out, r } = await act(xsec, () => usersA.createUserAction({ ...validCreate({ username, sectionId: SB, rankId: RB, guardians: GUARD, tempPassword: PW }), ...EXTRA({ id: forcedId, sectionId: SB, rankId: RB, platoonId: undefined, mustChangePassword: false }) } as any));
    expect(out).toBe('OK');
    created.push(r.data.id);
    expect(r.data.id).not.toBe(forcedId);
    const u = await userRow(r.data.id);
    expect(u.accountType).toBe('member');
    expect(u.status).toBe('active');
    expect(u.passwordHash).toMatch(/^\$argon2/);
    expect(u.mustChangePassword).toBe(true);
    expect(u.platoonRole).toBeNull();
    expect(u.createdBy).toBe(xsec.id);
    expect(u.failedLoginCount).toBe(0);
    expect(await loadPermissions(u.id)).toEqual(new Set());
  });

  it('SEC-DEEP-013 platoon / access actions ignore smuggled fields', async () => {
    const before = await db.select().from(platoons).where(eq(platoons.id, P1));
    const r1 = await act(offMgr, () => plA.updatePlatoonAction(P1, { name: before[0].name, isActive: true, sectionId: SB, sortOrder: -5, id: P2 } as any));
    expect(r1.out).toBe('VALIDATION'); // "Nothing has changed" — smuggled fields are not even considered
    const after = await db.select().from(platoons).where(eq(platoons.id, P1));
    expect(after).toEqual(before);
    // userIds as objects carrying a role
    const r2 = await act(offMgr, () => plA.assignMembersAction(P1, [{ id: mP2.id, platoonRole: 'leader' }] as any));
    expect(r2.out).toBe('NOT_FOUND');
    // access: delegate smuggles setBy / status / requestedBy into a request
    const r3 = await act(offDel, () => accessA.saveUserAccessAction(offPlain2.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow', setBy: captain.id, status: 'approved' } as any], requestedBy: captain.id, status: 'approved' } as any));
    expect(r3.out).toBe('OK');
    expect(r3.r.data.status).toBe('pending');
    const [req] = await db.select().from(permissionChangeRequests).where(and(eq(permissionChangeRequests.targetId, offPlain2.id), eq(permissionChangeRequests.status, 'pending')));
    expect(req.requestedBy).toBe(offDel.id);
    expect(JSON.stringify(req.changes)).not.toContain(captain.id);
    expect((await loadPermissions(offPlain2.id)).has('users.view')).toBe(false);
    await acc.cancelRequest(offDel, req.id, M());
  });
});

// ───────────────────────── 3. Malformed input fuzzing ─────────────────────────
describe('Deep / 3. fuzzing', () => {
  const NASTY: unknown[] = [-1, 0, 1.5, NaN, Infinity, 1e21, 2 ** 31, '1; drop table users', "' or 1=1 --", 'x'.repeat(10000), '\u0000', [1, 2], {}, null, true, '١'];
  const leaky = (r: any) => r && r.ok === false && /select .* from|insert into|failed query|violates|syntax error|column "|relation "/i.test(String(r.message));

  it('SEC-DEEP-020 numeric ids: platoon/org/rank actions never succeed or leak with garbage ids', async () => {
    const bad: string[] = [];
    // `true` / [n] would coerce to a REAL small id (e.g. 1) and could touch real data, so they are excluded here
    for (const v of NASTY.filter((x) => x !== true)) {
      for (const [name, fn, who] of [
        ['updatePlatoon', () => plA.updatePlatoonAction(v as any, { name: 'qa.deep.fz' + rand(5) }), offMgr],
        ['movePlatoon', () => plA.movePlatoonAction(v as any, 'up'), offMgr],
        ['assign', () => plA.assignMembersAction(v as any, [mP1.id]), offMgr],
        ['leaders', () => plA.setLeadersAction(v as any, null, null), offMgr],
        ['createPlatoon', () => plA.createPlatoonAction(v as any, 'qa.deep.fz' + rand(5)), offMgr],
        ['rankAccess', () => accessA.saveRankAccessAction(v as any, { permissions: ['users.view'] }), captain],
        // roleId null legitimately means "new role", so it is not garbage for saveRole
        ['saveRole', () => (v === null ? Promise.resolve({ ok: false, code: 'SKIP' }) : accessA.saveRoleAction(v as any, { name: 'qa.deep.fz' + rand(5), description: '', isActive: true, permissions: [] })), captain],
        ['updateOrg', () => orgA.updateOrgItemAction('rank', v as any, { name: 'qa.deep.fz' }), captain],
        ['createRank', () => orgA.createRankAction(v as any, 'qa.deep.fz' + rand(5)), captain],
      ] as [string, () => Promise<unknown>, CU][]) {
        // [1,2] / true / '١' coerce to an invalid or out-of-range id; only `[P1]`-style arrays could coerce to a real id
        const { out, r } = await act(who, fn);
        if (out === 'OK' || out.startsWith('THROW') || leaky(r)) bad.push(`${name}(${JSON.stringify(v)?.slice(0, 15)}) -> ${out}`);
      }
    }
    expect(bad, bad.join('; ')).toEqual([]);
  });

  it('SEC-DEEP-021 uuid ids: user/request/activity actions reject garbage ids as NOT_FOUND/VALIDATION', async () => {
    const bad: string[] = [];
    const ids: unknown[] = [...NASTY, randomUUID().toUpperCase(), mB.id + '\u0000', ` ${mB.id}`, mB.id.replace(/-/g, ''), `${mB.id}' or '1'='1`, '00000000-0000-0000-0000-000000000000'];
    const rid = await reasonId();
    for (const v of ids) {
      for (const [name, fn] of [
        ['update', () => usersA.updateUserAction(v as any, { username: 'qa.deep.zz', email: 'a@b.co', fullName: 'x', gender: 'male', dateOfBirth: '2012-05-05', joinDate: '2022-01-01', guardians: [] } as any)],
        ['status', () => usersA.setStatusAction(v as any, { status: 'inactive', reasonId: rid })],
        ['reset', () => usersA.resetPasswordAction(v as any, { reason: 'x' })],
        ['access', () => accessA.saveUserAccessAction(v as any, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow' }] })],
        ['decide', () => accessA.decideRequestAction(v as any, 'reject', 'n')],
        ['cancel', () => accessA.cancelRequestAction(v as any)],
        ['void', () => plA.voidActivityAction(v as any, 'x')],
        ['captain', () => usersA.appointCaptainAction(v as any)],
      ] as [string, () => Promise<unknown>][]) {
        // offAll holds every permission (officer); captain for decide
        const { out, r } = await act(name === 'decide' ? captain : name === 'captain' ? sa : offAll, fn);
        const okSet = ['NOT_FOUND', 'VALIDATION', 'FORBIDDEN', 'CONFLICT'];
        if (!okSet.includes(out) || leaky(r)) bad.push(`${name}(${JSON.stringify(v)?.slice(0, 20)}) -> ${out}`);
      }
    }
    expect(bad, bad.join('; ')).toEqual([]);
  });

  it('SEC-DEEP-022 search: LIKE wildcards are literal, long/unicode/SQL text is safe', async () => {
    const scope = await memberScope(xsec); // SB only
    const names = async (q: string) => (await us.listUsers({ q, status: 'all', pageSize: 100 }, { canSearchIc: false, scope })).rows;
    const pct = await names('%');
    expect(pct.length).toBeGreaterThan(0);
    expect(pct.every((r) => r.fullName.includes('%') || r.username.includes('%'))).toBe(true);
    const und = await names('_');
    expect(und.every((r) => r.fullName.includes('_') || r.username.includes('_'))).toBe(true);
    const bs = await names('\\');
    expect(bs.every((r) => r.fullName.includes('\\') || r.username.includes('\\'))).toBe(true);
    expect((await names('100% Sure_x\\y')).map((r) => r.id)).toEqual([mB.id]);
    expect((await names('1__% S')).length).toBe(0);
    for (const q of ["' or 1=1 --", 'x'.repeat(10000), '‮́😀', '%%%%' + 'a'.repeat(200), '[a-z]*', '.*']) {
      const rows = await names(q);
      expect(rows.every((r) => r.sectionId === SB)).toBe(true);
    }
    // filters with garbage are ignored, never widen scope
    const r = await us.listUsers({ section: SA, rank: -1 as any, platoon: 1.5 as any, page: NaN as any, pageSize: 1e9 as any, status: 'all' }, { canSearchIc: false, scope });
    expect(r.rows.every((x) => x.sectionId === SB)).toBe(true);
    expect(r.total).toBe(0);
  });

  it('SEC-DEEP-023 [fixed] search with a NUL byte does not crash the member list', async () => {
    const scope = await memberScope(xsec);
    const r = await ex(us.listUsers({ q: 'qa\u0000deep' }, { canSearchIc: false, scope }));
    expect(r.code, `listUsers threw: ${r.message?.slice(0, 120)}`).toBe('OK');
  });

  it('SEC-DEEP-024 [fixed] NUL byte in a profile/user text field is a VALIDATION error, not a server error', async () => {
    const { out } = await act(low, () => usersA.updateProfileAction({ email: 'qa@example.test', phone: '', address: 'a\u0000b', school: '', guardians: GUARD } as any));
    expect(out).toBe('VALIDATION');
  });

  it('SEC-DEEP-025 long strings, unicode and type confusion in every text field', async () => {
    const L = 'x'.repeat(10000);
    const bad: string[] = [];
    const chk = async (name: string, who: CU, fn: () => Promise<unknown>, okSet = ['VALIDATION']) => {
      const { out, r } = await act(who, fn);
      if (!okSet.includes(out) || leaky(r)) bad.push(`${name} -> ${out}`);
    };
    await chk('profile email 10k', low, () => usersA.updateProfileAction({ email: L + '@a.co', guardians: [] } as any));
    await chk('profile 3 guardians', low, () => usersA.updateProfileAction({ email: 'a@b.co', guardians: [...GUARD, ...GUARD, ...GUARD] } as any));
    await chk('profile guardians object', low, () => usersA.updateProfileAction({ email: 'a@b.co', guardians: { 0: GUARD[0], length: 1 } } as any));
    await chk('profile email array', low, () => usersA.updateProfileAction({ email: ['a@b.co'], guardians: [] } as any));
    await chk('create fullName 10k', xsec, () => usersA.createUserAction(validCreate({ username: 'qa.deep.l' + rand(5), sectionId: SB, rankId: RB, fullName: L })));
    await chk('create username unicode', xsec, () => usersA.createUserAction(validCreate({ username: 'qa.deep.é' + rand(3), sectionId: SB, rankId: RB })));
    await chk('create username IC-like', xsec, () => usersA.createUserAction(validCreate({ username: '1234-5678-9012', sectionId: SB, rankId: RB })));
    await chk('create sectionId array', xsec, () => usersA.createUserAction(validCreate({ username: 'qa.deep.l' + rand(5), sectionId: [SB, SA], rankId: RB })));
    await chk('create tempPassword 129', xsec, () => usersA.createUserAction(validCreate({ username: 'qa.deep.l' + rand(5), sectionId: SB, rankId: RB, tempPassword: 'Aa1!'.repeat(33) })));
    await chk('reset reason 501', offAll, () => usersA.resetPasswordAction(mB2.id, { reason: 'r'.repeat(501) }));
    await chk('reset password object', offAll, () => usersA.resetPasswordAction(mB2.id, { reason: 'x', password: { toString: () => 'x' } } as any), ['VALIDATION', 'OK']);
    await chk('promote reason 10k', offAll, () => usersA.promoteAction({ userIds: [mB2.id], sectionId: SB, rankId: RB2, reason: L }));
    await chk('promote userIds string', offAll, () => usersA.promoteAction({ userIds: mB2.id as any, sectionId: SB, rankId: RB2, reason: 'x' }));
    await chk('promote 101 ids', offAll, () => usersA.promoteAction({ userIds: Array.from({ length: 101 }, () => randomUUID()), sectionId: SB, rankId: RB2, reason: 'x' }));
    await chk('promote rank NaN', offAll, () => usersA.promoteAction({ userIds: [mB2.id], sectionId: SB, rankId: NaN, reason: 'x' }));
    await chk('promote rank float', offAll, () => usersA.promoteAction({ userIds: [mB2.id], sectionId: SB, rankId: RB2 + 0.5, reason: 'x' }));
    await chk('assign 101 ids', offMgr, () => plA.assignMembersAction(P1, Array.from({ length: 101 }, () => randomUUID())));
    await chk('assign empty', offMgr, () => plA.assignMembersAction(P1, []));
    await chk('assign string', offMgr, () => plA.assignMembersAction(P1, mP2.id as any));
    await chk('activity 5000 dup scores', offMgr, () => plA.saveActivityAction(null, { name: 'x', activityDate: '2026-01-01', note: '', scores: Array.from({ length: 5000 }, () => ({ platoonId: P1, points: '1' })) }));
    await chk('activity name 10k', offMgr, () => plA.saveActivityAction(null, { name: L, activityDate: '2026-01-01', note: '', scores: [{ platoonId: P1, points: '1' }] }));
    await chk('activity points NaN', offMgr, () => plA.saveActivityAction(null, { name: 'x', activityDate: '2026-01-01', note: '', scores: [{ platoonId: P1, points: 'NaN' }] }));
    await chk('activity points 1e9', offMgr, () => plA.saveActivityAction(null, { name: 'x', activityDate: '2026-01-01', note: '', scores: [{ platoonId: P1, points: '1e9' }] }));
    await chk('activity date injection', offMgr, () => plA.saveActivityAction(null, { name: 'x', activityDate: "2026-01-01' or '1'='1", note: '', scores: [{ platoonId: P1, points: '1' }] }));
    await chk('void reason 501', offMgr, () => plA.voidActivityAction(ACT, 'r'.repeat(501)));
    await chk('role name 10k', captain, () => accessA.saveRoleAction(null, { name: L, description: '', isActive: true, permissions: [] }));
    await chk('role perms unknown', captain, () => accessA.saveRoleAction(null, { name: 'qa.deep.r' + rand(5), description: '', isActive: true, permissions: ['__proto__', 'constructor'] }));
    await chk('role isActive string', captain, () => accessA.saveRoleAction(ROLE, { name: 'x', description: '', isActive: 'false' as any, permissions: [] }));
    await chk('access dup overrides', offAll, () => accessA.saveUserAccessAction(mB2.id, { roleIds: [], overrides: Array.from({ length: 10000 }, () => ({ slug: 'users.view', effect: 'allow' })) }));
    await chk('access role 1.5', offAll, () => accessA.saveUserAccessAction(mB2.id, { roleIds: [1.5], overrides: [] }));
    await chk('access role huge', offAll, () => accessA.saveUserAccessAction(mB2.id, { roleIds: [99999], overrides: [] }));
    await chk('access effect bogus', offAll, () => accessA.saveUserAccessAction(mB2.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'ALLOW' }] }));
    await chk('access reason 501', offAll, () => accessA.saveUserAccessAction(mB2.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow', reason: 'r'.repeat(501) }] }));
    await chk('decide bogus', captain, () => accessA.decideRequestAction(REQ, 'APPROVE' as any));
    await chk('org kind bogus', captain, () => orgA.updateOrgItemAction('user' as any, 1, { name: 'x' }), ['SERVER', 'VALIDATION', 'NOT_FOUND']);
    await chk('status bogus', offAll, () => usersA.setStatusAction(mB2.id, { status: 'deleted' as any }), ['SERVER', 'VALIDATION']);
    await chk('status reason float', offAll, () => usersA.setStatusAction(mB2.id, { status: 'inactive', reasonId: 1.5 }));
    expect(bad, bad.join('; ')).toEqual([]);
    expect((await userRow(mB2.id)).status).toBe('active');
    // the "reset password object" probe may have reset mB2; restore known state
    await db.update(users).set({ passwordHash: pwHash, mustChangePassword: false }).where(eq(users.id, mB2.id));
  });

  it('SEC-DEEP-026 [fixed] changePasswordAction with a non-object body returns an ActionResult instead of throwing', async () => {
    const { out } = await act(low, () => authA.changePasswordAction(null as any));
    expect(out).toBe('VALIDATION');
  });

  it('SEC-DEEP-027 duplicate ids in batch ops are applied once', async () => {
    const t = await mk('dup', { sectionId: SB, rankId: RB });
    const { out, r } = await act(offAll, () => usersA.promoteAction({ userIds: [t.id, t.id, t.id.toUpperCase(), t.id], sectionId: SB, rankId: RB2, reason: 'qa dup' }));
    // upper-case variant is the same uuid for Postgres: must not be applied twice
    expect(['OK', 'VALIDATION']).toContain(out);
    const hist = await db.select().from(rankHistory).where(and(eq(rankHistory.userId, t.id), eq(rankHistory.toRankId, RB2)));
    expect(hist.length).toBeLessThanOrEqual(1);
    if (out === 'OK') expect(r.data.count).toBeLessThanOrEqual(2);
    const a = await act(offMgr, () => plA.assignMembersAction(P1, [mP2.id, mP2.id, mP2.id]));
    expect(a.out).toBe('OK');
    const logs = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, mP2.id), eq(auditLogs.action, 'PLATOON_ASSIGNED'), gte(auditLogs.createdAt, new Date(Date.now() - 60000))));
    expect(logs.length).toBe(1);
    await pl.assignMembers(captain, P2, { userIds: [mP2.id] }, M());
  });
});

// ───────────────────────── 4. Escalation chains ─────────────────────────
describe('Deep / 4. escalation chains', () => {
  it('SEC-DEEP-030 delegate cannot grant permissions they lack (allow, role, deny->inherit, rank, new role, reactivation)', async () => {
    // offDel: officer with permissions.manage, users.view, users.update (lacks audit.view, users.reset_password...)
    const t = offPlain2;
    expect(await code(acc.saveUserAccess(offDel, t.id, { roleIds: [], overrides: [{ slug: 'audit.view', effect: 'allow' }] }, M()))).toBe('FORBIDDEN');
    expect(await code(acc.saveUserAccess(offDel, t.id, { roleIds: [], overrides: [{ slug: 'users.reset_password', effect: 'allow' }] }, M()))).toBe('FORBIDDEN');
    expect(await code(acc.saveUserAccess(offDel, t.id, { roleIds: [ROLE_AUDIT], overrides: [] }, M()))).toBe('FORBIDDEN');
    expect(await code(acc.saveRankAccess(offDel, RB2, { permissions: ['audit.view'] }, M()))).toBe('FORBIDDEN');
    expect(await code(acc.saveRole(offDel, null, { name: 'qa.deep.esc' + rand(5), description: null, isActive: true, permissions: ['audit.view'] }, M()))).toBe('FORBIDDEN');
    expect(await code(acc.saveRole(offDel, ROLE, { name: (await acc.getRole(ROLE))!.name, description: null, isActive: true, permissions: ['users.view', 'users.reset_password'] }, M()))).toBe('FORBIDDEN');
    // deny -> inherit when a role grants something the delegate lacks
    await db.insert(userRoles).values({ userId: t.id, roleId: ROLE_AUDIT }).onConflictDoNothing();
    await setOv(t.id, 'audit.view', 'deny');
    expect(await code(acc.saveUserAccess(offDel, t.id, { roleIds: [ROLE_AUDIT], overrides: [{ slug: 'audit.view', effect: 'inherit' }] }, M()))).toBe('FORBIDDEN');
    await db.delete(userPermissionOverrides).where(and(eq(userPermissionOverrides.userId, t.id), eq(userPermissionOverrides.permissionSlug, 'audit.view')));
    await db.delete(userRoles).where(and(eq(userRoles.userId, t.id), eq(userRoles.roleId, ROLE_AUDIT)));
    // own permissions / own rank / Captain / Superadmin
    expect(await code(acc.saveUserAccess(offDel, offDel.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'deny' }] }, M()))).toBe('FORBIDDEN');
    const cur = (await db.select({ s: rankPermissions.permissionSlug }).from(rankPermissions).where(eq(rankPermissions.rankId, firstOfficerRank))).map((r) => r.s);
    const extra = (['users.view', 'users.update', 'permissions.manage'] as PermissionSlug[]).find((p) => !cur.includes(p));
    if (extra) expect(await code(acc.saveRankAccess(offDel, firstOfficerRank, { permissions: [...cur, extra] }, M()))).toBe('FORBIDDEN');
    expect(await code(acc.saveUserAccess(offDel, captain.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'deny' }] }, M()))).toBe('FORBIDDEN');
    expect(await code(acc.saveUserAccess(offDel, sa.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'deny' }] }, M()))).toBe('NOT_FOUND');
    expect(await code(acc.saveUserAccess(offDel, offAll.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'deny' }] }, M()))).toBe('FORBIDDEN');
    // delegate cannot approve anything
    expect(await code(acc.decideRequest(offDel, REQ, 'approve', null, M()))).toBe('FORBIDDEN');
    expect(await code(acc.decideRequest(sa, REQ, 'approve', null, M()))).toBe('FORBIDDEN');
  });

  it('SEC-DEEP-031 [fixed] delegate cannot strip permissions they do not hold from a role or rank', async () => {
    // ROLE_AUDIT grants audit.view; offDel lacks audit.view. Removing it changes members who hold more than offDel.
    const g = (await acc.getRole(ROLE_AUDIT))!;
    const r1 = await ex(acc.saveRole(offDel, ROLE_AUDIT, { name: g.name, description: null, isActive: true, permissions: ['users.view'] }, M()));
    const r2 = await ex(acc.saveRankAccess(offDel, RICH, { permissions: ['users.view', 'users.update_status'] }, M()));
    for (const r of [r1, r2]) if (r.ok && r.v?.requestId) await acc.cancelRequest(offDel, r.v.requestId, M());
    expect([r1.code, r2.code], 'delegate request removing audit.view (which they lack) accepted').toEqual(['FORBIDDEN', 'FORBIDDEN']);
  });

  it('SEC-DEEP-032 create user in a privileged rank then reset its password (sock-puppet chain)', async () => {
    // offCR lacks audit.view / update_status that RICH grants
    const u = 'qa.deep.sock' + rand(5);
    expect(await code(us.createUser(offCR, validCreate({ username: u, sectionId: SB, rankId: RICH, tempPassword: PW, guardians: GUARD }), M()))).toBe('VALIDATION');
    // plain rank is allowed; then reset password + login gives only a subset of offCR's permissions
    const ok = await us.createUser(offCR, validCreate({ username: u, sectionId: SB, rankId: RB, guardians: GUARD }), M());
    created.push(ok!.id);
    const rp = await us.resetPassword(offCR, ok!.id, { reason: 'qa', password: PW2 }, M());
    expect(rp.tempPassword).toBe(PW2);
    const mine = await loadPermissions(offCR.id);
    for (const p of await loadPermissions(ok!.id)) expect(mine.has(p)).toBe(true);
    // promote it into RICH (needs change_rank AND RICH grants) -> refused
    expect(await code(us.promoteMembers(offCR, { userIds: [ok!.id], sectionId: SB, rankId: RICH, reason: 'qa' }, M()))).toBe('FORBIDDEN');
    // reset password of someone holding more permissions -> refused
    expect(await code(us.resetPassword(offCR, offAll.id, { reason: 'qa' }, M()))).toBe('FORBIDDEN');
    expect(await code(us.resetPassword(offCR, offMgr.id, { reason: 'qa' }, M()))).toBe('FORBIDDEN');
  });

  it('SEC-DEEP-033 cannot make yourself platoon leader / member', async () => {
    expect((await act(offMgr, () => plA.setLeadersAction(P1, offMgr.id, null))).out).toBe('VALIDATION');
    expect((await act(offMgr, () => plA.setLeadersAction(P1, null, offMgr.id))).out).toBe('VALIDATION');
    expect((await act(offMgr, () => plA.assignMembersAction(P1, [offMgr.id]))).out).toBe('VALIDATION');
    expect((await act(xplt, () => plA.setLeadersAction(P1, xplt.id, null))).out).toBe('FORBIDDEN');
    expect((await act(ofo, () => plA.setLeadersAction(P1, mP1.id, null))).out).toBe('FORBIDDEN');
    expect((await userRow(offMgr.id)).platoonRole).toBeNull();
    expect((await userRow(xplt.id)).platoonRole).toBeNull();
  });

  it('SEC-DEEP-034 promotion abuse: self, into Officer by non-officer, into Captain rank, promoter lacking grants', async () => {
    expect((await act(ofo, () => usersA.promoteAction({ userIds: [mB2.id], sectionId: org.officer, rankId: firstOfficerRank, reason: 'x' }))).out).toBe('FORBIDDEN');
    expect(['VALIDATION', 'FORBIDDEN']).toContain((await act(offCR, () => usersA.promoteAction({ userIds: [offCR.id], sectionId: org.officer, rankId: org.rk('Officer', 'Lieutenant'), reason: 'x' }))).out);
    expect(await code(us.promoteMembers(offAll, { userIds: [mB2.id], sectionId: org.officer, rankId: org.captainRankId, reason: 'x' }, M()))).toBe('VALIDATION');
    expect(await code(us.promoteMembers(offAll, { userIds: [mB2.id], sectionId: SB, rankId: org.captainRankId, reason: 'x' }, M()))).toBe('VALIDATION');
    // rank of another section (section/rank mismatch)
    expect(await code(us.promoteMembers(offAll, { userIds: [mB2.id], sectionId: SB, rankId: RA, reason: 'x' }, M()))).toBe('VALIDATION');
    expect((await userRow(offCR.id)).rankId).toBe(firstOfficerRank);
    expect((await userRow(mB2.id)).rankId).toBe(RB);
  });

  it('SEC-DEEP-035 Captain and Superadmin cannot be demoted/deactivated/reset/edited by an all-permission officer', async () => {
    const rid = await reasonId();
    const capRow = await userRow(captain.id);
    for (const t of [captain.id, sa.id]) {
      const outs = [
        (await act(offAll, () => usersA.promoteAction({ userIds: [t], sectionId: org.officer, rankId: firstOfficerRank, reason: 'x' }))).out,
        (await act(offAll, () => usersA.setStatusAction(t, { status: 'inactive', reasonId: rid }))).out,
        (await act(offAll, () => usersA.resetPasswordAction(t, { reason: 'x' }))).out,
        (await act(offAll, () => usersA.updateUserAction(t, { username: 'qa.deep.cap' + rand(4), email: 'a@b.co', fullName: 'x', gender: 'male', dateOfBirth: '2000-01-01', joinDate: '2020-01-01', guardians: [] } as any))).out,
        (await act(offAll, () => accessA.saveUserAccessAction(t, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'deny' }] }))).out,
      ];
      for (const o of outs) expect(['FORBIDDEN', 'NOT_FOUND', 'VALIDATION']).toContain(o);
    }
    expect((await act(captain, () => usersA.resetPasswordAction(sa.id, { reason: 'x' }))).out).toBe('NOT_FOUND');
    expect((await act(captain, () => usersA.setStatusAction(sa.id, { status: 'inactive', reasonId: rid }))).out).toBe('NOT_FOUND');
    expect((await act(captain, () => usersA.setStatusAction(captain.id, { status: 'inactive', reasonId: rid }))).out).toBe('FORBIDDEN');
    expect((await act(sa, () => usersA.setStatusAction(captain.id, { status: 'inactive', reasonId: rid }))).out).toBe('FORBIDDEN');
    expect((await act(sa, () => usersA.promoteAction({ userIds: [captain.id], sectionId: org.officer, rankId: firstOfficerRank, reason: 'x' }))).out).toBe('VALIDATION');
    const capAfter = await userRow(captain.id);
    expect([capAfter.status, capAfter.rankId, capAfter.passwordHash, capAfter.username]).toEqual([capRow.status, capRow.rankId, capRow.passwordHash, capRow.username]);
  });

  it('SEC-DEEP-036 acting on inactive users: no promotion, platoon, leader, or sign-in after reset', async () => {
    const t = await mk('inact', { sectionId: SA, rankId: RA, platoonId: P1 });
    await us.setStatus(captain, t.id, { status: 'inactive', reasonId: await reasonId() }, M());
    expect(await code(us.promoteMembers(offAll, { userIds: [t.id], sectionId: SA, rankId: RA2, reason: 'x' }, M()))).toBe('VALIDATION');
    expect(await code(pl.assignMembers(offMgr, P2, { userIds: [t.id] }, M()))).toBe('VALIDATION');
    expect(await code(pl.setPlatoonLeaders(offMgr, P1, { leaderId: t.id, assistantId: null }, M()))).toBe('VALIDATION');
    const rp = await ex(us.resetPassword(offAll, t.id, { reason: 'qa', password: PW2 }, M()));
    if (rp.ok) expect((await login((await userRow(t.id)).username, PW2, M())).ok).toBe(false);
    expect((await userRow(t.id)).status).toBe('inactive');
  });

  it('SEC-DEEP-037 [fixed] non-officer with users.all_sections cannot edit or deactivate an Officer account', async () => {
    // Same principle as R-40 (only officers may create officers). allS: SB member with view, all_sections, update, update_status.
    const before = await snap(offPlain.id);
    const u = await act(allS, () => usersA.updateUserAction(offPlain.id, { username: before.un, email: 'attacker@example.test', fullName: 'QA Deep offp', gender: 'male', dateOfBirth: '2012-05-05', joinDate: '2022-01-01', guardians: [] } as any));
    const s = await act(allS, async () => usersA.setStatusAction(offPlain.id, { status: 'inactive', reasonId: await reasonId() }));
    const after = await snap(offPlain.id);
    // restore
    if (after.st === 'inactive') await us.setStatus(captain, offPlain.id, { status: 'active', reason: 'qa restore' }, M());
    if (after.em !== before.em) await db.update(users).set({ email: before.em }).where(eq(users.id, offPlain.id));
    expect([u.out, s.out], `non-officer edited officer (email ${after.em}) / deactivated officer (status ${after.st})`).toEqual(['FORBIDDEN', 'FORBIDDEN']);
  });
});

// ───────────────────────── 5. Sessions ─────────────────────────
describe('Deep / 5. sessions', () => {
  it('SEC-DEEP-040 deactivated user with an existing session is locked out of every action', async () => {
    const t = await mk('sessd', { sectionId: SB, rankId: RB, perms: ['users.view', 'users.update_status'] });
    const tok = await mint(t.id);
    await db.update(users).set({ status: 'inactive', inactiveReasonId: await reasonId() }).where(eq(users.id, t.id)); // session NOT revoked
    ctx.token = tok;
    for (const fn of [
      () => usersA.updateProfileAction({ email: 'a@b.co', guardians: [] } as any),
      () => usersA.setStatusAction(mB2.id, { status: 'inactive', reasonId: 1 }),
      () => accessA.cancelRequestAction(randomUUID()),
      () => authA.changePasswordAction({ current: PW, next: PW2, confirm: PW2 }),
    ]) {
      ctx.token = tok;
      let out = '';
      try { const r: any = await fn(); out = r.ok ? 'OK' : r.code; } catch (e: any) { out = String(e?.digest ?? e?.message); }
      expect(out).toContain('/login');
    }
    await db.update(users).set({ status: 'active', inactiveReasonId: null }).where(eq(users.id, t.id));
    // and the normal path revokes sessions
    await us.setStatus(captain, t.id, { status: 'inactive', reasonId: await reasonId() }, M());
    await db.update(users).set({ status: 'active', inactiveReasonId: null }).where(eq(users.id, t.id));
    ctx.token = tok;
    let out = '';
    try { await usersA.updateProfileAction({ email: 'a@b.co', guardians: [] } as any); } catch (e: any) { out = String(e?.digest); }
    expect(out).toContain('/login');
  });

  it('SEC-DEEP-041 must-change-password user can only change password', async () => {
    const t = await mk('mustc', { sectionId: SB, rankId: RICH });
    await db.update(users).set({ mustChangePassword: true }).where(eq(users.id, t.id));
    const t2 = await loadCU(t.username);
    const bad: string[] = [];
    for (const [n, fn] of [
      ['profile', () => usersA.updateProfileAction({ email: 'a@b.co', guardians: [] } as any)],
      ['status', () => usersA.setStatusAction(mB2.id, { status: 'inactive', reasonId: 1 })],
      ['cancel', () => accessA.cancelRequestAction(randomUUID())],
      ['access', () => accessA.saveUserAccessAction(mB2.id, { roleIds: [], overrides: [] })],
      ['platoon', () => plA.movePlatoonAction(P1, 'up')],
      ['org', () => orgA.createSectionAction('x')],
    ] as [string, () => Promise<unknown>][]) {
      const { out } = await act(t2, fn);
      if (out !== 'REDIRECT:/change-password') bad.push(`${n} -> ${out}`);
    }
    expect(bad, bad.join('; ')).toEqual([]);
    const { out } = await act(t2, () => authA.changePasswordAction({ current: PW, next: PW2, confirm: PW2 }));
    expect(out).toBe('OK');
    expect((await userRow(t.id)).mustChangePassword).toBe(false);
  });

  it('SEC-DEEP-042 password change kills every older session (incl. the one used)', async () => {
    const t = await mk('pwc', { sectionId: SB, rankId: RB });
    const a = await login(t.username, PW, M());
    const b = await login(t.username, PW, M());
    expect(a.ok && b.ok).toBe(true);
    ctx.token = (a as any).token;
    const r: any = await authA.changePasswordAction({ current: PW, next: PW2, confirm: PW2 });
    expect(r.ok).toBe(true);
    const fresh = ctx.cookiesSet.find((c) => c.value)?.value;
    for (const old of [(a as any).token, (b as any).token]) {
      ctx.token = old;
      let out = '';
      try { await usersA.updateProfileAction({ email: 'a@b.co', guardians: [] } as any); } catch (e: any) { out = String(e?.digest); }
      expect(out).toContain('/login');
    }
    ctx.token = fresh;
    const ok: any = await usersA.updateProfileAction({ email: 'qa@example.test', phone: '', guardians: GUARD } as any);
    expect(ok.ok).toBe(true);
    expect((await login(t.username, PW, M())).ok).toBe(false);
  });

  it('SEC-DEEP-043 rank / override / role changes take effect on the next request (no stale permission cache)', async () => {
    const t = await mk('stale', { sectionId: SB, rankId: RICH });
    const probeAct = async () => (await act(t, () => usersA.setStatusAction(randomUUID(), { status: 'inactive', reasonId: 1 }))).out;
    expect(await probeAct()).toBe('NOT_FOUND'); // has users.update_status via rank
    await us.promoteMembers(captain, { userIds: [t.id], sectionId: SB, rankId: RB, reason: 'qa demote' }, M());
    expect(await probeAct()).toBe('FORBIDDEN');
    await setOv(t.id, 'users.update_status', 'allow');
    expect(await probeAct()).toBe('NOT_FOUND');
    await setOv(t.id, 'users.update_status', 'deny');
    expect(await probeAct()).toBe('FORBIDDEN');
    // role path: grant via role, then deactivate role
    await db.delete(userPermissionOverrides).where(eq(userPermissionOverrides.userId, t.id));
    const role = Number((await acc.saveRole(captain, null, { name: `qa.deep.st.${rand(6)}`, description: null, isActive: true, permissions: ['users.update_status'] }, M())).targetId);
    await db.insert(userRoles).values({ userId: t.id, roleId: role });
    expect(await probeAct()).toBe('NOT_FOUND');
    const g = (await acc.getRole(role))!;
    await acc.saveRole(captain, role, { name: g.name, description: null, isActive: false, permissions: g.permissions }, M());
    expect(await probeAct()).toBe('FORBIDDEN');
    // section change out of Officer strips officer-only on the next request
    const o = await mkOff('demo', ['users.reset_password', 'users.view']);
    const resetProbe = async () => (await act(o, () => usersA.resetPasswordAction(randomUUID(), { reason: 'x' }))).out;
    expect(await resetProbe()).toBe('NOT_FOUND');
    await us.promoteMembers(captain, { userIds: [o.id], sectionId: SB, rankId: RB, reason: 'qa demote' }, M());
    expect(await resetProbe()).toBe('FORBIDDEN');
  });

  it('SEC-DEEP-044 logout revokes the session server-side; null password kills sessions', async () => {
    const t = await mk('lo', { sectionId: SB, rankId: RB });
    const tok = await mint(t.id);
    ctx.token = tok;
    try { await authA.logoutAction(); } catch {}
    ctx.token = tok;
    let out = '';
    try { await usersA.updateProfileAction({ email: 'a@b.co', guardians: [] } as any); } catch (e: any) { out = String(e?.digest); }
    expect(out).toContain('/login');
    const tok2 = await mint(t.id);
    await db.update(users).set({ passwordHash: null }).where(eq(users.id, t.id));
    ctx.token = tok2;
    out = '';
    try { await usersA.updateProfileAction({ email: 'a@b.co', guardians: [] } as any); } catch (e: any) { out = String(e?.digest); }
    expect(out).toContain('/login');
  });
});

// ───────────────────────── 6. Races ─────────────────────────
describe('Deep / 6. races', () => {
  async function invariants() {
    const bad = await db.execute(sql`
      select 'role-without-platoon' k, count(*)::int n from users where platoon_role is not null and platoon_id is null
      union all select 'two-roles', count(*)::int from (select platoon_id, platoon_role from users where platoon_role is not null group by 1,2 having count(*) > 1) x
      union all select 'cross-section', count(*)::int from users u join platoons p on p.id = u.platoon_id where p.section_id <> u.section_id
      union all select 'captains', (select count(*)::int from users u join ranks r on r.id = u.rank_id where r.system_key = 'captain') - 1
      union all select 'pending-dupes', count(*)::int from (select kind, target_id from permission_change_requests where status = 'pending' group by 1,2 having count(*) > 1) y`);
    return (bad as any).rows.filter((r: any) => r.n !== 0);
  }

  it('SEC-DEEP-050 two leaders for one platoon at the same time', async () => {
    const a = await mk('ra', { sectionId: SA, rankId: RA, platoonId: P1 });
    const b = await mk('rb', { sectionId: SA, rankId: RA, platoonId: P1 });
    const c = await mk('rc', { sectionId: SA, rankId: RA, platoonId: P1 });
    const res = await Promise.all([
      ex(pl.setPlatoonLeaders(offMgr, P1, { leaderId: a.id, assistantId: null }, M())),
      ex(pl.setPlatoonLeaders(offMgr, P1, { leaderId: b.id, assistantId: null }, M())),
      ex(pl.setPlatoonLeaders(captain, P1, { leaderId: c.id, assistantId: a.id }, M())),
      ex(pl.assignMembers(offMgr, P2, { userIds: [a.id] }, M())),
    ]);
    expect(res.some((r) => r.ok)).toBe(true);
    const leaders = await db.select().from(users).where(and(eq(users.platoonId, P1), eq(users.platoonRole, 'leader')));
    expect(leaders.length).toBeLessThanOrEqual(1);
    expect(await invariants()).toEqual([]);
  });

  it('SEC-DEEP-051 double approve / approve+reject / approve+cancel of one pending request', async () => {
    for (const mode of ['approve2', 'reject', 'cancel'] as const) {
      const t = await mk('rq' + mode.slice(0, 2), { sectionId: SB, rankId: RB });
      const req = (await acc.saveUserAccess(del, t.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow' }] }, M()) as any).requestId;
      const second = mode === 'approve2' ? acc.decideRequest(captain, req, 'approve', null, M())
        : mode === 'reject' ? acc.decideRequest(captain, req, 'reject', 'no', M())
          : acc.cancelRequest(del, req, M());
      const res = await Promise.all([ex(acc.decideRequest(captain, req, 'approve', null, M())), ex(second)]);
      expect(res.filter((r) => r.ok).length, mode).toBe(1);
      expect(res.find((r) => !r.ok)!.code).toBe('CONFLICT');
      const decided = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, req), sql`${auditLogs.action} in ('ACCESS_CHANGE_APPROVED','ACCESS_CHANGE_REJECTED','ACCESS_CHANGE_CANCELLED')`));
      expect(decided.length, mode).toBe(1);
      const ov = await db.select().from(userPermissionOverrides).where(eq(userPermissionOverrides.userId, t.id));
      const [row] = await db.select().from(permissionChangeRequests).where(eq(permissionChangeRequests.id, req));
      expect(ov.length).toBe(row.status === 'approved' ? 1 : 0);
    }
    expect(await invariants()).toEqual([]);
  });

  it('SEC-DEEP-052 two Captains: concurrent appointments and raw DB attempt', async () => {
    const res = await Promise.all([offPlain.id, offPlain2.id].map((id) => ex(appointFirstCaptain(sa, id, M()))));
    expect(res.every((r) => r.code === 'CONFLICT')).toBe(true);
    const p = await probe(async (tx) => {
      await allowCaptainChange(tx);
      await tx.update(users).set({ rankId: org.captainRankId }).where(eq(users.id, offPlain.id));
    });
    expect(p.failed).toBe(true);
    const p2 = await probe(async (tx) => {
      await tx.update(users).set({ rankId: org.captainRankId }).where(eq(users.id, offPlain.id));
    });
    expect(p2.failed).toBe(true);
    expect(await invariants()).toEqual([]);
  });

  it('SEC-DEEP-053 concurrent overlapping batch assigns and promotions', async () => {
    const xs = await Promise.all(['x1', 'x2', 'x3'].map((t) => mk(t, { sectionId: SA, rankId: RA, platoonId: P1 })));
    const [x1, x2, x3] = xs;
    await pl.setPlatoonLeaders(captain, P1, { leaderId: x2.id, assistantId: null }, M()).catch(() => {});
    const res = await Promise.all([
      ex(pl.assignMembers(offMgr, P2, { userIds: [x1.id, x2.id] }, M())),
      ex(pl.assignMembers(captain, P2, { userIds: [x2.id, x3.id] }, M())),
      ex(pl.removeMembers(offMgr, P1, { userIds: [x2.id, x3.id] }, M())),
      ex(us.promoteMembers(offAll, { userIds: [x1.id, x2.id], sectionId: SA, rankId: RA2, reason: 'race' }, M())),
      ex(us.promoteMembers(captain, { userIds: [x2.id], sectionId: SB, rankId: RB, reason: 'race2' }, M())),
    ]);
    expect(res.some((r) => r.ok)).toBe(true);
    // DEADLOCK = Postgres resolved a lock cycle by aborting one transaction (atomic, surfaces as SERVER); not a security issue
    for (const r of res) expect(['OK', 'VALIDATION', 'CONFLICT', 'DEADLOCK'].includes(r.code), JSON.stringify(r).slice(0, 200)).toBe(true);
    for (const x of xs) {
      const u = await userRow(x.id);
      const last = await db.select().from(rankHistory).where(eq(rankHistory.userId, x.id));
      expect(last.some((h) => h.toRankId === u.rankId)).toBe(true);
    }
    expect(await invariants()).toEqual([]);
  });

  it('SEC-DEEP-054 concurrent duplicate create / deactivate / delegate request', async () => {
    const name = 'qa.deep.dupe' + rand(6);
    const res = await Promise.all(Array.from({ length: 5 }, () => ex(us.createUser(captain, validCreate({ username: name, sectionId: SB, rankId: RB, guardians: GUARD }), M()))));
    expect(res.filter((r) => r.ok).length).toBe(1);
    created.push(res.find((r) => r.ok)!.v.id);
    const ic = ic12();
    const res2 = await Promise.all(Array.from({ length: 3 }, () => ex(us.createUser(captain, validCreate({ username: 'qa.deep.ic' + rand(6), sectionId: SB, rankId: RB, guardians: GUARD, idType: 'mykad', idNumber: ic }), M()))));
    expect(res2.filter((r) => r.ok).length).toBe(1);
    created.push(res2.find((r) => r.ok)!.v.id);
    const t = await mk('dd', { sectionId: SB, rankId: RB });
    const rid = await reasonId();
    const res3 = await Promise.all([ex(us.setStatus(offAll, t.id, { status: 'inactive', reasonId: rid }, M())), ex(us.setStatus(captain, t.id, { status: 'inactive', reasonId: rid }, M()))]);
    expect(res3.filter((r) => r.ok).length).toBe(1);
    const t2 = await mk('dr', { sectionId: SB, rankId: RB });
    const res4 = await Promise.all([del, offDel].map((d) => ex(acc.saveUserAccess(d, t2.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow' }] }, M()))));
    expect(res4.filter((r) => r.ok).length).toBe(1);
    expect(await invariants()).toEqual([]);
  });
});

// ───────────────────────── 7. Information leaks ─────────────────────────
describe('Deep / 7. info leaks', () => {
  const dashed = () => `${mB_IC.slice(0, 6)}-${mB_IC.slice(6, 8)}-${mB_IC.slice(8)}`;
  const hasIc = (o: unknown) => { const s = JSON.stringify(o); return s.includes(mB_IC) || s.includes(dashed()); };

  it('SEC-DEEP-060 full IC never appears for users without users.view_sensitive', async () => {
    const leaks: string[] = [];
    const chk = (n: string, o: unknown) => { if (hasIc(o)) leaks.push(n); };
    const scope = await memberScope(noSens);
    chk('listUsers', await us.listUsers({ status: 'all', pageSize: 100 }, { canSearchIc: false, scope }));
    chk('listUsers IC search', await us.listUsers({ q: mB_IC }, { canSearchIc: false, scope }));
    expect((await us.listUsers({ q: mB_IC }, { canSearchIc: false, scope })).total).toBe(0);
    const d = await us.getUserDetail(noSens, mB.id, M());
    chk('getUserDetail', d);
    expect(d.idNumber).toMatch(/[•*x]/i);
    expect(d.idNumberVisible).toBe(false);
    expect(d.guardians.every((g) => g.phone === null || g.phone === '••••')).toBe(true);
    chk('allowedActions', await us.allowedActions(noSens, { id: mB.id, isCaptain: false, status: 'active' }));
    chk('getUserAccess', await acc.getUserAccess(del, mB.id));
    chk('listRequests', await acc.listRequests(del, 'pending'));
    chk('listRequests captain', await acc.listRequests(captain, 'pending'));
    chk('getPlatoon', await pl.getPlatoon(offMgr, P1));
    chk('listPlatoons', await pl.listPlatoons());
    chk('scoreboard', await pl.scoreboard(2026));
    chk('listRoles', await acc.listRoles());
    chk('getRole', await acc.getRole(ROLE));
    chk('orgOptions', await us.getOrgOptions());
    chk('listOrg', await orgSvc.listOrg());
    chk('own profile of other', await getOwnProfile(noSens));
    // action results
    const b = await userRow(mB.id);
    const up = await act(noSens, () => usersA.updateUserAction(mB.id, { username: b.username, email: b.email, fullName: b.fullName, gender: b.gender, dateOfBirth: b.dateOfBirth, joinDate: b.joinDate, phone: b.phone ?? '', guardians: GUARD, idType: 'mykad', idNumber: '000000000000' } as any));
    chk('updateUserAction result', up.r);
    expect((await userRow(mB.id)).idNumberHash).toBe(b.idNumberHash); // no view_sensitive -> IC not changed
    // audit rows about mB (any actor) never contain plaintext IC
    const logs = await db.select().from(auditLogs).where(eq(auditLogs.entityId, mB.id));
    chk('audit_logs', logs);
    // the sensitive viewer does see it (sanity)
    expect(hasIc(await us.getUserDetail(xsec, mB.id, M()))).toBe(true);
    expect(leaks, leaks.join(', ')).toEqual([]);
  });

  it('SEC-DEEP-061 out-of-scope / Superadmin / ghost targets are indistinguishable (no existence oracle)', async () => {
    const ghost = randomUUID();
    const sig = async (who: CU, id: string) => {
      const r: string[] = [];
      for (const fn of [
        () => usersA.updateUserAction(id, { username: 'qa.deep.or' + rand(4), email: 'a@b.co', fullName: 'x', gender: 'male', dateOfBirth: '2012-05-05', joinDate: '2022-01-01', guardians: GUARD } as any),
        () => usersA.setStatusAction(id, { status: 'inactive', reasonId: 1 }),
      ]) {
        const { r: res, out } = await act(who, fn);
        r.push(`${out}:${res?.message ?? ''}`);
      }
      r.push(`${(await ex(us.getUserDetail(who, id, M()))).code}`);
      return r.join('|');
    };
    // section-scoped (xsec, SB) and platoon-scoped (xplt, P1)
    for (const [who, outside] of [[xsec, [mP1.id, mP2.id, offPlain.id, captain.id, sa.id]], [xplt, [mP2.id, mB.id, captain.id, sa.id]]] as [CU, string[]][]) {
      const base = await sig(who, ghost);
      for (const id of outside) expect(await sig(who, id), `${who.username} -> ${id}`).toBe(base);
    }
    // delegate scope on access pages
    const dg = async (id: string) => `${(await ex(acc.getUserAccess(del, id))).message}|${(await ex(acc.saveUserAccess(del, id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow' }] }, M()))).message}`;
    const dBase = await dg(ghost);
    for (const id of [mP1.id, sa.id, offPlain.id]) expect(await dg(id)).toBe(dBase);
    // someone else's request vs a missing request
    const other = await ex(acc.cancelRequest(low, REQ, M()));
    const none = await ex(acc.cancelRequest(low, randomUUID(), M()));
    expect([other.code, other.message]).toEqual([none.code, none.message]);
  });

  it.skip('SEC-DEEP-062 [accepted R-51] scoped creator cannot learn whether an out-of-scope IC is registered', async () => {
    // xplt: platoon P1 only, holds users.create + users.view_sensitive. mB (section SB) is out of scope and
    // invisible to IC search (SYS-SCOPE-001). Creating a P1 member with mB's IC must not reveal that it exists.
    const viaSearch = await us.listUsers({ q: mB_IC }, { canSearchIc: true, scope: await memberScope(xplt) });
    expect(viaSearch.total).toBe(0);
    const taken = await ex(us.createUser(xplt, validCreate({ username: 'qa.deep.ico' + rand(5), sectionId: SA, rankId: RA, platoonId: P1, guardians: GUARD, idType: 'mykad', idNumber: mB_IC }), M()));
    const freeIc = ic12();
    const free = await ex(us.createUser(xplt, validCreate({ username: 'qa.deep.icf' + rand(5), sectionId: SA, rankId: RA, platoonId: P1, guardians: GUARD, idType: 'mykad', idNumber: freeIc }), M()));
    if (free.ok) created.push(free.v.id);
    expect(taken.ok).toBe(false);
    expect(JSON.stringify(taken.fe ?? {}), 'duplicate-IC message reveals an out-of-scope member').not.toMatch(/already registered/i);
  });

  it('SEC-DEEP-063 error results never carry DB internals, hashes or tokens', async () => {
    const outs: any[] = [];
    outs.push((await act(offAll, () => usersA.createUserAction(validCreate({ username: mB.username, sectionId: SB, rankId: RB, guardians: GUARD })))).r);
    outs.push((await act(low, () => usersA.updateProfileAction({ email: 'a@b.co', address: 'a\u0000b', guardians: GUARD } as any))).r);
    outs.push((await act(captain, () => orgA.createRankAction(SA, 'qa.member'))).r);
    outs.push((await act(offMgr, () => plA.createPlatoonAction(SA, (P1 && 'qa.deep.p1') + 'x'.repeat(50)))).r);
    const s = JSON.stringify(outs);
    expect(s).not.toMatch(/\$argon2|token_hash|password_hash|id_number|select |insert into|failed query|violates|constraint/i);
    const u = await userRow(mB.id);
    expect(s).not.toContain(u.passwordHash ?? '___');
  });
});
