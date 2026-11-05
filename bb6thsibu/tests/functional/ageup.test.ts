// FN-AGE: 到龄升组（组别设定 + Promotions 到龄名单）
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLogs, sections, users } from '@/lib/db/schema';
import type { CurrentUser } from '@/lib/server/auth/session';
import { createRank, createSection, listOrg, setAgeUp } from '@/lib/server/org/service';
import { ageUpCandidates, promoteMembers, setStatus } from '@/lib/server/users/service';
import { actor, err, makeUser, meta, rankId, reasonId, RUN } from './helpers';

let cap: CurrentUser;
let FROM: number, TO: number, FR: number, TR: number, LEFT: number;
const year = Number(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 4));
const created: string[] = [];
const mk = async (dob: string) => {
  const u = await makeUser(cap, { sectionId: FROM, rankId: FR, dateOfBirth: dob, joinDate: `${year - 1}-01-01` });
  created.push(u.id);
  return u.id;
};

beforeAll(async () => {
  cap = await actor('dev.captain');
  LEFT = await reasonId('Left company');
  FROM = (await createSection(cap, { name: `QA AGE ${RUN} From` }, meta))!.id;
  FR = (await createRank(cap, { sectionId: FROM, name: 'QA Kid' }, meta))!.id;
  TO = (await createSection(cap, { name: `QA AGE ${RUN} To` }, meta))!.id;
  TR = (await createRank(cap, { sectionId: TO, name: 'QA Recruit' }, meta))!.id;
}, 60000);

afterAll(async () => {
  for (const id of created) await setStatus(cap, id, { status: 'inactive', reasonId: LEFT }, meta).catch(() => {});
  await setAgeUp(cap, FROM, { age: null }, meta).catch(() => {});
});

describe('Age-up setting', () => {
  it('FN-AGE-001 only the Captain / Superadmin can change it', async () => {
    const m = await makeUser(cap, { sectionId: FROM, rankId: FR });
    created.push(m.id);
    const kid = await actor(m.input.username);
    expect((await err(() => setAgeUp(kid, FROM, { age: 13, rankId: TR }, meta)))?.code).toBe('FORBIDDEN');
  });

  it('FN-AGE-002 rejects bad ages and bad target ranks', async () => {
    expect((await err(() => setAgeUp(cap, FROM, { age: 3, rankId: TR }, meta)))?.fieldErrors?.age).toBeTruthy();
    expect((await err(() => setAgeUp(cap, FROM, { age: 26, rankId: TR }, meta)))?.fieldErrors?.age).toBeTruthy();
    expect((await err(() => setAgeUp(cap, FROM, { age: 12.5, rankId: TR }, meta)))?.fieldErrors?.age).toBeTruthy();
    expect((await err(() => setAgeUp(cap, FROM, { age: 13 }, meta)))?.fieldErrors?.rankId).toBeTruthy();
    // 同一组别、Captain 军阶、Officer 组别的军阶都不行
    const capRank = (await rankId('Officer', 'Captain')).id;
    const ltRank = (await rankId('Officer', 'Lieutenant')).id;
    expect((await err(() => setAgeUp(cap, FROM, { age: 13, rankId: FR }, meta)))?.fieldErrors?.rankId).toBeTruthy();
    expect((await err(() => setAgeUp(cap, FROM, { age: 13, rankId: capRank }, meta)))?.fieldErrors?.rankId).toBeTruthy();
    expect((await err(() => setAgeUp(cap, FROM, { age: 13, rankId: ltRank }, meta)))?.fieldErrors?.rankId).toBeTruthy();
  });

  it('FN-AGE-003 the Officer section cannot move up by age', async () => {
    const [off] = await db.select({ id: sections.id }).from(sections).where(eq(sections.systemKey, 'officer'));
    expect((await err(() => setAgeUp(cap, off.id, { age: 13, rankId: TR }, meta)))?.code).toBe('FORBIDDEN');
  });

  it('FN-AGE-004 saves, shows in listOrg, writes an audit row; same value = nothing changed', async () => {
    await setAgeUp(cap, FROM, { age: '13', rankId: String(TR) }, meta);
    const s = (await listOrg()).find((x) => x.id === FROM)!;
    expect(s.ageUp).toEqual({ age: 13, rankId: TR });
    const [a] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'sections'), eq(auditLogs.entityId, String(FROM)))).orderBy(desc(auditLogs.createdAt)).limit(1);
    expect(a.action).toBe('SECTION_AGE_UP_CHANGED');
    expect((await err(() => setAgeUp(cap, FROM, { age: 13, rankId: TR }, meta)))?.message).toBe('Nothing has changed.');
  });

  it('FN-AGE-005 the database refuses an age without a rank', async () => {
    await expect(db.update(sections).set({ ageUpAge: 10, ageUpRankId: null }).where(eq(sections.id, FROM))).rejects.toThrow();
  });
});

describe('Age-up list', () => {
  let turning13: string, older: string, younger: string, inactive: string;
  beforeAll(async () => {
    await setAgeUp(cap, FROM, { age: 13, rankId: TR }, meta).catch(() => {});
    turning13 = await mk(`${year - 13}-12-31`); // 生日还没到，但今年会满 13
    older = await mk(`${year - 14}-01-01`);
    younger = await mk(`${year - 12}-01-01`);
    inactive = await mk(`${year - 13}-06-01`);
    await setStatus(cap, inactive, { status: 'inactive', reasonId: LEFT }, meta);
  }, 60000);

  it('FN-AGE-010 lists active members turning the age (or older) this year, by birth year', async () => {
    const g = (await ageUpCandidates('all')).groups.find((x) => x.sectionId === FROM)!;
    const ids = g.members.map((m) => m.id);
    expect(ids).toContain(turning13);
    expect(ids).toContain(older);
    expect(ids).not.toContain(younger);
    expect(ids).not.toContain(inactive);
    expect(g).toMatchObject({ age: 13, rankId: TR, toSectionId: TO });
    expect(g.members.find((m) => m.id === turning13)?.turns).toBe(13);
  });

  it('FN-AGE-011 only lists sections inside the viewer scope', async () => {
    const res = await ageUpCandidates({ sections: [TO], platoonId: null });
    expect(res.groups.find((x) => x.sectionId === FROM)).toBeUndefined();
  });

  it('FN-AGE-012 turned off = no list', async () => {
    await setAgeUp(cap, FROM, { age: null }, meta);
    expect((await ageUpCandidates('all')).groups.find((x) => x.sectionId === FROM)).toBeUndefined();
    await setAgeUp(cap, FROM, { age: 13, rankId: TR }, meta);
  });

  it('FN-AGE-013 confirming moves them to the target rank and they leave the list', async () => {
    await promoteMembers(cap, { userIds: [turning13, older], sectionId: TO, rankId: TR, reason: `Age-up ${year}` }, meta);
    const rows = await db.select({ id: users.id, sectionId: users.sectionId, rankId: users.rankId }).from(users).where(eq(users.id, turning13));
    expect(rows[0]).toMatchObject({ sectionId: TO, rankId: TR });
    const g = (await ageUpCandidates('all')).groups.find((x) => x.sectionId === FROM)!;
    expect(g.members.map((m) => m.id)).not.toContain(turning13);
  });
});
