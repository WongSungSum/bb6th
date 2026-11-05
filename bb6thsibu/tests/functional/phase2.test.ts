// Phase 2 functional tests: permission model, batch promotions, access management, ranks & sections.
// Service-level against the local dev DB. Rows cannot be deleted; fixtures use the qa. prefix and are
// deactivated / rejected in afterAll so the dev UI stays clean.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLogs, inactiveReasons, permissionChangeRequests, rankHistory, rankPermissions, ranks, roles, sections, userPermissionOverrides, users } from '@/lib/db/schema';
import type { CurrentUser } from '@/lib/server/auth/session';
import { can, getPermissionsFor, loadPermissions, resolvePermissions } from '@/lib/server/authz';
import { ALL_PERMISSIONS, type PermissionSlug } from '@/lib/server/authz/catalog';
import {
  cancelRequest, decideRequest, getRole, getUserAccess, listRankAccess, listRequests, listRoles, pendingRequestCount,
  saveRankAccess, saveRole, saveUserAccess,
} from '@/lib/server/access/service';
import { createRank, createSection, listOrg, moveItem, updateRank, updateSection } from '@/lib/server/org/service';
import { changeRank, promoteMembers, setStatus } from '@/lib/server/users/service';
import { actor, err, makeUser, meta, rankId, RUN } from './helpers';

let cap: CurrentUser, officer: CurrentUser, sa: CurrentUser | null = null;
let S1: number, S2: number;
const R = {} as Record<'a' | 'b' | 'c' | 'x' | 'off', { id: number; sectionId: number }>; // a,b,c in S1; x in S2; off = Officer/Lieutenant
const members: string[] = [];
const delegates: string[] = [];
const roleIds: number[] = [];
const SEQ = { n: 0 };
const nm = (t: string) => `qa.${RUN}.${t}${++SEQ.n}`;
const GHOST = '00000000-0000-4000-8000-000000000000';

async function mk(rank = R.a) {
  const m = await makeUser(cap, { sectionId: rank.sectionId, rankId: rank.id });
  members.push(m.id);
  return { id: m.id, username: m.input.username };
}
async function grant(id: string, slugs: PermissionSlug[]) {
  await saveUserAccess(cap, id, { roleIds: [], overrides: slugs.map((slug) => ({ slug, effect: 'allow', reason: null })) }, meta);
}
/** member with the given personal ALLOW permissions, returned as an acting user */
async function delegate(slugs: PermissionSlug[], rank = R.a) {
  const m = await mk(rank);
  if (slugs.length) await grant(m.id, slugs);
  delegates.push(m.id);
  return { ...m, user: await actor(m.username) };
}
const mkRole = async (perms: PermissionSlug[] = [], isActive = true) => {
  const name = nm('role');
  await saveRole(cap, null, { name, description: 'qa', isActive, permissions: perms }, meta);
  const [r] = await db.select().from(roles).where(eq(roles.name, name));
  roleIds.push(r.id);
  return r;
};
const pendingReq = async (requester: string, kind?: 'user_access' | 'role' | 'rank_access') =>
  (await db.select().from(permissionChangeRequests).where(and(eq(permissionChangeRequests.requestedBy, requester), eq(permissionChangeRequests.status, 'pending'), kind ? eq(permissionChangeRequests.kind, kind) : undefined)).orderBy(desc(permissionChangeRequests.requestedAt)))[0];
const rankOf = async (id: string) => (await db.select({ r: users.rankId, s: users.sectionId }).from(users).where(eq(users.id, id)))[0];
const noNoteReason = async () => (await db.select({ id: inactiveReasons.id }).from(inactiveReasons).where(and(eq(inactiveReasons.requiresNote, false), eq(inactiveReasons.isActive, true))).limit(1))[0].id;
const MANAGE: PermissionSlug[] = ['permissions.manage'];
const ov = (slug: PermissionSlug, effect: 'allow' | 'deny' | 'inherit', reason: string | null = null) => ({ slug, effect, reason });

beforeAll(async () => {
  [cap, officer] = await Promise.all([actor('dev.captain'), actor('dev.officer')]);
  const [s] = await db.select().from(users).where(eq(users.accountType, 'superadmin')).limit(1);
  if (s) sa = { ...cap, id: s.id, username: s.username, isSuperadmin: true, isCaptain: false, accountType: 'superadmin' } as CurrentUser;
  S1 = (await createSection(cap, { name: `QA P2 ${RUN} A` }, meta))!.id;
  S2 = (await createSection(cap, { name: `QA P2 ${RUN} B` }, meta))!.id;
  for (const k of ['a', 'b', 'c'] as const) R[k] = { id: (await createRank(cap, { sectionId: S1, name: `QA ${k.toUpperCase()}` }, meta))!.id, sectionId: S1 };
  R.x = { id: (await createRank(cap, { sectionId: S2, name: 'QA X' }, meta))!.id, sectionId: S2 };
  R.off = await rankId('Officer', 'Lieutenant');
});

afterAll(async () => {
  try {
    const pend = delegates.length ? await db.select().from(permissionChangeRequests).where(and(inArray(permissionChangeRequests.requestedBy, delegates), eq(permissionChangeRequests.status, 'pending'))) : [];
    for (const p of pend) await decideRequest(cap, p.id, 'reject', 'qa cleanup', meta).catch(() => {});
    for (const id of roleIds) {
      const r = await getRole(id);
      if (r?.isActive) await saveRole(cap, id, { name: r.name, description: r.description, isActive: false, permissions: r.permissions }, meta).catch(() => {});
    }
    const reason = await noNoteReason();
    for (const id of members) await setStatus(cap, id, { status: 'inactive', reasonId: reason }, meta).catch(() => {});
    const all = await db.select({ id: ranks.id }).from(ranks).where(inArray(ranks.sectionId, [S1, S2]));
    for (const r of all) await updateRank(cap, r.id, { isActive: false }, meta).catch(() => {});
    for (const s of [S1, S2]) await updateSection(cap, s, { isActive: false }, meta).catch(() => {});
  } catch (e) {
    console.warn('phase2 cleanup issue', e);
  }
});

// ───────────────────────── A. permission resolution ─────────────────────────
describe('A permission model', () => {
  it('FN2-PERM-001 resolvePermissions: grants + ALLOW - DENY, deny wins over grant', () => {
    const r = resolvePermissions(['users.view', 'users.update'], [{ slug: 'users.create', effect: 'allow' }, { slug: 'users.update', effect: 'deny' }]);
    expect([...r].sort()).toEqual(['users.create', 'users.view']);
  });
  it('FN2-PERM-002 resolvePermissions ignores unknown slugs', () => {
    expect([...resolvePermissions(['nope.x', 'users.view'], [{ slug: 'also.nope', effect: 'allow' }])]).toEqual(['users.view']);
  });
  it('FN2-PERM-003 member with no grants has no permissions', async () => {
    const m = await mk();
    expect((await loadPermissions(m.id)).size).toBe(0);
  });
  it('FN2-PERM-004 rank grant gives the permission to every holder of that rank only', async () => {
    const m = await mk(R.b);
    await saveRankAccess(cap, R.b.id, { permissions: ['users.view'] }, meta);
    expect((await loadPermissions(m.id)).has('users.view')).toBe(true);
    const other = await mk(R.c);
    expect((await loadPermissions(other.id)).has('users.view')).toBe(false);
  });
  it('FN2-PERM-005 role grants and rank grants are unioned', async () => {
    const m = await mk(R.b);
    const role = await mkRole(['users.create']);
    await saveUserAccess(cap, m.id, { roleIds: [role.id], overrides: [] }, meta);
    const p = await loadPermissions(m.id);
    expect(p.has('users.view')).toBe(true); // rank B
    expect(p.has('users.create')).toBe(true); // role
  });
  it('FN2-PERM-006 inactive role grants nothing but the rank grant stays', async () => {
    const m = await mk(R.b);
    const role = await mkRole(['users.update']);
    await saveUserAccess(cap, m.id, { roleIds: [role.id], overrides: [] }, meta);
    expect((await loadPermissions(m.id)).has('users.update')).toBe(true);
    await saveRole(cap, role.id, { name: role.name, description: 'qa', isActive: false, permissions: ['users.update'] }, meta);
    const p = await loadPermissions(m.id);
    expect(p.has('users.update')).toBe(false);
    expect(p.has('users.view')).toBe(true);
  });
  it('FN2-PERM-007 per-user ALLOW adds a permission nobody else gives', async () => {
    const m = await mk();
    await grant(m.id, ['audit.view']);
    expect((await loadPermissions(m.id)).has('audit.view')).toBe(true);
  });
  it('FN2-PERM-008 per-user DENY removes a rank-granted permission', async () => {
    const m = await mk(R.b);
    await saveUserAccess(cap, m.id, { roleIds: [], overrides: [ov('users.view', 'deny', 'qa')] }, meta);
    expect((await loadPermissions(m.id)).has('users.view')).toBe(false);
  });
  it('FN2-PERM-009 per-user DENY removes a role-granted permission', async () => {
    const m = await mk();
    const role = await mkRole(['users.update']);
    await saveUserAccess(cap, m.id, { roleIds: [role.id], overrides: [ov('users.update', 'deny')] }, meta);
    expect((await loadPermissions(m.id)).has('users.update')).toBe(false);
  });
  it('FN2-PERM-010 setting back to Default restores the inherited permission', async () => {
    const m = await mk(R.b);
    await saveUserAccess(cap, m.id, { roleIds: [], overrides: [ov('users.view', 'deny')] }, meta);
    await saveUserAccess(cap, m.id, { roleIds: [], overrides: [ov('users.view', 'inherit')] }, meta);
    expect((await loadPermissions(m.id)).has('users.view')).toBe(true);
  });
  it('FN2-PERM-011 changing rank changes inherited rank grants immediately', async () => {
    const m = await mk(R.b);
    await promoteMembers(cap, { userIds: [m.id], sectionId: R.c.sectionId, rankId: R.c.id, reason: 'qa move' }, meta);
    expect((await loadPermissions(m.id)).has('users.view')).toBe(false);
  });
  it('FN2-PERM-012 Captain has every permission without any grants', async () => {
    expect([...(await getPermissionsFor(cap))].sort()).toEqual([...ALL_PERMISSIONS].sort());
    expect(await can(cap, 'permissions.manage')).toBe(true);
  });
  it('FN2-PERM-013 Superadmin has every permission', async () => {
    if (!sa) return;
    expect((await getPermissionsFor(sa)).size).toBe(ALL_PERMISSIONS.length);
  });
  it('FN2-PERM-014 can() throws on an unknown permission slug', async () => {
    await expect(can(cap, 'nope.nope' as never)).rejects.toThrow(/Unknown permission/);
  });
  it('FN2-PERM-015 dev.officer (Member Admin role) lacks change_rank and permissions.manage', async () => {
    const p = await getPermissionsFor(officer);
    expect(p.has('users.change_rank')).toBe(false);
    expect(p.has('permissions.manage')).toBe(false);
  });
  it('FN2-PERM-016 permission catalog includes users.change_rank and permissions.manage', () => {
    expect(ALL_PERMISSIONS).toContain('users.change_rank');
    expect(ALL_PERMISSIONS).toContain('permissions.manage');
  });
});

// ───────────────────────── B. batch promotions ─────────────────────────
describe('B batch promotions', () => {
  // createUser writes an initial history row (from null); only promotions have a from-rank
  const hist = (id: string) => db.select().from(rankHistory).where(and(eq(rankHistory.userId, id), sql`${rankHistory.fromRankId} is not null`));
  it('FN2-PROMO-001 promotes several members to one section+rank', async () => {
    const [a, b, c] = [await mk(), await mk(), await mk()];
    const res = await promoteMembers(cap, { userIds: [a.id, b.id, c.id], sectionId: R.b.sectionId, rankId: R.b.id, reason: 'Batch QA' }, meta);
    expect(res.count).toBe(3);
    for (const m of [a, b, c]) expect((await rankOf(m.id)).r).toBe(R.b.id);
  });
  it('FN2-PROMO-002 whole batch shares one change_set_id in rank_history and audit_logs', async () => {
    const [a, b] = [await mk(), await mk()];
    const res = await promoteMembers(cap, { userIds: [a.id, b.id], sectionId: R.b.sectionId, rankId: R.b.id, reason: 'Shared set' }, meta);
    const h = [...(await hist(a.id)), ...(await hist(b.id))];
    expect(h).toHaveLength(2);
    expect(new Set(h.map((x) => x.changeSetId))).toEqual(new Set([res.changeSetId]));
    const au = await db.select().from(auditLogs).where(and(eq(auditLogs.changeSetId, res.changeSetId), eq(auditLogs.action, 'RANK_CHANGED')));
    expect(au.map((x) => x.entityId).sort()).toEqual([a.id, b.id].sort());
    expect(h.every((x) => x.reason === 'Shared set' && x.changedBy === cap.id)).toBe(true);
  });
  it('FN2-PROMO-003 two separate batches get different change_set_ids', async () => {
    const a = await mk();
    const r1 = await promoteMembers(cap, { userIds: [a.id], sectionId: R.b.sectionId, rankId: R.b.id, reason: 'one' }, meta);
    const r2 = await promoteMembers(cap, { userIds: [a.id], sectionId: R.c.sectionId, rankId: R.c.id, reason: 'two' }, meta);
    expect(r1.changeSetId).not.toBe(r2.changeSetId);
  });
  it('FN2-PROMO-004 rank_history records from and to section/rank (cross-section)', async () => {
    const a = await mk();
    await promoteMembers(cap, { userIds: [a.id], sectionId: R.x.sectionId, rankId: R.x.id, reason: 'cross section' }, meta);
    const [h] = await hist(a.id);
    expect([h.fromSectionId, h.fromRankId, h.toSectionId, h.toRankId]).toEqual([R.a.sectionId, R.a.id, R.x.sectionId, R.x.id]);
    expect(await rankOf(a.id)).toEqual({ r: R.x.id, s: R.x.sectionId });
  });
  it('FN2-PROMO-005 one failing member rolls back the whole batch (already-that-rank)', async () => {
    const [ok, same] = [await mk(R.a), await mk(R.b)];
    const e = await err(() => promoteMembers(cap, { userIds: [ok.id, same.id], sectionId: R.b.sectionId, rankId: R.b.id, reason: 'x' }, meta));
    expect(e?.code).toBe('VALIDATION');
    expect(Object.keys(e!.fieldErrors!)).toEqual([same.id]);
    expect(e!.fieldErrors![same.id]).toMatch(/already holds/i);
    expect((await rankOf(ok.id)).r).toBe(R.a.id);
    expect(await hist(ok.id)).toHaveLength(0);
  });
  it('FN2-PROMO-006 inactive member fails with per-member message', async () => {
    const [ok, dead] = [await mk(), await mk()];
    await setStatus(cap, dead.id, { status: 'inactive', reasonId: await noNoteReason() }, meta);
    const e = await err(() => promoteMembers(cap, { userIds: [ok.id, dead.id], sectionId: R.b.sectionId, rankId: R.b.id, reason: 'x' }, meta));
    expect(e!.fieldErrors![dead.id]).toMatch(/inactive/i);
    expect((await rankOf(ok.id)).r).toBe(R.a.id);
  });
  it('FN2-PROMO-007 unknown member id -> "Member not found." and nothing saved', async () => {
    const ok = await mk();
    const e = await err(() => promoteMembers(cap, { userIds: [ok.id, GHOST], sectionId: R.b.sectionId, rankId: R.b.id, reason: 'x' }, meta));
    expect(e!.fieldErrors![GHOST]).toBe('Member not found.');
    expect((await rankOf(ok.id)).r).toBe(R.a.id);
  });
  it('FN2-PROMO-008 non-uuid id is reported per member, not a server error', async () => {
    const e = await err(() => promoteMembers(cap, { userIds: ['not-a-uuid'], sectionId: R.b.sectionId, rankId: R.b.id, reason: 'x' }, meta));
    expect(e?.code).toBe('VALIDATION');
    expect(e!.fieldErrors!['not-a-uuid']).toBe('Member not found.');
  });
  it('FN2-PROMO-009 actor cannot promote themselves (even Captain)', async () => {
    const ok = await mk();
    const e = await err(() => promoteMembers(cap, { userIds: [ok.id, cap.id], sectionId: R.b.sectionId, rankId: R.b.id, reason: 'x' }, meta));
    expect(e!.fieldErrors![cap.id]).toBeTruthy();
    expect((await rankOf(ok.id)).r).toBe(R.a.id);
  });
  it('FN2-PROMO-010 delegate cannot promote the Captain', async () => {
    const d = await delegate(['users.change_rank', 'users.view'], R.off);
    const e = await err(() => promoteMembers(d.user, { userIds: [cap.id], sectionId: R.b.sectionId, rankId: R.b.id, reason: 'x' }, meta));
    expect(e!.fieldErrors![cap.id]).toMatch(/cannot change/i);
  });
  it('FN2-PROMO-011 Superadmin cannot move the Captain (succession only)', async () => {
    if (!sa) return;
    const e = await err(() => promoteMembers(sa!, { userIds: [cap.id], sectionId: R.b.sectionId, rankId: R.b.id, reason: 'x' }, meta));
    expect(e!.fieldErrors![cap.id]).toMatch(/succession/i);
  });
  it('FN2-PROMO-012 delegate cannot promote a member who holds more permissions than they do', async () => {
    const d = await delegate(['users.change_rank'], R.off);
    const strong = await mk();
    await grant(strong.id, ['users.create']);
    const weak = await mk();
    // R.c 不带军阶权限（R.b 有，会被 R-27 规则整批拒绝）
    const e = await err(() => promoteMembers(d.user, { userIds: [weak.id, strong.id], sectionId: R.c.sectionId, rankId: R.c.id, reason: 'x' }, meta));
    expect(e!.fieldErrors![strong.id]).toMatch(/cannot change/i);
    expect(e!.fieldErrors![weak.id]).toBeUndefined();
    expect((await rankOf(weak.id)).r).toBe(R.a.id);
  });
  it('FN2-PROMO-013 delegate with change_rank can promote ordinary members', async () => {
    const d = await delegate(['users.change_rank'], R.off);
    const t = await mk();
    await promoteMembers(d.user, { userIds: [t.id], sectionId: R.c.sectionId, rankId: R.c.id, reason: 'delegate' }, meta);
    expect((await rankOf(t.id)).r).toBe(R.c.id);
  });
  it('FN2-PROMO-014 delegate cannot promote themselves', async () => {
    const d = await delegate(['users.change_rank'], R.off);
    const e = await err(() => promoteMembers(d.user, { userIds: [d.id], sectionId: R.c.sectionId, rankId: R.c.id, reason: 'x' }, meta));
    expect(e!.fieldErrors![d.id]).toMatch(/own account/i);
  });
  it('FN2-PROMO-015 empty selection rejected', async () => {
    const e = await err(() => promoteMembers(cap, { userIds: [], sectionId: R.b.sectionId, rankId: R.b.id, reason: 'x' }, meta));
    expect(e?.fieldErrors?.userIds).toBeTruthy();
  });
  it('FN2-PROMO-016 101 members rejected with limit message', async () => {
    const ids = Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
    const e = await err(() => promoteMembers(cap, { userIds: ids, sectionId: R.b.sectionId, rankId: R.b.id, reason: 'x' }, meta));
    expect(e?.fieldErrors?.userIds).toMatch(/100/);
  });
  it('FN2-PROMO-017 exactly 100 ids pass the size check (fail only per member)', async () => {
    const ids = Array.from({ length: 100 }, (_, i) => `00000000-0000-4000-9000-${String(i).padStart(12, '0')}`);
    const e = await err(() => promoteMembers(cap, { userIds: ids, sectionId: R.b.sectionId, rankId: R.b.id, reason: 'x' }, meta));
    expect(e?.fieldErrors?.userIds).toBeUndefined();
    expect(Object.keys(e!.fieldErrors!)).toHaveLength(100);
  });
  it('FN2-PROMO-018 duplicate ids in the selection are de-duplicated', async () => {
    const a = await mk();
    const res = await promoteMembers(cap, { userIds: [a.id, a.id], sectionId: R.b.sectionId, rankId: R.b.id, reason: 'dup' }, meta);
    expect(res.count).toBe(1);
    expect(await hist(a.id)).toHaveLength(1);
  });
  it('FN2-PROMO-019 reason is required and max 500 chars', async () => {
    const a = await mk();
    for (const reason of ['', '   ', 'x'.repeat(501)]) {
      const e = await err(() => promoteMembers(cap, { userIds: [a.id], sectionId: R.b.sectionId, rankId: R.b.id, reason }, meta));
      expect(e?.fieldErrors?.reason, `len ${reason.length}`).toBeTruthy();
    }
    await promoteMembers(cap, { userIds: [a.id], sectionId: R.b.sectionId, rankId: R.b.id, reason: 'x'.repeat(500) }, meta);
  });
  it('FN2-PROMO-020 rank must belong to the section; wrong section rejected', async () => {
    const a = await mk();
    const e = await err(() => promoteMembers(cap, { userIds: [a.id], sectionId: R.x.sectionId, rankId: R.b.id, reason: 'x' }, meta));
    expect(e?.fieldErrors?.rankId).toBeTruthy();
  });
  it('FN2-PROMO-021 Captain rank cannot be a promotion target', async () => {
    const a = await mk();
    const [c] = await db.select({ id: ranks.id, sectionId: ranks.sectionId }).from(ranks).where(eq(ranks.systemKey, 'captain'));
    const e = await err(() => promoteMembers(cap, { userIds: [a.id], sectionId: c.sectionId, rankId: c.id, reason: 'x' }, meta));
    expect(e?.fieldErrors?.rankId).toBeTruthy();
  });
  it('FN2-PROMO-022 non-numeric / out-of-range ranks rejected', async () => {
    const a = await mk();
    for (const [s, r] of [[NaN, NaN], [0, 0], [-1, -1], [99999, 99999], [1.5, 2.5]]) {
      const e = await err(() => promoteMembers(cap, { userIds: [a.id], sectionId: s, rankId: r, reason: 'x' }, meta));
      expect(e?.code, `${s}/${r}`).toBe('VALIDATION');
    }
  });
  it('FN2-PROMO-023 deactivated rank cannot be a target', async () => {
    const rk = (await createRank(cap, { sectionId: S1, name: nm('tmp') }, meta))!.id;
    await updateRank(cap, rk, { isActive: false }, meta);
    const a = await mk();
    const e = await err(() => promoteMembers(cap, { userIds: [a.id], sectionId: S1, rankId: rk, reason: 'x' }, meta));
    expect(e?.fieldErrors?.rankId).toBeTruthy();
  });
  it('FN2-PROMO-024 move to Officer-section rank works; audit carries before/after rank', async () => {
    const a = await mk();
    const [h] = await db.select({ id: ranks.id, sectionId: ranks.sectionId }).from(ranks).innerJoin(sections, eq(sections.id, ranks.sectionId)).where(and(eq(sections.systemKey, 'officer'), eq(ranks.name, 'Helper')));
    await promoteMembers(cap, { userIds: [a.id], sectionId: h.sectionId, rankId: h.id, reason: 'to officer' }, meta);
    const [au] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, a.id), eq(auditLogs.action, 'RANK_CHANGED')));
    expect((au.before as { rankId: number }).rankId).toBe(R.a.id);
    expect((au.after as { rankId: number }).rankId).toBe(h.id);
    await promoteMembers(cap, { userIds: [a.id], sectionId: R.a.sectionId, rankId: R.a.id, reason: 'back' }, meta);
  });
  it('FN2-PROMO-025 failed batch writes no RANK_CHANGED audit rows', async () => {
    const [ok, same] = [await mk(R.a), await mk(R.b)];
    const cnt = async () => (await db.select({ n: sql<number>`count(*)::int` }).from(auditLogs).where(eq(auditLogs.action, 'RANK_CHANGED')))[0].n;
    const before = await cnt();
    await err(() => promoteMembers(cap, { userIds: [ok.id, same.id], sectionId: R.b.sectionId, rankId: R.b.id, reason: 'x' }, meta));
    expect(await cnt()).toBe(before);
  });
  it('FN2-PROMO-026 several failing members are all listed together', async () => {
    const [a, b, c] = [await mk(R.b), await mk(R.b), await mk(R.a)];
    const e = await err(() => promoteMembers(cap, { userIds: [a.id, b.id, c.id], sectionId: R.b.sectionId, rankId: R.b.id, reason: 'x' }, meta));
    expect(Object.keys(e!.fieldErrors!).sort()).toEqual([a.id, b.id].sort());
    expect(e!.message).toMatch(/2 of 3/);
  });
  it('FN2-PROMO-027 changeRank() single-person wrapper still works and writes history', async () => {
    const a = await mk();
    await changeRank(cap, a.id, { sectionId: R.c.sectionId, rankId: R.c.id, reason: 'single' }, meta);
    expect(await hist(a.id)).toHaveLength(1);
  });
  it('FN2-PROMO-028 changeRank() same rank -> rankId field error; unknown id -> NOT_FOUND', async () => {
    const a = await mk();
    expect((await err(() => changeRank(cap, a.id, { sectionId: R.a.sectionId, rankId: R.a.id, reason: 'x' }, meta)))?.fieldErrors?.rankId).toBeTruthy();
    expect((await err(() => changeRank(cap, GHOST, { sectionId: R.a.sectionId, rankId: R.b.id, reason: 'x' }, meta)))?.code).toBe('NOT_FOUND');
  });
  it('FN2-PROMO-029 permission gate: users.change_rank is required at the action layer (service has no gate)', async () => {
    const none = await delegate([]);
    expect(await can(none.user, 'users.change_rank')).toBe(false);
    const withIt = await delegate(['users.change_rank'], R.off);
    expect(await can(withIt.user, 'users.change_rank')).toBe(true);
    // 只限军官：军员就算被给了也不生效
    const boy = await delegate(['users.change_rank']);
    expect(await can(boy.user, 'users.change_rank')).toBe(false);
  });
});

// ───────────────────────── C. rank permissions ─────────────────────────
describe('C rank permissions', () => {
  const newRank = async () => (await createRank(cap, { sectionId: S1, name: nm('rk') }, meta))!.id;
  const slugsOf = async (rk: number) => (await db.select().from(rankPermissions).where(eq(rankPermissions.rankId, rk))).map((x) => x.permissionSlug).sort();
  it('FN2-RANKACC-001 Captain edits rank permissions: applied immediately + audit', async () => {
    const rk = await newRank();
    const res = await saveRankAccess(cap, rk, { permissions: ['users.view', 'audit.view'] }, meta);
    expect(res.status).toBe('applied');
    expect(await slugsOf(rk)).toEqual(['audit.view', 'users.view']);
    const au = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'rank_permissions'), eq(auditLogs.entityId, String(rk))));
    expect(au[0].action).toBe('ACCESS_CHANGED');
  });
  it('FN2-RANKACC-002 un-ticking removes the grant', async () => {
    const rk = await newRank();
    await saveRankAccess(cap, rk, { permissions: ['users.view', 'audit.view'] }, meta);
    await saveRankAccess(cap, rk, { permissions: ['users.view'] }, meta);
    expect(await slugsOf(rk)).toEqual(['users.view']);
  });
  it('FN2-RANKACC-003 Captain rank is not editable', async () => {
    const [c] = await db.select({ id: ranks.id }).from(ranks).where(eq(ranks.systemKey, 'captain'));
    expect((await err(() => saveRankAccess(cap, c.id, { permissions: ['users.view'] }, meta)))?.code).toBe('VALIDATION');
  });
  it('FN2-RANKACC-004 no change -> "Nothing has changed."', async () => {
    expect((await err(() => saveRankAccess(cap, R.c.id, { permissions: [] }, meta)))?.message).toMatch(/nothing has changed/i);
  });
  it('FN2-RANKACC-005 unknown permission slug / unknown rank rejected', async () => {
    expect((await err(() => saveRankAccess(cap, R.c.id, { permissions: ['hack.all'] }, meta)))?.code).toBe('VALIDATION');
    expect((await err(() => saveRankAccess(cap, 30000, { permissions: ['users.view'] }, meta)))?.code).toBe('NOT_FOUND');
    expect((await err(() => saveRankAccess(cap, -1, { permissions: [] }, meta)))?.code).toBe('NOT_FOUND');
  });
  it('FN2-RANKACC-006 member without permissions.manage is forbidden (dev.officer, plain delegate)', async () => {
    expect((await err(() => saveRankAccess(officer, R.c.id, { permissions: ['users.view'] }, meta)))?.code).toBe('FORBIDDEN');
    const d = await delegate(['users.view']);
    expect((await err(() => saveRankAccess(d.user, R.c.id, { permissions: ['users.view'] }, meta)))?.code).toBe('FORBIDDEN');
  });
  it('FN2-RANKACC-007 delegate change becomes a PENDING request, nothing applied', async () => {
    const rk = await newRank();
    const d = await delegate([...MANAGE, 'users.view']);
    const res = await saveRankAccess(d.user, rk, { permissions: ['users.view'], reason: 'please' }, meta);
    expect(res.status).toBe('pending');
    expect(await slugsOf(rk)).toEqual([]);
    const req = await pendingReq(d.id, 'rank_access');
    expect([req.targetId, req.reason]).toEqual([String(rk), 'please']);
  });
  it('FN2-RANKACC-008 delegate cannot grant a permission they do not hold', async () => {
    const d = await delegate([...MANAGE]);
    const e = await err(() => saveRankAccess(d.user, R.c.id, { permissions: ['audit.view'] }, meta));
    expect(e?.code).toBe('FORBIDDEN');
    expect(e?.message).toMatch(/audit\.view/);
  });
  it("FN2-RANKACC-009 delegate cannot edit their own rank's permissions", async () => {
    const d = await delegate([...MANAGE, 'users.view'], R.c);
    const e = await err(() => saveRankAccess(d.user, R.c.id, { permissions: ['users.view'] }, meta));
    expect(e?.code).toBe('FORBIDDEN');
    expect(e?.message).toMatch(/own rank/i);
  });
  it('FN2-RANKACC-010 second delegate request for same rank while one is pending -> CONFLICT; Captain may still change directly (R-33)', async () => {
    const rk = await newRank();
    const d1 = await delegate([...MANAGE, 'users.view']);
    const d2 = await delegate([...MANAGE, 'users.view']);
    await saveRankAccess(d1.user, rk, { permissions: ['users.view'] }, meta);
    expect((await err(() => saveRankAccess(d2.user, rk, { permissions: ['users.view'] }, meta)))?.code).toBe('CONFLICT');
    expect((await saveRankAccess(cap, rk, { permissions: ['users.view'] }, meta)).status).toBe('applied');
    // 旧申请现在已过期，批准会失败
    const stale = await pendingReq(d1.id, 'rank_access');
    expect((await err(() => decideRequest(cap, stale.id, 'approve', null, meta)))?.code).toBe('CONFLICT');
  });
  it('FN2-RANKACC-011 Captain approval applies the rank grant', async () => {
    const rk = await newRank();
    const d = await delegate([...MANAGE, 'users.view']);
    await saveRankAccess(d.user, rk, { permissions: ['users.view'] }, meta);
    await decideRequest(cap, (await pendingReq(d.id)).id, 'approve', null, meta);
    expect(await slugsOf(rk)).toEqual(['users.view']);
  });
  it('FN2-RANKACC-012 stale rank request (rank changed meanwhile) -> CONFLICT on approve', async () => {
    const rk = await newRank();
    const d = await delegate([...MANAGE, 'users.view']);
    await saveRankAccess(d.user, rk, { permissions: ['users.view'] }, meta);
    await db.insert(rankPermissions).values({ rankId: rk, permissionSlug: 'users.view', grantedBy: cap.id });
    const req = await pendingReq(d.id);
    expect((await err(() => decideRequest(cap, req.id, 'approve', null, meta)))?.code).toBe('CONFLICT');
  });
  it('FN2-RANKACC-013 listRankAccess includes the Captain rank flagged, with section names', async () => {
    const list = await listRankAccess();
    expect(list.find((r) => r.isCaptain)).toBeTruthy();
    expect(list.every((r) => typeof r.sectionName === 'string')).toBe(true);
  });
});

// ───────────────────────── D. roles ─────────────────────────
describe('D roles', () => {
  const rd = (id: number) => saveRole;
  void rd;
  it('FN2-ROLE-001 Captain creates a role with permissions (applied) + audit', async () => {
    const r = await mkRole(['users.view', 'users.update']);
    const d = await getRole(r.id);
    expect(d!.permissions.sort()).toEqual(['users.update', 'users.view']);
    expect(d!.isActive).toBe(true);
    const au = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'roles'), eq(auditLogs.entityId, String(r.id))));
    expect(au.some((a) => a.action === 'ACCESS_CHANGED')).toBe(true);
  });
  it('FN2-ROLE-002 name required, max 50, duplicates rejected case-insensitively', async () => {
    const base = { description: '', isActive: true, permissions: [] };
    expect((await err(() => saveRole(cap, null, { ...base, name: '  ' }, meta)))?.fieldErrors?.name).toBeTruthy();
    expect((await err(() => saveRole(cap, null, { ...base, name: 'x'.repeat(51) }, meta)))?.fieldErrors?.name).toBeTruthy();
    const r = await mkRole();
    expect((await err(() => saveRole(cap, null, { ...base, name: r.name.toUpperCase() }, meta)))?.fieldErrors?.name).toMatch(/already exists/);
  });
  it('FN2-ROLE-003 edit name/description/permissions; unchanged -> "Nothing has changed."', async () => {
    const r = await mkRole(['users.view']);
    const n2 = nm('renamed');
    await saveRole(cap, r.id, { name: n2, description: 'new desc', isActive: true, permissions: ['audit.view'] }, meta);
    const d = await getRole(r.id);
    expect([d!.name, d!.description, d!.permissions]).toEqual([n2, 'new desc', ['audit.view']]);
    expect((await err(() => saveRole(cap, r.id, { name: n2, description: 'new desc', isActive: true, permissions: ['audit.view'] }, meta)))?.message).toMatch(/nothing has changed/i);
  });
  it('FN2-ROLE-004 rename to another existing role name rejected', async () => {
    const [a, b] = [await mkRole(), await mkRole()];
    expect((await err(() => saveRole(cap, b.id, { name: a.name, description: null, isActive: true, permissions: [] }, meta)))?.fieldErrors?.name).toMatch(/already exists/);
  });
  it('FN2-ROLE-005 description is cut to 200 chars', async () => {
    const r = await mkRole();
    await saveRole(cap, r.id, { name: r.name, description: 'd'.repeat(300), isActive: true, permissions: [] }, meta);
    expect((await getRole(r.id))!.description).toHaveLength(200);
  });
  it('FN2-ROLE-006 unknown permission slug rejected', async () => {
    expect((await err(() => saveRole(cap, null, { name: nm('bad'), description: '', isActive: true, permissions: ['x.y'] }, meta)))?.code).toBe('VALIDATION');
  });
  it('FN2-ROLE-007 unknown / invalid role id -> NOT_FOUND', async () => {
    for (const id of [30000, 0, -5]) expect((await err(() => saveRole(cap, id, { name: 'x', description: '', isActive: true, permissions: [] }, meta)))?.code, String(id)).toBe('NOT_FOUND');
  });
  it('FN2-ROLE-008 deactivated role cannot be assigned; reactivating allows it', async () => {
    const r = await mkRole(['users.view'], false);
    const m = await mk();
    expect((await err(() => saveUserAccess(cap, m.id, { roleIds: [r.id], overrides: [] }, meta)))?.message).toMatch(/inactive role/i);
    await saveRole(cap, r.id, { name: r.name, description: 'qa', isActive: true, permissions: ['users.view'] }, meta);
    await saveUserAccess(cap, m.id, { roleIds: [r.id], overrides: [] }, meta);
    expect((await loadPermissions(m.id)).has('users.view')).toBe(true);
  });
  it('FN2-ROLE-009 role cannot be changed by member without permissions.manage', async () => {
    const r = await mkRole();
    expect((await err(() => saveRole(officer, r.id, { name: r.name, description: 'x', isActive: true, permissions: [] }, meta)))?.code).toBe('FORBIDDEN');
  });
  it('FN2-ROLE-010 delegate creating a role -> pending, role not created until Captain approves', async () => {
    const d = await delegate([...MANAGE, 'users.view']);
    const name = nm('pendrole');
    const res = await saveRole(d.user, null, { name, description: 'p', isActive: true, permissions: ['users.view'], reason: 'need it' }, meta);
    expect(res.status).toBe('pending');
    expect(await db.select().from(roles).where(eq(roles.name, name))).toHaveLength(0);
    await decideRequest(cap, (await pendingReq(d.id, 'role')).id, 'approve', null, meta);
    const [r] = await db.select().from(roles).where(eq(roles.name, name));
    roleIds.push(r.id);
    expect((await getRole(r.id))!.permissions).toEqual(['users.view']);
  });
  it('FN2-ROLE-011 delegate cannot put permissions they lack into a role', async () => {
    const d = await delegate([...MANAGE]);
    expect((await err(() => saveRole(d.user, null, { name: nm('x'), description: '', isActive: true, permissions: ['users.create'] }, meta)))?.code).toBe('FORBIDDEN');
  });
  it('FN2-ROLE-012 one pending request per role: second -> CONFLICT', async () => {
    const r = await mkRole(['users.view']);
    const d = await delegate([...MANAGE, 'users.view']);
    await saveRole(d.user, r.id, { name: r.name, description: 'one', isActive: true, permissions: ['users.view'] }, meta);
    expect((await err(() => saveRole(d.user, r.id, { name: r.name, description: 'two', isActive: true, permissions: ['users.view'] }, meta)))?.code).toBe('CONFLICT');
  });
  it('FN2-ROLE-013 stale role request (role edited after request) -> CONFLICT', async () => {
    const r = await mkRole(['users.view']);
    const d = await delegate([...MANAGE, 'users.view']);
    await saveRole(d.user, r.id, { name: r.name, description: 'from delegate', isActive: true, permissions: ['users.view'] }, meta);
    await db.update(roles).set({ description: 'changed elsewhere' }).where(eq(roles.id, r.id));
    expect((await err(async () => decideRequest(cap, (await pendingReq(d.id)).id, 'approve', null, meta)))?.code).toBe('CONFLICT');
  });
  it('FN2-ROLE-014 listRoles gives member count (active members) and permission count', async () => {
    const r = await mkRole(['users.view']);
    const m = await mk();
    await saveUserAccess(cap, m.id, { roleIds: [r.id], overrides: [] }, meta);
    const row = (await listRoles()).find((x) => x.id === r.id)!;
    expect([row.memberCount, row.permissionCount, row.pending]).toEqual([1, 1, false]);
  });
  it('FN2-ROLE-015 delegate role-create with duplicate name rejected up front', async () => {
    const r = await mkRole();
    const d = await delegate([...MANAGE]);
    expect((await err(() => saveRole(d.user, null, { name: r.name, description: '', isActive: true, permissions: [] }, meta)))?.fieldErrors?.name).toBeTruthy();
  });
});

// ───────────────────────── E. per-user access ─────────────────────────
describe('E member access', () => {
  it('FN2-USERACC-001 Captain assigns roles + overrides: applied, audit written', async () => {
    const m = await mk();
    const role = await mkRole(['users.view']);
    const res = await saveUserAccess(cap, m.id, { roleIds: [role.id], overrides: [ov('audit.view', 'allow', 'audit duty')] }, meta);
    expect(res.status).toBe('applied');
    const p = await loadPermissions(m.id);
    expect(p.has('users.view') && p.has('audit.view')).toBe(true);
    const au = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'user_access'), eq(auditLogs.entityId, m.id)));
    expect(au).toHaveLength(1);
  });
  it('FN2-USERACC-002 removing a role removes its grant', async () => {
    const m = await mk();
    const role = await mkRole(['users.update']);
    await saveUserAccess(cap, m.id, { roleIds: [role.id], overrides: [] }, meta);
    await saveUserAccess(cap, m.id, { roleIds: [], overrides: [] }, meta);
    expect((await loadPermissions(m.id)).has('users.update')).toBe(false);
  });
  it('FN2-USERACC-003 nothing changed -> error', async () => {
    const m = await mk();
    expect((await err(() => saveUserAccess(cap, m.id, { roleIds: [], overrides: [] }, meta)))?.message).toMatch(/nothing has changed/i);
  });
  it('FN2-USERACC-004 getUserAccess reports source (role/rank/override) and effective result', async () => {
    const m = await mk(R.b);
    const role = await mkRole(['users.update']);
    await saveUserAccess(cap, m.id, { roleIds: [role.id], overrides: [ov('users.view', 'deny', 'r')] }, meta);
    const a = await getUserAccess(cap, m.id);
    const view = a.permissions.find((p) => p.slug === 'users.view')!;
    const upd = a.permissions.find((p) => p.slug === 'users.update')!;
    expect([view.fromRank, view.override, view.effective, view.overrideReason]).toEqual([true, 'deny', false, 'r']);
    expect([upd.fromRoles, upd.effective]).toEqual([[role.name], true]);
    expect(a.editable).toBe(true);
  });
  it('FN2-USERACC-005 delegate cannot change their own permissions', async () => {
    const d = await delegate([...MANAGE, 'users.view']);
    const e = await err(() => saveUserAccess(d.user, d.id, { roleIds: [], overrides: [ov('users.view', 'deny')] }, meta));
    expect(e?.code).toBe('FORBIDDEN');
    expect(e?.message).toMatch(/own permissions/i);
  });
  it('FN2-USERACC-006 nobody can edit the Captain', async () => {
    expect((await err(() => saveUserAccess(cap, cap.id, { roleIds: [], overrides: [ov('users.view', 'deny')] }, meta)))?.code).toBe('FORBIDDEN');
    const d = await delegate([...MANAGE]);
    // 不在同一组别的人看不到 Captain（NOT_FOUND），同组别也会被拒（FORBIDDEN）
    expect(['FORBIDDEN', 'NOT_FOUND']).toContain((await err(() => saveUserAccess(d.user, cap.id, { roleIds: [], overrides: [ov('users.view', 'deny')] }, meta)))?.code);
  });
  it('FN2-USERACC-007 Superadmin account is not addressable (NOT_FOUND)', async () => {
    if (!sa) return;
    expect((await err(() => saveUserAccess(cap, sa!.id, { roleIds: [], overrides: [] }, meta)))?.code).toBe('NOT_FOUND');
  });
  it('FN2-USERACC-008 non-uuid / unknown target -> NOT_FOUND', async () => {
    expect((await err(() => saveUserAccess(cap, 'abc', { roleIds: [], overrides: [] }, meta)))?.code).toBe('NOT_FOUND');
    expect((await err(() => saveUserAccess(cap, GHOST, { roleIds: [], overrides: [] }, meta)))?.code).toBe('NOT_FOUND');
  });
  it('FN2-USERACC-009 member without permissions.manage is forbidden (officer): save and read', async () => {
    const m = await mk();
    expect((await err(() => saveUserAccess(officer, m.id, { roleIds: [], overrides: [ov('users.view', 'allow')] }, meta)))?.code).toBe('FORBIDDEN');
    expect((await err(() => getUserAccess(officer, m.id)))?.code).toBe('FORBIDDEN');
  });
  it('FN2-USERACC-010 delegate change -> pending, member permissions unchanged', async () => {
    const d = await delegate([...MANAGE, 'users.view']);
    const m = await mk();
    const res = await saveUserAccess(d.user, m.id, { roleIds: [], overrides: [ov('users.view', 'allow', 'why')], reason: 'overall' }, meta);
    expect(res.status).toBe('pending');
    expect((await loadPermissions(m.id)).has('users.view')).toBe(false);
    expect((await getUserAccess(cap, m.id)).pending).toBe(true);
  });
  it('FN2-USERACC-011 delegate cannot grant a permission they lack (override or via role)', async () => {
    const d = await delegate([...MANAGE]);
    const m = await mk();
    expect((await err(() => saveUserAccess(d.user, m.id, { roleIds: [], overrides: [ov('users.create', 'allow')] }, meta)))?.code).toBe('FORBIDDEN');
    const role = await mkRole(['users.create']);
    expect((await err(() => saveUserAccess(d.user, m.id, { roleIds: [role.id], overrides: [] }, meta)))?.code).toBe('FORBIDDEN');
  });
  it('FN2-USERACC-012 delegate cannot change a member who gets users.view from rank when delegate lacks it', async () => {
    const d = await delegate([...MANAGE]);
    const m = await mk(R.b); // users.view via rank B
    expect((await err(() => saveUserAccess(d.user, m.id, { roleIds: [], overrides: [ov('users.view', 'deny')] }, meta)))?.code).toBe('FORBIDDEN');
  });
  it('FN2-USERACC-013 delegate cannot change a member with more permissions than themselves', async () => {
    const d = await delegate([...MANAGE]);
    const strong = await mk();
    await grant(strong.id, ['users.update']);
    expect((await err(() => saveUserAccess(d.user, strong.id, { roleIds: [], overrides: [ov('users.update', 'deny')] }, meta)))?.code).toBe('FORBIDDEN');
  });
  it('FN2-USERACC-014 one pending request per target member -> CONFLICT for delegates; Captain applies directly (R-33)', async () => {
    const d = await delegate([...MANAGE, 'users.view', 'audit.view']);
    const m = await mk();
    await saveUserAccess(d.user, m.id, { roleIds: [], overrides: [ov('users.view', 'allow')] }, meta);
    expect((await err(() => saveUserAccess(d.user, m.id, { roleIds: [], overrides: [ov('audit.view', 'allow')] }, meta)))?.code).toBe('CONFLICT');
    expect((await saveUserAccess(cap, m.id, { roleIds: [], overrides: [ov('audit.view', 'allow')] }, meta)).status).toBe('applied');
  });
  it('FN2-USERACC-015 DB unique index blocks a second pending row for the same target', async () => {
    const d = await delegate([...MANAGE, 'users.view']);
    const m = await mk();
    await saveUserAccess(d.user, m.id, { roleIds: [], overrides: [ov('users.view', 'allow')] }, meta);
    expect(await err(() => db.insert(permissionChangeRequests).values({ kind: 'user_access', targetId: m.id, changes: {}, requestedBy: d.id }))).toBeTruthy();
  });
  it('FN2-USERACC-016 invalid input: unknown slug, bad effect, duplicate slug, unknown role, reason > 500', async () => {
    const m = await mk();
    const bad = [
      { roleIds: [], overrides: [{ slug: 'x.y', effect: 'allow' }] },
      { roleIds: [], overrides: [{ slug: 'users.view', effect: 'maybe' }] },
      { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow' }, { slug: 'users.view', effect: 'deny' }] },
      { roleIds: [30000], overrides: [] },
      { roleIds: ['abc'], overrides: [] },
      { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow', reason: 'x'.repeat(501) }] },
    ];
    for (const [i, b] of bad.entries()) expect((await err(() => saveUserAccess(cap, m.id, b as never, meta)))?.code, `case ${i}`).toBe('VALIDATION');
  });
  it('FN2-USERACC-017 changing only the reason of an existing override counts as a change', async () => {
    const m = await mk();
    await saveUserAccess(cap, m.id, { roleIds: [], overrides: [ov('users.view', 'allow', 'one')] }, meta);
    await saveUserAccess(cap, m.id, { roleIds: [], overrides: [ov('users.view', 'allow', 'two')] }, meta);
    expect((await getUserAccess(cap, m.id)).permissions.find((p) => p.slug === 'users.view')!.overrideReason).toBe('two');
  });
  it('FN2-USERACC-018 Captain in getUserAccess: not editable, every permission effective', async () => {
    const a = await getUserAccess(cap, cap.id);
    expect(a.editable).toBe(false);
    expect(a.permissions.every((p) => p.effective)).toBe(true);
  });
});

// ───────────────────────── F. approvals ─────────────────────────
describe('F approvals', () => {
  async function pendingFor(slug: PermissionSlug = 'users.view', extra: PermissionSlug[] = []) {
    const d = await delegate([...MANAGE, slug, ...extra]);
    const m = await mk();
    await saveUserAccess(d.user, m.id, { roleIds: [], overrides: [ov(slug, 'allow')], reason: 'r' }, meta);
    return { d, m, req: await pendingReq(d.id) };
  }
  it('FN2-APPR-001 Captain approves: change applied, request approved, audit trail', async () => {
    const { m, req } = await pendingFor();
    await decideRequest(cap, req.id, 'approve', 'ok', meta);
    expect((await loadPermissions(m.id)).has('users.view')).toBe(true);
    const [r] = await db.select().from(permissionChangeRequests).where(eq(permissionChangeRequests.id, req.id));
    expect([r.status, r.decidedBy, r.decisionNote]).toEqual(['approved', cap.id, 'ok']);
    const au = await db.select().from(auditLogs).where(eq(auditLogs.entityId, req.id));
    expect(au.map((a) => a.action).sort()).toEqual(['ACCESS_CHANGE_APPROVED', 'ACCESS_CHANGE_REQUESTED']);
  });
  it('FN2-APPR-002 Captain rejects with reason: nothing applied', async () => {
    const { m, req } = await pendingFor();
    await decideRequest(cap, req.id, 'reject', 'no thanks', meta);
    expect((await loadPermissions(m.id)).has('users.view')).toBe(false);
    const [r] = await db.select().from(permissionChangeRequests).where(eq(permissionChangeRequests.id, req.id));
    expect([r.status, r.decisionNote]).toEqual(['rejected', 'no thanks']);
  });
  it('FN2-APPR-003 reject without reason -> field error "note"', async () => {
    const { req } = await pendingFor();
    for (const note of [null, '', '  ']) expect((await err(() => decideRequest(cap, req.id, 'reject', note, meta)))?.fieldErrors?.note, String(note)).toBeTruthy();
  });
  it('FN2-APPR-004 approve with no note is allowed; note > 500 rejected', async () => {
    const { req } = await pendingFor();
    expect((await err(() => decideRequest(cap, req.id, 'approve', 'x'.repeat(501), meta)))?.code).toBe('VALIDATION');
    await decideRequest(cap, req.id, 'approve', null, meta);
  });
  it('FN2-APPR-005 only the Captain may decide: delegate, officer and Superadmin are FORBIDDEN', async () => {
    const { req } = await pendingFor();
    const other = await delegate([...MANAGE]);
    expect((await err(() => decideRequest(other.user, req.id, 'approve', null, meta)))?.code).toBe('FORBIDDEN');
    expect((await err(() => decideRequest(officer, req.id, 'reject', 'x', meta)))?.code).toBe('FORBIDDEN');
    if (sa) expect((await err(() => decideRequest(sa!, req.id, 'approve', null, meta)))?.code).toBe('FORBIDDEN');
  });
  it('FN2-APPR-006 decided request cannot be decided again -> CONFLICT', async () => {
    const { req } = await pendingFor();
    await decideRequest(cap, req.id, 'reject', 'x', meta);
    expect((await err(() => decideRequest(cap, req.id, 'approve', null, meta)))?.code).toBe('CONFLICT');
  });
  it('FN2-APPR-007 unknown / malformed request id -> NOT_FOUND; bad decision -> VALIDATION', async () => {
    expect((await err(() => decideRequest(cap, 'nope', 'approve', null, meta)))?.code).toBe('NOT_FOUND');
    expect((await err(() => decideRequest(cap, GHOST, 'approve', null, meta)))?.code).toBe('NOT_FOUND');
    const { req } = await pendingFor();
    expect((await err(() => decideRequest(cap, req.id, 'maybe' as never, null, meta)))?.code).toBe('VALIDATION');
  });
  it('FN2-APPR-008 requester can withdraw; status cancelled; new request then possible', async () => {
    const { d, m, req } = await pendingFor('users.view', ['audit.view']);
    await cancelRequest(d.user, req.id, meta);
    const [r] = await db.select().from(permissionChangeRequests).where(eq(permissionChangeRequests.id, req.id));
    expect(r.status).toBe('cancelled');
    const res = await saveUserAccess(d.user, m.id, { roleIds: [], overrides: [ov('audit.view', 'allow')] }, meta);
    expect(res.status).toBe('pending');
  });
  it("FN2-APPR-009 someone else (even Captain) cannot withdraw another person's request", async () => {
    const { req } = await pendingFor();
    expect((await err(() => cancelRequest(cap, req.id, meta)))?.code).toBe('NOT_FOUND');
    const other = await delegate([...MANAGE]);
    expect((await err(() => cancelRequest(other.user, req.id, meta)))?.code).toBe('NOT_FOUND');
  });
  it('FN2-APPR-010 withdraw twice -> CONFLICT; approve after withdraw -> CONFLICT', async () => {
    const { d, req } = await pendingFor();
    await cancelRequest(d.user, req.id, meta);
    expect((await err(() => cancelRequest(d.user, req.id, meta)))?.code).toBe('CONFLICT');
    expect((await err(() => decideRequest(cap, req.id, 'approve', null, meta)))?.code).toBe('CONFLICT');
  });
  it('FN2-APPR-011 approval fails when requester lost permissions.manage meanwhile', async () => {
    const { d, req } = await pendingFor();
    await saveUserAccess(cap, d.id, { roleIds: [], overrides: [ov('permissions.manage', 'deny', 'revoked')] }, meta);
    const e = await err(() => decideRequest(cap, req.id, 'approve', null, meta));
    expect(e?.code).toBe('CONFLICT');
    expect(e?.message).toMatch(/no longer has permission/i);
  });
  it('FN2-APPR-012 approval fails when requester was deactivated (reject still possible)', async () => {
    const { d, req } = await pendingFor();
    await setStatus(cap, d.id, { status: 'inactive', reasonId: await noNoteReason() }, meta);
    expect((await err(() => decideRequest(cap, req.id, 'approve', null, meta)))?.code).toBe('CONFLICT');
    await decideRequest(cap, req.id, 'reject', 'requester inactive', meta);
  });
  it('FN2-APPR-013 approval fails when requester lost a permission being granted', async () => {
    const { d, req, m } = await pendingFor('users.view');
    await saveUserAccess(cap, d.id, { roleIds: [], overrides: [ov('users.view', 'deny', 'revoked')] }, meta);
    const e = await err(() => decideRequest(cap, req.id, 'approve', null, meta));
    expect(e?.code).toBe('CONFLICT');
    expect(e?.message).toMatch(/no longer has some/i);
    expect((await loadPermissions(m.id)).has('users.view')).toBe(false);
  });
  it('FN2-APPR-014 stale user request (target changed after request) -> CONFLICT, nothing applied', async () => {
    const { m, req } = await pendingFor('users.view');
    await db.insert(userPermissionOverrides).values({ userId: m.id, permissionSlug: 'users.view', effect: 'deny', setBy: cap.id });
    const e = await err(() => decideRequest(cap, req.id, 'approve', null, meta));
    expect(e?.code).toBe('CONFLICT');
    expect(e?.message).toMatch(/changed since/i);
    expect((await loadPermissions(m.id)).has('users.view')).toBe(false);
  });
  it('FN2-APPR-015 pendingRequestCount: Captain sees count, others see 0', async () => {
    const before = await pendingRequestCount(cap);
    const { d, req } = await pendingFor();
    expect(await pendingRequestCount(cap)).toBe(before + 1);
    expect(await pendingRequestCount(d.user)).toBe(0);
    expect(await pendingRequestCount(officer)).toBe(0);
    await decideRequest(cap, req.id, 'reject', 'x', meta);
    expect(await pendingRequestCount(cap)).toBe(before);
  });
  it('FN2-APPR-016 listRequests: delegate sees only own; Captain sees all; officer forbidden', async () => {
    const a = await pendingFor();
    const b = await pendingFor();
    const mine = await listRequests(a.d.user, 'pending');
    expect(mine.map((r) => r.id)).toContain(a.req.id);
    expect(mine.map((r) => r.id)).not.toContain(b.req.id);
    expect(mine.every((r) => r.mine)).toBe(true);
    expect((await listRequests(cap, 'pending')).map((r) => r.id)).toEqual(expect.arrayContaining([a.req.id, b.req.id]));
    expect((await err(() => listRequests(officer, 'pending')))?.code).toBe('FORBIDDEN');
    await cancelRequest(a.d.user, a.req.id, meta);
    expect((await listRequests(cap, 'decided')).map((r) => r.id)).toContain(a.req.id);
  });
  it('FN2-APPR-017 request shows readable target name', async () => {
    const { m, req } = await pendingFor();
    const row = (await listRequests(cap, 'pending')).find((r) => r.id === req.id)!;
    expect(row.targetName).toBeTruthy();
    expect(row.targetName).not.toBe(m.id);
  });
  it('FN2-APPR-018 DB trigger: decided request is immutable and requests cannot be deleted', async () => {
    const { req } = await pendingFor();
    await decideRequest(cap, req.id, 'reject', 'x', meta);
    expect(await err(() => db.update(permissionChangeRequests).set({ status: 'approved' }).where(eq(permissionChangeRequests.id, req.id)))).toBeTruthy();
    expect(await err(() => db.delete(permissionChangeRequests).where(eq(permissionChangeRequests.id, req.id)))).toBeTruthy();
  });
  it('FN2-APPR-019 DB trigger: pending request content cannot be edited', async () => {
    const { req } = await pendingFor();
    expect(await err(() => db.update(permissionChangeRequests).set({ changes: {} }).where(eq(permissionChangeRequests.id, req.id)))).toBeTruthy();
  });
  it('FN2-APPR-020 role-request approval applies role changes', async () => {
    const r = await mkRole(['users.view']);
    const d = await delegate([...MANAGE, 'users.view']);
    await saveRole(d.user, r.id, { name: r.name, description: 'via request', isActive: true, permissions: ['users.view'] }, meta);
    await decideRequest(cap, (await pendingReq(d.id)).id, 'approve', null, meta);
    expect((await getRole(r.id))!.description).toBe('via request');
  });
});

// ───────────────────────── G. ranks & sections maintenance ─────────────────────────
describe('G org maintenance', () => {
  const sec = (id: number) => db.select().from(sections).where(eq(sections.id, id)).then((r) => r[0]);
  const rk = (id: number) => db.select().from(ranks).where(eq(ranks.id, id)).then((r) => r[0]);
  it('FN2-ORG-001 Captain creates section and ranks; audit written; ranks appended at end', async () => {
    const s = (await createSection(cap, { name: nm('Sec') }, meta))!.id;
    const r1 = (await createRank(cap, { sectionId: s, name: 'One' }, meta))!.id;
    const r2 = (await createRank(cap, { sectionId: s, name: 'Two' }, meta))!.id;
    expect((await rk(r2)).sortOrder).toBeGreaterThan((await rk(r1)).sortOrder);
    const au = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'sections'), eq(auditLogs.entityId, String(s))));
    expect(au[0].action).toBe('SECTION_CREATED');
    await updateRank(cap, r1, { isActive: false }, meta);
    await updateRank(cap, r2, { isActive: false }, meta);
    await updateSection(cap, s, { isActive: false }, meta);
  });
  it('FN2-ORG-002 officer / permissions.manage holder cannot maintain; Superadmin can', async () => {
    const d = await delegate([...MANAGE, 'users.view']);
    for (const u of [officer, d.user]) {
      expect((await err(() => createSection(u, { name: nm('x') }, meta)))?.code).toBe('FORBIDDEN');
      expect((await err(() => createRank(u, { sectionId: S1, name: nm('x') }, meta)))?.code).toBe('FORBIDDEN');
      expect((await err(() => updateRank(u, R.a.id, { name: nm('x') }, meta)))?.code).toBe('FORBIDDEN');
      expect((await err(() => updateSection(u, S1, { name: nm('x') }, meta)))?.code).toBe('FORBIDDEN');
      expect((await err(() => moveItem(u, 'rank', R.a.id, 'down', meta)))?.code).toBe('FORBIDDEN');
    }
    if (sa) {
      const id = (await createSection(sa, { name: nm('sa') }, meta))!.id;
      await updateSection(sa, id, { isActive: false }, meta);
    }
  });
  it('FN2-ORG-003 duplicate section name rejected', async () => {
    expect((await err(() => createSection(cap, { name: `QA P2 ${RUN} A` }, meta)))?.fieldErrors?.name).toMatch(/already used/);
  });
  it('FN2-ORG-004 duplicate rank name in same section rejected; same name in another section allowed', async () => {
    expect((await err(() => createRank(cap, { sectionId: S1, name: 'QA A' }, meta)))?.fieldErrors?.name).toMatch(/already used/);
    const id = (await createRank(cap, { sectionId: S2, name: 'QA A' }, meta))!.id;
    await updateRank(cap, id, { isActive: false }, meta);
  });
  it('FN2-ORG-005 name rules: empty, whitespace-only, 41 chars, non-string rejected; inner spaces collapsed', async () => {
    for (const name of ['', '   ', 'x'.repeat(41), undefined, 5]) expect((await err(() => createSection(cap, { name }, meta)))?.fieldErrors?.name, String(name)).toBeTruthy();
    const id = (await createSection(cap, { name: `  ${nm('a')}   b  ` }, meta))!.id;
    expect((await sec(id)).name).toMatch(/^qa\.\S+ b$/);
    await updateSection(cap, id, { isActive: false }, meta);
  });
  it('FN2-ORG-006 case-variant duplicate section name should be rejected', async () => {
    const e = await err(() => createSection(cap, { name: `qa p2 ${RUN} a` }, meta));
    if (!e) {
      const [s] = await db.select().from(sections).where(eq(sections.name, `qa p2 ${RUN} a`));
      await updateSection(cap, s.id, { isActive: false }, meta);
    }
    expect(e, 'case-insensitive duplicate accepted').toBeTruthy();
  });
  it('FN2-ORG-007 rename rank; audit RENAMED; same name -> "Nothing has changed."', async () => {
    const s = (await createSection(cap, { name: nm('ren') }, meta))!.id;
    const r = (await createRank(cap, { sectionId: s, name: 'Old' }, meta))!.id;
    await updateRank(cap, r, { name: 'New' }, meta);
    expect((await rk(r)).name).toBe('New');
    expect((await err(() => updateRank(cap, r, { name: 'New' }, meta)))?.message).toMatch(/nothing has changed/i);
    const au = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'ranks'), eq(auditLogs.entityId, String(r)), eq(auditLogs.action, 'RANK_RENAMED')));
    expect(au).toHaveLength(1);
    await updateRank(cap, r, { isActive: false }, meta);
    await updateSection(cap, s, { isActive: false }, meta);
  });
  it('FN2-ORG-008 rename to existing sibling name rejected', async () => {
    expect((await err(() => updateRank(cap, R.b.id, { name: 'QA A' }, meta)))?.fieldErrors?.name).toMatch(/already used/);
    expect((await err(() => updateSection(cap, S2, { name: `QA P2 ${RUN} A` }, meta)))?.fieldErrors?.name).toMatch(/already used/);
  });
  it('FN2-ORG-009 cannot deactivate a rank held by active members; can once they move', async () => {
    const r = (await createRank(cap, { sectionId: S1, name: nm('held') }, meta))!.id;
    const m = await mk({ id: r, sectionId: S1 });
    expect((await err(() => updateRank(cap, r, { isActive: false }, meta)))?.message).toMatch(/promote or deactivate/i);
    await promoteMembers(cap, { userIds: [m.id], sectionId: R.a.sectionId, rankId: R.a.id, reason: 'move out' }, meta);
    await updateRank(cap, r, { isActive: false }, meta);
    expect((await rk(r)).isActive).toBe(false);
  });
  it('FN2-ORG-010 inactive members do not block rank deactivation', async () => {
    const r = (await createRank(cap, { sectionId: S1, name: nm('inact') }, meta))!.id;
    const m = await mk({ id: r, sectionId: S1 });
    await setStatus(cap, m.id, { status: 'inactive', reasonId: await noNoteReason() }, meta);
    await updateRank(cap, r, { isActive: false }, meta);
  });
  it('FN2-ORG-011 cannot deactivate a section with active ranks or active members', async () => {
    const s = (await createSection(cap, { name: nm('sx') }, meta))!.id;
    const r = (await createRank(cap, { sectionId: s, name: 'R' }, meta))!.id;
    const m = await mk({ id: r, sectionId: s });
    expect((await err(() => updateSection(cap, s, { isActive: false }, meta)))?.message).toMatch(/active members/i);
    await promoteMembers(cap, { userIds: [m.id], sectionId: R.a.sectionId, rankId: R.a.id, reason: 'out' }, meta);
    expect((await err(() => updateSection(cap, s, { isActive: false }, meta)))?.message).toMatch(/deactivate the ranks/i);
    await updateRank(cap, r, { isActive: false }, meta);
    await updateSection(cap, s, { isActive: false }, meta);
    expect((await sec(s)).isActive).toBe(false);
  });
  it('FN2-ORG-012 reactivation rules: rank under inactive section blocked; no new ranks in inactive section', async () => {
    const s = (await createSection(cap, { name: nm('re') }, meta))!.id;
    const r = (await createRank(cap, { sectionId: s, name: 'R' }, meta))!.id;
    await updateRank(cap, r, { isActive: false }, meta);
    await updateSection(cap, s, { isActive: false }, meta);
    expect((await err(() => updateRank(cap, r, { isActive: true }, meta)))?.message).toMatch(/reactivate this section/i);
    expect((await err(() => createRank(cap, { sectionId: s, name: 'New' }, meta)))?.message).toMatch(/reactivate this section/i);
    await updateSection(cap, s, { isActive: true }, meta);
    await updateRank(cap, r, { isActive: true }, meta);
    expect((await rk(r)).isActive).toBe(true);
    await updateRank(cap, r, { isActive: false }, meta);
    await updateSection(cap, s, { isActive: false }, meta);
  });
  it('FN2-ORG-013 Officer section cannot be renamed or deactivated (service)', async () => {
    const [o] = await db.select().from(sections).where(eq(sections.systemKey, 'officer'));
    expect((await err(() => updateSection(cap, o.id, { name: 'Renamed' }, meta)))?.code).toBe('FORBIDDEN');
    expect((await err(() => updateSection(cap, o.id, { isActive: false }, meta)))?.code).toBe('FORBIDDEN');
  });
  it('FN2-ORG-014 Captain rank cannot be renamed or deactivated (service)', async () => {
    const [c] = await db.select().from(ranks).where(eq(ranks.systemKey, 'captain'));
    expect((await err(() => updateRank(cap, c.id, { name: 'Boss' }, meta)))?.code).toBe('FORBIDDEN');
    expect((await err(() => updateRank(cap, c.id, { isActive: false }, meta)))?.code).toBe('FORBIDDEN');
  });
  it('FN2-ORG-015 DB trigger blocks direct SQL rename/deactivate of Officer section and clearing system_key', async () => {
    const [o] = await db.select().from(sections).where(eq(sections.systemKey, 'officer'));
    expect(await err(() => db.update(sections).set({ name: 'X' }).where(eq(sections.id, o.id)))).toBeTruthy();
    expect(await err(() => db.update(sections).set({ isActive: false }).where(eq(sections.id, o.id)))).toBeTruthy();
    expect(await err(() => db.update(sections).set({ systemKey: null }).where(eq(sections.id, o.id)))).toBeTruthy();
  });
  it('FN2-ORG-016 DB trigger blocks direct SQL changes to Captain rank', async () => {
    const [c] = await db.select().from(ranks).where(eq(ranks.systemKey, 'captain'));
    expect(await err(() => db.update(ranks).set({ name: 'X' }).where(eq(ranks.id, c.id)))).toBeTruthy();
    expect(await err(() => db.update(ranks).set({ isActive: false }).where(eq(ranks.id, c.id)))).toBeTruthy();
  });
  it('FN2-ORG-017 sections and ranks cannot be deleted (DB)', async () => {
    expect(await err(() => db.delete(ranks).where(eq(ranks.id, R.a.id)))).toBeTruthy();
    expect(await err(() => db.delete(sections).where(eq(sections.id, S2)))).toBeTruthy();
  });
  it('FN2-ORG-018 moveItem rank up/down swaps neighbours; first-up is a no-op', async () => {
    const order = async () => (await listOrg()).find((s) => s.id === S1)!.ranks.filter((r) => [R.a.id, R.b.id, R.c.id].includes(r.id)).map((r) => r.id);
    const base = await order();
    expect(base).toEqual([R.a.id, R.b.id, R.c.id]);
    await moveItem(cap, 'rank', R.c.id, 'up', meta);
    expect(await order()).toEqual([R.a.id, R.c.id, R.b.id]);
    await moveItem(cap, 'rank', R.c.id, 'down', meta);
    expect(await order()).toEqual(base);
    await moveItem(cap, 'rank', R.a.id, 'up', meta);
    expect(await order()).toEqual(base);
  });
  it('FN2-ORG-019 moveItem section swaps order; bad direction / id rejected', async () => {
    const order = async () => (await listOrg()).map((s) => s.id).filter((i) => i === S1 || i === S2);
    expect(await order()).toEqual([S1, S2]);
    await moveItem(cap, 'section', S2, 'up', meta);
    expect(await order()).toEqual([S2, S1]);
    await moveItem(cap, 'section', S2, 'down', meta);
    expect(await order()).toEqual([S1, S2]);
    expect((await err(() => moveItem(cap, 'rank', R.a.id, 'sideways' as never, meta)))?.code).toBe('NOT_FOUND');
    expect((await err(() => moveItem(cap, 'rank', 0, 'up', meta)))?.code).toBe('NOT_FOUND');
    expect((await err(() => moveItem(cap, 'rank', 30000, 'up', meta)))?.code).toBe('NOT_FOUND');
  });
  it('FN2-ORG-020 unknown / invalid ids -> NOT_FOUND', async () => {
    expect((await err(() => updateSection(cap, 30000, { name: 'x' }, meta)))?.code).toBe('NOT_FOUND');
    expect((await err(() => updateRank(cap, -1, { name: 'x' }, meta)))?.code).toBe('NOT_FOUND');
    expect((await err(() => createRank(cap, { sectionId: 30000, name: 'x' }, meta)))?.code).toBe('NOT_FOUND');
    expect((await err(() => createRank(cap, { sectionId: 'abc', name: 'x' }, meta)))?.code).toBe('NOT_FOUND');
  });
  it('FN2-ORG-021 listOrg: section count equals sum of rank counts; Officer flagged system', async () => {
    const all = await listOrg();
    const o = all.find((s) => s.id === S1)!;
    expect(o.activeMembers).toBe(o.ranks.reduce((a, r) => a + r.activeMembers, 0));
    expect(all.find((s) => s.isSystem)!.name).toBe('Officer');
  });
  it('FN2-ORG-022 newly created rank usable in promotion immediately; deactivated rank not', async () => {
    const r = (await createRank(cap, { sectionId: S1, name: nm('use') }, meta))!.id;
    const m = await mk();
    await promoteMembers(cap, { userIds: [m.id], sectionId: S1, rankId: r, reason: 'new rank' }, meta);
    await promoteMembers(cap, { userIds: [m.id], sectionId: R.a.sectionId, rankId: R.a.id, reason: 'back' }, meta);
    await updateRank(cap, r, { isActive: false }, meta);
    expect((await err(() => promoteMembers(cap, { userIds: [m.id], sectionId: S1, rankId: r, reason: 'x' }, meta)))?.fieldErrors?.rankId).toBeTruthy();
  });
});
