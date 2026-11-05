// FN-UIFIX: 第四轮留下的 3 个界面问题（UI-03 / UI-04 / UI-06）的回归测试
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { platoonScores } from '@/lib/db/schema';
import type { CurrentUser } from '@/lib/server/auth/session';
import { createSection } from '@/lib/server/org/service';
import { createActivity, createPlatoon, scoreboard, updateActivity, updatePlatoon, voidActivity } from '@/lib/server/platoons/service';
import { userAccessBlock } from '@/lib/server/access/service';
import { allowedActions, setStatus } from '@/lib/server/users/service';
import { pickGuardians } from '@/app/components/guardian-errors';
import { actor, makeUser, meta, reasonId, RUN } from './helpers';

let cap: CurrentUser;
let P1: number, P2: number;
const year = Number(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 4));
const created: string[] = [];

beforeAll(async () => {
  cap = await actor('dev.captain');
  const sec = (await createSection(cap, { name: `QA UIFIX ${RUN}` }, meta))!.id;
  P1 = (await createPlatoon(cap, { sectionId: sec, name: `QA UIFIX ${RUN} P1` }, meta))!.id;
  P2 = (await createPlatoon(cap, { sectionId: sec, name: `QA UIFIX ${RUN} P2` }, meta))!.id;
}, 60000);

afterAll(async () => {
  const left = await reasonId('Left company');
  for (const id of created) await setStatus(cap, id, { status: 'inactive', reasonId: left }, meta).catch(() => {});
  for (const id of [P1, P2]) await updatePlatoon(cap, id, { isActive: false }, meta).catch(() => {});
});

describe('UI-03 clear a score', () => {
  it('FN-UIFIX-001 leaving a platoon blank on edit removes its points from the activity and the total', async () => {
    const date = `${year}-01-02`;
    const { id } = (await createActivity(cap, { name: `QA UIFIX ${RUN} act`, activityDate: date, scores: [{ platoonId: P1, points: 10 }, { platoonId: P2, points: 5 }] }, meta))!;
    const before = await scoreboard(year);
    const totalOf = (sb: typeof before, pid: number) => sb.ranking.find((p) => p.id === pid)?.total ?? 0;

    await updateActivity(cap, id, { name: `QA UIFIX ${RUN} act`, activityDate: date, scores: [{ platoonId: P1, points: 10 }, { platoonId: P2, points: '' }] }, meta);
    const [row] = await db.select().from(platoonScores).where(and(eq(platoonScores.activityId, id), eq(platoonScores.platoonId, P2)));
    expect(row.points).toBeNull();
    const after = await scoreboard(year);
    expect(totalOf(after, P2)).toBe(totalOf(before, P2) - 5);
    expect(totalOf(after, P1)).toBe(totalOf(before, P1));
    expect(after.activities.find((a) => a.id === id)?.scores).toEqual({ [P1]: 10 });

    // 清掉后可以再填回去
    await updateActivity(cap, id, { name: `QA UIFIX ${RUN} act`, activityDate: date, scores: [{ platoonId: P1, points: 10 }, { platoonId: P2, points: 7 }] }, meta);
    expect((await scoreboard(year)).activities.find((a) => a.id === id)?.scores).toEqual({ [P1]: 10, [P2]: 7 });
    await voidActivity(cap, id, { reason: 'qa cleanup' }, meta);
  });
});

describe('UI-04 Permissions button only when it can be saved', () => {
  it('FN-UIFIX-002 hidden for the Captain, for yourself, and for someone with more permissions than you', async () => {
    const officer = await actor('dev.officer');
    const m = await makeUser(cap);
    created.push(m.id);
    const kid = await actor(m.input.username);
    expect(await userAccessBlock(cap, { id: cap.id, isCaptain: true })).toMatch(/Captain/);
    expect(await userAccessBlock(officer, { id: officer.id, isCaptain: false })).toMatch(/your own/);
    expect(await userAccessBlock(kid, { id: officer.id, isCaptain: false })).toMatch(/only the Captain/);
    expect(await userAccessBlock(cap, { id: m.id, isCaptain: false })).toBeNull();
    expect((await allowedActions(cap, { id: m.id, isCaptain: false, status: 'active' })).access).toBe(true);
    expect((await allowedActions(cap, { id: cap.id, isCaptain: true, status: 'active' })).access).toBe(false);
  });
});

describe('UI-06 guardian errors under the right box', () => {
  it('FN-UIFIX-003 empty first guardian + filled second: server error for guardians.0 shows under box 2', () => {
    const empty = { name: '', relationship: '', phone: '', email: '' };
    const g2 = { name: 'Mum', relationship: 'mother', phone: 'abc', email: '' };
    const { filled, remap } = pickGuardians([empty, g2]);
    expect(filled).toEqual([g2]);
    expect(remap({ 'guardians.0.phone': 'Enter a valid phone number.', email: 'x' })).toEqual({ 'guardians.1.phone': 'Enter a valid phone number.', email: 'x' });
  });
});
