// 组别范围与军官专属规则（用不同组别的账号逐一测试）
// - Captain / Superadmin / 军官 看全部；其他人只看自己组别，除非有 users.all_sections
// - 升阶、重设密码只能由军官做；军员就算被给了权限也不生效
// - 每个人都能改自己的联络资料（My profile）
import { beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLogs, guardians, userPermissionOverrides, users } from '@/lib/db/schema';
import type { CurrentUser } from '@/lib/server/auth/session';
import { getPermissionsFor, memberScope } from '@/lib/server/authz';
import type { PermissionSlug } from '@/lib/server/authz/catalog';
import { getUserAccess } from '@/lib/server/access/service';
import { getOwnProfile, updateOwnProfile } from '@/lib/server/users/profile';
import { createUser, getUserDetail, listUsers, promoteMembers, resetPassword, updateUser } from '@/lib/server/users/service';
import { actor, baseInput, err, makeUser, meta, newIc, rankId, RUN } from './helpers';

let cap: CurrentUser;
const sec = {} as Record<'jr' | 'sr' | 'off', { id: number; sectionId: number }>;
const ids = {} as Record<'jrA' | 'jrB' | 'srA' | 'offA', string>;

/** 建一个成员并直接给个人 ALLOW 权限，回传当作登入者用的 CurrentUser */
async function person(where: keyof typeof sec, perms: PermissionSlug[], over: Record<string, unknown> = {}) {
  const r = sec[where];
  const { id, input } = await makeUser(cap, { sectionId: r.sectionId, rankId: r.id, ...(where === 'off' ? { guardians: [] } : {}), ...over });
  if (perms.length) await db.insert(userPermissionOverrides).values(perms.map((p) => ({ userId: id, permissionSlug: p, effect: 'allow' as const, setBy: cap.id })));
  return actor(input.username as string);
}
const scopeList = async (a: CurrentUser, q = `QA FN ${RUN}`) => listUsers({ q, status: 'all', pageSize: 100 }, { canSearchIc: false, scope: await memberScope(a) });

beforeAll(async () => {
  cap = await actor('dev.captain');
  sec.jr = await rankId('Junior', 'Member');
  sec.sr = await rankId('Senior', 'Private');
  sec.off = await rankId('Officer', 'Lieutenant');
  ids.jrA = (await makeUser(cap, { sectionId: sec.jr.sectionId, rankId: sec.jr.id })).id;
  ids.jrB = (await makeUser(cap, { sectionId: sec.jr.sectionId, rankId: sec.jr.id, idType: 'mykad', idNumber: newIc() })).id;
  ids.srA = (await makeUser(cap, { sectionId: sec.sr.sectionId, rankId: sec.sr.id })).id;
  ids.offA = (await makeUser(cap, { sectionId: sec.off.sectionId, rankId: sec.off.id, guardians: [] })).id;
});

describe('Section scope - viewing', () => {
  it('SCOPE-001 Junior with users.view lists only Junior members', async () => {
    const j = await person('jr', ['users.view']);
    expect(await memberScope(j)).toEqual({ sections: [sec.jr.sectionId], platoonId: null });
    const r = await scopeList(j);
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((x) => x.sectionId === sec.jr.sectionId)).toBe(true);
    expect(r.rows.map((x) => x.id)).not.toContain(ids.srA);
  });
  it('SCOPE-002 Senior with users.view lists only Senior members', async () => {
    const s = await person('sr', ['users.view']);
    const r = await scopeList(s);
    expect(r.rows.every((x) => x.sectionId === sec.sr.sectionId)).toBe(true);
    expect(r.rows.map((x) => x.id)).not.toContain(ids.jrA);
  });
  it('SCOPE-003 Junior cannot open a Senior or Officer member (looks like not found)', async () => {
    const j = await person('jr', ['users.view']);
    expect((await err(() => getUserDetail(j, ids.srA, meta)))?.code).toBe('NOT_FOUND');
    expect((await err(() => getUserDetail(j, ids.offA, meta)))?.code).toBe('NOT_FOUND');
    expect((await getUserDetail(j, ids.jrA, meta)).id).toBe(ids.jrA);
  });
  it('SCOPE-004 Senior cannot open a Junior member', async () => {
    const s = await person('sr', ['users.view']);
    expect((await err(() => getUserDetail(s, ids.jrA, meta)))?.code).toBe('NOT_FOUND');
  });
  it('SCOPE-005 Officer sees every section', async () => {
    const o = await person('off', ['users.view']);
    expect(await memberScope(o)).toBe('all');
    const r = await scopeList(o);
    const found = r.rows.map((x) => x.id);
    expect(found).toEqual(expect.arrayContaining([ids.jrA, ids.srA, ids.offA]));
    expect((await getUserDetail(o, ids.srA, meta)).id).toBe(ids.srA);
  });
  it('SCOPE-006 Captain sees every section', async () => {
    expect(await memberScope(cap)).toBe('all');
    expect((await getUserDetail(cap, ids.jrA, meta)).id).toBe(ids.jrA);
  });
  it('SCOPE-007 Junior given "every section" (by role or Allow) sees Senior members', async () => {
    const j = await person('jr', ['users.view', 'users.all_sections']);
    expect(await memberScope(j)).toBe('all');
    expect((await getUserDetail(j, ids.srA, meta)).id).toBe(ids.srA);
  });
  it('SCOPE-008 member with no section sees nobody', async () => {
    expect(await memberScope({ ...cap, isCaptain: false, id: ids.jrA, sectionId: null })).toEqual({ sections: [], platoonId: null });
  });
});

describe('Section scope - changes', () => {
  it('SCOPE-010 Junior with users.update can edit a Junior but not a Senior', async () => {
    const j = await person('jr', ['users.view', 'users.update']);
    const d = await getUserDetail(cap, ids.srA, meta);
    const input = { ...(await baseInput()), username: d.username, email: d.email, fullName: d.fullName } as never;
    expect((await err(() => updateUser(j, ids.srA, input, meta)))?.code).toBe('NOT_FOUND');
    const dj = await getUserDetail(cap, ids.jrA, meta);
    const inputJ = { ...(await baseInput()), username: dj.username, email: dj.email, fullName: dj.fullName } as never;
    expect(await err(() => updateUser(j, ids.jrA, inputJ, meta))).toBeNull();
  });
  it('SCOPE-011 Junior with users.create can add Junior members only', async () => {
    const j = await person('jr', ['users.view', 'users.create']);
    const senior = { ...(await baseInput()), sectionId: sec.sr.sectionId, rankId: sec.sr.id } as never;
    const junior = (await baseInput()) as never;
    expect((await err(() => createUser(j, senior, meta)))?.code).toBe('NOT_FOUND');
    expect(await err(() => createUser(j, junior, meta))).toBeNull();
  });
  it('SCOPE-012 Junior with permissions.manage cannot open permissions of a Senior', async () => {
    const j = await person('jr', ['users.view', 'permissions.manage']);
    expect((await err(() => getUserAccess(j, ids.srA)))?.code).toBe('NOT_FOUND');
  });
});

describe('Officer-only actions', () => {
  it('OFF-001 promotion permission given to a Junior does not take effect', async () => {
    const j = await person('jr', ['users.view', 'users.change_rank']);
    expect((await getPermissionsFor(j)).has('users.change_rank')).toBe(false);
    expect((await err(() => promoteMembers(j, { userIds: [ids.jrA], sectionId: sec.jr.sectionId, rankId: sec.jr.id, reason: 'x' }, meta)))?.code).toBe('FORBIDDEN');
  });
  it('OFF-002 reset-password permission given to a Senior does not take effect', async () => {
    const s = await person('sr', ['users.view', 'users.reset_password']);
    expect((await getPermissionsFor(s)).has('users.reset_password')).toBe(false);
    expect((await err(() => resetPassword(s, ids.srA, { reason: 'x' }, meta)))?.code).toBe('FORBIDDEN');
  });
  it('OFF-003 Officer with reset-password can reset a Junior', async () => {
    const o = await person('off', ['users.view', 'users.reset_password']);
    const r = await resetPassword(o, ids.jrA, { reason: 'scope test' }, meta);
    expect(r.tempPassword.length).toBeGreaterThanOrEqual(8);
  });
  it('OFF-004 Officer without the promotion permission cannot promote', async () => {
    const o = await person('off', ['users.view']);
    expect((await err(() => promoteMembers(o, { userIds: [ids.jrA], sectionId: sec.jr.sectionId, rankId: sec.jr.id, reason: 'x' }, meta)))?.code).toBe('FORBIDDEN');
  });
});

describe('ID numbers', () => {
  it('ID-001 member without the ID permission sees a hidden ID', async () => {
    const j = await person('jr', ['users.view']);
    const d = await getUserDetail(j, ids.jrB, meta);
    expect(d.idNumberVisible).toBe(false);
    expect(d.idNumber).toMatch(/^\*{6}-\*{2}-\d{4}$/);
  });
  it('ID-002 the ID permission can be given in Permissions', async () => {
    const j = await person('jr', ['users.view', 'users.view_sensitive']);
    const d = await getUserDetail(j, ids.jrB, meta);
    expect(d.idNumberVisible).toBe(true);
    expect(d.idNumber).toMatch(/^\d{12}$/);
  });
});

describe('My profile', () => {
  it('PROF-001 anyone can see their own profile, including their own ID', async () => {
    const ic = newIc();
    const j = await person('jr', [], { idType: 'mykad', idNumber: ic });
    const p = await getOwnProfile(j);
    expect(p.idNumber).toBe(ic);
    expect(p.hasGuardians).toBe(true);
  });
  it('PROF-002 a member with no permissions can update their own contact details', async () => {
    const j = await person('jr', []);
    const p = await getOwnProfile(j);
    await updateOwnProfile(j, { email: 'me@example.test', phone: '0123456780', address: 'Sibu', school: 'SMK', guardians: [], expectedUpdatedAt: p.updatedAt }, meta);
    const [u] = await db.select().from(users).where(eq(users.id, j.id));
    expect([u.email, u.phone, u.address, u.school]).toEqual(['me@example.test', '0123456780', 'Sibu', 'SMK']);
    const [a] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, j.id), eq(auditLogs.action, 'PROFILE_UPDATED'))).orderBy(desc(auditLogs.createdAt)).limit(1);
    expect(a).toBeTruthy();
  });
  it('PROF-003 name, username and other identity fields cannot be changed from the profile', async () => {
    const j = await person('jr', []);
    const before = await getOwnProfile(j);
    await updateOwnProfile(j, { email: before.email, fullName: 'Hacked', username: 'hacked', sectionId: sec.off.sectionId, guardians: [] } as never, meta);
    const after = await getOwnProfile(j);
    expect([after.fullName, after.username, after.sectionName]).toEqual([before.fullName, before.username, before.sectionName]);
  });
  it('PROF-004 a member can update their guardians; an officer has none', async () => {
    const j = await person('jr', []);
    await updateOwnProfile(j, { email: 'g@example.test', guardians: [{ name: 'Mum', relationship: 'mother', phone: '0123456789', email: '' }] }, meta);
    const gs = await db.select().from(guardians).where(eq(guardians.userId, j.id));
    expect(gs.map((g) => g.name)).toEqual(['Mum']);
    const o = await person('off', []);
    await updateOwnProfile(o, { email: 'o@example.test', guardians: [{ name: 'X', relationship: 'father', phone: '0123456789' }] }, meta);
    expect(await db.select().from(guardians).where(eq(guardians.userId, o.id))).toEqual([]);
  });
  it('PROF-005 invalid email is rejected and nothing is saved', async () => {
    const j = await person('jr', []);
    const e = await err(() => updateOwnProfile(j, { email: 'not-an-email', guardians: [] }, meta));
    expect(e?.code).toBe('VALIDATION');
    expect(e?.fieldErrors?.email).toBeTruthy();
  });
  it('PROF-006 a stale form is refused', async () => {
    const j = await person('jr', []);
    const e = await err(() => updateOwnProfile(j, { email: 'a@example.test', guardians: [], expectedUpdatedAt: '2000-01-01T00:00:00.000Z' }, meta));
    expect(e?.code).toBe('CONFLICT');
  });
});
