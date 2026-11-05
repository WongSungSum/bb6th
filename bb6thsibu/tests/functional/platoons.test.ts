// Platoon：维护、分配、Leader、看的范围、计分板
// 用自己建立的测试组别，不影响真正的 Senior 组别
import { beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { platoonActivities, platoons, platoonScores, userPermissionOverrides, users } from '@/lib/db/schema';
import type { CurrentUser } from '@/lib/server/auth/session';
import { getPermissionsFor, memberScope } from '@/lib/server/authz';
import type { PermissionSlug } from '@/lib/server/authz/catalog';
import { createRank, createSection } from '@/lib/server/org/service';
import {
  assignMembers, createActivity, createPlatoon, getPlatoon, listPlatoons, movePlatoon, removeMembers, scoreboard,
  setPlatoonLeaders, updateActivity, updatePlatoon, voidActivity,
} from '@/lib/server/platoons/service';
import { createUser, getUserDetail, listUsers, promoteMembers, updateUser } from '@/lib/server/users/service';
import { actor, baseInput, err, meta, rankId, RUN } from './helpers';

let cap: CurrentUser;
let SEC = 0;
let RK = 0;
let P1 = 0;
let P2 = 0;
let officer: CurrentUser;
const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const YEAR = Number(today.slice(0, 4));
let seq = 0;

async function allow(id: string, perms: PermissionSlug[]) {
  if (perms.length) await db.insert(userPermissionOverrides).values(perms.map((p) => ({ userId: id, permissionSlug: p, effect: 'allow' as const, setBy: cap.id })));
}
/** 测试组别里的成员 */
async function member(platoonId: number | undefined, perms: PermissionSlug[] = []) {
  const input = await baseInput({ sectionId: SEC, rankId: RK, platoonId, fullName: `QA PL ${RUN} M${++seq}` } as never);
  const { id } = (await createUser(cap, input, meta))!;
  await allow(id, perms);
  return { id, user: await actor(input.username as string) };
}

beforeAll(async () => {
  cap = await actor('dev.captain');
  SEC = (await createSection(cap, { name: `QA PL ${RUN}` }, meta))!.id;
  RK = (await createRank(cap, { sectionId: SEC, name: 'QA Private' }, meta))!.id;
  P1 = (await createPlatoon(cap, { sectionId: SEC, name: `QA ${RUN} Alpha` }, meta))!.id;
  P2 = (await createPlatoon(cap, { sectionId: SEC, name: `QA ${RUN} Bravo` }, meta))!.id;
  const off = await rankId('Officer', 'Lieutenant');
  const input = await baseInput({ sectionId: off.sectionId, rankId: off.id, guardians: [] });
  const { id } = (await createUser(cap, input, meta))!;
  await allow(id, ['users.view', 'users.update', 'platoons.manage', 'platoons.score']);
  officer = await actor(input.username as string);
});

describe('Platoon maintenance', () => {
  it('PL-001 create: name required, unique (any case), Officer section refused', async () => {
    expect((await err(() => createPlatoon(cap, { sectionId: SEC, name: '  ' }, meta)))?.fieldErrors?.name).toBeTruthy();
    expect((await err(() => createPlatoon(cap, { sectionId: SEC, name: `qa ${RUN} ALPHA` }, meta)))?.fieldErrors?.name).toMatch(/already/);
    const off = await rankId('Officer', 'Lieutenant');
    expect((await err(() => createPlatoon(cap, { sectionId: off.sectionId, name: `QA ${RUN} Off` }, meta)))?.fieldErrors?.sectionId).toMatch(/Officers/);
  });
  it('PL-002 only holders of platoons.manage can manage; a Senior-type member given it gets nothing', async () => {
    const m = await member(P1, ['platoons.manage', 'platoons.score']);
    expect((await getPermissionsFor(m.user)).has('platoons.manage')).toBe(false);
    expect((await err(() => createPlatoon(m.user, { sectionId: SEC, name: `QA ${RUN} X` }, meta)))?.code).toBe('FORBIDDEN');
    expect((await err(() => getPlatoon(m.user, P1)))?.code).toBe('FORBIDDEN');
    expect((await err(() => createActivity(m.user, { name: 'x', activityDate: today, scores: [{ platoonId: P1, points: 1 }] }, meta)))?.code).toBe('FORBIDDEN');
  });
  it('PL-003 officer with platoons.manage can rename and reorder', async () => {
    await updatePlatoon(officer, P2, { name: `QA ${RUN} Bravo2` }, meta);
    await movePlatoon(officer, P2, 'up', meta);
    const l = await listPlatoons();
    const mine = l.platoons.filter((p) => p.id === P1 || p.id === P2).map((p) => p.id);
    expect(mine).toEqual([P2, P1]);
    expect((await err(() => updatePlatoon(officer, P2, { isActive: 'no' as never }, meta)))?.code).toBe('VALIDATION');
  });
  it('PL-004 a platoon with members cannot be deactivated', async () => {
    const p = (await createPlatoon(cap, { sectionId: SEC, name: `QA ${RUN} Tmp` }, meta))!.id;
    const m = await member(p);
    expect((await err(() => updatePlatoon(cap, p, { isActive: false }, meta)))?.message).toMatch(/Move the members/);
    await removeMembers(cap, p, { userIds: [m.id] }, meta);
    await updatePlatoon(cap, p, { isActive: false }, meta);
    // 停用后不能再加人，也不能被选为新成员的 Platoon
    expect((await err(() => assignMembers(cap, p, { userIds: [m.id] }, meta)))?.message).toMatch(/Reactivate/);
    const input = await baseInput({ sectionId: SEC, rankId: RK, platoonId: p } as never);
    expect((await err(() => createUser(cap, input, meta)))?.fieldErrors?.platoonId).toBeTruthy();
  });
  it('PL-005 platoons and activities cannot be deleted (database)', async () => {
    expect(await err(() => db.delete(platoons).where(eq(platoons.id, P1)))).toBeTruthy();
    expect(await err(() => db.update(platoons).set({ sectionId: 1 }).where(eq(platoons.id, P1)))).toBeTruthy();
  });
});

describe('Platoon required when adding members', () => {
  it('PL-010 section with platoons: platoon required and must belong to that section', async () => {
    const input = await baseInput({ sectionId: SEC, rankId: RK } as never);
    expect((await err(() => createUser(cap, input, meta)))?.fieldErrors?.platoonId).toMatch(/Select a platoon/);
    const jr = await rankId('Junior', 'Member');
    const wrong = await baseInput({ sectionId: jr.sectionId, rankId: jr.id, platoonId: P1 } as never);
    expect((await err(() => createUser(cap, wrong, meta)))?.fieldErrors?.platoonId).toMatch(/no platoons/);
    const ok = await baseInput({ sectionId: SEC, rankId: RK, platoonId: String(P1) } as never);
    const { id } = (await createUser(cap, ok, meta))!;
    expect((await db.select({ p: users.platoonId }).from(users).where(eq(users.id, id)))[0].p).toBe(P1);
  });
  it('PL-011 database refuses a platoon from another section', async () => {
    const jr = await rankId('Junior', 'Member');
    const m = await member(P1);
    expect(await err(() => db.update(users).set({ sectionId: jr.sectionId, rankId: jr.id }).where(eq(users.id, m.id)))).toBeTruthy();
  });
});

describe('Assigning members', () => {
  it('PL-020 batch add moves members between platoons and clears their leader role', async () => {
    const a = await member(P1);
    const b = await member(P1);
    await setPlatoonLeaders(cap, P1, { leaderId: a.id, assistantId: null }, meta);
    await assignMembers(officer, P2, { userIds: [a.id, b.id] }, meta);
    const rows = await db.select({ id: users.id, p: users.platoonId, r: users.platoonRole }).from(users).where(eq(users.platoonId, P2));
    expect(rows.find((r) => r.id === a.id)).toMatchObject({ p: P2, r: null });
    expect(rows.find((r) => r.id === b.id)?.p).toBe(P2);
  });
  it('PL-021 all-or-nothing: one bad member means nothing changes', async () => {
    const a = await member(P1);
    const jr = await rankId('Junior', 'Member');
    const { id: junior } = (await createUser(cap, await baseInput({ sectionId: jr.sectionId, rankId: jr.id }), meta))!;
    const e = await err(() => assignMembers(cap, P2, { userIds: [a.id, junior, '00000000-0000-4000-8000-000000000000'] }, meta));
    expect(e?.fieldErrors?.[junior]).toMatch(/not in this section/);
    expect((await db.select({ p: users.platoonId }).from(users).where(eq(users.id, a.id)))[0].p).toBe(P1);
  });
  it('PL-022 input checks: empty, too many, bad ids, already in platoon', async () => {
    expect((await err(() => assignMembers(cap, P1, { userIds: [] }, meta)))?.fieldErrors?.userIds).toBeTruthy();
    expect((await err(() => assignMembers(cap, P1, { userIds: Array.from({ length: 101 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`) }, meta)))?.fieldErrors?.userIds).toMatch(/at most/);
    expect((await err(() => assignMembers(cap, P1, { userIds: ["' or 1=1"] }, meta)))?.code).toBe('NOT_FOUND');
    const a = await member(P1);
    expect((await err(() => assignMembers(cap, P1, { userIds: [a.id] }, meta)))?.fieldErrors?.[a.id]).toMatch(/Already/);
  });
  it('PL-023 remove: only members of this platoon; removed member shows as unassigned', async () => {
    const a = await member(P1);
    expect((await err(() => removeMembers(cap, P2, { userIds: [a.id] }, meta)))?.fieldErrors?.[a.id]).toMatch(/Not in this platoon/);
    await removeMembers(cap, P1, { userIds: [a.id] }, meta);
    expect((await listPlatoons()).unassigned.map((u) => u.id)).toContain(a.id);
  });
  it('PL-024 officers can change a platoon from the member edit page; others cannot', async () => {
    const a = await member(P1);
    const d = await getUserDetail(cap, a.id, meta);
    const base = { ...(await baseInput()), username: d.username, email: d.email, fullName: d.fullName, sectionId: SEC, rankId: RK };
    await updateUser(officer, a.id, { ...base, platoonId: P2 } as never, meta);
    expect((await db.select({ p: users.platoonId }).from(users).where(eq(users.id, a.id)))[0].p).toBe(P2);
    const editor = await member(P2, ['users.view', 'users.update']);
    expect((await err(() => updateUser(editor.user, a.id, { ...base, platoonId: P1 } as never, meta)))?.message).toMatch(/Only officers/);
  });
  it('PL-025 leaving the section (promotion) leaves the platoon', async () => {
    const a = await member(P1);
    const sr = await rankId('Junior', 'Member');
    await promoteMembers(cap, { userIds: [a.id], sectionId: sr.sectionId, rankId: sr.id, reason: 'qa' }, meta);
    const [u] = await db.select({ p: users.platoonId, r: users.platoonRole }).from(users).where(eq(users.id, a.id));
    expect(u).toEqual({ p: null, r: null });
  });
});

describe('Leaders', () => {
  it('PL-030 one leader and one assistant, both must be members, not the same person', async () => {
    const a = await member(P1);
    const b = await member(P1);
    const out = await member(P2);
    expect((await err(() => setPlatoonLeaders(cap, P1, { leaderId: a.id, assistantId: a.id }, meta)))?.fieldErrors?.assistantId).toBeTruthy();
    expect((await err(() => setPlatoonLeaders(cap, P1, { leaderId: out.id, assistantId: null }, meta)))?.fieldErrors?.leaderId).toBeTruthy();
    await setPlatoonLeaders(cap, P1, { leaderId: a.id, assistantId: b.id }, meta);
    // 对调
    await setPlatoonLeaders(cap, P1, { leaderId: b.id, assistantId: a.id }, meta);
    const roles = await db.select({ id: users.id, r: users.platoonRole }).from(users).where(and(eq(users.platoonId, P1)));
    expect(roles.filter((r) => r.r === 'leader').map((r) => r.id)).toEqual([b.id]);
    expect(roles.filter((r) => r.r === 'assistant').map((r) => r.id)).toEqual([a.id]);
    expect((await err(() => setPlatoonLeaders(cap, P1, { leaderId: b.id, assistantId: a.id }, meta)))?.message).toMatch(/Nothing/);
  });
  it('PL-031 database allows only one leader per platoon', async () => {
    const a = await member(P2);
    const b = await member(P2);
    await db.update(users).set({ platoonRole: null }).where(eq(users.platoonId, P2));
    await db.update(users).set({ platoonRole: 'leader' }).where(eq(users.id, a.id));
    expect(await err(() => db.update(users).set({ platoonRole: 'leader' }).where(eq(users.id, b.id)))).toBeTruthy();
  });
});

describe('Platoon scope', () => {
  it('PL-040 a member in a platoon only sees their own platoon', async () => {
    const a = await member(P1, ['users.view']);
    const other = await member(P2);
    expect(await memberScope(a.user)).toEqual({ sections: [SEC], platoonId: P1 });
    const r = await listUsers({ q: `QA PL ${RUN}`, status: 'all', pageSize: 100 }, { canSearchIc: false, scope: await memberScope(a.user) });
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((x) => x.platoonId === P1)).toBe(true);
    expect((await err(() => getUserDetail(a.user, other.id, meta)))?.code).toBe('NOT_FOUND');
  });
  it('PL-041 officers and "every section" holders see all platoons', async () => {
    expect(await memberScope(officer)).toBe('all');
    const a = await member(P1, ['users.view', 'users.all_sections']);
    expect(await memberScope(a.user)).toBe('all');
  });
  it('PL-042 a member of a platoon cannot add someone into another platoon', async () => {
    const a = await member(P1, ['users.view', 'users.create']);
    const input = await baseInput({ sectionId: SEC, rankId: RK, platoonId: P2 } as never);
    expect((await err(() => createUser(a.user, input, meta)))?.code).toBe('NOT_FOUND');
  });
});

describe('Scoreboard', () => {
  let actId = '';
  it('PL-050 record an activity; totals and ranking follow', async () => {
    const before = await scoreboard(YEAR);
    const t = (pid: number) => before.ranking.find((p) => p.id === pid)?.total ?? 0;
    actId = (await createActivity(officer, { name: 'QA Drill', activityDate: today, note: 'n', scores: [{ platoonId: P1, points: 10 }, { platoonId: P2, points: 4 }] }, meta)).id;
    const after = await scoreboard(YEAR);
    const tot = (pid: number) => after.ranking.find((p) => p.id === pid)!.total;
    expect(tot(P1) - t(P1)).toBe(10);
    expect(tot(P2) - t(P2)).toBe(4);
    expect(after.activities.find((a) => a.id === actId)?.scores).toEqual({ [P1]: 10, [P2]: 4 });
  });
  it('PL-051 validation: name, date, future date, points range, whole numbers, unknown platoon, empty', async () => {
    const v = (x: object) => err(() => createActivity(officer, { name: 'ok', activityDate: today, scores: [{ platoonId: P1, points: 1 }], ...x }, meta));
    expect((await v({ name: '' }))?.fieldErrors?.name).toBeTruthy();
    expect((await v({ activityDate: '2026-02-30' }))?.fieldErrors?.activityDate).toBeTruthy();
    expect((await v({ activityDate: '2999-01-01' }))?.fieldErrors?.activityDate).toMatch(/future/);
    expect((await v({ scores: [{ platoonId: P1, points: 1001 }] }))?.fieldErrors?.[`score.${P1}`]).toBeTruthy();
    expect((await v({ scores: [{ platoonId: P1, points: 1.5 }] }))?.fieldErrors?.[`score.${P1}`]).toBeTruthy();
    expect((await v({ scores: [{ platoonId: 32000, points: 1 }] }))?.fieldErrors?.scores).toBeTruthy();
    expect((await v({ scores: [] }))?.fieldErrors?.scores).toBeTruthy();
    expect((await v({ scores: [{ platoonId: P1, points: 1 }, { platoonId: P1, points: 2 }] }))?.fieldErrors?.scores).toBeTruthy();
  });
  it('PL-052 edit scores; stale edit refused', async () => {
    const a = (await scoreboard(YEAR)).activities.find((x) => x.id === actId)!;
    await updateActivity(officer, actId, { name: 'QA Drill 2', activityDate: today, scores: [{ platoonId: P1, points: 7 }], expectedUpdatedAt: a.updatedAt }, meta);
    const b = (await scoreboard(YEAR)).activities.find((x) => x.id === actId)!;
    expect(b.name).toBe('QA Drill 2');
    expect(b.scores).toEqual({ [P1]: 7 }); // 修改时没填的 Platoon = 清掉分数（2026-11-04 起）
    expect((await err(() => updateActivity(officer, actId, { name: 'x', activityDate: today, scores: [{ platoonId: P1, points: 1 }], expectedUpdatedAt: a.updatedAt }, meta)))?.code).toBe('CONFLICT');
  });
  it('PL-053 void: no longer counts, needs a reason, cannot be edited or voided again', async () => {
    const before = await scoreboard(YEAR);
    expect((await err(() => voidActivity(officer, actId, { reason: ' ' }, meta)))?.fieldErrors?.reason).toBeTruthy();
    await voidActivity(officer, actId, { reason: 'entered twice' }, meta);
    const after = await scoreboard(YEAR);
    expect(before.ranking.find((p) => p.id === P1)!.total - after.ranking.find((p) => p.id === P1)!.total).toBe(7);
    expect(after.activities.find((a) => a.id === actId)?.voided).toBe(true);
    expect((await err(() => updateActivity(officer, actId, { name: 'x', activityDate: today, scores: [{ platoonId: P1, points: 1 }] }, meta)))?.message).toMatch(/voided/);
    expect((await err(() => voidActivity(officer, actId, { reason: 'again' }, meta)))?.message).toMatch(/already/);
    // 数据库也挡住
    expect(await err(() => db.update(platoonActivities).set({ name: 'hack' }).where(eq(platoonActivities.id, actId)))).toBeTruthy();
    expect(await err(() => db.delete(platoonScores).where(eq(platoonScores.activityId, actId)))).toBeTruthy();
  });
  it('PL-054 ties share a place; other years are separate', async () => {
    const sb = await scoreboard(YEAR);
    for (const p of sb.ranking) expect(p.place).toBe(sb.ranking.findIndex((q) => q.total === p.total) + 1);
    const past = await scoreboard(2001);
    expect(past.activities.filter((a) => a.scores[P1] !== undefined || a.scores[P2] !== undefined)).toEqual([]); // 只看本测试的 Platoon（别的测试可能建了 2001 年的活动）
    expect(past.ranking.every((p) => p.total === 0)).toBe(true);
    expect((await scoreboard('abc')).year).toBe(YEAR);
  });
  it('PL-055 bad activity ids are not found', async () => {
    expect((await err(() => voidActivity(officer, 'nope', { reason: 'x' }, meta)))?.code).toBe('NOT_FOUND');
    expect((await err(() => updateActivity(officer, '00000000-0000-4000-8000-000000000000', { name: 'x', activityDate: today, scores: [{ platoonId: P1, points: 1 }] }, meta)))?.code).toBe('NOT_FOUND');
  });
});
