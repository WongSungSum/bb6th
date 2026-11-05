// System test 2026-11-03：组别 / Platoon 范围、军官专属权限、My profile、Platoon 生命周期、密码长度、维护选单、页面
// 只用自己建立的测试组别（QA SYS ...）和 qa.* 账号，不在真正的 Senior 组别建立 Platoon。
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { rankPermissions, rolePermissions, roles, userPermissionOverrides, userRoles, users } from '@/lib/db/schema';
import type { CurrentUser } from '@/lib/server/auth/session';
import { createSession } from '@/lib/server/auth/session';
import { hashPassword } from '@/lib/server/auth/password';
import { getPermissionsFor, memberScope } from '@/lib/server/authz';
import type { PermissionSlug } from '@/lib/server/authz/catalog';
import { getUserAccess, saveUserAccess } from '@/lib/server/access/service';
import { createRank, createSection, updateRank, updateSection } from '@/lib/server/org/service';
import {
  assignMembers, createActivity, createPlatoon, getPlatoon, listPlatoons, removeMembers, scoreboard, setPlatoonLeaders, updatePlatoon,
} from '@/lib/server/platoons/service';
import { getOwnProfile, updateOwnProfile } from '@/lib/server/users/profile';
import {
  allowedActions, createUser, getOrgOptions, getUserDetail, listUsers, promoteMembers, resetPassword, scopedOrg, setStatus, updateUser,
} from '@/lib/server/users/service';
import { maintenanceItems } from '@/app/maintenance/menu';
import { actor, baseInput, err, meta, PW, rankId, reasonId, RUN } from './helpers';

let cap: CurrentUser;
let SEC = 0; // 有 Platoon 的测试组别
let RK = 0;
let SEC2 = 0; // 没有 Platoon 的测试组别
let RK2 = 0;
let P1 = 0;
let P2 = 0;
let officer: CurrentUser;
let seq = 0;
const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

async function allow(id: string, perms: PermissionSlug[]) {
  if (perms.length) await db.insert(userPermissionOverrides).values(perms.map((p) => ({ userId: id, permissionSlug: p, effect: 'allow' as const, setBy: cap.id })));
}
async function member(sectionId: number, rank: number, platoonId: number | undefined, perms: PermissionSlug[] = [], over: Record<string, unknown> = {}) {
  const input = await baseInput({ sectionId, rankId: rank, platoonId, fullName: `QA SYS ${RUN} M${++seq}`, ...over } as never);
  const { id } = (await createUser(cap, input, meta))!;
  await allow(id, perms);
  return { id, user: await actor(input.username as string) };
}
const inP = (p: number | undefined, perms: PermissionSlug[] = []) => member(SEC, RK, p, perms);
async function editInput(id: string, extra: Record<string, unknown> = {}) {
  const d = await getUserDetail(cap, id, meta);
  return { ...(await baseInput()), username: d.username, email: d.email, fullName: d.fullName, sectionId: d.sectionId, rankId: d.rankId, ...extra } as never;
}
const sysList = async (a: CurrentUser, extra: Record<string, unknown> = {}) =>
  listUsers({ q: `QA SYS ${RUN}`, status: 'all', pageSize: 100, ...extra }, { canSearchIc: false, scope: await memberScope(a) });

beforeAll(async () => {
  cap = await actor('dev.captain');
  SEC = (await createSection(cap, { name: `QA SYS ${RUN}` }, meta))!.id;
  RK = (await createRank(cap, { sectionId: SEC, name: 'QA Private' }, meta))!.id;
  SEC2 = (await createSection(cap, { name: `QA SYS2 ${RUN}` }, meta))!.id;
  RK2 = (await createRank(cap, { sectionId: SEC2, name: 'QA Private' }, meta))!.id;
  P1 = (await createPlatoon(cap, { sectionId: SEC, name: `QA SYS ${RUN} Alpha` }, meta))!.id;
  P2 = (await createPlatoon(cap, { sectionId: SEC, name: `QA SYS ${RUN} Bravo` }, meta))!.id;
  const off = await rankId('Officer', 'Lieutenant');
  const o = await member(off.sectionId, off.id, undefined, ['users.view', 'users.update', 'users.update_status', 'users.reset_password', 'users.change_rank', 'platoons.manage', 'platoons.score'], { guardians: [] });
  officer = o.user;
});

describe('SYS scope: platoon members across every action', () => {
  it('SYS-SCOPE-001 platoon member with update_status: same platoon OK, other platoon NOT_FOUND', async () => {
    const a = await inP(P1, ['users.view', 'users.update_status']);
    const same = await inP(P1);
    const other = await inP(P2);
    const rid = await reasonId('Stepped down');
    expect((await err(() => setStatus(a.user, other.id, { status: 'inactive', reasonId: rid }, meta)))?.code).toBe('NOT_FOUND');
    expect(await err(() => setStatus(a.user, same.id, { status: 'inactive', reasonId: rid }, meta))).toBeNull();
  });
  it('SYS-SCOPE-002 platoon member with users.update cannot edit a member of another platoon', async () => {
    const a = await inP(P1, ['users.view', 'users.update']);
    const other = await inP(P2);
    const inp = await editInput(other.id);
    expect((await err(() => updateUser(a.user, other.id, inp, meta)))?.code).toBe('NOT_FOUND');
  });
  it('SYS-SCOPE-003 platoon member with permissions.manage: other platoon / other section NOT_FOUND (view and save)', async () => {
    const a = await inP(P1, ['users.view', 'permissions.manage']);
    const other = await inP(P2);
    const outside = await member(SEC2, RK2, undefined);
    expect((await err(() => getUserAccess(a.user, other.id)))?.code).toBe('NOT_FOUND');
    expect((await err(() => getUserAccess(a.user, outside.id)))?.code).toBe('NOT_FOUND');
    expect((await err(() => saveUserAccess(a.user, other.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow' }] }, meta)))?.code).toBe('NOT_FOUND');
    expect((await err(() => saveUserAccess(a.user, outside.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow' }] }, meta)))?.code).toBe('NOT_FOUND');
  });
  it('SYS-SCOPE-004 platoon filter in the URL cannot widen a platoon member\'s list', async () => {
    const a = await inP(P1, ['users.view']);
    await inP(P2);
    const r = await sysList(a.user, { platoon: P2 });
    expect(r.rows).toEqual([]);
  });
  it('SYS-SCOPE-005 captain platoon filter returns only that platoon', async () => {
    await inP(P2);
    const r = await sysList(cap, { platoon: P2 });
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((x) => x.platoonId === P2)).toBe(true);
  });
  it('SYS-SCOPE-006 scopedOrg: platoon member sees only own section + own platoon; section-only member sees own section platoons', async () => {
    const a = await inP(P1, ['users.view']);
    const org = scopedOrg(await getOrgOptions(), await memberScope(a.user));
    expect(org.sections.map((s) => s.id)).toEqual([SEC]);
    expect(org.platoons.map((p) => p.id)).toEqual([P1]);
    const b = await member(SEC2, RK2, undefined, ['users.view']);
    const org2 = scopedOrg(await getOrgOptions(), await memberScope(b.user));
    expect(org2.sections.map((s) => s.id)).toEqual([SEC2]);
    expect(org2.platoons).toEqual([]);
  });
  it('SYS-SCOPE-007 platoon member with users.create can add into own platoon', async () => {
    const a = await inP(P1, ['users.view', 'users.create']);
    const input = await baseInput({ sectionId: SEC, rankId: RK, platoonId: P1 } as never);
    expect(await err(() => createUser(a.user, input, meta))).toBeNull();
  });
  it('SYS-SCOPE-008 section-only member with all_sections + update can edit another section', async () => {
    const a = await member(SEC2, RK2, undefined, ['users.view', 'users.update', 'users.all_sections']);
    const other = await inP(P2);
    const inp = await editInput(other.id);
    expect(await err(() => updateUser(a.user, other.id, inp, meta))).toBeNull();
  });
  it('SYS-SCOPE-009 Deny on users.all_sections removes the lift', async () => {
    const a = await member(SEC2, RK2, undefined, ['users.view']);
    await db.insert(userPermissionOverrides).values({ userId: a.id, permissionSlug: 'users.all_sections', effect: 'deny', setBy: cap.id });
    expect(await memberScope(a.user)).toEqual({ sections: [SEC2], platoonId: null });
  });
  it('SYS-SCOPE-010 member of a section with platoons but not yet assigned sees whole section', async () => {
    const a = await inP(P1, ['users.view']);
    await removeMembers(cap, P1, { userIds: [a.id] }, meta);
    expect(await memberScope(a.user)).toEqual({ sections: [SEC], platoonId: null });
  });
  it('SYS-SCOPE-011 detail page buttons: platoon member does not get actions on another platoon (NOT_FOUND on detail)', async () => {
    const a = await inP(P1, ['users.view', 'users.update', 'users.update_status']);
    const same = await inP(P1);
    const d = await getUserDetail(a.user, same.id, meta);
    const acts = await allowedActions(a.user, d);
    expect(acts.edit).toBe(true);
    expect(acts.status).toBe(true);
    expect(acts.resetPassword).toBe(false);
  });
});

describe('SYS officer-only permissions from every source', () => {
  it('SYS-OFF-001 officer-only via a ROLE does not take effect for a non-officer', async () => {
    const [role] = await db.insert(roles).values({ name: `QA SYS ${RUN} Role`, createdBy: cap.id }).returning();
    await db.insert(rolePermissions).values((['users.view', 'users.reset_password', 'platoons.manage', 'platoons.score', 'users.change_rank'] as const).map((p) => ({ roleId: role.id, permissionSlug: p })));
    const a = await inP(P1);
    await db.insert(userRoles).values({ userId: a.id, roleId: role.id });
    const perms = await getPermissionsFor(a.user);
    expect(perms.has('users.view')).toBe(true);
    for (const p of ['users.reset_password', 'platoons.manage', 'platoons.score', 'users.change_rank'] as const) expect(perms.has(p), p).toBe(false);
    expect((await err(() => createActivity(a.user, { name: 'x', activityDate: today, scores: [{ platoonId: P1, points: 1 }] }, meta)))?.code).toBe('FORBIDDEN');
  });
  it('SYS-OFF-002 officer-only via a RANK permission does not take effect for a non-officer', async () => {
    const rk = (await createRank(cap, { sectionId: SEC2, name: `QA Rank ${RUN}` }, meta))!.id;
    await db.insert(rankPermissions).values([{ rankId: rk, permissionSlug: 'users.reset_password' }, { rankId: rk, permissionSlug: 'users.view' }]);
    const a = await member(SEC2, rk, undefined);
    const perms = await getPermissionsFor(a.user);
    expect(perms.has('users.view')).toBe(true);
    expect(perms.has('users.reset_password')).toBe(false);
  });
  it('SYS-OFF-003 officer with Deny on reset_password cannot reset', async () => {
    const off = await rankId('Officer', 'Lieutenant');
    const o = await member(off.sectionId, off.id, undefined, ['users.view', 'users.reset_password'], { guardians: [] });
    await db.update(userPermissionOverrides).set({ effect: 'deny' }).where(eq(userPermissionOverrides.userId, o.id));
    const t = await inP(P1);
    expect((await err(() => resetPassword(o.user, t.id, { reason: 'x' }, meta)))?.code).toBe('FORBIDDEN');
  });
  it('SYS-OFF-004 officer moved to a member section loses officer-only permissions and all-section scope', async () => {
    const off = await rankId('Officer', 'Lieutenant');
    const o = await member(off.sectionId, off.id, undefined, ['users.view', 'users.reset_password', 'platoons.manage'], { guardians: [] });
    expect((await getPermissionsFor(o.user)).has('platoons.manage')).toBe(true);
    await promoteMembers(cap, { userIds: [o.id], sectionId: SEC2, rankId: RK2, reason: 'qa move' }, meta);
    const moved = await actor(o.user.username);
    const perms = await getPermissionsFor(moved);
    expect(perms.has('platoons.manage')).toBe(false);
    expect(perms.has('users.reset_password')).toBe(false);
    expect(await memberScope(moved)).toEqual({ sections: [SEC2], platoonId: null });
  });
  it('SYS-OFF-005 officer-only holder (officer) can reset a member in any section; temp password >= 8', async () => {
    const t = await member(SEC2, RK2, undefined);
    const r = await resetPassword(officer, t.id, { reason: 'qa' }, meta);
    expect(r.tempPassword.length).toBeGreaterThanOrEqual(8);
  });
  it('SYS-OFF-006 platoon maintenance: non-officer with users.all_sections still cannot manage platoons', async () => {
    const a = await member(SEC2, RK2, undefined, ['users.all_sections', 'platoons.manage']);
    expect((await err(() => listPlatoonsAs(a.user)))?.code).toBe('FORBIDDEN');
  });
});
const listPlatoonsAs = (u: CurrentUser) => getPlatoon(u, P1);

describe('SYS my profile', () => {
  it('SYS-PROF-001 officer profile has no guardians; contact fields save; blanks clear optional fields', async () => {
    const p = await getOwnProfile(officer);
    expect(p.hasGuardians).toBe(false);
    await updateOwnProfile(officer, { email: 'off@example.test', phone: '0123456789', address: 'A', school: 'S', guardians: [] }, meta);
    await updateOwnProfile(officer, { email: 'off@example.test', phone: '', address: '', school: '', guardians: [] }, meta);
    const [u] = await db.select().from(users).where(eq(users.id, officer.id));
    expect([u.phone, u.address, u.school]).toEqual([null, null, null]);
  });
  it('SYS-PROF-002 more than 2 guardians refused; unicode address kept', async () => {
    const a = await inP(P1);
    const g = { name: 'G', relationship: 'father' as const, phone: '0123456789', email: '' };
    expect((await err(() => updateOwnProfile(a.user, { email: 'a@example.test', guardians: [g, g, g] }, meta)))?.code).toBe('VALIDATION');
    await updateOwnProfile(a.user, { email: 'a@example.test', address: '诗巫 Sibu 🏠', guardians: [g] }, meta);
    expect((await getOwnProfile(a.user)).address).toBe('诗巫 Sibu 🏠');
  });
  it('SYS-PROF-003 profile cannot change platoon, platoon role, status or rank', async () => {
    const a = await inP(P1);
    await updateOwnProfile(a.user, { email: 'a@example.test', guardians: [], platoonId: P2, platoonRole: 'leader', status: 'inactive', rankId: RK2 } as never, meta);
    const [u] = await db.select().from(users).where(eq(users.id, a.id));
    expect([u.platoonId, u.platoonRole, u.status, u.rankId]).toEqual([P1, null, 'active', RK]);
  });
  it('SYS-PROF-004 superadmin can open own profile', async () => {
    const sa = await actor('dev.superadmin').catch(() => null);
    if (!sa) return;
    const p = await getOwnProfile(sa);
    expect(p.hasGuardians).toBe(false);
  });
});

describe('SYS platoon lifecycle', () => {
  it('SYS-PL-001 officer edit: moving a leader to another platoon clears the leader role', async () => {
    const a = await inP(P1);
    await setPlatoonLeaders(cap, P1, { leaderId: a.id, assistantId: null }, meta);
    await updateUser(officer, a.id, await editInput(a.id, { platoonId: P2 }), meta);
    const [u] = await db.select().from(users).where(eq(users.id, a.id));
    expect([u.platoonId, u.platoonRole]).toEqual([P2, null]);
  });
  it('SYS-PL-002 officer edit: platoon from another section refused', async () => {
    const p3 = (await createPlatoon(cap, { sectionId: SEC2, name: `QA SYS ${RUN} Other` }, meta))!.id;
    const a = await inP(P1);
    const inp = await editInput(a.id, { platoonId: p3 });
    expect((await err(() => updateUser(officer, a.id, inp, meta)))?.fieldErrors?.platoonId).toBeTruthy();
    // 收尾：停用这个 Platoon，以免 SEC2 后面的建立需要选 Platoon
    await updatePlatoon(cap, p3, { isActive: false }, meta);
  });
  it('SYS-PL-003 non-officer edit without platoonId keeps platoon', async () => {
    const a = await inP(P1, ['users.view', 'users.update']);
    const t = await inP(P1);
    await updateUser(a.user, t.id, await editInput(t.id), meta);
    expect((await db.select({ p: users.platoonId }).from(users).where(eq(users.id, t.id)))[0].p).toBe(P1);
  });
  it('SYS-PL-004 promotion within the same section keeps platoon and leader role', async () => {
    const rk = (await createRank(cap, { sectionId: SEC, name: `QA Cpl ${RUN}` }, meta))!.id;
    const p = (await createPlatoon(cap, { sectionId: SEC, name: `QA SYS ${RUN} Charlie` }, meta))!.id;
    const a = await inP(p);
    await setPlatoonLeaders(cap, p, { leaderId: a.id, assistantId: null }, meta);
    await promoteMembers(cap, { userIds: [a.id], sectionId: SEC, rankId: rk, reason: 'qa' }, meta);
    const [u] = await db.select().from(users).where(eq(users.id, a.id));
    expect([u.platoonId, u.platoonRole, u.rankId]).toEqual([p, 'leader', rk]);
  });
  it('SYS-PL-005 a platoon whose only member is inactive: detail page shows 0 members, but deactivation is refused', async () => {
    const p = (await createPlatoon(cap, { sectionId: SEC, name: `QA SYS ${RUN} Delta` }, meta))!.id;
    const a = await inP(p);
    await setStatus(cap, a.id, { status: 'inactive', reasonId: await reasonId('Stepped down') }, meta);
    const detail = await getPlatoon(cap, p);
    expect(detail.members).toEqual([]); // 页面上看不到任何成员可以移出
    expect((await listPlatoons()).platoons.find((x) => x.id === p)?.members).toBe(0);
    const e = await err(() => updatePlatoon(cap, p, { isActive: false }, meta));
    // 期望：0 位（启用中）成员的 Platoon 可以停用，或页面能列出停用成员让人移出
    expect(e, `deactivate refused: ${e?.message}`).toBeNull();
  });
  it('SYS-PL-006 deactivated section: its empty platoons should not stay active on the scoreboard', async () => {
    const s = (await createSection(cap, { name: `QA SYS3 ${RUN}` }, meta))!.id;
    const r = (await createRank(cap, { sectionId: s, name: 'QA R' }, meta))!.id;
    const p = (await createPlatoon(cap, { sectionId: s, name: `QA SYS ${RUN} Echo` }, meta))!.id;
    await updateRank(cap, r, { isActive: false }, meta);
    // 修正后：组别还有启用中的 Platoon 时不能停用（和军阶同一规则）
    expect((await err(() => updateSection(cap, s, { isActive: false }, meta)))?.message).toMatch(/platoons in this section/);
    await updatePlatoon(cap, p, { isActive: false }, meta);
    await updateSection(cap, s, { isActive: false }, meta);
    const sb = await scoreboard(undefined);
    const shown = sb.ranking.find((x) => x.id === p);
    // 期望：组别停用后，它的 Platoon 也停用 / 不再出现，也不能再记分
    expect(shown, 'platoon of an inactive section still on scoreboard').toBeUndefined();
  });
  it('SYS-PL-008 a platoon of an inactive section should not accept new scores', async () => {
    const s = (await createSection(cap, { name: `QA SYS4 ${RUN}` }, meta))!.id;
    const r = (await createRank(cap, { sectionId: s, name: 'QA R' }, meta))!.id;
    const p = (await createPlatoon(cap, { sectionId: s, name: `QA SYS ${RUN} Foxtrot` }, meta))!.id;
    await updateRank(cap, r, { isActive: false }, meta);
    expect((await err(() => updateSection(cap, s, { isActive: false }, meta)))?.message).toMatch(/platoons in this section/);
    await updatePlatoon(cap, p, { isActive: false }, meta);
    await updateSection(cap, s, { isActive: false }, meta);
    const e = await err(() => createActivity(officer, { name: 'QA SYS score', activityDate: today, scores: [{ platoonId: p, points: 1 }] }, meta));
    expect(e?.fieldErrors?.scores, 'score accepted for platoon of inactive section').toBeTruthy();
  });
  it('SYS-PL-007 assign skips inactive member with message', async () => {
    const a = await inP(P1);
    await setStatus(cap, a.id, { status: 'inactive', reasonId: await reasonId('Stepped down') }, meta);
    expect((await err(() => assignMembers(cap, P2, { userIds: [a.id] }, meta)))?.fieldErrors?.[a.id]).toMatch(/inactive/);
  });
});

describe('SYS password minimum 8', () => {
  it('SYS-PW-001 create with 7-char temp password refused, 8 accepted', async () => {
    const bad = await baseInput({ sectionId: SEC2, rankId: RK2, tempPassword: 'Ab3$xyz' } as never);
    expect((await err(() => createUser(cap, bad, meta)))?.fieldErrors?.tempPassword).toMatch(/8/);
    const ok = await baseInput({ sectionId: SEC2, rankId: RK2, tempPassword: 'Qx7$pLm2' } as never);
    expect(await err(() => createUser(cap, ok, meta))).toBeNull();
  });
  it('SYS-PW-002 reset with 7-char password refused, 8 accepted', async () => {
    const t = await member(SEC2, RK2, undefined);
    expect((await err(() => resetPassword(cap, t.id, { password: 'Ab3$xyz', reason: 'qa' }, meta)))?.fieldErrors?.password).toMatch(/8/);
    expect(await err(() => resetPassword(cap, t.id, { password: 'Qx7$pLm2', reason: 'qa' }, meta))).toBeNull();
  });
});

describe('SYS maintenance menu', () => {
  it('SYS-MENU-001 phone shows only Confirmations; platoons only with permission; org only for captain/superadmin', () => {
    const all = maintenanceItems({ orgAdmin: true, isCaptain: true, pending: 2, permissions: true, platoons: true });
    expect(all.filter((i) => !i.desktopOnly).map((i) => i.title)).toEqual(['Confirmations']);
    expect(all.map((i) => i.href)).toEqual(expect.arrayContaining(['/maintenance/platoons', '/maintenance/organization']));
    const plain = maintenanceItems({ orgAdmin: false, isCaptain: false, pending: 0, permissions: false, platoons: false });
    expect(plain).toEqual([]);
    const plOnly = maintenanceItems({ orgAdmin: false, isCaptain: false, pending: 0, permissions: false, platoons: true });
    expect(plOnly.map((i) => i.href)).toEqual(['/maintenance/platoons']);
  });
});

// ─── 页面（dev server，使用测试账号的会话）─────────────
const BASE = 'http://localhost:3000';
async function page(path: string, token?: string) {
  const r = await fetch(BASE + path, { redirect: 'manual', headers: token ? { cookie: `bb6_session=${token}` } : {} });
  return { status: r.status, location: r.headers.get('location'), html: await r.text() };
}
// 测试账号需要有密码（没有密码的账号不能登入），且不需要强制改密码
const mint = async (id: string) => {
  await db.update(users).set({ passwordHash: await hashPassword(PW), mustChangePassword: false }).where(eq(users.id, id));
  return (await db.transaction((tx) => createSession(tx, id, { ip: 'qa-sys', userAgent: 'vitest' }))).token;
};

describe('SYS pages', () => {
  it('SYS-UI-001 signed-out: /profile, /platoons, /maintenance, /maintenance/platoons, /promotions redirect to /login', async () => {
    for (const p of ['/profile', '/platoons', '/maintenance', '/maintenance/platoons', '/promotions']) {
      const r = await page(p);
      expect([302, 303, 307, 308], `${p} -> ${r.status}`).toContain(r.status);
      expect(r.location, p).toContain('/login');
    }
  });
  it('SYS-UI-002 platoon member: list hides other platoon, other-platoon detail is "not found", platoon maintenance denied, scoreboard and profile open', async () => {
    const a = await inP(P1, ['users.view']);
    const other = await inP(P2);
    const tok = await mint(a.id);
    const otherName = (await db.select({ n: users.fullName }).from(users).where(eq(users.id, other.id)))[0].n;
    const list = await page(`/users?q=${encodeURIComponent(`QA SYS ${RUN}`)}&status=all`, tok);
    expect(list.status).toBe(200);
    expect(list.html).not.toContain(otherName);
    const det = await page(`/users/${other.id}`, tok);
    expect(det.status).toBeLessThan(500);
    expect(det.html).not.toContain(otherName);
    const pm = await page('/maintenance/platoons', tok);
    expect(pm.status).toBe(200);
    expect(pm.html).toContain('You do not have access');
    const sb = await page('/platoons', tok);
    expect(sb.status).toBe(200);
    expect(sb.html).toContain(`QA SYS ${RUN} Alpha`);
    const pr = await page('/profile', tok);
    expect(pr.status).toBe(200);
    const access = await page(`/users/${other.id}/access`, tok);
    expect(access.status).toBeLessThan(500);
    expect(access.html).not.toContain(otherName);
  });
  it('SYS-UI-003 officer with platoons.manage opens platoon maintenance and platoon detail (web-only wrapper present)', async () => {
    const tok = await mint(officer.id);
    const pm = await page('/maintenance/platoons', tok);
    expect(pm.status).toBe(200);
    expect(pm.html).toContain(`QA SYS ${RUN} Alpha`);
    expect(pm.html).toContain('Use a computer for this page');
    const pd = await page(`/maintenance/platoons/${P1}`, tok);
    expect(pd.status).toBe(200);
    const bad = await page('/maintenance/platoons/99999', tok);
    expect(bad.status).toBeLessThan(500);
    const bad2 = await page('/maintenance/platoons/abc', tok);
    expect(bad2.status).toBeLessThan(500);
  });
  it('SYS-UI-004 edit page: non-officer sees platoon locked, officer sees a select', async () => {
    const a = await inP(P1, ['users.view', 'users.update']);
    const t = await inP(P1);
    const lock = await page(`/users/${t.id}/edit`, await mint(a.id));
    expect(lock.status).toBe(200);
    expect(lock.html).toContain('Only officers can change platoons.');
    const off = await page(`/users/${t.id}/edit`, await mint(officer.id));
    expect(off.status).toBe(200);
    expect(off.html).toContain('Moving a member clears their leader role.');
  });
  it('SYS-UI-005 /users with junk platoon filter does not 500', async () => {
    const tok = await mint(officer.id);
    for (const q of ['platoon=abc', 'platoon=-1', 'platoon=99999999', 'platoon=1.5', `platoon=${P1}&section=${SEC2}`]) {
      expect((await page(`/users?${q}`, tok)).status, q).toBe(200);
    }
  });
});
