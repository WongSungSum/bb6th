// FN-DEEP: deep functional bug hunt - boundaries, state machines, invariants, audit, listing, profile.
// Service-level against the local dev DB. Rows cannot be deleted; fixtures use the qa. prefix, live in
// their own QA sections, and are deactivated in afterAll. Tests whose name has [bug] document a
// confirmed defect: they assert the CORRECT behaviour and fail until the code is fixed.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { db } from '@/lib/db/client';
import { auditLogs, guardians, permissionChangeRequests, platoonScores, platoons, rankHistory, ranks, sections, sessions, userPermissionOverrides, users } from '@/lib/db/schema';
import type { CurrentUser } from '@/lib/server/auth/session';
import { createSession } from '@/lib/server/auth/session';
import { login } from '@/lib/server/auth/login';
import { checkPasswordPolicy } from '@/lib/server/auth/password';
import type { PermissionSlug } from '@/lib/server/authz/catalog';
import { decideRequest, saveRankAccess, saveUserAccess } from '@/lib/server/access/service';
import { createRank, createSection, listOrg, updateRank, updateSection } from '@/lib/server/org/service';
import {
  assignMembers, createActivity, createPlatoon, listPlatoons, removeMembers, scoreboard, setPlatoonLeaders, updateActivity, updatePlatoon, voidActivity,
} from '@/lib/server/platoons/service';
import { getOwnProfile, updateOwnProfile } from '@/lib/server/users/profile';
import { createUser, getUserDetail, listUsers, promoteMembers, resetPassword, setStatus, updateUser } from '@/lib/server/users/service';
import { createUserSchema } from '@/lib/validation/users';
import { actor, baseInput, err, guardian, meta, newIc, rankId, reasonId, RUN, uname } from './helpers';

let cap: CurrentUser;
let OFF: { id: number; sectionId: number };
let DS = 0, DR1 = 0, DR2 = 0, DP1 = 0, DP2 = 0; // section with platoons
let DS2 = 0, DX = 0, DX2 = 0; // section without platoons
let LEFT = 0; // "Left company" style reason without note
const created: string[] = [];
const todayMy = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const addDays = (d: string, n: number) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const YEAR = Number(todayMy().slice(0, 4));
let seq = 0;

/** member in a given section/rank (and platoon if that section has platoons) */
async function mk(over: Record<string, unknown> = {}) {
  const input = await baseInput({ sectionId: DS2, rankId: DX, fullName: `QA DEEP ${RUN} M${++seq}`, ...over } as never);
  const res = await createUser(cap, input, meta);
  created.push(res!.id);
  return { id: res!.id, username: input.username as string, input };
}
const row = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0];
const lastAudit = async (id: string, action?: string) =>
  (await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, id), action ? eq(auditLogs.action, action) : undefined)).orderBy(desc(auditLogs.createdAt), desc(auditLogs.id)).limit(1))[0];
async function allow(id: string, perms: PermissionSlug[]) {
  await db.insert(userPermissionOverrides).values(perms.map((p) => ({ userId: id, permissionSlug: p, effect: 'allow' as const, setBy: cap.id })));
}
const ghosts = (n: number) => Array.from({ length: n }, () => randomUUID());

beforeAll(async () => {
  cap = await actor('dev.captain');
  OFF = await rankId('Officer', 'Lieutenant');
  LEFT = await reasonId('Left company').catch(async () => (await db.execute(sql`select id from inactive_reasons where not requires_note and is_active limit 1`)).rows[0].id as number);
  DS = (await createSection(cap, { name: `QA DEEP ${RUN} A` }, meta))!.id;
  DR1 = (await createRank(cap, { sectionId: DS, name: 'QA D1' }, meta))!.id;
  DR2 = (await createRank(cap, { sectionId: DS, name: 'QA D2' }, meta))!.id;
  DP1 = (await createPlatoon(cap, { sectionId: DS, name: `QA DEEP ${RUN} P1` }, meta))!.id;
  DP2 = (await createPlatoon(cap, { sectionId: DS, name: `QA DEEP ${RUN} P2` }, meta))!.id;
  DS2 = (await createSection(cap, { name: `QA DEEP ${RUN} B` }, meta))!.id;
  DX = (await createRank(cap, { sectionId: DS2, name: 'QA X1' }, meta))!.id;
  DX2 = (await createRank(cap, { sectionId: DS2, name: 'QA X2' }, meta))!.id;
});

afterAll(async () => {
  vi.useRealTimers();
  for (const id of created) await setStatus(cap, id, { status: 'inactive', reasonId: LEFT }, meta).catch(() => {});
});

// ─── Passwords ─────────────────────────────────────────

describe('Passwords', () => {
  it('FN-DEEP-001 create temp password 7 refused, 8 accepted, 128 accepted, 129 refused', async () => {
    expect((await err(() => mk({ tempPassword: 'Kq7#zP2' })))?.fieldErrors?.tempPassword).toBeTruthy();
    await mk({ tempPassword: 'Kq7#zP2x' });
    await mk({ tempPassword: 'aB3$'.repeat(32) });
    expect((await err(() => mk({ tempPassword: 'aB3$'.repeat(32) + 'z' })))?.fieldErrors?.tempPassword).toBeTruthy();
  });

  it('FN-DEEP-002 reset password 128 accepted, 129 refused', async () => {
    const m = await mk();
    await resetPassword(cap, m.id, { password: 'aB3$'.repeat(32), reason: 'qa' }, meta);
    expect((await err(() => resetPassword(cap, m.id, { password: 'aB3$'.repeat(32) + 'z', reason: 'qa' }, meta)))?.fieldErrors?.password).toMatch(/at most 128/);
  });

  it('FN-DEEP-003 sequences, repeats and common words refused (any case)', () => {
    for (const p of ['abcdefgh', 'ABCDEFGHIJ', 'qwertyuiop', 'Password123', 'aaaaaaaa', '87654321', '23456789', 'ASDFGHJKL']) {
      expect(checkPasswordPolicy(p), p).toBe('This password is too common.');
    }
    expect(checkPasswordPolicy('Kq7#zP2x')).toBeNull();
  });

  it('FN-DEEP-004 password equal to username in another case / with spaces refused (reset)', async () => {
    const m = await mk();
    for (const p of [m.username.toUpperCase(), ` ${m.username}`.replace('.', ' .')]) {
      const e = await err(() => resetPassword(cap, m.id, { password: p, reason: 'qa' }, meta));
      expect(e?.fieldErrors?.password, p).toMatch(/username or ID/);
    }
  });

  it('FN-DEEP-005 reset password equal to own IC written with dashes refused', async () => {
    const ic = newIc();
    const m = await mk({ idType: 'mykad', idNumber: ic });
    const dashed = `${ic.slice(0, 6)}-${ic.slice(6, 8)}-${ic.slice(8)}`;
    expect((await err(() => resetPassword(cap, m.id, { password: dashed, reason: 'qa' }, meta)))?.fieldErrors?.password).toMatch(/username or ID/);
  });

  it('FN-DEEP-006 [fixed] create: temp password equal to the new member\'s own IC is refused (as on reset)', async () => {
    const ic = newIc();
    const e = await err(() => mk({ idType: 'mykad', idNumber: ic, tempPassword: ic }));
    expect(e?.fieldErrors?.tempPassword).toMatch(/username or ID/);
  });
});

// ─── Dates ─────────────────────────────────────────────

describe('Dates', () => {
  const parse = async (over: Record<string, unknown>) => createUserSchema.safeParse(await baseInput(over as never));

  it('FN-DEEP-010 DOB tomorrow (Malaysia time) refused, today accepted', async () => {
    expect((await parse({ dateOfBirth: addDays(todayMy(), 1) })).success).toBe(false);
    expect((await parse({ dateOfBirth: todayMy(), joinDate: todayMy() })).success).toBe(true);
  });

  it('FN-DEEP-011 calendar edges: Feb 29 leap ok, non-leap refused, 1900-01-01 ok, 1899-12-31 refused', async () => {
    expect((await parse({ dateOfBirth: '2012-02-29' })).success).toBe(true);
    expect((await parse({ dateOfBirth: '2013-02-29' })).success).toBe(false);
    expect((await parse({ dateOfBirth: '1900-01-01' })).success).toBe(true);
    expect((await parse({ dateOfBirth: '1899-12-31' })).success).toBe(false);
    expect((await parse({ dateOfBirth: '2012-5-5' })).success).toBe(false);
  });

  it('FN-DEEP-012 [fixed] join date before date of birth is refused', async () => {
    const e = await err(() => mk({ dateOfBirth: '2015-06-01', joinDate: '2010-01-01' }));
    expect(e?.code).toBe('VALIDATION');
    expect(e?.fieldErrors?.joinDate).toBeTruthy();
  });

  it('FN-DEEP-013 midnight Malaysia: 00:30 MYT accepts the new day, 23:59 MYT refuses it (user dates)', async () => {
    const input = await baseInput({});
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-04T16:30:00Z')); // 2026-11-05 00:30 MYT
      expect(createUserSchema.safeParse({ ...input, dateOfBirth: '2026-11-05', joinDate: '2026-11-05' }).success).toBe(true);
      vi.setSystemTime(new Date('2026-11-04T15:59:00Z')); // 2026-11-04 23:59 MYT
      expect(createUserSchema.safeParse({ ...input, dateOfBirth: '2026-11-05', joinDate: '2026-11-04' }).success).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('FN-DEEP-014 midnight Malaysia for activity dates', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-11-04T16:30:00Z'));
      const a = await err(() => createActivity(cap, { name: 'x', activityDate: '2026-11-05', scores: [] }, meta));
      expect(a?.fieldErrors?.activityDate).toBeUndefined();
      vi.setSystemTime(new Date('2026-11-04T15:59:00Z'));
      const b = await err(() => createActivity(cap, { name: 'x', activityDate: '2026-11-05', scores: [] }, meta));
      expect(b?.fieldErrors?.activityDate).toMatch(/future/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('FN-DEEP-015 scoreboard default year flips at Malaysian New Year, not UTC', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2026-12-31T16:30:00Z'));
      expect((await scoreboard(undefined)).year).toBe(2027);
      vi.setSystemTime(new Date('2026-12-31T15:59:00Z'));
      expect((await scoreboard(undefined)).year).toBe(2026);
      expect((await scoreboard('1999')).year).toBe(2026);
      expect((await scoreboard('2026.5')).year).toBe(2026);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Scores ────────────────────────────────────────────

describe('Score input', () => {
  const act = (scores: unknown, over: Record<string, unknown> = {}) => createActivity(cap, { name: `QA DEEP ${RUN} act`, activityDate: `${YEAR - 3}-03-03`, scores, ...over }, meta);

  it('FN-DEEP-020 points -1000 and 1000 accepted; -1001, 1001, 1.5 refused', async () => {
    const { id } = await act([{ platoonId: DP1, points: -1000 }, { platoonId: DP2, points: 1000 }]);
    const s = await db.select().from(platoonScores).where(eq(platoonScores.activityId, id));
    expect(s.map((x) => x.points).sort((a, b) => a! - b!)).toEqual([-1000, 1000]);
    for (const p of [-1001, 1001, 1.5]) expect((await err(() => act([{ platoonId: DP1, points: p }])))?.fieldErrors?.[`score.${DP1}`], String(p)).toBeTruthy();
    await voidActivity(cap, id, { reason: 'qa cleanup' }, meta);
  });

  it('FN-DEEP-021 [fixed] whitespace-only points are treated as blank, not saved as 0', async () => {
    const { id } = await act([{ platoonId: DP1, points: 5 }, { platoonId: DP2, points: '   ' }]);
    const s = await db.select().from(platoonScores).where(eq(platoonScores.activityId, id));
    await voidActivity(cap, id, { reason: 'qa cleanup' }, meta);
    expect(s.find((x) => x.platoonId === DP2)).toBeUndefined(); // actual: DP2 row with points 0
  });

  it('FN-DEEP-022 activity name: whitespace-only refused, 80 ok, 81 refused, inner spaces collapsed', async () => {
    expect((await err(() => act([{ platoonId: DP1, points: 1 }], { name: '   ' })))?.fieldErrors?.name).toBeTruthy();
    expect((await err(() => act([{ platoonId: DP1, points: 1 }], { name: 'n'.repeat(81) })))?.fieldErrors?.name).toBeTruthy();
    const { id } = await act([{ platoonId: DP1, points: 1 }], { name: '  QA   deep  ' + 'n'.repeat(60) });
    const sb = await scoreboard(YEAR - 3);
    expect(sb.activities.find((a) => a.id === id)?.name).toBe('QA deep ' + 'n'.repeat(60));
    await voidActivity(cap, id, { reason: 'qa cleanup' }, meta);
  });

  it('FN-DEEP-023 activity date edges: 2000-01-01 ok, 1999-12-31 and 2024-02-30 refused', async () => {
    for (const d of ['1999-12-31', '2024-02-30', '2024-2-3', '']) expect((await err(() => act([{ platoonId: DP1, points: 1 }], { activityDate: d })))?.fieldErrors?.activityDate, d).toBeTruthy();
    const { id } = await act([{ platoonId: DP1, points: 1 }], { activityDate: '2000-01-01' });
    await voidActivity(cap, id, { reason: 'qa cleanup' }, meta);
  });

  it('FN-DEEP-024 the same platoon twice in one activity refused', async () => {
    expect((await err(() => act([{ platoonId: DP1, points: 1 }, { platoonId: DP1, points: 2 }])))?.fieldErrors?.scores).toMatch(/only have one/);
  });
});

// ─── Batch sizes ───────────────────────────────────────

describe('Batch limits', () => {
  it('FN-DEEP-030 promotion: exactly 100 ids pass the size check, 101 refused, duplicates collapse', async () => {
    const hundred = await err(() => promoteMembers(cap, { userIds: ghosts(100), sectionId: DS2, rankId: DX2, reason: 'qa' }, meta));
    expect(hundred?.message).toMatch(/^100 of 100/);
    expect(Object.keys(hundred?.fieldErrors ?? {})).toHaveLength(100);
    const over = await err(() => promoteMembers(cap, { userIds: ghosts(101), sectionId: DS2, rankId: DX2, reason: 'qa' }, meta));
    expect(over?.fieldErrors?.userIds).toMatch(/at most 100/);
    const g = ghosts(100);
    const dup = await err(() => promoteMembers(cap, { userIds: [...g, g[0]], sectionId: DS2, rankId: DX2, reason: 'qa' }, meta));
    expect(dup?.message).toMatch(/^100 of 100/);
  });

  it('FN-DEEP-031 platoon assign/remove: 100 ok size, 101 refused', async () => {
    for (const fn of [assignMembers, removeMembers]) {
      const a = await err(() => fn(cap, DP1, { userIds: ghosts(100) }, meta));
      expect(a?.message).toMatch(/^100 of 100/);
      const b = await err(() => fn(cap, DP1, { userIds: ghosts(101) }, meta));
      expect(b?.fieldErrors?.userIds).toMatch(/at most 100/);
    }
  });
});

// ─── Optional fields & formats ─────────────────────────

describe('Optional fields and formats', () => {
  it('FN-DEEP-040 empty, whitespace-only and null optional fields are all stored as null', async () => {
    for (const v of ['', '   ', null, undefined]) {
      const m = await mk({ phone: v, address: v, school: v });
      const r = await row(m.id);
      expect([r.phone, r.address, r.school], String(v)).toEqual([null, null, null]);
    }
  });

  it('FN-DEEP-041 phone formats', async () => {
    const good = ['+60 12-345 6789', '01234567', '123456789012345'];
    const bad = ['1234567', '1234567890123456', '12345678a', '++60123456789', '--------', '+'];
    for (const p of good) expect((await createUserSchema.safeParseAsync(await baseInput({ phone: p }))).success, p).toBe(true);
    for (const p of bad) expect((await createUserSchema.safeParseAsync(await baseInput({ phone: p }))).success, p).toBe(false);
  });

  it('FN-DEEP-042 email trimmed; missing TLD and >254 chars refused', async () => {
    const m = await mk({ email: '  QA.Deep@Example.TEST  ' });
    expect((await row(m.id)).email).toBe('QA.Deep@Example.TEST');
    expect((await createUserSchema.safeParseAsync(await baseInput({ email: 'a@b' }))).success).toBe(false);
    expect((await createUserSchema.safeParseAsync(await baseInput({ email: 'a'.repeat(64) + '@' + 'b'.repeat(186) + '.com' }))).success).toBe(false);
  });

  it('FN-DEEP-043 guardian: whitespace-only email stored null, whitespace-only phone refused', async () => {
    const m = await mk({ guardians: [guardian({ email: '   ' })] });
    const [g] = await db.select().from(guardians).where(eq(guardians.userId, m.id));
    expect(g.email).toBeNull();
    expect((await err(() => mk({ guardians: [guardian({ phone: '   ' })] })))?.fieldErrors?.['guardians.0.phone']).toBeTruthy();
  });
});

// ─── ID numbers & usernames ────────────────────────────

describe('ID numbers and usernames', () => {
  it('FN-DEEP-050 MyKad with dashes / spaces / plain is the same IC (duplicate refused)', async () => {
    const ic = newIc();
    await mk({ idType: 'mykad', idNumber: `${ic.slice(0, 6)}-${ic.slice(6, 8)}-${ic.slice(8)}` });
    for (const v of [ic, `${ic.slice(0, 6)} ${ic.slice(6, 8)} ${ic.slice(8)}`, ` ${ic} `]) {
      expect((await err(() => mk({ idType: 'mykad', idNumber: v })))?.fieldErrors?.idNumber, v).toMatch(/already registered/);
    }
  });

  it('FN-DEEP-051 passport case / spacing variants are the same passport', async () => {
    const p = `QA${String(Date.now()).slice(-7)}`;
    await mk({ idType: 'passport', idNumber: p });
    for (const v of [p.toLowerCase(), `${p.slice(0, 3)} ${p.slice(3)}`]) {
      expect((await err(() => mk({ idType: 'passport', idNumber: v })))?.fieldErrors?.idNumber, v).toMatch(/already registered/);
    }
  });

  it('FN-DEEP-052 [fixed] passport written with a dash is the same passport (duplicate refused)', async () => {
    const p = `QB${String(Date.now()).slice(-7)}`;
    await mk({ idType: 'passport', idNumber: p });
    const e = await err(() => mk({ idType: 'passport', idNumber: `${p.slice(0, 2)}-${p.slice(2)}` }));
    expect(e?.fieldErrors?.idNumber).toMatch(/already registered/);
  });

  it('FN-DEEP-053 [fixed] a MyKad number cannot be registered again under ID type "other"', async () => {
    const ic = newIc();
    await mk({ idType: 'mykad', idNumber: ic });
    const e = await err(() => mk({ idType: 'other', idNumber: ic }));
    expect(e?.fieldErrors?.idNumber).toMatch(/already registered/);
  });

  it('FN-DEEP-054 stateless (none): number ignored; many stateless members allowed', async () => {
    const a = await mk({ idType: 'none', idNumber: '123456789012' });
    const b = await mk({ idType: 'none' });
    for (const id of [a.id, b.id]) {
      const r = await row(id);
      expect([r.idType, r.idNumberEnc, r.idNumberHash]).toEqual(['none', null, null]);
    }
  });

  it('FN-DEEP-055 username case / spacing variants collide on create and on edit', async () => {
    const base = `qa.dp.${RUN}.${++seq}`;
    const first = await mk({ username: `  ${base.toUpperCase()} ` });
    expect((await row(first.id)).username).toBe(base);
    expect((await err(() => mk({ username: base })))?.fieldErrors?.username).toMatch(/taken/);
    const other = await mk();
    const e = await err(async () => updateUser(cap, other.id, { ...(other.input as object), username: base.toUpperCase(), guardians: [] } as never, meta));
    expect(e?.fieldErrors?.username).toMatch(/taken/);
  });
});

// ─── State machines ────────────────────────────────────

describe('User status lifecycle', () => {
  it('FN-DEEP-060 active -> inactive -> active: sessions revoked and stay revoked; reason cleared; audits', async () => {
    const m = await mk();
    await db.transaction((tx) => createSession(tx, m.id, meta));
    await setStatus(cap, m.id, { status: 'inactive', reasonId: LEFT }, meta);
    const live = await db.select().from(sessions).where(and(eq(sessions.userId, m.id), sql`${sessions.revokedAt} is null`));
    expect(live).toHaveLength(0);
    await setStatus(cap, m.id, { status: 'active', reason: 'qa back' }, meta);
    const r = await row(m.id);
    expect([r.status, r.inactiveReasonId, r.inactiveNote]).toEqual(['active', null, null]);
    expect((await db.select().from(sessions).where(and(eq(sessions.userId, m.id), sql`${sessions.revokedAt} is null`)))).toHaveLength(0);
    const a = await lastAudit(m.id, 'USER_REACTIVATED');
    expect(a.before).toMatchObject({ status: 'inactive', inactiveReasonId: LEFT });
    expect(a.after).toMatchObject({ status: 'active', inactiveReasonId: null });
    expect(a.reason).toBe('qa back');
  });

  it('FN-DEEP-061 [fixed] deactivating a platoon leader clears the leader role', async () => {
    const m = await mk({ sectionId: DS, rankId: DR1, platoonId: DP1 });
    await setPlatoonLeaders(cap, DP1, { leaderId: m.id, assistantId: null }, meta);
    await setStatus(cap, m.id, { status: 'inactive', reasonId: LEFT }, meta);
    const list = await listPlatoons();
    expect(list.platoons.find((p) => p.id === DP1)?.leader).toBeNull(); // page shows "no leader"
    expect((await row(m.id)).platoonRole).toBeNull(); // ... so the database should agree
  });

  it('FN-DEEP-062 [fixed] reactivating a member whose rank was deactivated meanwhile is refused (or needs a new rank)', async () => {
    const rk = (await createRank(cap, { sectionId: DS2, name: `QA tmp ${++seq}` }, meta))!.id;
    const m = await mk({ rankId: rk });
    await setStatus(cap, m.id, { status: 'inactive', reasonId: LEFT }, meta);
    await updateRank(cap, rk, { isActive: false }, meta);
    const e = await err(() => setStatus(cap, m.id, { status: 'active' }, meta));
    const r = await row(m.id);
    // cleanup so the global invariant test is not polluted by this fixture
    if (r.status === 'active') await setStatus(cap, m.id, { status: 'inactive', reasonId: LEFT }, meta);
    expect(e?.code).toBe('VALIDATION');
  });

  it('FN-DEEP-063 status: same status twice -> CONFLICT; "requires note" with whitespace note refused', async () => {
    const m = await mk();
    expect((await err(() => setStatus(cap, m.id, { status: 'active' }, meta)))?.code).toBe('CONFLICT');
    const [other] = (await db.execute(sql`select id from inactive_reasons where requires_note and is_active limit 1`)).rows as { id: number }[];
    if (other) expect((await err(() => setStatus(cap, m.id, { status: 'inactive', reasonId: other.id, note: '   ' }, meta)))?.fieldErrors?.note).toBeTruthy();
    expect((await row(m.id)).status).toBe('active');
  });
});

describe('Rank changes across sections', () => {
  it('FN-DEEP-064 leader promoted to another section leaves platoon and role; history row written', async () => {
    const m = await mk({ sectionId: DS, rankId: DR1, platoonId: DP2 });
    await setPlatoonLeaders(cap, DP2, { leaderId: m.id, assistantId: null }, meta);
    await promoteMembers(cap, { userIds: [m.id], sectionId: DS2, rankId: DX, reason: 'qa move' }, meta);
    const r = await row(m.id);
    expect([r.sectionId, r.rankId, r.platoonId, r.platoonRole]).toEqual([DS2, DX, null, null]);
    const [h] = await db.select().from(rankHistory).where(eq(rankHistory.userId, m.id)).orderBy(desc(rankHistory.changedAt)).limit(1);
    expect([h.fromSectionId, h.fromRankId, h.toSectionId, h.toRankId]).toEqual([DS, DR1, DS2, DX]);
  });

  it('FN-DEEP-065 [fixed] RANK_CHANGED audit records the platoon / leader role that were cleared', async () => {
    const m = await mk({ sectionId: DS, rankId: DR1, platoonId: DP2 });
    await setPlatoonLeaders(cap, DP2, { leaderId: null, assistantId: m.id }, meta);
    await promoteMembers(cap, { userIds: [m.id], sectionId: DS2, rankId: DX, reason: 'qa move' }, meta);
    const a = await lastAudit(m.id, 'RANK_CHANGED');
    expect(a.before).toMatchObject({ platoonId: DP2, platoonRole: 'assistant' });
    expect(a.after).toMatchObject({ platoonId: null, platoonRole: null });
  });

  it('FN-DEEP-066 batch with one inactive member: nothing saved, inactive named', async () => {
    const a = await mk();
    const b = await mk();
    await setStatus(cap, b.id, { status: 'inactive', reasonId: LEFT }, meta);
    const e = await err(() => promoteMembers(cap, { userIds: [a.id, b.id], sectionId: DS2, rankId: DX2, reason: 'qa' }, meta));
    expect(e?.fieldErrors?.[b.id]).toBe('Member is inactive.');
    expect((await row(a.id)).rankId).toBe(DX);
  });

  it('FN-DEEP-067 promotion into Officer: profile has no guardians section, detail flags officer', async () => {
    const m = await mk({ guardians: [guardian()] });
    await promoteMembers(cap, { userIds: [m.id], sectionId: OFF.sectionId, rankId: OFF.id, reason: 'qa to officer' }, meta);
    const p = await getOwnProfile(await actor(m.username));
    expect(p.hasGuardians).toBe(false);
    const d = await getUserDetail(cap, m.id, meta);
    expect(d.isOfficer).toBe(true);
  });
});

describe('Platoon and section lifecycle', () => {
  it('FN-DEEP-068 platoon deactivate -> reactivate: audits, members not restored, inactive member removed with audit', async () => {
    const P = (await createPlatoon(cap, { sectionId: DS, name: `QA DEEP ${RUN} P3` }, meta))!.id;
    const m = await mk({ sectionId: DS, rankId: DR1, platoonId: P });
    expect((await err(() => updatePlatoon(cap, P, { isActive: false }, meta)))?.message).toMatch(/Move the members/);
    await setStatus(cap, m.id, { status: 'inactive', reasonId: LEFT }, meta);
    await updatePlatoon(cap, P, { isActive: false }, meta);
    expect((await row(m.id)).platoonId).toBeNull();
    expect((await lastAudit(m.id, 'PLATOON_REMOVED'))?.before).toMatchObject({ platoonId: P });
    expect((await lastAudit(String(P), 'PLATOON_DEACTIVATED'))?.after).toMatchObject({ isActive: false });
    await updatePlatoon(cap, P, { isActive: true }, meta);
    expect((await lastAudit(String(P), 'PLATOON_REACTIVATED'))?.before).toMatchObject({ isActive: false });
    expect((await row(m.id)).platoonId).toBeNull();
    await updatePlatoon(cap, P, { isActive: false }, meta);
  });

  it('FN-DEEP-069 section deactivate guard order: members, then ranks, then platoons; rank reactivation needs section', async () => {
    const S = (await createSection(cap, { name: `QA DEEP ${RUN} C` }, meta))!.id;
    const R = (await createRank(cap, { sectionId: S, name: 'QA C1' }, meta))!.id;
    const P = (await createPlatoon(cap, { sectionId: S, name: `QA DEEP ${RUN} PC` }, meta))!.id;
    const m = await mk({ sectionId: S, rankId: R, platoonId: P });
    expect((await err(() => updateSection(cap, S, { isActive: false }, meta)))?.message).toMatch(/active members/);
    await setStatus(cap, m.id, { status: 'inactive', reasonId: LEFT }, meta);
    expect((await err(() => updateSection(cap, S, { isActive: false }, meta)))?.message).toMatch(/ranks/);
    await updateRank(cap, R, { isActive: false }, meta);
    expect((await err(() => updateSection(cap, S, { isActive: false }, meta)))?.message).toMatch(/platoons/);
    await updatePlatoon(cap, P, { isActive: false }, meta);
    await updateSection(cap, S, { isActive: false }, meta);
    expect((await err(() => updateRank(cap, R, { isActive: true }, meta)))?.message).toMatch(/section first/);
    expect((await err(() => updatePlatoon(cap, P, { isActive: true }, meta)))?.message).toMatch(/section first/);
  });
});

describe('Scoreboard state', () => {
  const total = (sb: Awaited<ReturnType<typeof scoreboard>>, id: number) => sb.ranking.find((p) => p.id === id);

  it('FN-DEEP-070 ties share a place; year boundary; re-score (omitted platoon is cleared, 2026-11-04 rule); void excludes; void is final; moving date moves totals', async () => {
    const before = await scoreboard(YEAR);
    const base1 = total(before, DP1)?.total ?? 0;
    const base2 = total(before, DP2)?.total ?? 0;
    const prevBase = total(await scoreboard(YEAR - 1), DP1)?.total ?? 0;
    // equalize so the platoons tie
    const eq1 = Math.max(base1, base2) - base1, eq2 = Math.max(base1, base2) - base2;
    const a1 = (await createActivity(cap, { name: `QA DEEP ${RUN} tie`, activityDate: `${YEAR}-01-01`, scores: [{ platoonId: DP1, points: 10 + eq1 }, { platoonId: DP2, points: 10 + eq2 }] }, meta)).id;
    const a2 = (await createActivity(cap, { name: `QA DEEP ${RUN} nye`, activityDate: `${YEAR - 1}-12-31`, scores: [{ platoonId: DP1, points: 50 }] }, meta)).id;
    let sb = await scoreboard(YEAR);
    expect(total(sb, DP1)?.total).toBe(total(sb, DP2)?.total);
    expect(total(sb, DP1)?.place).toBe(total(sb, DP2)?.place);
    expect(total(await scoreboard(YEAR - 1), DP1)?.total).toBe(prevBase + 50);

    const t2 = total(sb, DP2)!.total;
    const upd = sb.activities.find((a) => a.id === a1)!.updatedAt;
    await updateActivity(cap, a1, { name: `QA DEEP ${RUN} tie`, activityDate: `${YEAR}-01-01`, scores: [{ platoonId: DP1, points: 20 + eq1 }, { platoonId: DP2, points: 10 + eq2 }], expectedUpdatedAt: upd }, meta);
    sb = await scoreboard(YEAR);
    expect(total(sb, DP2)?.total).toBe(t2); // platoon sent with the same score keeps it
    expect(total(sb, DP1)!.total - total(sb, DP2)!.total).toBe(10);
    expect((await err(() => updateActivity(cap, a1, { name: 'x', activityDate: `${YEAR}-01-01`, scores: [{ platoonId: DP1, points: 1 }], expectedUpdatedAt: upd }, meta)))?.code).toBe('CONFLICT');

    await voidActivity(cap, a1, { reason: 'qa void' }, meta);
    sb = await scoreboard(YEAR);
    expect(total(sb, DP1)?.total).toBe(base1);
    expect(total(sb, DP2)?.total).toBe(base2);
    expect((await err(() => updateActivity(cap, a1, { name: 'x', activityDate: `${YEAR}-01-01`, scores: [{ platoonId: DP1, points: 1 }] }, meta)))?.message).toMatch(/voided/);
    expect((await err(() => voidActivity(cap, a1, { reason: 'again' }, meta)))?.message).toMatch(/already voided/);

    await updateActivity(cap, a2, { name: `QA DEEP ${RUN} nye`, activityDate: `${YEAR}-01-02`, scores: [{ platoonId: DP1, points: 50 }] }, meta);
    expect(total(await scoreboard(YEAR - 1), DP1)?.total ?? 0).toBe(prevBase);
    expect(total(await scoreboard(YEAR), DP1)?.total).toBe(base1 + 50);
    await voidActivity(cap, a2, { reason: 'qa cleanup' }, meta);
  });

  it('FN-DEEP-071 audit of a re-score holds old and new points', async () => {
    const id = (await createActivity(cap, { name: `QA DEEP ${RUN} au`, activityDate: `${YEAR - 2}-06-06`, scores: [{ platoonId: DP1, points: 3 }] }, meta)).id;
    await updateActivity(cap, id, { name: `QA DEEP ${RUN} au`, activityDate: `${YEAR - 2}-06-06`, scores: [{ platoonId: DP1, points: 7 }, { platoonId: DP2, points: 1 }] }, meta);
    const a = await lastAudit(id, 'PLATOON_ACTIVITY_UPDATED');
    expect((a.before as { scores: unknown }).scores).toEqual([{ platoonId: DP1, points: 3 }]);
    expect((a.after as { scores: unknown[] }).scores).toEqual(expect.arrayContaining([{ platoonId: DP1, points: 7 }, { platoonId: DP2, points: 1 }]));
    await voidActivity(cap, id, { reason: 'qa cleanup' }, meta);
    expect((await lastAudit(id, 'PLATOON_ACTIVITY_VOIDED'))?.reason).toBe('qa cleanup');
  });
});

describe('Scoreboard visibility', () => {
  it('FN-DEEP-075 [fixed] an inactive platoon whose only scores were voided is not shown on the scoreboard', async () => {
    const P = (await createPlatoon(cap, { sectionId: DS, name: `QA DEEP ${RUN} PV` }, meta))!.id;
    const id = (await createActivity(cap, { name: `QA DEEP ${RUN} pv`, activityDate: `${YEAR - 4}-04-04`, scores: [{ platoonId: P, points: 9 }] }, meta)).id;
    await voidActivity(cap, id, { reason: 'qa' }, meta);
    await updatePlatoon(cap, P, { isActive: false }, meta);
    const sb = await scoreboard(YEAR - 4);
    expect(sb.ranking.find((p) => p.id === P)).toBeUndefined();
  });
});

describe('Login lockout', () => {
  it('FN-DEEP-120 5 wrong passwords by username lock the account for sign-in by IC too', async () => {
    const ic = newIc();
    const pw = 'Kq7#zP2x-deep';
    const m = await mk({ idType: 'mykad', idNumber: ic, tempPassword: pw });
    const m2 = { ip: `qa-deep-${RUN}-${Date.now()}`, userAgent: 'vitest' };
    for (let i = 0; i < 5; i++) expect((await login(m.username, 'wrong-password-x', m2)).ok).toBe(false);
    expect((await login(m.username, pw, m2)).ok).toBe(false); // username is locked
    const r = await row(m.id);
    expect(r.lockedUntil).not.toBeNull();
    expect((await login(ic, pw, { ...m2, ip: m2.ip + 'b' })).ok).toBe(false); // same account via IC should be locked as well
  });
});

describe('Pending permission requests vs. later changes', () => {
  async function delegate() {
    const d = await mk();
    await allow(d.id, ['permissions.manage', 'users.view']);
    return { ...d, user: await actor(d.username) };
  }
  const pending = async (target: string) =>
    (await db.select().from(permissionChangeRequests).where(and(eq(permissionChangeRequests.targetId, target), eq(permissionChangeRequests.status, 'pending'))))[0];

  it('FN-DEEP-072 [fixed] target moved out of the requester\'s section before approval: approval refused', async () => {
    const d = await delegate();
    const t = await mk();
    const res = await saveUserAccess(d.user, t.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow', reason: null }] }, meta);
    expect(res.status).toBe('pending');
    await promoteMembers(cap, { userIds: [t.id], sectionId: DS, rankId: DR1, reason: 'qa move' }, meta);
    // the requester can no longer even see the target ...
    expect((await err(() => saveUserAccess(d.user, t.id, { roleIds: [], overrides: [] }, meta)))?.code).toBe('NOT_FOUND');
    // ... so the Captain should not be able to apply their request
    const req = await pending(t.id);
    const e = await err(() => decideRequest(cap, req.id, 'approve', null, meta));
    if (!e) await saveUserAccess(cap, t.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'inherit', reason: null }] }, meta);
    else await decideRequest(cap, req.id, 'reject', 'qa cleanup', meta);
    expect(e?.code).toBe('CONFLICT');
  });

  it('FN-DEEP-073 target promoted to a rank carrying a permission the requester lacks: approval refused', async () => {
    const d = await delegate();
    const t = await mk();
    await saveRankAccess(cap, DX2, { permissions: ['audit.view'] }, meta);
    try {
      await saveUserAccess(d.user, t.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow', reason: null }] }, meta);
      await promoteMembers(cap, { userIds: [t.id], sectionId: DS2, rankId: DX2, reason: 'qa' }, meta);
      const req = await pending(t.id);
      expect((await err(() => decideRequest(cap, req.id, 'approve', null, meta)))?.code).toBe('CONFLICT');
      await decideRequest(cap, req.id, 'reject', 'qa cleanup', meta);
    } finally {
      await saveRankAccess(cap, DX2, { permissions: [] }, meta);
    }
  });

  it('FN-DEEP-074 requester deactivated before approval: approval refused', async () => {
    const d = await delegate();
    const t = await mk();
    await saveUserAccess(d.user, t.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow', reason: null }] }, meta);
    await setStatus(cap, d.id, { status: 'inactive', reasonId: LEFT }, meta);
    const req = await pending(t.id);
    expect((await err(() => decideRequest(cap, req.id, 'approve', null, meta)))?.code).toBe('CONFLICT');
    await decideRequest(cap, req.id, 'reject', 'qa cleanup', meta);
  });
});

// ─── Global invariants ─────────────────────────────────

describe('Data invariants (whole database)', () => {
  it('FN-DEEP-080 at most one Captain, and the Captain is an active member', async () => {
    const rows = (await db.execute(sql`select u.status, u.account_type from users u join ranks r on r.id = u.rank_id where r.system_key = 'captain'`)).rows as { status: string; account_type: string }[];
    expect(rows.length).toBeLessThanOrEqual(1);
    for (const r of rows) expect([r.status, r.account_type]).toEqual(['active', 'member']);
  });

  it('FN-DEEP-081 platoon roles: unique per platoon, holder is a member of that platoon in the same section', async () => {
    const dup = (await db.execute(sql`select platoon_id, platoon_role, count(*) n from users where platoon_role is not null group by 1,2 having count(*) > 1`)).rows;
    expect(dup).toEqual([]);
    const bad = (await db.execute(sql`select u.id from users u left join platoons p on p.id = u.platoon_id where u.platoon_role is not null and (p.id is null or p.section_id <> u.section_id)`)).rows;
    expect(bad).toEqual([]);
    const sec = (await db.execute(sql`select u.id from users u join platoons p on p.id = u.platoon_id where p.section_id <> u.section_id`)).rows;
    expect(sec).toEqual([]);
    const rk = (await db.execute(sql`select u.id from users u join ranks r on r.id = u.rank_id where r.section_id <> u.section_id`)).rows;
    expect(rk).toEqual([]);
  });

  it('FN-DEEP-082 no active member sits in an inactive platoon', async () => {
    const rows = (await db.execute(sql`select u.id from users u join platoons p on p.id = u.platoon_id where u.status = 'active' and not p.is_active`)).rows;
    expect(rows).toEqual([]);
  });

  it('FN-DEEP-083 no active member holds an inactive rank or sits in an inactive section', async () => {
    const rows = (await db.execute(sql`select u.username from users u join ranks r on r.id = u.rank_id join sections s on s.id = u.section_id where u.status = 'active' and u.account_type = 'member' and (not r.is_active or not s.is_active)`)).rows;
    expect(rows).toEqual([]);
  });

  it('FN-DEEP-084 every QA member created through the service has rank history ending at the current rank', async () => {
    const rows = (await db.execute(sql`
      select u.username from users u
      where u.username like ${`qa.%${RUN}%`} and coalesce((select h.to_rank_id from rank_history h where h.user_id = u.id order by h.changed_at desc, h.id desc limit 1), -1) <> u.rank_id`)).rows;
    expect(rows).toEqual([]);
  });

  it('FN-DEEP-085 every QA member of this run has a USER_CREATED audit row', async () => {
    const mine = await db.select({ id: users.id }).from(users).where(inArray(users.id, created));
    const audited = await db.select({ id: auditLogs.entityId }).from(auditLogs).where(and(eq(auditLogs.action, 'USER_CREATED'), inArray(auditLogs.entityId, created)));
    expect(new Set(audited.map((a) => a.id)).size).toBe(mine.length);
  });

  it('FN-DEEP-086 [fixed] inactive members do not keep a leader / assistant role', async () => {
    const rows = (await db.execute(sql`select username from users where status = 'inactive' and platoon_role is not null`)).rows;
    expect(rows).toEqual([]);
  });
});

// ─── Audit before / after ─────────────────────────────

describe('Audit before/after', () => {
  it('FN-DEEP-090 edit: before/after hold old and new values incl. platoon move and role clear', async () => {
    const m = await mk({ sectionId: DS, rankId: DR1, platoonId: DP1, phone: '0123456789' });
    await setPlatoonLeaders(cap, DP1, { leaderId: m.id, assistantId: null }, meta);
    await updateUser(cap, m.id, { ...(m.input as object), platoonId: DP2, phone: '0198765432', guardians: [] } as never, meta);
    const a = await lastAudit(m.id, 'USER_UPDATED');
    expect(a.before).toMatchObject({ phone: '0123456789', platoonId: DP1, platoonRole: 'leader' });
    expect(a.after).toMatchObject({ phone: '0198765432', platoonId: DP2, platoonRole: null });
  });

  it('FN-DEEP-091 leaders: one audit row per changed member with old/new role, sharing a change set', async () => {
    const a = await mk({ sectionId: DS, rankId: DR1, platoonId: DP1 });
    const b = await mk({ sectionId: DS, rankId: DR1, platoonId: DP1 });
    await setPlatoonLeaders(cap, DP1, { leaderId: a.id, assistantId: b.id }, meta);
    await setPlatoonLeaders(cap, DP1, { leaderId: b.id, assistantId: a.id }, meta);
    const [x, y] = [await lastAudit(a.id, 'PLATOON_ROLE_CHANGED'), await lastAudit(b.id, 'PLATOON_ROLE_CHANGED')];
    expect([x.before, x.after]).toEqual([{ platoonId: DP1, platoonRole: 'leader' }, { platoonId: DP1, platoonRole: 'assistant' }]);
    expect([y.before, y.after]).toEqual([{ platoonId: DP1, platoonRole: 'assistant' }, { platoonId: DP1, platoonRole: 'leader' }]);
    expect(x.changeSetId).toBe(y.changeSetId);
    await setPlatoonLeaders(cap, DP1, { leaderId: null, assistantId: null }, meta);
  });

  it('FN-DEEP-092 leaders: a member of another platoon or an inactive member cannot be chosen', async () => {
    const o = await mk({ sectionId: DS, rankId: DR1, platoonId: DP2 });
    expect((await err(() => setPlatoonLeaders(cap, DP1, { leaderId: o.id, assistantId: null }, meta)))?.fieldErrors?.leaderId).toBeTruthy();
    const i = await mk({ sectionId: DS, rankId: DR1, platoonId: DP1 });
    await setStatus(cap, i.id, { status: 'inactive', reasonId: LEFT }, meta);
    expect((await err(() => setPlatoonLeaders(cap, DP1, { leaderId: null, assistantId: i.id }, meta)))?.fieldErrors?.assistantId).toBeTruthy();
  });
});

// ─── Listing ───────────────────────────────────────────

describe('Listing, search, filters, pagination', () => {
  const NAME = `QA DEEP ${RUN} Same`;
  const same: string[] = [];
  beforeAll(async () => {
    for (let i = 0; i < 7; i++) same.push((await mk({ fullName: NAME })).id);
  });

  it('FN-DEEP-100 identical names: paging is stable, no duplicates or gaps across pages', async () => {
    const seen: string[] = [];
    for (let p = 1; p <= 3; p++) seen.push(...(await listUsers({ q: NAME, page: p, pageSize: 3 }, { canSearchIc: false })).rows.map((r) => r.id));
    expect(seen).toHaveLength(7);
    expect(new Set(seen)).toEqual(new Set(same));
    const r = await listUsers({ q: NAME, page: 4, pageSize: 3 }, { canSearchIc: false });
    expect([r.rows.length, r.total]).toEqual([0, 7]);
  });

  it('FN-DEEP-101 combined filters: section + rank + platoon + status + q; total equals rows', async () => {
    const a = await mk({ sectionId: DS, rankId: DR2, platoonId: DP2, fullName: `QA DEEP ${RUN} Combo` });
    await mk({ sectionId: DS, rankId: DR2, platoonId: DP1, fullName: `QA DEEP ${RUN} Combo` });
    const b = await mk({ sectionId: DS, rankId: DR2, platoonId: DP2, fullName: `QA DEEP ${RUN} Combo` });
    await setStatus(cap, b.id, { status: 'inactive', reasonId: LEFT }, meta);
    const f = { q: `${RUN} combo`, section: DS, rank: DR2, platoon: DP2 };
    const act = await listUsers({ ...f }, { canSearchIc: false });
    expect(act.rows.map((r) => r.id)).toEqual([a.id]);
    const all = await listUsers({ ...f, status: 'all', pageSize: 100 }, { canSearchIc: false });
    expect(all.total).toBe(2);
    expect(all.rows).toHaveLength(2);
    const ina = await listUsers({ ...f, status: 'inactive' }, { canSearchIc: false });
    expect(ina.rows.map((r) => r.id)).toEqual([b.id]);
  });

  it('FN-DEEP-102 special characters: % _ \\ and quotes are literal', async () => {
    const m = await mk({ fullName: `QA DEEP ${RUN} O'Br_en 100%\\x` });
    for (const q of ['%', '_', '\\', "O'Br", '100%\\']) {
      const r = await listUsers({ q, status: 'all', pageSize: 100 }, { canSearchIc: false });
      for (const x of r.rows) expect(`${x.fullName} ${x.username}`.toLowerCase(), q).toContain(q.toLowerCase());
    }
    const r = await listUsers({ q: `${RUN} O'Br_en 100%\\` }, { canSearchIc: false });
    expect(r.rows.map((x) => x.id)).toEqual([m.id]);
  });

  it('FN-DEEP-103 scope + filter that contradict it return nothing (total 0)', async () => {
    const r1 = await listUsers({ section: DS }, { canSearchIc: false, scope: { sections: [DS2], platoonId: null } });
    expect([r1.rows.length, r1.total]).toEqual([0, 0]);
    const r2 = await listUsers({ platoon: DP2 }, { canSearchIc: false, scope: { sections: [DS], platoonId: DP1 } });
    expect([r2.rows.length, r2.total]).toEqual([0, 0]);
    const r3 = await listUsers({}, { canSearchIc: false, scope: { sections: [], platoonId: null } });
    expect(r3.total).toBe(0);
  });

  it('FN-DEEP-104 pageSize / page clamping', async () => {
    expect((await listUsers({ q: NAME, pageSize: 0 }, { canSearchIc: false })).pageSize).toBe(20);
    expect((await listUsers({ q: NAME, pageSize: -5 }, { canSearchIc: false })).pageSize).toBe(1);
    expect((await listUsers({ q: NAME, pageSize: 1000 }, { canSearchIc: false })).pageSize).toBe(100);
    expect((await listUsers({ q: NAME, page: -3 }, { canSearchIc: false })).page).toBe(1);
    expect((await listUsers({ q: NAME, page: 2.5 }, { canSearchIc: false })).page).toBe(1);
  });

  it('FN-DEEP-105 IC search: dashed / spaced input finds exact IC only with view_sensitive', async () => {
    const ic = newIc();
    const m = await mk({ idType: 'mykad', idNumber: ic });
    const dashed = `${ic.slice(0, 6)}-${ic.slice(6, 8)}-${ic.slice(8)}`;
    expect((await listUsers({ q: ` ${dashed} ` }, { canSearchIc: true })).rows.map((r) => r.id)).toEqual([m.id]);
    expect((await listUsers({ q: dashed }, { canSearchIc: false })).total).toBe(0);
    expect((await listUsers({ q: ic.slice(0, 11) }, { canSearchIc: true })).rows.find((r) => r.id === m.id)).toBeUndefined();
  });

  it('FN-DEEP-106 counts agree: org rank count, platoon member count vs. list totals', async () => {
    const org = await listOrg();
    const rk = org.find((s) => s.id === DS)!.ranks.find((r) => r.id === DR1)!;
    expect(rk.activeMembers).toBe((await listUsers({ rank: DR1 }, { canSearchIc: false })).total);
    const pl = (await listPlatoons()).platoons.find((p) => p.id === DP1)!;
    expect(pl.members).toBe((await listUsers({ platoon: DP1 }, { canSearchIc: false })).total);
  });
});

// ─── Own profile ───────────────────────────────────────

describe('Own profile', () => {
  it('FN-DEEP-110 non-officer: 2 guardians saved then cleared; audit keeps the removed ones', async () => {
    const m = await mk();
    const me = await actor(m.username);
    let p = await getOwnProfile(me);
    const r1 = await updateOwnProfile(me, { email: p.email, guardians: [guardian({ name: 'G One' }), guardian({ name: 'G Two', relationship: 'mother' })], expectedUpdatedAt: p.updatedAt }, meta);
    expect((await db.select().from(guardians).where(eq(guardians.userId, m.id))).map((g) => g.slot).sort()).toEqual([1, 2]);
    await updateOwnProfile(me, { email: p.email, guardians: [], expectedUpdatedAt: r1.updatedAt }, meta);
    expect(await db.select().from(guardians).where(eq(guardians.userId, m.id))).toHaveLength(0);
    const a = await lastAudit(m.id, 'PROFILE_UPDATED');
    expect((a.before as { guardians: { name: string }[] }).guardians.map((g) => g.name).sort()).toEqual(['G One', 'G Two']);
    expect((a.after as { guardians: unknown[] }).guardians).toEqual([]);
    p = await getOwnProfile(me);
    expect(p.guardians).toEqual([]);
  });

  it('FN-DEEP-111 officer: guardians in the request are ignored; audit has no guardians key', async () => {
    const m = await mk({ sectionId: OFF.sectionId, rankId: OFF.id });
    const me = await actor(m.username);
    const p = await getOwnProfile(me);
    await updateOwnProfile(me, { email: p.email, guardians: [guardian()], expectedUpdatedAt: p.updatedAt }, meta);
    expect(await db.select().from(guardians).where(eq(guardians.userId, m.id))).toHaveLength(0);
    const a = await lastAudit(m.id, 'PROFILE_UPDATED');
    expect(a.before).not.toHaveProperty('guardians');
  });

  it('FN-DEEP-112 conflict: stale token refused and nothing saved; returned token chains', async () => {
    const m = await mk();
    const me = await actor(m.username);
    const p = await getOwnProfile(me);
    const r1 = await updateOwnProfile(me, { email: 'one@example.test', expectedUpdatedAt: p.updatedAt }, meta);
    expect((await err(() => updateOwnProfile(me, { email: 'two@example.test', expectedUpdatedAt: p.updatedAt }, meta)))?.code).toBe('CONFLICT');
    expect((await row(m.id)).email).toBe('one@example.test');
    const r2 = await updateOwnProfile(me, { email: 'three@example.test', expectedUpdatedAt: r1.updatedAt }, meta);
    expect(r2.updatedAt > r1.updatedAt).toBe(true);
  });

  it('FN-DEEP-113 admin edit after profile load makes the profile token stale', async () => {
    const m = await mk();
    const me = await actor(m.username);
    const p = await getOwnProfile(me);
    await updateUser(cap, m.id, { ...(m.input as object), fullName: 'QA DEEP renamed', guardians: [] } as never, meta);
    expect((await err(() => updateOwnProfile(me, { email: 'x@example.test', expectedUpdatedAt: p.updatedAt }, meta)))?.code).toBe('CONFLICT');
  });

  it('FN-DEEP-114 locked fields untouched; audit only has contact fields; blanks become null', async () => {
    const m = await mk({ phone: '0123456789', address: 'Somewhere', school: 'SMK' });
    const me = await actor(m.username);
    const p = await getOwnProfile(me);
    const before = await row(m.id);
    await updateOwnProfile(me, { email: p.email, phone: '  ', address: '', school: null, fullName: 'Hacked', username: 'hacked', dateOfBirth: '2000-01-01', sectionId: OFF.sectionId, idNumber: newIc() } as never, meta);
    const after = await row(m.id);
    expect([after.phone, after.address, after.school]).toEqual([null, null, null]);
    expect([after.fullName, after.username, after.dateOfBirth, after.sectionId, after.idNumberHash]).toEqual([before.fullName, before.username, before.dateOfBirth, before.sectionId, before.idNumberHash]);
    const a = await lastAudit(m.id, 'PROFILE_UPDATED');
    expect(Object.keys(a.after as object).sort()).toEqual(['address', 'email', 'guardians', 'phone', 'school']);
  });
});

// keep imports used (isNotNull for future invariant checks)
void isNotNull;
void platoons;
void ranks;
void sections;
