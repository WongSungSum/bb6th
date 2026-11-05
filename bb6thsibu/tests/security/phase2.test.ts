import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('next/headers', async () => (await import('./ctx')).headersMock);
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/server/request', async () => (await import('./ctx')).requestMock);

import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { and, count, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  auditLogs, permissionChangeRequests, rankHistory, rankPermissions, ranks, rolePermissions, roles, sections,
  userPermissionOverrides, userRoles, users,
} from '@/lib/db/schema';
import { getPermissionsFor, loadPermissions, resolvePermissions } from '@/lib/server/authz';
import { ALL_PERMISSIONS, type PermissionSlug } from '@/lib/server/authz/catalog';
import * as acc from '@/lib/server/access/service';
import * as orgSvc from '@/lib/server/org/service';
import { createUser, promoteMembers, setStatus } from '@/lib/server/users/service';
import {
  cancelRequestAction, decideRequestAction, saveRankAccessAction, saveRoleAction, saveUserAccessAction,
} from '@/app/actions/access';
import { createRankAction, createSectionAction, moveOrgItemAction, updateOrgItemAction } from '@/app/actions/org';
import { promoteAction } from '@/app/actions/users';
import { hashPassword } from '@/lib/server/auth/password';
import { ctx, resetCtx } from './ctx';
import {
  BASE, closeDb, loadCU, meta, mint, orgIds, rand, reasonId, redirectOf, revokeQaSessions, userRow, validCreate, probe,
} from './fixtures';

type CU = Awaited<ReturnType<typeof loadCU>>;
let captain: CU, sa: CU, org: Awaited<ReturnType<typeof orgIds>>;
let D1: CU, D2: CU, plain: CU, viewer: CU;
let SEC = 0, RK_PLAIN = 0, RK_RICH = 0, RK_OTHER = 0;
let ROLE_VIEW = 0, ROLE_RESET = 0, ROLE_MANAGE = 0;
const created: string[] = [];
let pw: string | undefined;
const tok: Record<string, string> = {};
const tokenOf = async (u: CU) => mint(u.id);
const as = (t: string) => { ctx.token = t; };
const ROOT = path.resolve(__dirname, '../..');
const ex = async (p: Promise<unknown>): Promise<any> => { try { return { ok: true, v: await p }; } catch (e: any) { return { ok: false, code: e.code ?? 'ERR', message: String(e.message), fe: e.fieldErrors, e }; } };
const code = async (p: Promise<unknown>) => { const r = await ex(p); return r.ok ? 'OK' : r.code; };
const SQLISH = /select |insert into|update "|constraint|postgres|violates|invalid input|duplicate key|permission_change_requests_/i;
const M = () => meta('p2');
const ids = (n = 1) => Array.from({ length: n }, () => randomUUID());

const GUARD = [{ name: 'QA Guardian', relationship: 'father', phone: '+60111222333', email: '' }];
async function setOv(userId: string, slug: PermissionSlug, effect: 'allow' | 'deny') {
  await db.insert(userPermissionOverrides).values({ userId, permissionSlug: slug, effect, reason: 'qa.p2' })
    .onConflictDoUpdate({ target: [userPermissionOverrides.userId, userPermissionOverrides.permissionSlug], set: { effect } });
}
async function mk(tag: string, o: { perms?: PermissionSlug[]; deny?: PermissionSlug[]; officer?: boolean; sectionId?: number; rankId?: number } = {}): Promise<CU> {
  const username = `qa.sec.p2${tag}${rand(5)}`;
  const officer = !!o.officer;
  const sectionId = o.sectionId ?? (officer ? org.officer : org.junior);
  const rankId = o.rankId ?? (officer ? org.rk('Officer', 'Helper') : org.rk('Junior', 'Member'));
  const r = await createUser(captain, validCreate({ username, sectionId, rankId, guardians: officer || o.sectionId ? (o.sectionId && !officer ? GUARD : []) : GUARD }), M());
  pw ??= await hashPassword('QaSec-Pass-2026-x1');
  await db.update(users).set({ mustChangePassword: false, passwordHash: pw }).where(eq(users.id, r!.id));
  for (const p of o.perms ?? []) await setOv(r!.id, p, 'allow');
  for (const p of o.deny ?? []) await setOv(r!.id, p, 'deny');
  created.push(r!.id);
  return loadCU(username);
}
const reqsFor = (kind: 'user_access' | 'role' | 'rank_access', targetId: string) =>
  db.select().from(permissionChangeRequests).where(and(eq(permissionChangeRequests.kind, kind), eq(permissionChangeRequests.targetId, targetId))).orderBy(desc(permissionChangeRequests.requestedAt));
const ovs = (uid: string) => db.select().from(userPermissionOverrides).where(eq(userPermissionOverrides.userId, uid));
const urs = (uid: string) => db.select().from(userRoles).where(eq(userRoles.userId, uid));
const grant = (u: CU, slug: PermissionSlug, effect: 'allow' | 'deny' = 'allow') => ({ roleIds: [] as number[], overrides: [{ slug, effect }] });
const saveUA = (a: CU, t: string, i: any) => acc.saveUserAccess(a, t, i, M());
const decide = (a: CU, id: string, d: 'approve' | 'reject', note: unknown = null) => acc.decideRequest(a, id, d, note, M());
const rankOf = async (id: string) => (await userRow(id)).rankId;
const noRaw = (x: unknown) => expect(JSON.stringify(x)).not.toMatch(SQLISH);

async function newRole(perms: PermissionSlug[], active = true) {
  const r = await acc.saveRole(captain, null, { name: `qa.p2.role.${rand(7)}`, description: null, isActive: active, permissions: perms }, M());
  return Number(r.targetId);
}
const walk = (dir: string, out: string[] = []) => {
  for (const f of readdirSync(dir)) {
    const p = path.join(dir, f);
    if (f === 'node_modules' || f === '.next') continue;
    statSync(p).isDirectory() ? walk(p, out) : /\.(ts|tsx)$/.test(f) && out.push(p);
  }
  return out;
};
const read = (rel: string) => readFileSync(path.join(ROOT, rel), 'utf8');

beforeAll(async () => {
  captain = await loadCU('dev.captain');
  sa = await loadCU('superadmin');
  org = await orgIds();
  const MANAGER: PermissionSlug[] = ['permissions.manage', 'users.view', 'users.change_rank'];
  D1 = await mk('d1', { perms: MANAGER, officer: true });
  D2 = await mk('d2', { perms: MANAGER, officer: true });
  plain = await mk('plain');
  viewer = await mk('viewer', { perms: ['users.view'] });
  SEC = (await orgSvc.createSection(captain, { name: `qa.p2.s${rand(6)}` }, M()))!.id;
  RK_PLAIN = (await orgSvc.createRank(captain, { sectionId: SEC, name: 'qa.plain' }, M()))!.id;
  RK_RICH = (await orgSvc.createRank(captain, { sectionId: SEC, name: 'qa.rich' }, M()))!.id;
  RK_OTHER = (await orgSvc.createRank(captain, { sectionId: SEC, name: 'qa.other' }, M()))!.id;
  await acc.saveRankAccess(captain, RK_RICH, { permissions: ['users.update_status', 'users.view'] }, M());
  ROLE_VIEW = await newRole(['users.view']);
  ROLE_RESET = await newRole(['users.view', 'users.update_status']);
  ROLE_MANAGE = await newRole(['permissions.manage']);
}, 180000);
beforeEach(async () => { resetCtx(); await revokeQaSessions(); });
afterAll(async () => {
  // reject any pending request left by these tests so the Captain queue stays clean
  try {
    const open = await db.select({ id: permissionChangeRequests.id }).from(permissionChangeRequests)
      .where(and(eq(permissionChangeRequests.status, 'pending'), inArray(permissionChangeRequests.requestedBy, created)));
    for (const r of open) await acc.decideRequest(captain, r.id, 'reject', 'qa cleanup', M()).catch(() => {});
    // put org objects back
    await db.update(users).set({ sectionId: org.junior, rankId: org.rk('Junior', 'Member') }).where(and(inArray(users.id, created), inArray(users.rankId, [RK_PLAIN, RK_RICH, RK_OTHER]))).catch(() => {});
    await acc.saveRankAccess(captain, RK_RICH, { permissions: [] }, M()).catch(() => {});
    for (const r of [RK_PLAIN, RK_RICH, RK_OTHER]) await orgSvc.updateRank(captain, r, { isActive: false }, M()).catch(() => {});
    await orgSvc.updateSection(captain, SEC, { isActive: false }, M()).catch(() => {});
    for (const id of [ROLE_VIEW, ROLE_RESET, ROLE_MANAGE]) await db.update(roles).set({ isActive: false }).where(eq(roles.id, id));
  } catch {}
  await db.execute(sql`update sessions set revoked_at = now() where revoked_at is null and ip = 'qa-mint'`);
  await closeDb();
});

// ───────────────────────────── A. Delegated requests ─────────────────────────────
describe('Phase 2 / delegated admin requests', () => {
  it('SEC2-001 delegate change becomes a pending request, nothing applied', async () => {
    const t = await mk('t');
    const r = await saveUA(D1, t.id, grant(t, 'users.view'));
    expect(r.status).toBe('pending');
    expect(await ovs(t.id)).toEqual([]);
    const [q] = await reqsFor('user_access', t.id);
    expect([q.status, q.requestedBy]).toEqual(['pending', D1.id]);
    const [a] = await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'ACCESS_CHANGE_REQUESTED'), eq(auditLogs.entityId, q.id)));
    expect(a?.actorId).toBe(D1.id);
    expect((await loadPermissions(t.id)).has('users.view')).toBe(false);
  });
  it('SEC2-002 one pending request per target (service and DB index)', async () => {
    const t = await mk('t');
    await saveUA(D1, t.id, grant(t, 'users.view'));
    expect(await ex(saveUA(D2, t.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow' }] }))).toMatchObject({ ok: false, code: 'CONFLICT' });
    const p = await probe((tx) => tx.insert(permissionChangeRequests).values({ kind: 'user_access', targetId: t.id, changes: {}, requestedBy: D2.id }));
    expect(p.failed).toBe(true);
    expect((await reqsFor('user_access', t.id)).length).toBe(1);
  });
  it('SEC2-003 concurrent submissions on one target: exactly one pending', async () => {
    const t = await mk('t');
    const res = await Promise.all([D1, D2, D1, D2].map((d) => ex(saveUA(d, t.id, grant(t, 'users.view')))));
    expect(res.filter((r) => r.ok).length).toBe(1);
    expect(res.filter((r) => !r.ok).every((r) => r.code === 'CONFLICT')).toBe(true);
    expect((await reqsFor('user_access', t.id)).length).toBe(1);
  });
  it('SEC2-004 delegate cannot grant a permission they do not hold', async () => {
    const t = await mk('t');
    const r = await ex(saveUA(D1, t.id, grant(t, 'users.create')));
    expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    noRaw(r.message);
    expect(await reqsFor('user_access', t.id)).toEqual([]);
    expect(await ovs(t.id)).toEqual([]);
  });
  it('SEC2-005 delegate cannot assign a role carrying permissions they lack', async () => {
    const t = await mk('t');
    expect(await code(saveUA(D1, t.id, { roleIds: [ROLE_RESET], overrides: [] }))).toBe('FORBIDDEN');
    expect(await urs(t.id)).toEqual([]);
    expect(await reqsFor('user_access', t.id)).toEqual([]);
    expect((await saveUA(D1, t.id, { roleIds: [ROLE_VIEW], overrides: [] })).status).toBe('pending');
  });
  it('SEC2-006 delegate cannot change themselves', async () => {
    expect(await code(saveUA(D1, D1.id, grant(D1, 'users.view', 'allow')))).toBe('FORBIDDEN');
    expect(await code(saveUA(D1, D1.id, { roleIds: [ROLE_VIEW], overrides: [] }))).toBe('FORBIDDEN');
    expect(await reqsFor('user_access', D1.id)).toEqual([]);
  });
  it('SEC2-007 delegate cannot change the Captain; Superadmin looks nonexistent', async () => {
    expect(await code(saveUA(D1, captain.id, grant(captain, 'users.view')))).toBe('FORBIDDEN');
    const a = await ex(saveUA(D1, sa.id, grant(sa, 'users.view')));
    const b = await ex(saveUA(D1, randomUUID(), grant(sa, 'users.view')));
    expect([a.code, a.message]).toEqual([b.code, b.message]);
    expect(a.code).toBe('NOT_FOUND');
    expect((await reqsFor('user_access', captain.id)).filter((q) => q.requestedBy === D1.id && q.status !== 'rejected')).toEqual([]);
    expect((await reqsFor('user_access', sa.id)).length).toBe(0);
  });
  it('SEC2-008 delegate cannot change someone holding permissions they lack', async () => {
    const t = await mk('rich', { perms: ['users.update_status'] });
    expect(await code(saveUA(D1, t.id, grant(t, 'users.view')))).toBe('FORBIDDEN');
    expect(await reqsFor('user_access', t.id)).toEqual([]);
  });
  it('SEC2-009 [R-28] delegate cannot remove a DENY that would hand over a permission they lack', async () => {
    const t = await mk('deny', { deny: ['users.update_status'] });
    await saveUA(captain, t.id, { roleIds: [ROLE_RESET], overrides: [{ slug: 'users.update_status', effect: 'deny' }] });
    expect((await loadPermissions(t.id)).has('users.update_status')).toBe(false);
    const r = await ex(saveUA(D1, t.id, { roleIds: [ROLE_RESET], overrides: [{ slug: 'users.update_status', effect: 'inherit' }] }));
    expect(r.ok ? 'pending request created' : r.code).toBe('FORBIDDEN');
  });
  it('SEC2-010 [R-29] delegate cannot reactivate a role carrying permissions they lack', async () => {
    const rid = await newRole(['users.update_status'], false);
    const r = await ex(acc.saveRole(D1, rid, { name: (await db.select().from(roles).where(eq(roles.id, rid)))[0].name, description: null, isActive: true, permissions: ['users.update_status'] }, M()));
    expect(r.ok ? 'pending request created' : r.code).toBe('FORBIDDEN');
  });
  it('SEC2-011 role create/edit: only held permissions; creates nothing until approval', async () => {
    const name = `qa.p2.role.${rand(7)}`;
    expect(await code(acc.saveRole(D1, null, { name, description: null, isActive: true, permissions: ['users.create'] }, M()))).toBe('FORBIDDEN');
    const r = await acc.saveRole(D1, null, { name, description: 'd', isActive: true, permissions: ['users.view'] }, M());
    expect(r.status).toBe('pending');
    expect(await db.select().from(roles).where(eq(roles.name, name))).toEqual([]);
    // case-insensitive duplicate of an existing role
    const existing = (await db.select().from(roles).where(eq(roles.id, ROLE_VIEW)))[0].name;
    expect(await code(acc.saveRole(D1, null, { name: existing.toUpperCase(), description: null, isActive: true, permissions: [] }, M()))).toBe('VALIDATION');
  });
  it('SEC2-012 delegate cannot widen a role they hold', async () => {
    const holder = await mk('holder', { perms: ['users.view'], officer: true });
    await saveUA(captain, holder.id, { roleIds: [ROLE_MANAGE], overrides: [{ slug: 'users.view', effect: 'allow' }] });
    expect((await loadPermissions(holder.id)).has('permissions.manage')).toBe(true);
    const cur = (await db.select({ s: rolePermissions.permissionSlug }).from(rolePermissions).where(eq(rolePermissions.roleId, ROLE_MANAGE))).map((x) => x.s);
    const r = await ex(acc.saveRole(holder, ROLE_MANAGE, { name: (await db.select().from(roles).where(eq(roles.id, ROLE_MANAGE)))[0].name, description: null, isActive: true, permissions: [...cur, 'users.create', 'audit.view'] }, M()));
    expect(r).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    const after = (await db.select({ s: rolePermissions.permissionSlug }).from(rolePermissions).where(eq(rolePermissions.roleId, ROLE_MANAGE))).map((x) => x.s);
    expect(after.sort()).toEqual([...cur].sort());
  });
  it('SEC2-013 delegate cannot change the permissions of their own rank', async () => {
    const own = D1.rankId!;
    const before = await db.select().from(rankPermissions).where(eq(rankPermissions.rankId, own));
    expect(await code(acc.saveRankAccess(D1, own, { permissions: ['users.view', 'permissions.manage'] }, M()))).toBe('FORBIDDEN');
    expect(await db.select().from(rankPermissions).where(eq(rankPermissions.rankId, own))).toEqual(before);
  });
  it('SEC2-014 rank permissions: held only, other ranks pend, Captain rank refused, bad ids NOT_FOUND', async () => {
    expect(await code(acc.saveRankAccess(D1, RK_OTHER, { permissions: ['users.create'] }, M()))).toBe('FORBIDDEN');
    expect(await code(acc.saveRankAccess(D1, org.captainRankId, { permissions: ['users.view'] }, M()))).toBe('VALIDATION');
    expect(await code(acc.saveRankAccess(captain, org.captainRankId, { permissions: ['users.view'] }, M()))).toBe('VALIDATION');
    for (const id of [0, -1, 1.5, 99999, 1e9, NaN, 'x' as any, null as any]) expect(await code(acc.saveRankAccess(D1, id, { permissions: ['users.view'] }, M())), String(id)).toBe('NOT_FOUND');
    expect((await acc.saveRankAccess(D1, RK_OTHER, { permissions: ['users.view'] }, M())).status).toBe('pending');
    expect(await db.select().from(rankPermissions).where(eq(rankPermissions.rankId, RK_OTHER))).toEqual([]);
    expect((await db.select().from(rankPermissions).where(eq(rankPermissions.rankId, org.captainRankId))).length).toBe(0);
  });
  it('SEC2-015 Captain and Superadmin changes apply immediately and are audited', async () => {
    const t = await mk('t');
    const r1 = await saveUA(sa, t.id, grant(t, 'audit.view'));
    expect(r1.status).toBe('applied');
    expect((await ovs(t.id)).map((o) => o.permissionSlug)).toEqual(['audit.view']);
    const r2 = await saveUA(captain, t.id, { roleIds: [ROLE_VIEW], overrides: [{ slug: 'audit.view', effect: 'allow' }] });
    expect(r2.status).toBe('applied');
    const [a] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'user_access'), eq(auditLogs.entityId, t.id), eq(auditLogs.actorId, captain.id)));
    expect(a?.action).toBe('ACCESS_CHANGED');
  });
  it('SEC2-016 users without permissions.manage are refused everywhere', async () => {
    const t = await mk('t');
    for (const u of [plain, viewer]) {
      expect(await code(saveUA(u, t.id, grant(t, 'users.view')))).toBe('FORBIDDEN');
      expect(await code(acc.saveRole(u, null, { name: 'qa.p2.x' + rand(4), description: null, isActive: true, permissions: [] }, M()))).toBe('FORBIDDEN');
      expect(await code(acc.saveRankAccess(u, RK_OTHER, { permissions: [] }, M()))).toBe('FORBIDDEN');
      expect(await code(acc.getUserAccess(u, t.id))).toBe('FORBIDDEN');
      expect(await code(acc.listRequests(u, 'pending'))).toBe('FORBIDDEN');
      expect(await code(decide(u, randomUUID(), 'approve'))).toBe('FORBIDDEN');
    }
    expect(await reqsFor('user_access', t.id)).toEqual([]);
  });
});

// ───────────────────────────── B. Approval ─────────────────────────────
describe('Phase 2 / approval, replay, staleness, forgery', () => {
  it('SEC2-020 only the Captain can confirm (delegate, Superadmin, requester refused)', async () => {
    const t = await mk('t');
    const { requestId } = (await saveUA(D1, t.id, grant(t, 'users.view'))) as any;
    for (const u of [D1, D2, sa, plain]) expect(await code(decide(u, requestId, 'approve')), u.username).toBe('FORBIDDEN');
    expect(await code(decide(sa, requestId, 'reject', 'no'))).toBe('FORBIDDEN');
    as(await tokenOf(sa));
    expect(await decideRequestAction(requestId, 'approve')).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    as(await tokenOf(D1));
    expect(await decideRequestAction(requestId, 'approve')).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    expect((await reqsFor('user_access', t.id))[0].status).toBe('pending');
    expect(await ovs(t.id)).toEqual([]);
  });
  it('SEC2-021 DB trigger: requester cannot be recorded as approver; content immutable; no delete', async () => {
    const t = await mk('t');
    const { requestId } = (await saveUA(D1, t.id, grant(t, 'users.view'))) as any;
    const q = (fn: (tx: any) => Promise<unknown>) => probe(fn);
    expect((await q((tx) => tx.update(permissionChangeRequests).set({ status: 'approved', decidedBy: D1.id, decidedAt: new Date() }).where(eq(permissionChangeRequests.id, requestId)))).failed).toBe(true);
    expect((await q((tx) => tx.update(permissionChangeRequests).set({ changes: { addRoles: [], removeRoles: [], overrides: [{ slug: 'permissions.manage', from: 'inherit', to: 'allow', reason: null }] } }).where(eq(permissionChangeRequests.id, requestId)))).failed).toBe(true);
    expect((await q((tx) => tx.update(permissionChangeRequests).set({ requestedBy: captain.id }).where(eq(permissionChangeRequests.id, requestId)))).failed).toBe(true);
    expect((await q((tx) => tx.update(permissionChangeRequests).set({ targetId: captain.id }).where(eq(permissionChangeRequests.id, requestId)))).failed).toBe(true);
    expect((await q((tx) => tx.delete(permissionChangeRequests).where(eq(permissionChangeRequests.id, requestId)))).failed).toBe(true);
    await decide(captain, requestId, 'reject', 'qa');
    expect((await q((tx) => tx.update(permissionChangeRequests).set({ status: 'pending' }).where(eq(permissionChangeRequests.id, requestId)))).failed).toBe(true);
    expect((await q((tx) => tx.update(permissionChangeRequests).set({ status: 'approved', decidedBy: captain.id }).where(eq(permissionChangeRequests.id, requestId)))).failed).toBe(true);
  });
  it('SEC2-022 Captain approval applies the change once, with audit', async () => {
    const t = await mk('t');
    const { requestId } = (await saveUA(D1, t.id, grant(t, 'users.view'))) as any;
    await decide(captain, requestId, 'approve');
    expect((await ovs(t.id)).map((o) => [o.permissionSlug, o.effect, o.setBy])).toEqual([['users.view', 'allow', D1.id]]);
    const [q] = await reqsFor('user_access', t.id);
    expect([q.status, q.decidedBy]).toEqual(['approved', captain.id]);
    const audits = await db.select({ a: auditLogs.action }).from(auditLogs).where(sql`${auditLogs.entityId} in (${requestId}, ${t.id})`);
    expect(audits.map((x) => x.a)).toEqual(expect.arrayContaining(['ACCESS_CHANGE_REQUESTED', 'ACCESS_CHANGE_APPROVED', 'ACCESS_CHANGED']));
  });
  it('SEC2-023 replay: second approve/reject of a decided request is CONFLICT', async () => {
    const t = await mk('t');
    const { requestId } = (await saveUA(D1, t.id, grant(t, 'users.view'))) as any;
    await decide(captain, requestId, 'approve');
    await db.delete(userPermissionOverrides).where(eq(userPermissionOverrides.userId, t.id)); // simulate later revocation
    expect(await code(decide(captain, requestId, 'approve'))).toBe('CONFLICT');
    expect(await code(decide(captain, requestId, 'reject', 'x'))).toBe('CONFLICT');
    expect(await ovs(t.id)).toEqual([]);
  });
  it('SEC2-024 concurrent approvals: exactly one wins', async () => {
    const t = await mk('t');
    const { requestId } = (await saveUA(D1, t.id, { roleIds: [ROLE_VIEW], overrides: [] })) as any;
    const res = await Promise.all([1, 2, 3].map(() => ex(decide(captain, requestId, 'approve'))));
    expect(res.filter((r) => r.ok).length).toBe(1);
    expect(res.filter((r) => !r.ok).every((r) => r.code === 'CONFLICT')).toBe(true);
    expect((await urs(t.id)).length).toBe(1);
  });
  it('SEC2-025 reject needs a note (<=500) and applies nothing', async () => {
    const t = await mk('t');
    const { requestId } = (await saveUA(D1, t.id, grant(t, 'users.view'))) as any;
    expect(await code(decide(captain, requestId, 'reject'))).toBe('VALIDATION');
    expect(await code(decide(captain, requestId, 'reject', '  '))).toBe('VALIDATION');
    expect(await code(decide(captain, requestId, 'reject', 'x'.repeat(501)))).toBe('VALIDATION');
    expect(await code(decide(captain, requestId, 'maybe' as any, 'x'))).toBe('VALIDATION');
    await decide(captain, requestId, 'reject', 'not needed');
    expect(await ovs(t.id)).toEqual([]);
    expect((await reqsFor('user_access', t.id))[0].status).toBe('rejected');
    // after rejection a fresh request is possible again
    expect((await saveUA(D1, t.id, grant(t, 'users.view'))).status).toBe('pending');
  });
  it('SEC2-026 approval re-validates: requester lost a granted permission', async () => {
    const t = await mk('t');
    const dd = await mk('dd', { perms: ['permissions.manage', 'users.view'], officer: true });
    const { requestId } = (await saveUA(dd, t.id, grant(t, 'users.view'))) as any;
    await db.delete(userPermissionOverrides).where(and(eq(userPermissionOverrides.userId, dd.id), eq(userPermissionOverrides.permissionSlug, 'users.view')));
    expect(await code(decide(captain, requestId, 'approve'))).toBe('CONFLICT');
    expect(await ovs(t.id)).toEqual([]);
    expect((await reqsFor('user_access', t.id))[0].status).toBe('pending');
  });
  it('SEC2-027 approval re-validates: requester lost permissions.manage', async () => {
    const t = await mk('t');
    const dd = await mk('dd', { perms: ['permissions.manage', 'users.view'], officer: true });
    const { requestId } = (await saveUA(dd, t.id, grant(t, 'users.view'))) as any;
    await setOv(dd.id, 'permissions.manage', 'deny');
    expect(await code(decide(captain, requestId, 'approve'))).toBe('CONFLICT');
    expect(await ovs(t.id)).toEqual([]);
  });
  it('SEC2-028 approval re-validates: requester deactivated', async () => {
    const t = await mk('t');
    const dd = await mk('dd', { perms: ['permissions.manage', 'users.view'], officer: true });
    const { requestId } = (await saveUA(dd, t.id, grant(t, 'users.view'))) as any;
    await setStatus(captain, dd.id, { status: 'inactive', reasonId: await reasonId() }, M());
    expect(await code(decide(captain, requestId, 'approve'))).toBe('CONFLICT');
    expect(await ovs(t.id)).toEqual([]);
  });
  it('SEC2-029 approval detects stale user/role/rank state', async () => {
    const t = await mk('t');
    const { requestId } = (await saveUA(D1, t.id, grant(t, 'users.view'))) as any;
    await setOv(t.id, 'users.view', 'deny'); // target changed behind the request
    expect(await code(decide(captain, requestId, 'approve'))).toBe('CONFLICT');
    expect((await ovs(t.id))[0].effect).toBe('deny');

    const rid = await newRole(['users.view']);
    const nm = (await db.select().from(roles).where(eq(roles.id, rid)))[0].name;
    const r2 = (await acc.saveRole(D1, rid, { name: nm, description: null, isActive: true, permissions: ['users.view'].concat([]) as any }, M()).catch((e) => e)) as any;
    expect(r2.code).toBe('VALIDATION'); // nothing changed
    const r3 = (await acc.saveRole(D1, rid, { name: nm, description: null, isActive: true, permissions: [] }, M())) as any; // removal request
    await db.delete(rolePermissions).where(eq(rolePermissions.roleId, rid)); // removed elsewhere
    expect(await code(decide(captain, r3.requestId, 'approve'))).toBe('CONFLICT');

    const rkS = (await orgSvc.createRank(captain, { sectionId: SEC, name: 'qa.s' + rand(5) }, M()))!.id;
    const r4 = (await acc.saveRankAccess(D1, rkS, { permissions: ['users.view'] }, M())) as any;
    await db.insert(rankPermissions).values({ rankId: rkS, permissionSlug: 'users.view' });
    expect(await code(decide(captain, r4.requestId, 'approve'))).toBe('CONFLICT');
    await db.delete(rankPermissions).where(eq(rankPermissions.rankId, rkS));
  });
  it('SEC2-030 forged request JSON (written straight to the DB) cannot escalate on approval', async () => {
    const forge = async (kind: 'user_access' | 'role' | 'rank_access', targetId: string, changes: unknown) => {
      const [r] = await db.insert(permissionChangeRequests).values({ kind, targetId, changes: changes as any, requestedBy: D1.id }).returning();
      return r.id;
    };
    // rank grant of a permission the requester does not hold
    const rkF = (await orgSvc.createRank(captain, { sectionId: SEC, name: 'qa.f' + rand(5) }, M()))!.id;
    const roleF = await newRole(['users.view']);
    const id1 = await forge('rank_access', String(rkF), { addPermissions: ['users.create', 'users.update_status'], removePermissions: [] });
    expect(await code(decide(captain, id1, 'approve'))).toBe('CONFLICT');
    // unknown slug
    const id2 = await forge('role', String(roleF), { addPermissions: ['bogus.slug'], removePermissions: [] });
    const r2 = await ex(decide(captain, id2, 'approve'));
    expect(r2.ok ? 'applied' : r2.code).toBe('CONFLICT');
    // user_access aimed at the Captain
    const id3 = await forge('user_access', captain.id, { addRoles: [], removeRoles: [], overrides: [{ slug: 'users.view', from: 'inherit', to: 'deny', reason: null }] });
    expect(await code(decide(captain, id3, 'approve'))).toBe('CONFLICT');
    // user_access with a role the requester cannot grant
    const t = await mk('t');
    const id4 = await forge('user_access', t.id, { addRoles: [ROLE_RESET], removeRoles: [], overrides: [] });
    expect(await code(decide(captain, id4, 'approve'))).toBe('CONFLICT');
    // malformed changes shape
    const t2 = await mk('t');
    const id5 = await forge('user_access', t2.id, { nonsense: true });
    const r5 = await ex(decide(captain, id5, 'approve'));
    expect(r5.ok).toBe(false);
    if (r5.code !== 'SERVER') noRaw(r5.message);
    expect(await urs(t.id)).toEqual([]);
    expect(await ovs(t2.id)).toEqual([]);
    expect((await db.select().from(rankPermissions).where(eq(rankPermissions.rankId, RK_OTHER))).length).toBe(0);
    for (const id of [id1, id2, id3, id4, id5]) await decide(captain, id, 'reject', 'qa forged').catch(() => {});
  });
  it('SEC2-031 cancel: only requester; others see NOT_FOUND; cancelled cannot be approved', async () => {
    const t = await mk('t');
    const { requestId } = (await saveUA(D1, t.id, grant(t, 'users.view'))) as any;
    const ghost = await ex(acc.cancelRequest(D2, randomUUID(), M()));
    const other = await ex(acc.cancelRequest(D2, requestId, M()));
    expect([other.code, other.message]).toEqual([ghost.code, ghost.message]);
    expect(await code(acc.cancelRequest(captain, requestId, M()))).toBe('NOT_FOUND');
    expect((await reqsFor('user_access', t.id))[0].status).toBe('pending');
    await acc.cancelRequest(D1, requestId, M());
    expect(await code(decide(captain, requestId, 'approve'))).toBe('CONFLICT');
    expect(await code(acc.cancelRequest(D1, requestId, M()))).toBe('CONFLICT');
    expect(await ovs(t.id)).toEqual([]);
  });
  it('SEC2-032 request IDOR: delegates only list their own; malformed ids are NOT_FOUND', async () => {
    const t = await mk('t');
    const { requestId } = (await saveUA(D1, t.id, grant(t, 'users.view'))) as any;
    expect((await acc.listRequests(D2, 'pending')).find((r) => r.id === requestId)).toBeUndefined();
    expect((await acc.listRequests(D1, 'pending')).find((r) => r.id === requestId)?.mine).toBe(true);
    expect((await acc.listRequests(captain, 'pending')).find((r) => r.id === requestId)).toBeTruthy();
    expect((await acc.listRequests(sa, 'pending')).find((r) => r.id === requestId)).toBeTruthy();
    for (const id of ['x', '', "' OR 1=1 --", 'a'.repeat(1000), '-'.repeat(36), randomUUID(), null as any, undefined as any, '0'.repeat(36)]) {
      for (const [n, p] of [['decide', decide(captain, id, 'approve')], ['cancel', acc.cancelRequest(D1, id, M())]] as const) {
        const r = await ex(p);
        expect(r.ok ? 'OK' : r.code, `${n}(${String(id).slice(0, 8)})`).toBe('NOT_FOUND');
        noRaw(r.message);
      }
    }
  });
  it('SEC2-033 stored request JSON carries only slugs/ids/names (no PII or secrets)', async () => {
    const t = await mk('t');
    const { requestId } = (await saveUA(D1, t.id, { roleIds: [ROLE_VIEW], overrides: [{ slug: 'users.view', effect: 'allow', reason: 'because' }], reason: 'r' })) as any;
    const [q] = await db.select().from(permissionChangeRequests).where(eq(permissionChangeRequests.id, requestId));
    const s = JSON.stringify(q.changes);
    expect(s).not.toMatch(/password|hash|ic_?number|idNumber|token|@/i);
    const rows = await acc.listRequests(D1, 'pending');
    expect(JSON.stringify(rows.find((r) => r.id === requestId))).not.toMatch(/password|hash|idNumber|token/i);
  });
});

// ───────────────────────────── C. Input / actions ─────────────────────────────
describe('Phase 2 / actions, validation, mass assignment', () => {
  it('SEC2-040 anonymous callers are redirected on every phase-2 action', async () => {
    const calls = [
      saveRoleAction(null, { name: 'qa.p2.anon', description: '', isActive: true, permissions: [] }),
      saveRankAccessAction(RK_OTHER, { permissions: ['users.view'] }),
      saveUserAccessAction(plain.id, { roleIds: [], overrides: [] }),
      decideRequestAction(randomUUID(), 'approve'),
      cancelRequestAction(randomUUID()),
      createSectionAction('qa.p2.anon'),
      createRankAction(SEC, 'qa.p2.anon'),
      updateOrgItemAction('rank', RK_OTHER, { isActive: false }),
      moveOrgItemAction('rank', RK_OTHER, 'up'),
      promoteAction({ userIds: [plain.id], sectionId: org.junior, rankId: org.rk('Junior', 'Leading Boy'), reason: 'x' }),
    ];
    expect(await Promise.all(calls.map((c) => redirectOf(c)))).toEqual(Array(calls.length).fill('/login'));
    expect(await rankOf(plain.id)).toBe(org.rk('Junior', 'Member'));
  });
  it('SEC2-041 members without the permission get FORBIDDEN from every action', async () => {
    for (const u of [plain, viewer]) {
      as(await tokenOf(u));
      const rs = await Promise.all([
        saveRoleAction(null, { name: 'qa.p2.n' + rand(4), description: '', isActive: true, permissions: [] }),
        saveRankAccessAction(RK_OTHER, { permissions: ['users.view'] }),
        saveUserAccessAction(plain.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow' }] }),
        decideRequestAction(randomUUID(), 'approve'),
        createSectionAction('qa.p2.n' + rand(4)),
        createRankAction(SEC, 'qa.p2.n' + rand(4)),
        updateOrgItemAction('rank', RK_OTHER, { isActive: false }),
        moveOrgItemAction('section', SEC, 'up'),
        promoteAction({ userIds: [plain.id], sectionId: org.junior, rankId: org.rk('Junior', 'Leading Boy'), reason: 'x' }),
      ]);
      expect(rs.map((r: any) => (r.ok ? 'OK' : r.code))).toEqual(Array(9).fill('FORBIDDEN'));
    }
    expect(await ovs(plain.id)).toEqual([]);
  });
  it('SEC2-042 mass assignment: extra body fields cannot set status/requester/target', async () => {
    const t = await mk('t'), other = await mk('t');
    as(await tokenOf(D1));
    const r: any = await saveUserAccessAction(t.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow' }], status: 'applied', requestedBy: captain.id, userId: other.id, decidedBy: captain.id, actor: captain } as any);
    expect(r).toMatchObject({ ok: true, data: { status: 'pending' } });
    const [q] = await reqsFor('user_access', t.id);
    expect([q.requestedBy, q.status, q.decidedBy, q.targetId]).toEqual([D1.id, 'pending', null, t.id]);
    expect(await ovs(other.id)).toEqual([]);
    expect(await ovs(t.id)).toEqual([]);
  });
  it('SEC2-043 saveUserAccess input fuzz is rejected cleanly (VALIDATION, no raw errors, nothing written)', async () => {
    const t = await mk('t');
    const bad: any[] = [
      { roleIds: [], overrides: [{ slug: 'nope.bogus', effect: 'allow' }] },
      { roleIds: [], overrides: [{ slug: '__proto__', effect: 'allow' }] },
      { roleIds: [], overrides: [{ slug: "users.view'; drop table users;--", effect: 'allow' }] },
      { roleIds: [], overrides: [{ slug: 'users.view', effect: 'ADMIN' }] },
      { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow' }, { slug: 'users.view', effect: 'deny' }] },
      { roleIds: [], overrides: [null] },
      { roleIds: [99999999], overrides: [] }, { roleIds: [-1], overrides: [] }, { roleIds: [1.5], overrides: [] },
      { roleIds: ['a'], overrides: [] }, { roleIds: [0], overrides: [] },
      { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow' }], reason: 'x'.repeat(501) },
    ];
    for (const b of bad) {
      const r = await ex(saveUA(D1, t.id, b));
      expect(r.ok ? 'OK' : r.code, JSON.stringify(b)).toBe('VALIDATION');
      noRaw(r.message);
    }
    expect(await code(saveUA(D1, t.id, { roleIds: 'x', overrides: 'y' }))).toBe('VALIDATION'); // non-arrays -> nothing changed
    for (const id of ['x', '', "' or 1=1", 'a'.repeat(500), '0'.repeat(36), randomUUID()]) expect(await code(saveUA(D1, id, grant(t, 'users.view'))), id.slice(0, 6)).toBe('NOT_FOUND');
    expect(await reqsFor('user_access', t.id)).toEqual([]);
  });
  it('SEC2-044 saveRole input fuzz', async () => {
    const mkRole = (o: any) => acc.saveRole(captain, null, { name: 'qa.p2.f' + rand(5), description: null, isActive: true, permissions: [], ...o }, M());
    for (const o of [{ name: '' }, { name: '   ' }, { name: 'x'.repeat(51) }, { name: 123 }, { name: null }, { permissions: ['bogus'] }, { permissions: ['users.view', 5] }]) {
      expect(await code(mkRole(o)), JSON.stringify(o)).toBe('VALIDATION');
    }
    for (const id of [0, -1, 99999, 1.5, NaN, 'x' as any]) expect(await code(acc.saveRole(captain, id, { name: 'a', description: null, isActive: true, permissions: [] }, M())), String(id)).toBe('NOT_FOUND');
    const r = await mkRole({ description: 'd'.repeat(5000), permissions: 'not-an-array' }); // description trimmed; non-array => no perms
    const row = (await db.select().from(roles).where(eq(roles.id, Number(r.targetId))))[0];
    expect((row.description ?? '').length).toBeLessThanOrEqual(200);
    expect(await db.select().from(rolePermissions).where(eq(rolePermissions.roleId, row.id))).toEqual([]);
  });
  it('SEC2-045 error text from access service never exposes SQL or other members', async () => {
    const t = await mk('t', { perms: ['users.update_status'] });
    const msgs: string[] = [];
    for (const p of [saveUA(D1, t.id, grant(t, 'users.view')), saveUA(D1, t.id, grant(t, 'users.create')), saveUA(D1, 'zzz', grant(t, 'users.view')), acc.saveRankAccess(D1, D1.rankId!, { permissions: [] }, M())]) {
      const r = await ex(p); msgs.push(r.message);
    }
    for (const m of msgs) { noRaw(m); expect(m).not.toContain(t.id); expect(m).not.toContain(t.username); }
  });
  it('SEC2-046 getUserAccess: Superadmin hidden, Captain read-only, bad ids NOT_FOUND', async () => {
    const a = await ex(acc.getUserAccess(D1, sa.id)), b = await ex(acc.getUserAccess(D1, randomUUID()));
    expect([a.code, a.message]).toEqual([b.code, b.message]);
    const c = await acc.getUserAccess(D1, captain.id);
    expect(c.editable).toBe(false);
    for (const id of ['x', '', "'", 'a'.repeat(1000)]) expect(await code(acc.getUserAccess(D1, id))).toBe('NOT_FOUND');
    const self = await acc.getUserAccess(D1, D1.id);
    expect(self.editable).toBe(false);
  });
  it('SEC2-047 nav pending count only for the Captain', async () => {
    const t = await mk('t');
    await saveUA(D1, t.id, grant(t, 'users.view'));
    expect(await acc.pendingRequestCount(captain)).toBeGreaterThan(0);
    for (const u of [D1, D2, sa, plain, viewer]) expect(await acc.pendingRequestCount(u), u.username).toBe(0);
  });
});

// ───────────────────────────── D. Organization maintenance ─────────────────────────────
describe('Phase 2 / organization maintenance', () => {
  it('SEC2-050 only Captain/Superadmin; delegates with permissions.manage are refused', async () => {
    const nm = () => 'qa.p2.o' + rand(5);
    for (const u of [D1, plain, viewer]) {
      expect(await code(orgSvc.createSection(u, { name: nm() }, M()))).toBe('FORBIDDEN');
      expect(await code(orgSvc.createRank(u, { sectionId: SEC, name: nm() }, M()))).toBe('FORBIDDEN');
      expect(await code(orgSvc.updateRank(u, RK_OTHER, { name: nm() }, M()))).toBe('FORBIDDEN');
      expect(await code(orgSvc.updateSection(u, SEC, { name: nm() }, M()))).toBe('FORBIDDEN');
      expect(await code(orgSvc.moveItem(u, 'rank', RK_OTHER, 'up', M()))).toBe('FORBIDDEN');
    }
    expect(await code(orgSvc.createSection(sa, { name: nm() }, M()))).toBe('OK');
    as(await tokenOf(captain));
    expect(await createRankAction(SEC, 'qa.p2.cap' + rand(4))).toMatchObject({ ok: true });
  });
  it('SEC2-051 Officer section and Captain rank are immutable (service and DB)', async () => {
    expect(await code(orgSvc.updateSection(captain, org.officer, { name: 'Renamed' }, M()))).toBe('FORBIDDEN');
    expect(await code(orgSvc.updateSection(sa, org.officer, { isActive: false }, M()))).toBe('FORBIDDEN');
    expect(await code(orgSvc.updateRank(captain, org.captainRankId, { name: 'King' }, M()))).toBe('FORBIDDEN');
    expect(await code(orgSvc.updateRank(sa, org.captainRankId, { isActive: false }, M()))).toBe('FORBIDDEN');
    const raw = [
      probe((tx) => tx.update(sections).set({ name: 'Hacked' }).where(eq(sections.id, org.officer))),
      probe((tx) => tx.update(sections).set({ isActive: false }).where(eq(sections.id, org.officer))),
      probe((tx) => tx.update(sections).set({ systemKey: null }).where(eq(sections.id, org.officer))),
      probe((tx) => tx.update(ranks).set({ name: 'Hacked' }).where(eq(ranks.id, org.captainRankId))),
      probe((tx) => tx.update(ranks).set({ isActive: false }).where(eq(ranks.id, org.captainRankId))),
      probe((tx) => tx.update(ranks).set({ systemKey: null }).where(eq(ranks.id, org.captainRankId))),
      probe((tx) => tx.delete(sections).where(eq(sections.id, org.officer))),
      probe((tx) => tx.delete(ranks).where(eq(ranks.id, org.captainRankId))),
      probe((tx) => tx.update(sections).set({ systemKey: 'officer' }).where(eq(sections.id, org.junior))),
    ];
    expect((await Promise.all(raw)).map((r) => r.failed)).toEqual(Array(raw.length).fill(true));
  });
  it('SEC2-052 name validation, duplicates and id fuzz', async () => {
    const mkSec = (name: any) => orgSvc.createSection(captain, { name }, M());
    for (const n of ['', '   ', 'x'.repeat(41), 5, null, undefined, {}, ['a']]) expect(await code(mkSec(n)), JSON.stringify(n)).toBe('VALIDATION');
    const base = 'qa.p2.d' + rand(5);
    await mkSec(base);
    expect(await code(mkSec(base))).toBe('VALIDATION');
    expect(await code(mkSec('  ' + base + '  '))).toBe('VALIDATION'); // trimmed dup
    expect(await code(orgSvc.createRank(captain, { sectionId: SEC, name: 'qa.plain' }, M()))).toBe('VALIDATION');
    for (const id of [0, -1, 1.5, 99999, 'x', null, undefined, 1e9]) {
      expect(await code(orgSvc.createRank(captain, { sectionId: id, name: 'qa.x' + rand(4) }, M())), String(id)).toBe('NOT_FOUND');
      expect(await code(orgSvc.updateRank(captain, id as any, { name: 'a' }, M())), String(id)).toBe('NOT_FOUND');
      expect(await code(orgSvc.updateSection(captain, id as any, { name: 'a' }, M())), String(id)).toBe('NOT_FOUND');
    }
    expect(await code(orgSvc.moveItem(captain, 'rank', RK_OTHER, 'sideways' as any, M()))).toBe('NOT_FOUND');
    expect(await code(orgSvc.moveItem(captain, 'nonsense' as any, RK_OTHER, 'up', M()))).toBe('OK'); // kind falls to rank branch - must not corrupt
  });
  it('SEC2-053 unknown "kind" is rejected generically by the action', async () => {
    as(await tokenOf(captain));
    const r: any = await updateOrgItemAction('users' as any, RK_OTHER, { name: 'x' });
    expect(r.ok).toBe(false);
    noRaw(r.message);
    const m: any = await moveOrgItemAction('users' as any, RK_OTHER, 'up');
    expect(m.ok).toBe(false);
    noRaw(m.message);
  });
  it('SEC2-054 [R-30] non-boolean isActive must not deactivate', async () => {
    const rk = (await orgSvc.createRank(captain, { sectionId: SEC, name: 'qa.b' + rand(5) }, M()))!.id;
    for (const v of ['false', 'no', null, 0, 'true']) {
      const r = await ex(orgSvc.updateRank(captain, rk, { isActive: v as any }, M()));
      const [row] = await db.select().from(ranks).where(eq(ranks.id, rk));
      expect(row.isActive, `isActive=${JSON.stringify(v)} -> ${r.ok ? 'ok' : r.code}`).toBe(true);
    }
    await orgSvc.updateRank(captain, rk, { isActive: false }, M());
  });
  it('SEC2-055 cannot deactivate in-use ranks/sections; nothing is hard-deleted', async () => {
    const x = await mk('inuse', { sectionId: SEC, rankId: RK_PLAIN });
    expect(await code(orgSvc.updateRank(captain, RK_PLAIN, { isActive: false }, M()))).toBe('VALIDATION');
    expect(await code(orgSvc.updateSection(captain, SEC, { isActive: false }, M()))).toBe('VALIDATION');
    expect((await db.select().from(ranks).where(eq(ranks.id, RK_PLAIN)))[0].isActive).toBe(true);
    const src = read('lib/server/org/service.ts');
    expect(/\.delete\(\s*(sections|ranks)/.test(src)).toBe(false);
    const [{ n }] = await db.select({ n: count() }).from(sections);
    expect(n).toBeGreaterThan(3);
    await db.update(users).set({ sectionId: org.junior, rankId: org.rk('Junior', 'Member') }).where(eq(users.id, x.id));
  });
  it('SEC2-056 inactive section: ranks cannot be created or reactivated under it', async () => {
    const s = (await orgSvc.createSection(captain, { name: 'qa.p2.i' + rand(5) }, M()))!.id;
    const r = (await orgSvc.createRank(captain, { sectionId: s, name: 'qa.r' }, M()))!.id;
    await orgSvc.updateRank(captain, r, { isActive: false }, M());
    await orgSvc.updateSection(captain, s, { isActive: false }, M());
    expect(await code(orgSvc.createRank(captain, { sectionId: s, name: 'qa.r2' }, M()))).toBe('VALIDATION');
    expect(await code(orgSvc.updateRank(captain, r, { isActive: true }, M()))).toBe('VALIDATION');
    expect(await code(promoteMembers(captain, { userIds: [plain.id], sectionId: s, rankId: r, reason: 'x' }, M()))).toBe('VALIDATION');
  });
  it('SEC2-057 every org change writes an audit entry by the actor', async () => {
    const s = (await orgSvc.createSection(sa, { name: 'qa.p2.a' + rand(5) }, M()))!.id;
    const r = (await orgSvc.createRank(sa, { sectionId: s, name: 'qa.a' }, M()))!.id;
    await orgSvc.updateRank(sa, r, { name: 'qa.a2' }, M());
    await orgSvc.moveItem(sa, 'rank', r, 'up', M());
    await orgSvc.updateRank(sa, r, { isActive: false }, M());
    const rows = await db.select({ a: auditLogs.action, who: auditLogs.actorId }).from(auditLogs).where(and(sql`((${auditLogs.entityType} = 'sections' and ${auditLogs.entityId} = ${String(s)}) or (${auditLogs.entityType} = 'ranks' and ${auditLogs.entityId} = ${String(r)}))`));
    expect(rows.map((x) => x.a)).toEqual(expect.arrayContaining(['SECTION_CREATED', 'RANK_CREATED', 'RANK_RENAMED', 'RANK_DEACTIVATED']));
    expect(rows.every((x) => x.who === sa.id)).toBe(true);
  });
  it('SEC2-058 concurrent duplicate create yields one row and a clean validation error', async () => {
    const name = 'qa.p2.c' + rand(5);
    const res = await Promise.all([1, 2, 3].map(() => ex(orgSvc.createSection(captain, { name }, M()))));
    expect(res.filter((r) => r.ok).length).toBe(1);
    for (const r of res.filter((x) => !x.ok)) { expect(r.code).toBe('VALIDATION'); noRaw(r.message); }
    expect((await db.select().from(sections).where(eq(sections.name, name))).length).toBe(1);
  });
});

// ───────────────────────────── E. Promotions ─────────────────────────────
describe('Phase 2 / promotions (batch rank change)', () => {
  const P = (u: CU, userIds: any, extra: Record<string, unknown> = {}) =>
    promoteMembers(u, { userIds, sectionId: org.junior, rankId: org.rk('Junior', 'Leading Boy'), reason: 'qa p2', ...extra } as any, M());
  it('SEC2-060 batch size limits: 0, 101, non-array; 100 ghosts cleanly refused', async () => {
    expect(await code(P(D1, []))).toBe('VALIDATION');
    expect(await code(P(D1, ids(101)))).toBe('VALIDATION');
    expect(await code(P(D1, 'abc'))).toBe('VALIDATION');
    expect(await code(P(D1, null))).toBe('VALIDATION');
    const t0 = Date.now();
    const r = await ex(P(D1, ids(100)));
    expect(r.code).toBe('VALIDATION');
    expect(Object.keys(r.fe ?? {}).length).toBe(100);
    expect(new Set(Object.values(r.fe)).size).toBe(1);
    noRaw(r.message);
    expect(Date.now() - t0).toBeLessThan(20000);
    const dup = await ex(P(D1, Array(500).fill(ids()[0]))); // duplicates collapse to 1, no DoS
    expect(dup.code).toBe('VALIDATION');
  });
  it('SEC2-061 all-or-nothing: one invalid member blocks the whole batch', async () => {
    const a = await mk('t'), b = await mk('t');
    const before = (await db.select().from(rankHistory)).length;
    const r = await ex(P(D1, [a.id, b.id, captain.id]));
    expect(r.code).toBe('VALIDATION');
    expect(Object.keys(r.fe)).toEqual([captain.id]);
    expect(r.fe[captain.id]).toBe('You cannot change this member.');
    expect(await rankOf(a.id)).toBe(org.rk('Junior', 'Member'));
    expect(await rankOf(b.id)).toBe(org.rk('Junior', 'Member'));
    expect((await db.select().from(rankHistory)).length).toBe(before);
    const aud = await db.select().from(auditLogs).where(and(eq(auditLogs.action, 'RANK_CHANGED'), inArray(auditLogs.entityId, [a.id, b.id])));
    expect(aud).toEqual([]);
  });
  it('SEC2-062 cannot promote self; Captain rank only via succession; cannot target Captain', async () => {
    const before = await rankOf(D1.id);
    const r = await ex(P(D1, [D1.id]));
    expect(r.code).toBe('VALIDATION');
    expect(Object.values(r.fe)).toEqual(['You cannot do this to your own account.']);
    expect(await rankOf(D1.id)).toBe(before);
    const t = await mk('t');
    for (const u of [captain, sa, D1]) {
      const rr = await ex(promoteMembers(u, { userIds: [t.id], sectionId: org.officer, rankId: org.captainRankId, reason: 'crown' }, M()));
      expect(rr.code, u.username).toBe('VALIDATION');
      expect(await rankOf(t.id)).toBe(org.rk('Junior', 'Member'));
    }
    const cr = await ex(promoteMembers(captain, { userIds: [captain.id], sectionId: org.junior, rankId: org.rk('Junior', 'Member'), reason: 'demote' }, M()));
    expect(cr.code).toBe('VALIDATION');
    expect(await rankOf(captain.id)).toBe(org.captainRankId);
    const raw = await probe((tx) => tx.update(users).set({ rankId: org.captainRankId, sectionId: org.officer }).where(eq(users.id, t.id)));
    expect(raw.failed).toBe(true);
  });
  it('SEC2-063 cannot touch someone with more permissions; Superadmin indistinguishable from a ghost', async () => {
    const rich = await mk('rich', { perms: ['users.update_status'] });
    const r = await ex(P(D1, [rich.id]));
    expect(Object.values(r.fe)).toEqual(['You cannot change this member.']);
    expect(await rankOf(rich.id)).toBe(org.rk('Junior', 'Member'));
    for (const u of [D1, captain]) {
      const a = await ex(P(u, [sa.id])), b = await ex(P(u, [randomUUID()]));
      expect(Object.values(a.fe)).toEqual(['Member not found.']);
      expect(Object.values(b.fe)).toEqual(['Member not found.']);
      expect(a.message).toBe(b.message);
    }
  });
  it('SEC2-064 requires users.change_rank and a reason; extra fields ignored', async () => {
    const t = await mk('t');
    for (const u of [plain, viewer]) {
      as(await tokenOf(u));
      expect(await promoteAction({ userIds: [t.id], sectionId: org.junior, rankId: org.rk('Junior', 'Leading Boy'), reason: 'x' })).toMatchObject({ ok: false, code: 'FORBIDDEN' });
    }
    as(await tokenOf(D1));
    for (const reason of ['', '   ', undefined as any, null as any]) expect(await code(P(D1, [t.id], { reason })), String(reason)).toBe('VALIDATION');
    const r: any = await promoteAction({ userIds: [t.id], sectionId: org.junior, rankId: org.rk('Junior', 'Leading Boy'), reason: 'ok', status: 'inactive', accountType: 'superadmin', changedBy: captain.id } as any);
    expect(r.ok).toBe(true);
    const u = await userRow(t.id);
    expect([u.status, u.accountType, u.updatedBy]).toEqual(['active', 'member', D1.id]);
  });
  it('SEC2-065 destination validation: mismatched, inactive, unknown, weird ids', async () => {
    const t = await mk('t');
    const bad: [any, any][] = [[org.junior, org.rk('Officer', 'Helper')], [org.officer, 0], [0, 0], [-1, 5], [1.5, 2], ['x', 'y'], [null, null], [999999, 999999], [org.junior, 1e9]];
    for (const [s, r] of bad) {
      const res = await ex(promoteMembers(captain, { userIds: [t.id], sectionId: s, rankId: r, reason: 'x' }, M()));
      expect(res.code, JSON.stringify([s, r])).toBe('VALIDATION');
      noRaw(res.message);
    }
    expect(await rankOf(t.id)).toBe(org.rk('Junior', 'Member'));
  });
  it('SEC2-066 inactive members and no-op promotions are refused per member', async () => {
    const t = await mk('t');
    expect(Object.values((await ex(promoteMembers(captain, { userIds: [t.id], sectionId: org.junior, rankId: org.rk('Junior', 'Member'), reason: 'x' }, M()))).fe)).toEqual(['Already holds this rank.']);
    await setStatus(captain, t.id, { status: 'inactive', reasonId: await reasonId() }, M());
    expect(Object.values((await ex(P(captain, [t.id]))).fe)).toEqual(['Member is inactive.']);
  });
  it('SEC2-067 success shares one change set across rank_history and audit', async () => {
    const a = await mk('t'), b = await mk('t');
    const res = await P(D1, [a.id, b.id, a.id]);
    expect(res.count).toBe(2);
    const hist = await db.select().from(rankHistory).where(and(eq(rankHistory.changeSetId, res.changeSetId)));
    expect(hist.map((h) => h.userId).sort()).toEqual([a.id, b.id].sort());
    expect(hist.every((h) => h.changedBy === D1.id)).toBe(true);
    const aud = await db.select().from(auditLogs).where(and(eq(auditLogs.changeSetId, res.changeSetId), eq(auditLogs.action, 'RANK_CHANGED')));
    expect(aud.length).toBe(2);
    expect(aud.every((x) => x.actorId === D1.id)).toBe(true);
  });
  it('SEC2-068 concurrent promotions of one member keep history consistent', async () => {
    const t = await mk('t');
    const rks = [org.rk('Junior', 'Leading Boy'), org.rk('Junior', 'Assisting Leading Boy'), org.rk('Junior', 'Chief-Leading Boy')];
    const res = await Promise.all(rks.map((rk) => ex(promoteMembers(captain, { userIds: [t.id], sectionId: org.junior, rankId: rk, reason: 'race' }, M()))));
    for (const r of res.filter((x) => !x.ok)) expect(['VALIDATION', 'CONFLICT']).toContain(r.code);
    const hist = await db.select().from(rankHistory).where(eq(rankHistory.userId, t.id)).orderBy(desc(rankHistory.changedAt));
    expect(hist.length).toBe(1 + res.filter((x) => x.ok).length);
    expect(hist.map((h) => h.toRankId)).toContain(await rankOf(t.id));
  });
  it('SEC2-069 [R-27] a delegate cannot promote someone into a rank that grants permissions the delegate lacks', async () => {
    const t = await mk('t');
    const r = await ex(promoteMembers(D1, { userIds: [t.id], sectionId: SEC, rankId: RK_RICH, reason: 'qa p2' }, M()));
    const gotReset = (await loadPermissions(t.id)).has('users.update_status');
    expect(gotReset ? 'member received users.update_status the promoter does not hold' : 'refused').toBe('refused');
    expect(r.ok && gotReset).toBe(false);
    await db.update(users).set({ sectionId: org.junior, rankId: org.rk('Junior', 'Member') }).where(eq(users.id, t.id));
  });
  it('SEC2-070 promoting into the same rank grants nothing the Captain did not configure', async () => {
    const t = await mk('t');
    await promoteMembers(captain, { userIds: [t.id], sectionId: SEC, rankId: RK_RICH, reason: 'qa' }, M());
    expect([...(await loadPermissions(t.id))].sort()).toEqual(['users.update_status', 'users.view']);
    await promoteMembers(captain, { userIds: [t.id], sectionId: SEC, rankId: RK_PLAIN, reason: 'qa' }, M());
    expect([...(await loadPermissions(t.id))]).toEqual([]);
  });
});

// ───────────────────────────── F. Effective permissions ─────────────────────────────
describe('Phase 2 / effective permission calculation', () => {
  it('SEC2-080 resolvePermissions: (role ∪ rank) + ALLOW − DENY, unknown slugs dropped', () => {
    const s = resolvePermissions(['users.view', 'users.create', 'ghost'], [{ slug: 'users.create', effect: 'deny' }, { slug: 'audit.view', effect: 'allow' }, { slug: 'ghost2', effect: 'allow' }]);
    expect([...s].sort()).toEqual(['audit.view', 'users.view']);
  });
  it('SEC2-081 rank grants apply, DENY beats rank grant, inactive role gives nothing', async () => {
    const t = await mk('t', { sectionId: SEC, rankId: RK_RICH });
    expect([...(await loadPermissions(t.id))].sort()).toEqual(['users.update_status', 'users.view']);
    await setOv(t.id, 'users.update_status', 'deny');
    expect((await loadPermissions(t.id)).has('users.update_status')).toBe(false);
    const dead = await newRole(['audit.view'], false);
    await db.insert(userRoles).values({ userId: t.id, roleId: dead });
    expect((await loadPermissions(t.id)).has('audit.view')).toBe(false);
    await db.update(users).set({ sectionId: org.junior, rankId: org.rk('Junior', 'Member') }).where(eq(users.id, t.id));
    expect((await loadPermissions(t.id)).has('users.view')).toBe(false);
  });
  it('SEC2-082 Captain and Superadmin always hold everything; Captain rank has no stored grants', async () => {
    expect((await getPermissionsFor(captain)).size).toBe(ALL_PERMISSIONS.length);
    expect((await getPermissionsFor(sa)).size).toBe(ALL_PERMISSIONS.length);
    expect((await db.select().from(rankPermissions).where(eq(rankPermissions.rankId, org.captainRankId))).length).toBe(0);
  });
  it('SEC2-083 deactivated members cannot use delegated rights', async () => {
    const dd = await mk('dd', { perms: ['permissions.manage', 'users.view'], officer: true });
    const tk = await mint(dd.id);
    await setStatus(captain, dd.id, { status: 'inactive', reasonId: await reasonId() }, M());
    as(tk);
    const r: any = await redirectOf(saveUserAccessAction(plain.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow' }] }));
    expect(r).toBe('/login');
  });
});

// ───────────────────────────── G. Static and HTTP ─────────────────────────────
describe('Phase 2 / static and HTTP', () => {
  it('SEC2-090 every exported action in access/org/users authenticates', () => {
    for (const f of ['access.ts', 'org.ts']) {
      for (const part of read(`app/actions/${f}`).split('export async function ').slice(1)) {
        expect(/requirePermission\(|requireUser\(/.test(part), `${f}:${part.split('(')[0]}`).toBe(true);
      }
    }
    const u = read('app/actions/users.ts');
    expect(/export async function promoteAction[\s\S]*?requirePermission\('users\.change_rank'\)/.test(u)).toBe(true);
  });
  it('SEC2-091 every org mutator asserts Captain/Superadmin; access mutators check permission or Captain', () => {
    const o = read('lib/server/org/service.ts');
    for (const fn of ['createSection', 'createRank', 'updateSection', 'updateRank', 'moveItem']) {
      const body = o.split(`export async function ${fn}(`)[1].split('\nexport ')[0];
      expect(body.includes('assertOrgAdmin(actor)'), fn).toBe(true);
    }
    const a = read('lib/server/access/service.ts');
    for (const fn of ['getUserAccess', 'saveRole', 'saveRankAccess', 'saveUserAccess', 'listRequests']) {
      expect(a.split(`export async function ${fn}(`)[1].split('\nexport ')[0].includes('assertCanManageAccess(actor)'), fn).toBe(true);
    }
    expect(a.split('export async function decideRequest(')[1].split('\n')[1]).toMatch(/isCaptain/);
  });
  it('SEC2-092 phase-2 pages gate on login/permission server-side', () => {
    const pages = walk(path.join(ROOT, 'app')).filter((f) => /[\\/](maintenance|promotions)[\\/].*page\.tsx$|users[\\/]\[id\][\\/]access[\\/]page\.tsx$/.test(f));
    expect(pages.length).toBeGreaterThanOrEqual(7);
    const bad = pages.filter((f) => !/maintenanceAccess\(|requireUser\(|can\(/.test(readFileSync(f, 'utf8'))).map((f) => path.relative(ROOT, f));
    expect(bad).toEqual([]);
    const org = read('app/maintenance/organization/page.tsx') + read('app/maintenance/approvals/page.tsx');
    expect(/orgAdmin|isCaptain|isPrivileged/.test(org)).toBe(true);
  });
  it('SEC2-093 layout only computes the pending count through the service (no raw query, no names)', () => {
    const l = read('app/layout.tsx');
    expect(l).toContain('pendingRequestCount(user)');
    expect(/permissionChangeRequests/.test(l)).toBe(false);
    expect(read('lib/server/access/service.ts')).toMatch(/pendingRequestCount[\s\S]{0,120}if \(!actor\.isCaptain\) return 0/);
  });
  it('SEC2-094 unauthenticated requests to phase-2 pages redirect to /login; members see no admin data', async () => {
    let up = true;
    try { await fetch(BASE + '/login', { redirect: 'manual' }); } catch { up = false; }
    if (!up) return;
    const paths = ['/maintenance', '/maintenance/roles', `/maintenance/roles/${ROLE_VIEW}`, '/maintenance/approvals', '/maintenance/organization', '/maintenance/rank-permissions', '/promotions', `/users/${plain.id}/access`];
    for (const p of paths) {
      const r = await fetch(BASE + p, { redirect: 'manual' });
      expect([r.status, r.headers.get('location') ?? ''].join(' '), p).toMatch(/^30[78] .*\/login/);
    }
    const t = await mint(plain.id);
    const roleName = (await db.select().from(roles).where(eq(roles.id, ROLE_VIEW)))[0].name;
    for (const p of ['/maintenance/roles', '/maintenance/approvals', '/maintenance/organization', '/maintenance/rank-permissions', `/users/${D1.id}/access`, '/promotions']) {
      const r = await fetch(BASE + p, { redirect: 'manual', headers: { Cookie: `bb6_session=${t}` } });
      const body = await r.text();
      expect(body, p).not.toContain(roleName);
      expect(body, p).not.toContain(D1.username);
      expect(r.headers.get('cache-control') ?? '').toMatch(/no-store/);
    }
  });
});
