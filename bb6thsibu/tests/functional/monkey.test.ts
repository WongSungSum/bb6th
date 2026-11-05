// Chaos / "monkey" functional test 2026-11-04 (FN-MONKEY-*).
// A "fool clicking randomly": drives the REAL server actions (app/actions/*.ts) with a minted session cookie, exactly like
// the browser would, picking random operations, random actors and random (often garbage) payloads from a seeded PRNG.
// Rule under test: every action answers ok or a clean ActionResult error (VALIDATION / FORBIDDEN / NOT_FOUND / CONFLICT);
// never a thrown exception, never code SERVER; global DB invariants hold after every batch of steps.
// Uses only its own sections / ranks / platoons / roles / users (qa.mk.<run>.*). Nothing is deleted; afterAll deactivates.
// Re-run a failing sequence with MONKEY_SEED=<seed>. MONKEY_ROUNDS / MONKEY_STEPS tune the size.
import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest';
vi.mock('next/headers', async () => (await import('../security/ctx')).headersMock);
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/server/request', async () => (await import('../security/ctx')).requestMock);

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  auditLogs, permissionChangeRequests, platoonActivities, platoonScores, rankHistory, roles, sessions, userPermissionOverrides, users,
} from '@/lib/db/schema';
import { ALL_PERMISSIONS, type PermissionSlug } from '@/lib/server/authz/catalog';
import * as acc from '@/lib/server/access/service';
import * as orgSvc from '@/lib/server/org/service';
import * as pl from '@/lib/server/platoons/service';
import * as us from '@/lib/server/users/service';
import { hashPassword } from '@/lib/server/auth/password';
import * as accessA from '@/app/actions/access';
import * as authA from '@/app/actions/auth';
import * as orgA from '@/app/actions/org';
import * as plA from '@/app/actions/platoons';
import * as usersA from '@/app/actions/users';
import { ctx, resetCtx } from '../security/ctx';
import { closeDb, loadCU, mint, orgIds, reasonId, userRow } from '../security/fixtures';

type CU = Awaited<ReturnType<typeof loadCU>>;
type Actor = { key: string; cu: CU };

// ───────────────────────── PRNG ─────────────────────────
const SEED = Number(process.env.MONKEY_SEED ?? (Date.now() % 2_147_483_647));
const ROUNDS = Number(process.env.MONKEY_ROUNDS ?? 5);
const STEPS = Number(process.env.MONKEY_STEPS ?? 400);
const CHECK_EVERY = 25;
function mulberry32(a: number) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rnd = mulberry32(SEED);
const R = {
  f: () => rnd(),
  int: (n: number) => Math.floor(rnd() * n),
  chance: (p: number) => rnd() < p,
  pick: <T,>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)],
  subset: <T,>(a: readonly T[], max: number): T[] => {
    const n = 1 + Math.floor(rnd() * Math.max(1, Math.min(max, a.length)));
    return [...a].sort(() => rnd() - 0.5).slice(0, n);
  },
};

// ───────────────────────── state ─────────────────────────
const RUN = randomUUID().slice(0, 6);
const PW = 'QaMonkey-Pass-2026-k3';
const GUARD = [{ name: 'QA Guardian', relationship: 'father', phone: '+60111222333', email: '' }];
let captain: CU, sa: CU, org: Awaited<ReturnType<typeof orgIds>>;
let OFFICER_SEC = 0, CAPTAIN_RANK = 0, HELPER = 0;
let SA = 0, SB = 0;
const A: Record<string, Actor> = {};
const pwOf: Record<string, string> = {};
const pool: string[] = []; // users the monkey may act on
const actorIds: string[] = [];
const mySecs: number[] = [];
const myRanks: { id: number; sectionId: number }[] = [];
const myPls: { id: number; sectionId: number }[] = [];
const myRoles: number[] = [];
const myActs: string[] = [];
const voidedSnap = new Map<string, string>();
const problems: { phase: string; label: string; who: string; out: string; args: string }[] = [];
const invariantBreaks: string[] = [];
const summary: string[] = []; // printed in afterAll (vitest hides stdout of passing tests)
const tally: Record<string, Record<string, number>> = {};
const replays: { who: Actor | null; label: string; fn: (...a: any[]) => Promise<any>; args: any[] }[] = [];
let phase = 'setup';
let ipSeq = 0;
let mutations = 0;
let seq = 0;
const uname = (t = 'u') => `qa.mk.${RUN}.${t}${++seq}`;
const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const smallOr = (v: unknown) => { const n = Number(v); return Number.isInteger(n) && n > 0 && n <= 32767 ? n : -1; };
const CLEAN = ['OK', 'VALIDATION', 'FORBIDDEN', 'NOT_FOUND', 'CONFLICT'];

const short = (v: unknown) => {
  try { return JSON.stringify(v, (_k, x) => (x === undefined ? '<undef>' : typeof x === 'string' && x.length > 40 ? x.slice(0, 40) + '…' : x)).slice(0, 300); } catch { return String(v); }
};

/** Call a server action as `who` the way the browser does (fresh session cookie, unique IP for audit tracing). */
async function call(who: Actor | null, label: string, fn: (...a: any[]) => Promise<any>, args: any[], o: { mut?: boolean; replay?: boolean; allowRedirect?: string } = {}) {
  ctx.token = who ? await mint(who.cu.id) : undefined;
  const ip = (ctx.ip = `mk-${RUN}-${++ipSeq}`);
  let out: string;
  let r: any;
  try {
    r = await fn(...args);
    out = r && typeof r === 'object' && 'ok' in r ? (r.ok ? 'OK' : String(r.code)) : 'OK';
  } catch (e: any) {
    const d = String(e?.digest ?? '');
    out = d.startsWith('NEXT_REDIRECT') ? 'REDIRECT:' + d.split(';')[2] : 'THROW:' + String(e?.message).slice(0, 100);
  }
  (tally[label] ??= {})[out] = ((tally[label] ??= {})[out] ?? 0) + 1;
  const fine = CLEAN.includes(out) || (!who && out === 'REDIRECT:/login') || (o.allowRedirect && out === o.allowRedirect);
  if (!fine) problems.push({ phase, label, who: who?.key ?? 'none', out, args: short(args) });
  if (out === 'OK' && o.mut !== false) {
    mutations++;
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLogs).where(eq(auditLogs.ip, ip));
    if (n < 1) invariantBreaks.push(`[${phase}] ${label} by ${who?.key} succeeded without an audit row`);
  }
  if (out === 'OK' && !o.replay) replays.push({ who, label, fn, args });
  return { out, r, ip };
}
const entityByIp = async (ip: string, action: string) =>
  (await db.select({ id: auditLogs.entityId }).from(auditLogs).where(and(eq(auditLogs.ip, ip), eq(auditLogs.action, action)))).map((x) => x.id);

async function setOv(userId: string, slug: PermissionSlug) {
  await db.insert(userPermissionOverrides).values({ userId, permissionSlug: slug, effect: 'allow', reason: 'qa.mk' })
    .onConflictDoUpdate({ target: [userPermissionOverrides.userId, userPermissionOverrides.permissionSlug], set: { effect: 'allow' } });
}
async function mkUser(tag: string, sectionId: number, rankId: number, platoonId?: number, perms: readonly PermissionSlug[] = [], officer = false) {
  const username = uname(tag);
  const r = await us.createUser(captain, {
    username, email: 'qa.mk@example.test', fullName: `QA Monkey ${tag}`, gender: 'male', dateOfBirth: '2010-05-05', joinDate: '2022-01-01',
    idType: 'none', sectionId, rankId, platoonId, guardians: officer ? [] : GUARD,
  } as any, { ip: `mk-${RUN}-setup`, userAgent: 'vitest' });
  const hash = await hashPassword(PW);
  await db.update(users).set({ mustChangePassword: false, passwordHash: hash }).where(eq(users.id, r!.id));
  for (const p of perms) await setOv(r!.id, p);
  pwOf[r!.id] = PW;
  await mint(r!.id); // a live session that deactivation must revoke
  return loadCU(username);
}
const M = () => ({ ip: `mk-${RUN}-svc`, userAgent: 'vitest' });

// ───────────────────────── invariants ─────────────────────────
async function rows(q: ReturnType<typeof sql>) {
  return ((await db.execute(q)) as any).rows as any[];
}
async function checkInvariants(where: string) {
  const br = (m: string, r: any[]) => { if (r.length) invariantBreaks.push(`[${where}] ${m}: ${short(r.slice(0, 3))}`); };
  const secs = sql.join(mySecs.map((s) => sql`${s}`), sql`,`);
  const pls = myPls.length ? sql.join(myPls.map((p) => sql`${p.id}`), sql`,`) : sql`-1`;
  const ids = [...pool, ...actorIds];
  const uids = ids.length ? sql.join(ids.map((i) => sql`${i}::uuid`), sql`,`) : sql`null::uuid`;
  br('more than one Captain / Captain inactive', await rows(sql`
    select count(*)::int n, bool_and(u.status = 'active') active from users u join ranks r on r.id = u.rank_id where r.system_key = 'captain'
    having count(*) <> 1 or not bool_and(u.status = 'active')`));
  br('rank not in user section', await rows(sql`select u.id from users u join ranks r on r.id = u.rank_id where r.section_id <> u.section_id`));
  br('platoon not in user section', await rows(sql`select u.id from users u join platoons p on p.id = u.platoon_id where p.section_id <> u.section_id`));
  br('duplicate leader/assistant', await rows(sql`select platoon_id, platoon_role, count(*) from users where platoon_role is not null group by 1,2 having count(*) > 1`));
  br('leader/assistant inactive or without platoon', await rows(sql`select id from users where platoon_role is not null and (status <> 'active' or platoon_id is null)`));
  br('active member on inactive rank/section (qa.mk)', await rows(sql`
    select u.id from users u join ranks r on r.id = u.rank_id join sections s on s.id = u.section_id
    where u.status = 'active' and (not r.is_active or not s.is_active) and u.section_id in (${secs})`));
  br('active member in inactive platoon (qa.mk)', await rows(sql`
    select u.id from users u join platoons p on p.id = u.platoon_id where u.status = 'active' and not p.is_active and p.id in (${pls})`));
  br('live session for inactive user', await rows(sql`
    select s.id from sessions s join users u on u.id = s.user_id
    where u.status = 'inactive' and s.revoked_at is null and s.expires_at > now() and u.id in (${uids})`));
  br('qa.mk user is not a plain member', await rows(sql`select id from users where id in (${uids}) and account_type <> 'member'`));
  br('active platoon in inactive section', await rows(sql`select p.id from platoons p join sections s on s.id = p.section_id where p.is_active and not s.is_active and p.id in (${pls})`));
  br('active rank in inactive section (qa.mk)', await rows(sql`select r.id from ranks r join sections s on s.id = r.section_id where r.is_active and not s.is_active and s.id in (${secs})`));
  for (const [id, snap] of voidedSnap) {
    const now = await activitySnap(id);
    if (now !== snap) invariantBreaks.push(`[${where}] voided activity ${id} changed: ${snap} -> ${now}`);
  }
}
async function activitySnap(id: string) {
  const [a] = await db.select().from(platoonActivities).where(eq(platoonActivities.id, id));
  const sc = await db.select().from(platoonScores).where(eq(platoonScores.activityId, id));
  return JSON.stringify({ n: a.name, d: a.activityDate, no: a.note, v: a.voidedAt?.toISOString(), r: a.voidReason, u: a.updatedAt.toISOString(), s: sc.map((x) => [x.platoonId, x.points]).sort() });
}

// ───────────────────────── random input builders ─────────────────────────
const GARBAGE_ID = [0, -1, 32767, 99999, 1.5, 'abc', '', null, undefined, NaN, '1e3', [1], {}];
const GARBAGE_UUID = ['', 'abc', null, undefined, randomUUID(), '00000000-0000-0000-0000-000000000000', "' or 1=1 --", 123, {}];
const NAMES = () => R.chance(0.5) ? [`qa.mk.${RUN}.n${++seq}`] : ['', '   ', 'x'.repeat(41), 'x'.repeat(81), '名字 émoji 🎉', 'a\0b', '<img src=x onerror=alert(1)>', `qa.mk.${RUN}.n${++seq}`, `QA.MK.${RUN}.N${seq}`];
const actorList = () => [A.captain, A.captain, A.captain, A.captain, A.officer, A.officer, A.officer, A.officer, A.madmin, A.madmin, A.plain, A.leader, A.delegate, R.chance(0.4) ? null : A.captain];
const pickActor = () => R.pick(actorList());
const ranksOf = (s: number) => myRanks.filter((r) => r.sectionId === s).map((r) => r.id);
const plsOf = (s: number) => myPls.filter((p) => p.sectionId === s).map((p) => p.id);
const anyId = () => (R.chance(0.08) ? R.pick(GARBAGE_UUID) : R.chance(0.05) ? captain.id : R.pick(pool.length ? pool : [randomUUID()]));
const anySec = () => (R.chance(0.1) ? R.pick(GARBAGE_ID) : R.chance(0.08) ? OFFICER_SEC : R.pick(mySecs));
const anyRank = (sec?: number) => {
  const own = sec !== undefined ? ranksOf(Number(sec)) : [];
  if (own.length && R.chance(0.7)) return R.pick(own);
  return R.pick([...myRanks.map((r) => r.id), CAPTAIN_RANK, HELPER, ...GARBAGE_ID.slice(0, 6)]);
};
const anyPl = (sec?: number) => {
  const own = sec !== undefined ? plsOf(Number(sec)) : [];
  if (own.length && R.chance(0.7)) return R.pick(own);
  return R.pick([...myPls.map((p) => p.id), ...GARBAGE_ID.slice(0, 4)]);
};

function garbageProfile(o: any) {
  const muts: (() => void)[] = [
    () => (o.username = R.pick(['', 'a', 'x'.repeat(40), '<script>', '123456789012', ` QA.MK.${RUN}.Up${++seq} `, 'dev.captain', null])),
    () => (o.email = R.pick(['', 'nope', 'a@' + 'x'.repeat(300) + '.com', null, 5])),
    () => (o.fullName = R.pick(['', ' ', 'x'.repeat(101), '名字 émoji 🎉', 'a\0b', null])),
    () => (o.gender = R.pick(['other', undefined, ''])),
    () => (o.dateOfBirth = R.pick(['2099-01-01', '2012-02-30', 'yesterday', '', '1899-01-01'])),
    () => (o.joinDate = '2001-01-01'),
    () => { o.idType = 'mykad'; o.idNumber = R.pick(['123', '1234567890123', '9' + String(R.int(1e11)).padStart(11, '0'), '']); },
    () => { o.idType = R.pick(['passport', 'bogus']); o.idNumber = R.pick(['A1', 'ABCD1234', '!!!!']); },
    () => (o.guardians = R.pick([[...GUARD, ...GUARD, ...GUARD], [{}], 'str', null, [{ ...GUARD[0], phone: 'abc' }]])),
    () => (o.phone = R.pick(['abc', '1', '+'.repeat(20), '0123456789'])),
    () => (o.address = R.pick(['x'.repeat(301), 'a\0b', null])),
    () => (o.platoonId = R.pick([-1, 'abc', 99999, ...myPls.map((p) => p.id)])),
    () => Object.assign(o, { accountType: 'superadmin', isCaptain: true, status: 'inactive', rankId: o.rankId, id: captain.id }),
    () => (o.expectedUpdatedAt = R.pick(['', 'garbage', new Date(0).toISOString()])),
  ];
  for (let i = 0, n = 1 + R.int(3); i < n; i++) R.pick(muts)();
  return o;
}

function genCreate() {
  const sec = anySec();
  const officer = sec === OFFICER_SEC;
  const o: any = {
    username: uname('c'), email: 'qa.mk@example.test', fullName: `QA Monkey ${seq}`, gender: R.pick(['male', 'female']),
    dateOfBirth: '2011-0' + (1 + R.int(9)) + '-1' + R.int(9), joinDate: '2022-01-01', phone: R.chance(0.5) ? '+60123456789' : '', idType: 'none',
    sectionId: sec, rankId: anyRank(sec as number), platoonId: R.chance(0.8) ? anyPl(sec as number) : undefined,
    guardians: officer ? [] : R.chance(0.7) ? GUARD : [], tempPassword: R.chance(0.3) ? PW : R.chance(0.1) ? 'short' : undefined,
  };
  return R.chance(0.25) ? garbageProfile(o) : o;
}
async function genUpdate(id: string) {
  const u = await userRow(id).catch(() => undefined);
  const o: any = u
    ? {
        username: u.username, email: u.email, fullName: u.fullName, gender: u.gender, dateOfBirth: u.dateOfBirth, joinDate: u.joinDate,
        phone: u.phone ?? '', address: u.address, school: u.school, guardians: R.chance(0.7) ? GUARD : [],
        platoonId: R.chance(0.2) ? anyPl(u.sectionId ?? undefined) : u.platoonId ?? undefined,
        expectedUpdatedAt: R.chance(0.6) ? u.updatedAt.toISOString() : R.chance(0.5) ? new Date(0).toISOString() : undefined,
      }
    : { username: 'qa.mk.nobody', email: 'x@example.test', fullName: 'X', gender: 'male', dateOfBirth: '2012-01-01', joinDate: '2022-01-01', guardians: [] };
  if (R.chance(0.3)) o.fullName = `QA Monkey edited ${++seq}`;
  return R.chance(0.3) ? garbageProfile(o) : o;
}
function genScores() {
  if (R.chance(0.6) && myPls.length) return R.subset(myPls.map((p) => p.id), 3).map((id) => ({ platoonId: id, points: String(R.int(41) - 20) }));
  const list = [];
  for (let i = 0, n = R.int(4); i < n; i++) {
    list.push({ platoonId: R.chance(0.85) ? R.pick(myPls.length ? myPls.map((p) => p.id) : [1]) : R.pick(GARBAGE_ID), points: R.pick(['5', '-3', '0', '', ' ', '1000', '1001', '-2000', 'abc', '2.5', '1e3', null, 7, ' 12 ']) });
  }
  return R.chance(0.1) ? R.pick([null, 'x', {}]) : list;
}
const genDate = () => R.chance(0.6) ? `2001-0${1 + R.int(9)}-1${R.int(9)}` : R.pick(['2001-0' + (1 + R.int(9)) + '-1' + R.int(9), '2001-03-03', '2099-01-01', '2001-02-30', '', 'today', '1999-12-31', today()]);
const genReason = () => R.chance(0.6) ? 'qa monkey' : R.pick(['qa monkey', '', '  ', 'x'.repeat(501), 'a\0b', null, undefined, 'ok']);
const anyAct = () => (R.chance(0.15) ? R.pick(GARBAGE_UUID) : R.pick(myActs.length ? myActs : [randomUUID()]));
const genPerms = () => (R.chance(0.05) ? R.pick([null, 'users.view', ['nope.perm'], [{}]]) : R.subset(ALL_PERMISSIONS, 4).filter(() => R.chance(0.8)));

// ───────────────────────── operations ─────────────────────────
type Op = [string, number, () => Promise<void>];
const OPS: Op[] = [
  ['createUser', 8, async () => {
    const res = await call(pickActor(), 'createUser', usersA.createUserAction, [genCreate()]);
    if (res.out === 'OK') { pool.push(res.r.data.id); await mint(res.r.data.id); }
  }],
  ['updateUser', 8, async () => { const id = anyId(); await call(pickActor(), 'updateUser', usersA.updateUserAction, [id, await genUpdate(String(id))]); }],
  ['deactivate', 5, async () => {
    await call(pickActor(), 'deactivate', usersA.setStatusAction, [anyId(), { status: 'inactive', reasonId: R.pick([await reasonId(), await reasonId('Other'), 0, 999, 'x', undefined]), note: R.pick(['', 'gone', undefined, 'x'.repeat(600)]) }]);
  }],
  ['reactivate', 5, async () => { await call(pickActor(), 'reactivate', usersA.setStatusAction, [anyId(), { status: 'active', reason: genReason() }]); }],
  ['resetPassword', 3, async () => {
    await call(pickActor(), 'resetPassword', usersA.resetPasswordAction, [anyId(), { reason: genReason(), password: R.pick([undefined, '', 'short', PW + 'x', 'x'.repeat(200), '   '] as any[]) }]);
  }],
  ['promote', 7, async () => {
    const sec = anySec();
    const ids = [...R.subset(pool.length ? pool : [randomUUID()], 6), ...(R.chance(0.2) ? [R.pick(GARBAGE_UUID)] : []), ...(R.chance(0.05) ? [captain.id] : [])];
    await call(pickActor(), 'promote', usersA.promoteAction, [{ userIds: R.chance(0.05) ? R.pick([null, 'x', []]) : ids, sectionId: sec, rankId: anyRank(sec as number), reason: genReason() }]);
  }],
  ['assignMembers', 6, async () => {
    const p = anyPl(R.pick(mySecs));
    await call(pickActor(), 'assignMembers', plA.assignMembersAction, [p, R.chance(0.05) ? R.pick([null, 'x', []]) : R.subset(pool.length ? pool : [randomUUID()], 5)]);
  }],
  ['removeMembers', 4, async () => {
    const p = anyPl(R.pick(mySecs));
    const inP = (await db.select({ id: users.id }).from(users).where(eq(users.platoonId, smallOr(p)))).map((x) => x.id).filter((i) => pool.includes(i));
    await call(pickActor(), 'removeMembers', plA.removeMembersAction, [p, R.subset(inP.length && R.chance(0.8) ? inP : pool, 3)]);
  }],
  ['setLeaders', 5, async () => {
    const p = anyPl(R.pick(mySecs));
    const inP = (await db.select({ id: users.id }).from(users).where(eq(users.platoonId, smallOr(p)))).map((x) => x.id);
    const cand = [...inP, ...inP, null, '', ...(pool.length ? [R.pick(pool)] : []), R.pick(GARBAGE_UUID)];
    await call(pickActor(), 'setLeaders', plA.setLeadersAction, [p, R.pick(cand), R.pick(cand)]);
  }],
  ['createActivity', 4, async () => {
    const res = await call(pickActor(), 'createActivity', plA.saveActivityAction, [null, { name: R.chance(0.8) ? `qa.mk act ${++seq}` : R.pick(NAMES()), activityDate: genDate(), note: R.pick(['', 'n', 'x'.repeat(600)]), scores: genScores() }]);
    if (res.out === 'OK') myActs.push(...(await entityByIp(res.ip, 'PLATOON_ACTIVITY_CREATED')));
  }],
  ['editActivity', 4, async () => {
    const id = anyAct();
    const [a] = typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id) ? await db.select().from(platoonActivities).where(eq(platoonActivities.id, id)) : [];
    await call(pickActor(), 'editActivity', plA.saveActivityAction, [id, {
      name: R.chance(0.8) ? `qa.mk act e${++seq}` : R.pick(NAMES()), activityDate: genDate(), note: '', scores: genScores(),
      expectedUpdatedAt: a && R.chance(0.6) ? a.updatedAt.toISOString() : R.pick([undefined, new Date(0).toISOString(), 'x']),
    }]);
  }],
  ['voidActivity', 3, async () => {
    const id = anyAct();
    const res = await call(pickActor(), 'voidActivity', plA.voidActivityAction, [id, genReason()]);
    if (res.out === 'OK') voidedSnap.set(String(id), await activitySnap(String(id)));
  }],
  ['ageUp', 3, async () => {
    const sec = anySec();
    await call(pickActor(), 'ageUp', orgA.setAgeUpAction, [sec, R.chance(0.05) ? R.pick([null, {}]) : { age: R.pick([null, '', 3, 4, 12, 25, 26, 'abc', 1.5, undefined, '13']), rankId: anyRank(R.pick(mySecs)) }]);
  }],
  ['createSection', 1, async () => {
    const res = await call(pickActor(), 'createSection', orgA.createSectionAction, [R.pick(NAMES())]);
    if (res.out === 'OK') mySecs.push(...(await entityByIp(res.ip, 'SECTION_CREATED')).map(Number));
  }],
  ['updateSection', 3, async () => {
    const id = R.chance(0.1) ? OFFICER_SEC : R.chance(0.1) ? R.pick(GARBAGE_ID) : R.pick(mySecs);
    await call(pickActor(), 'updateSection', orgA.updateOrgItemAction, ['section', id, R.chance(0.5) ? { isActive: R.pick([true, false, 'no', null]) } : { name: R.pick(NAMES()) }]);
  }],
  ['createRank', 2, async () => {
    const sec = R.chance(0.15) ? R.pick([OFFICER_SEC, ...GARBAGE_ID]) : R.pick(mySecs);
    const res = await call(pickActor(), 'createRank', orgA.createRankAction, [sec, R.pick(NAMES())]);
    if (res.out === 'OK') {
      const [id] = (await entityByIp(res.ip, 'RANK_CREATED')).map(Number);
      myRanks.push({ id, sectionId: Number(sec) });
    }
  }],
  ['updateRank', 3, async () => {
    const id = R.chance(0.1) ? R.pick([CAPTAIN_RANK, ...GARBAGE_ID]) : R.pick(myRanks).id;
    await call(pickActor(), 'updateRank', orgA.updateOrgItemAction, ['rank', id, R.chance(0.6) ? { isActive: R.pick([true, false]) } : { name: R.pick(NAMES()) }]);
  }],
  ['moveRank', 1, async () => { await call(pickActor(), 'moveRank', orgA.moveOrgItemAction, ['rank', R.chance(0.1) ? R.pick(GARBAGE_ID) : R.pick(myRanks).id, R.pick(['up', 'down', 'sideways'])]); }],
  ['createPlatoon', 2, async () => {
    const sec = R.chance(0.15) ? R.pick([OFFICER_SEC, ...GARBAGE_ID]) : R.pick(mySecs);
    const res = await call(pickActor(), 'createPlatoon', plA.createPlatoonAction, [sec, R.pick(NAMES())]);
    if (res.out === 'OK') myPls.push({ id: Number((await entityByIp(res.ip, 'PLATOON_CREATED'))[0]), sectionId: Number(sec) });
  }],
  ['updatePlatoon', 4, async () => {
    const id = R.chance(0.1) ? R.pick(GARBAGE_ID) : R.pick(myPls).id;
    await call(pickActor(), 'updatePlatoon', plA.updatePlatoonAction, [id, R.chance(0.6) ? { isActive: R.pick([true, false, 'yes']) } : { name: R.pick(NAMES()) }]);
  }],
  ['saveRole', 3, async () => {
    const existing = myRoles.length && R.chance(0.6) ? R.pick(myRoles) : null;
    const g = existing ? await acc.getRole(existing) : null;
    const res = await call(pickActor(), 'saveRole', accessA.saveRoleAction, [existing ?? (R.chance(0.1) ? R.pick(GARBAGE_ID) : null), {
      name: g && R.chance(0.6) ? g.name : R.chance(0.8) ? `qa.mk.${RUN}.role${++seq}` : R.pick(NAMES()), description: R.pick(['', 'd', 'x'.repeat(300)]),
      isActive: R.pick([true, true, false, 'x', undefined]), permissions: genPerms(), reason: genReason(),
    }]);
    if (res.out === 'OK' && res.r.data.status === 'applied') { const id = Number(res.r.data.targetId); if (!myRoles.includes(id)) myRoles.push(id); }
  }],
  ['saveRankAccess', 2, async () => {
    const id = R.chance(0.1) ? R.pick([CAPTAIN_RANK, ...GARBAGE_ID]) : R.pick(myRanks).id;
    await call(pickActor(), 'saveRankAccess', accessA.saveRankAccessAction, [id, { permissions: genPerms(), reason: genReason() }]);
  }],
  ['saveUserAccess', 4, async () => {
    await call(pickActor(), 'saveUserAccess', accessA.saveUserAccessAction, [anyId(), {
      roleIds: R.chance(0.1) ? R.pick([null, ['x'], [99999]]) : R.subset(myRoles.length ? myRoles : [1], 2).filter(() => R.chance(0.7)),
      overrides: R.chance(0.1) ? R.pick([null, [{}], [{ slug: 'nope', effect: 'allow' }]]) : R.subset(ALL_PERMISSIONS, 3).filter(() => R.chance(0.5)).map((s) => ({ slug: s, effect: R.pick(['allow', 'deny', 'inherit', 'maybe']), reason: R.pick(['', 'r']) })),
      reason: genReason(),
    }]);
  }],
  ['decideRequest', 4, async () => {
    const open = (await db.select({ id: permissionChangeRequests.id }).from(permissionChangeRequests)
      .where(and(eq(permissionChangeRequests.status, 'pending'), inArray(permissionChangeRequests.requestedBy, actorIds)))).map((x) => x.id);
    const id = open.length && R.chance(0.85) ? R.pick(open) : R.pick(GARBAGE_UUID);
    const who = R.chance(0.6) ? A.captain : pickActor();
    await call(who, 'decideRequest', accessA.decideRequestAction, [id, R.pick(['approve', 'approve', 'reject', 'maybe']), R.pick(['', 'qa no', undefined])]);
  }],
  ['cancelRequest', 1, async () => {
    const open = (await db.select({ id: permissionChangeRequests.id }).from(permissionChangeRequests)
      .where(and(eq(permissionChangeRequests.status, 'pending'), inArray(permissionChangeRequests.requestedBy, actorIds)))).map((x) => x.id);
    await call(R.pick([A.delegate, A.officer, A.captain]), 'cancelRequest', accessA.cancelRequestAction, [open.length ? R.pick(open) : R.pick(GARBAGE_UUID)]);
  }],
  ['updateProfile', 4, async () => {
    const who = R.pick([A.officer, A.madmin, A.plain, A.leader, A.delegate, A.captain]);
    const u = await userRow(who.cu.id);
    const o: any = { email: R.chance(0.9) ? 'qa.mk@example.test' : R.pick(['', 'bad']), phone: R.pick(['', '+60123456789', 'abc']), address: R.pick([null, 'Sibu', 'x'.repeat(301)]), school: null,
      guardians: R.pick([GUARD, [], [{}], [...GUARD, ...GUARD, ...GUARD]]), expectedUpdatedAt: R.chance(0.6) ? u.updatedAt.toISOString() : R.pick([undefined, new Date(0).toISOString()]) };
    if (who === A.captain) { o.email = u.email; o.phone = u.phone ?? ''; o.address = u.address; o.guardians = []; } // never change the real Captain's contact details
    await call(who, 'updateProfile', usersA.updateProfileAction, [o]);
  }],
  ['changePassword', 1, async () => {
    const who = R.pick([A.officer, A.madmin, A.plain, A.leader]);
    const cur = R.chance(0.5) ? pwOf[who.cu.id] : R.pick(['', 'wrong-pass-123', 'x'.repeat(200)]);
    const next = R.pick([`QaMonkey-New-${++seq}-z9`, 'short', '', who.cu.username, 'x'.repeat(200)]);
    const res = await call(who, 'changePassword', authA.changePasswordAction, [{ current: cur, next, confirm: R.chance(0.85) ? next : next + 'x' }]);
    if (res.out === 'OK') pwOf[who.cu.id] = next;
  }],
  ['appointCaptain', 1, async () => { await call(R.pick([A.captain, A.officer, null, { key: 'superadmin', cu: sa }]), 'appointCaptain', usersA.appointCaptainAction, [R.pick([...GARBAGE_UUID, ...pool.slice(0, 3), A.officer.cu.id])]); }],
];
const TOTAL_W = OPS.reduce((n, o) => n + o[1], 0);
function pickOp(): Op {
  let x = R.f() * TOTAL_W;
  for (const o of OPS) if ((x -= o[1]) < 0) return o;
  return OPS[0];
}

// ───────────────────────── setup / cleanup ─────────────────────────
beforeAll(async () => {
  resetCtx();
  console.log(`[FN-MONKEY] seed=${SEED} rounds=${ROUNDS} steps=${STEPS} run=${RUN}`);
  captain = await loadCU('dev.captain');
  sa = await loadCU('superadmin');
  org = await orgIds();
  OFFICER_SEC = org.officer;
  CAPTAIN_RANK = org.captainRankId;
  HELPER = org.rk('Officer', 'Helper');
  SA = (await orgSvc.createSection(captain, { name: `qa.mk.${RUN}.sa` }, M()))!.id;
  SB = (await orgSvc.createSection(captain, { name: `qa.mk.${RUN}.sb` }, M()))!.id;
  mySecs.push(SA, SB);
  for (const [s, n] of [[SA, 'r0'], [SA, 'r1'], [SA, 'r2'], [SB, 'r0'], [SB, 'r1'], [SB, 'r2']] as const) {
    myRanks.push({ id: (await orgSvc.createRank(captain, { sectionId: s, name: `qa.mk.${n}` }, M()))!.id, sectionId: s });
  }
  for (const n of ['p1', 'p2']) myPls.push({ id: (await pl.createPlatoon(captain, { sectionId: SA, name: `qa.mk.${RUN}.${n}` }, M()))!.id, sectionId: SA });
  const [PA1] = myPls;
  const RA0 = myRanks[0].id, RB0 = myRanks[3].id;
  const USERS: PermissionSlug[] = ['users.view', 'users.create', 'users.update', 'users.update_status', 'users.view_sensitive'];
  A.captain = { key: 'captain', cu: captain };
  A.officer = { key: 'officer', cu: await mkUser('off', OFFICER_SEC, HELPER, undefined, ALL_PERMISSIONS.filter((p) => p !== 'permissions.manage'), true) };
  A.delegate = { key: 'delegate', cu: await mkUser('del', OFFICER_SEC, HELPER, undefined, ALL_PERMISSIONS, true) };
  A.madmin = { key: 'madmin', cu: await mkUser('madm', SB, RB0, undefined, USERS) };
  A.plain = { key: 'plain', cu: await mkUser('plain', SA, RA0, PA1.id) };
  A.leader = { key: 'leader', cu: await mkUser('lead', SA, RA0, PA1.id, ['users.view', 'users.update']) };
  await pl.setPlatoonLeaders(captain, PA1.id, { leaderId: A.leader.cu.id, assistantId: null }, M());
  actorIds.push(...[A.officer, A.delegate, A.madmin, A.plain, A.leader].map((a) => a.cu.id));
  for (let i = 0; i < 6; i++) pool.push((await mkUser('s', SA, myRanks[i % 3].id, myPls[i % 2].id)).id);
  for (let i = 0; i < 4; i++) pool.push((await mkUser('t', SB, myRanks[3 + (i % 3)].id)).id);
  myActs.push((await pl.createActivity(captain, { name: 'qa.mk seed act', activityDate: '2001-01-01', scores: [{ platoonId: PA1.id, points: 5 }] }, M())).id);
  await checkInvariants('setup');
  expect(invariantBreaks, 'invariants already broken before the monkey ran').toEqual([]);
}, 120000);

afterAll(async () => {
  phase = 'cleanup';
  const meta = M();
  const errs: string[] = [];
  const t = async (what: string, p: Promise<unknown>) => { try { await p; } catch (e: any) { errs.push(`${what}: ${e?.code ?? ''} ${String(e?.message).slice(0, 80)}`); } };
  try {
    // everything any monkey run created (also replays, and earlier runs' leftovers), found through the audit trail
    const made = await rows(sql`select distinct action, entity_id from audit_logs where ip like 'mk-%'
      and action in ('SECTION_CREATED', 'RANK_CREATED', 'PLATOON_CREATED', 'USER_CREATED', 'PLATOON_ACTIVITY_CREATED')`);
    const of = (a: string) => made.filter((m) => m.action === a).map((m) => m.entity_id as string);
    const secIds = [...new Set([...mySecs, ...of('SECTION_CREATED').map(Number)])];
    const userIds = [...new Set([...pool, ...actorIds, ...of('USER_CREATED')])];
    const open = await db.select({ id: permissionChangeRequests.id }).from(permissionChangeRequests)
      .where(and(eq(permissionChangeRequests.status, 'pending'), inArray(permissionChangeRequests.requestedBy, userIds)));
    for (const r of open) await t('reject', acc.decideRequest(captain, r.id, 'reject', 'qa monkey cleanup', meta));
    const acts = await rows(sql`select id from platoon_activities where voided_at is null and id::text in (${sql.join([...new Set([...myActs, ...of('PLATOON_ACTIVITY_CREATED')])].map((x) => sql`${x}`), sql`,`)})`);
    for (const a of acts) await t('void', pl.voidActivity(captain, a.id, { reason: 'qa monkey cleanup' }, meta));
    const ageUps = await rows(sql`select id from sections where age_up_age is not null and (id in (${sql.join(secIds.map((x) => sql`${x}`), sql`,`)})
      or age_up_rank_id in (select id from ranks where section_id in (${sql.join(secIds.map((x) => sql`${x}`), sql`,`)})))`);
    for (const s of ageUps) await t('ageUp', orgSvc.setAgeUp(captain, s.id, { age: null, rankId: null }, meta));
    const rid = await reasonId();
    const activeUsers = await rows(sql`select id from users where status = 'active' and (id::text in (${sql.join(userIds.map((x) => sql`${x}`), sql`,`)})
      or section_id in (${sql.join(secIds.map((x) => sql`${x}`), sql`,`)}))`);
    for (const u of activeUsers) await t('deactivate ' + u.id, us.setStatus(captain, u.id, { status: 'inactive', reasonId: rid }, meta));
    const rks = await rows(sql`select id, is_active from ranks where section_id in (${sql.join(secIds.map((x) => sql`${x}`), sql`,`)})`);
    for (const r of rks) await acc.saveRankAccess(captain, r.id, { permissions: [] }, meta).catch(() => {});
    for (const p of await rows(sql`select id from platoons where is_active and section_id in (${sql.join(secIds.map((x) => sql`${x}`), sql`,`)})`)) await t('platoon ' + p.id, pl.updatePlatoon(captain, p.id, { isActive: false }, meta));
    for (const r of rks.filter((x) => x.is_active)) await t('rank ' + r.id, orgSvc.updateRank(captain, r.id, { isActive: false }, meta));
    for (const s of await rows(sql`select id from sections where is_active and id in (${sql.join(secIds.map((x) => sql`${x}`), sql`,`)})`)) await t('section ' + s.id, orgSvc.updateSection(captain, s.id, { isActive: false }, meta));
    const extra = (await db.select({ id: roles.id }).from(roles).where(and(sql`${roles.name} like 'qa.mk.%'`, eq(roles.isActive, true)))).map((r) => r.id);
    for (const r of [...new Set([...myRoles, ...extra])]) {
      const g = await acc.getRole(r);
      if (g?.isActive) await t('role ' + r, acc.saveRole(captain, r, { name: g.name, description: null, isActive: false, permissions: g.permissions }, meta));
    }
    await db.update(sessions).set({ revokedAt: new Date() }).where(and(inArray(sessions.userId, [...userIds, captain.id, sa.id]), sql`${sessions.revokedAt} is null`, eq(sessions.ip, 'qa-mint')));
  } catch (e) {
    errs.push('cleanup aborted: ' + String((e as Error)?.message).slice(0, 200));
  }
  if (errs.length) console.log('[FN-MONKEY] cleanup problems: ' + errs.join(' | '));
  console.log('[FN-MONKEY] tally', JSON.stringify(tally));
  console.log(summary.join(' || '));
  await closeDb();
}, 300000);

const report = (title: string) => {
  const uniq = new Map<string, number>();
  for (const p of problems.filter((x) => x.phase === title)) uniq.set(`${p.label} as ${p.who} -> ${p.out} | e.g. ${p.args}`, (uniq.get(`${p.label} as ${p.who} -> ${p.out} | e.g. ${p.args}`) ?? 0) + 1);
  const lines = [...uniq.entries()].map(([k, n]) => `${n}x ${k}`);
  if (lines.length) console.log(`[FN-MONKEY] ${title} problems:\n  ` + lines.join('\n  '));
  return lines;
};

// ───────────────────────── 1. random monkey ─────────────────────────
describe('FN-MONKEY-001 seeded random monkey', () => {
  it(`runs ${ROUNDS} rounds x ${STEPS} steps; every answer clean; invariants hold`, async () => {
    phase = 'monkey';
    const t0 = Date.now();
    for (let round = 0; round < ROUNDS; round++) {
      rnd = mulberry32(SEED + round);
      for (let step = 1; step <= STEPS; step++) {
        const [name, , fn] = pickOp();
        try {
          await fn();
        } catch (e: any) {
          problems.push({ phase, label: name, who: '?', out: 'HARNESS:' + String(e?.message).slice(0, 120), args: '' });
        }
        if (step % CHECK_EVERY === 0) await checkInvariants(`round ${round} step ${step} seed ${SEED + round}`);
      }
    }
    summary.push(`[FN-MONKEY-001] seed=${SEED} ${ROUNDS * STEPS} steps, ${mutations} successful mutations, pool=${pool.length}, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    const lines = report('monkey');
    if (invariantBreaks.length) console.log('[FN-MONKEY] invariant breaks:\n  ' + [...new Set(invariantBreaks)].slice(0, 30).join('\n  '));
    expect(invariantBreaks).toEqual([]);
    expect(lines).toEqual([]);
  }, 600000);
});


/** Fresh, untouched org items for the deterministic sections (the monkey may have deactivated / re-permissioned its own). */
let F: { S1: number; r1a: number; r1b: number; S2: number; r2a: number; P2: number } | undefined;
async function fresh() {
  if (F) return F;
  const S1 = (await orgSvc.createSection(captain, { name: `qa.mk.${RUN}.f1` }, M()))!.id;
  const S2 = (await orgSvc.createSection(captain, { name: `qa.mk.${RUN}.f2` }, M()))!.id;
  mySecs.push(S1, S2);
  const r1a = (await orgSvc.createRank(captain, { sectionId: S1, name: 'qa.mk.fa' }, M()))!.id;
  const r1b = (await orgSvc.createRank(captain, { sectionId: S1, name: 'qa.mk.fb' }, M()))!.id;
  const r2a = (await orgSvc.createRank(captain, { sectionId: S2, name: 'qa.mk.fa' }, M()))!.id;
  myRanks.push({ id: r1a, sectionId: S1 }, { id: r1b, sectionId: S1 }, { id: r2a, sectionId: S2 });
  const P2 = (await pl.createPlatoon(captain, { sectionId: S2, name: `qa.mk.${RUN}.fp` }, M()))!.id;
  myPls.push({ id: P2, sectionId: S2 });
  return (F = { S1, r1a, r1b, S2, r2a, P2 });
}

// ───────────────────────── 2. double / triple click ─────────────────────────
async function burst(who: Actor, n: number, fn: (...a: any[]) => Promise<any>, args: any[]) {
  ctx.token = await mint(who.cu.id);
  ctx.ip = `mk-${RUN}-b${++ipSeq}`;
  const outs = await Promise.all(Array.from({ length: n }, async () => {
    try {
      const r = await fn(...args);
      return r && 'ok' in r ? (r.ok ? 'OK' : r.code) : 'OK';
    } catch (e: any) {
      return 'THROW:' + String(e?.message).slice(0, 80);
    }
  }));
  for (const o of outs) if (!CLEAN.includes(o)) problems.push({ phase: 'burst', label: fn.name, who: who.key, out: o, args: short(args) });
  return outs.sort();
}
const okCount = (o: string[]) => o.filter((x) => x === 'OK').length;

describe('FN-MONKEY-002 double / triple click (same action fired 2-5x concurrently)', () => {
  const findings: string[] = [];
  beforeAll(async () => { await fresh(); }, 60000);
  it('FN-MONKEY-002a create same username x4 -> exactly one user', async () => {
    phase = 'burst';
    const input = { username: uname('dbl'), email: 'qa.mk@example.test', fullName: 'QA Dbl', gender: 'male', dateOfBirth: '2010-01-01', joinDate: '2022-01-01', idType: 'none', sectionId: F!.S1, rankId: F!.r1a, guardians: GUARD } as any;
    const outs = await burst(A.captain, 4, usersA.createUserAction, [input]);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(eq(users.username, input.username));
    const [u] = await db.select({ id: users.id }).from(users).where(eq(users.username, input.username));
    if (u) pool.push(u.id);
    expect({ outs, n }).toEqual({ outs: ['OK', 'VALIDATION', 'VALIDATION', 'VALIDATION'], n: 1 });
  });
  it('FN-MONKEY-002b promote same batch x3 -> one rank change per member', async () => {
    const ids = [(await mkUser('pb', F!.S1, F!.r1a)).id, (await mkUser('pb', F!.S1, F!.r1a)).id];
    pool.push(...ids);
    const outs = await burst(A.captain, 3, usersA.promoteAction, [{ userIds: ids, sectionId: F!.S1, rankId: F!.r1b, reason: 'qa dbl' }]);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(rankHistory).where(and(inArray(rankHistory.userId, ids), eq(rankHistory.toRankId, F!.r1b)));
    expect(okCount(outs)).toBe(1);
    expect(n).toBe(2);
  });
  it('FN-MONKEY-002c assign same members x3 -> one success, one audit per member', async () => {
    const p = (await pl.createPlatoon(captain, { sectionId: F!.S2, name: `qa.mk.${RUN}.dbl${++seq}` }, M()))!.id;
    myPls.push({ id: p, sectionId: F!.S2 });
    const ids = [(await mkUser('as', F!.S2, F!.r2a, F!.P2)).id, (await mkUser('as', F!.S2, F!.r2a, F!.P2)).id];
    pool.push(...ids);
    const outs = await burst(A.officer, 3, plA.assignMembersAction, [p, ids]);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLogs).where(and(eq(auditLogs.action, 'PLATOON_ASSIGNED'), inArray(auditLogs.entityId, ids)));
    expect(okCount(outs)).toBe(1);
    expect(n).toBe(2);
  });
  it('FN-MONKEY-002d approve same request x3 -> one approval', async () => {
    const t = (await mkUser('rq', F!.S1, F!.r1a)).id;
    pool.push(t);
    const r: any = await acc.saveUserAccess(A.delegate.cu, t, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow' }] }, M());
    const outs = await burst(A.captain, 3, accessA.decideRequestAction, [r.requestId, 'approve', 'qa']);
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLogs).where(and(eq(auditLogs.action, 'ACCESS_CHANGE_APPROVED'), eq(auditLogs.entityId, r.requestId)));
    expect({ outs, n }).toEqual({ outs: ['CONFLICT', 'CONFLICT', 'OK'], n: 1 });
  });
  it('FN-MONKEY-002e save same profile with same expectedUpdatedAt x3 -> one save', async () => {
    const u = await userRow(A.plain.cu.id);
    const outs = await burst(A.plain, 3, usersA.updateProfileAction, [{ email: 'qa.mk@example.test', phone: '+60123456789', address: `dbl ${++seq}`, school: null, guardians: GUARD, expectedUpdatedAt: u.updatedAt.toISOString() }]);
    expect(outs).toEqual(['CONFLICT', 'CONFLICT', 'OK']);
  });
  it('FN-MONKEY-002f void same activity x3 -> one void', async () => {
    const a = (await pl.createActivity(captain, { name: 'qa.mk dbl void', activityDate: '2001-01-02', scores: [{ platoonId: F!.P2, points: 3 }] }, M())).id;
    myActs.push(a);
    const outs = await burst(A.officer, 3, plA.voidActivityAction, [a, 'qa dbl']);
    expect(outs).toEqual(['OK', 'VALIDATION', 'VALIDATION']);
    voidedSnap.set(a, await activitySnap(a));
  });
  it('FN-MONKEY-002g set same leaders x3 -> one change, roles unique', async () => {
    const p = (await pl.createPlatoon(captain, { sectionId: F!.S2, name: `qa.mk.${RUN}.ldr${++seq}` }, M()))!.id;
    myPls.push({ id: p, sectionId: F!.S2 });
    const a = (await mkUser('ld', F!.S2, F!.r2a, p)).id;
    const b = (await mkUser('ld', F!.S2, F!.r2a, p)).id;
    pool.push(a, b);
    const outs = await burst(A.officer, 3, plA.setLeadersAction, [p, a, b]);
    expect(outs).toEqual(['OK', 'VALIDATION', 'VALIDATION']);
  });
  it('FN-MONKEY-002h deactivate same member x3 / create same section, platoon, role x3', async () => {
    const t = (await mkUser('dx', F!.S1, F!.r1a)).id;
    pool.push(t);
    expect(okCount(await burst(A.captain, 3, usersA.setStatusAction, [t, { status: 'inactive', reasonId: await reasonId() }]))).toBe(1);
    const sname = `qa.mk.${RUN}.dsec${++seq}`;
    const so = await burst(A.captain, 3, orgA.createSectionAction, [sname]);
    const secRows = await rows(sql`select id from sections where lower(name) = lower(${sname})`);
    mySecs.push(...secRows.map((x) => Number(x.id)));
    const pname = `qa.mk.${RUN}.dpl${++seq}`;
    const po = await burst(A.captain, 3, plA.createPlatoonAction, [F!.S2, pname]);
    for (const x of await rows(sql`select id from platoons where lower(name) = lower(${pname})`)) myPls.push({ id: Number(x.id), sectionId: F!.S2 });
    const rname = `qa.mk.${RUN}.drole${++seq}`;
    const ro = await burst(A.captain, 3, accessA.saveRoleAction, [null, { name: rname, description: '', isActive: true, permissions: ['users.view'] }]);
    const roleRows = await rows(sql`select id from roles where lower(name) = lower(${rname})`);
    myRoles.push(...roleRows.map((x) => Number(x.id)));
    // case-variant double click: "Foo" and "foo" at the same time
    const cname = `qa.mk.${RUN}.CaSe${++seq}`;
    ctx.token = await mint(captain.id);
    await Promise.all([orgA.createSectionAction(cname), orgA.createSectionAction(cname.toLowerCase())]);
    const caseRows = await rows(sql`select id from sections where lower(name) = lower(${cname})`);
    mySecs.push(...caseRows.map((x) => Number(x.id)));
    console.log('[FN-MONKEY-002h]', { section: so, platoon: po, role: ro, caseVariantSections: caseRows.length });
    if (caseRows.length > 1) findings.push(`concurrent "${cname}" + lowercase created ${caseRows.length} sections (case-insensitive rule broken)`);
    expect({ sec: secRows.length, pl: okCount(po), role: roleRows.length }).toEqual({ sec: 1, pl: 1, role: 1 });
    expect(okCount(so)).toBe(1);
    expect(okCount(ro)).toBe(1);
  });
  it('FN-MONKEY-002i double-click "Save" on a NEW activity x3 (no idempotency key)', async () => {
    const name = `qa.mk dbl create ${++seq}`;
    const outs = await burst(A.officer, 3, plA.saveActivityAction, [null, { name, activityDate: '2001-01-03', note: '', scores: [{ platoonId: F!.P2, points: '5' }] }]);
    const made = await db.select({ id: platoonActivities.id }).from(platoonActivities).where(eq(platoonActivities.name, name));
    myActs.push(...made.map((m) => m.id));
    console.log('[FN-MONKEY-002i] outs', outs, 'activities created', made.length);
    if (made.length > 1) findings.push(`double-click create activity -> ${made.length} identical activities, all counted on the scoreboard`);
    expect(outs.every((o) => CLEAN.includes(o))).toBe(true);
  });
  it('FN-MONKEY-002j double-click change password / reset password / delegate request', async () => {
    const who = A.leader;
    const next = `QaMonkey-Dbl-${++seq}-q1`;
    const co = await burst(who, 3, authA.changePasswordAction, [{ current: pwOf[who.cu.id], next, confirm: next }]);
    if (co.includes('OK')) pwOf[who.cu.id] = next;
    console.log('[FN-MONKEY-002j] change password x3', co);
    if (okCount(co) > 1) findings.push(`same password change accepted ${okCount(co)}x concurrently (current password verified outside the transaction)`);
    const t = pool.find(Boolean)!;
    expect((await burst(A.officer, 3, usersA.resetPasswordAction, [t, { reason: 'qa dbl' }])).every((o) => CLEAN.includes(o))).toBe(true);
    const t2 = (await mkUser('dq', F!.S1, F!.r1a)).id;
    pool.push(t2);
    const dq = await burst(A.delegate, 3, accessA.saveUserAccessAction, [t2, { roleIds: [], overrides: [{ slug: 'audit.view', effect: 'allow' }] }]);
    const pend = await db.select({ id: permissionChangeRequests.id }).from(permissionChangeRequests).where(and(eq(permissionChangeRequests.targetId, t2), eq(permissionChangeRequests.status, 'pending')));
    expect({ ok: okCount(dq), pend: pend.length }).toEqual({ ok: 1, pend: 1 });
  });
  it('FN-MONKEY-002z no SERVER/exception in any burst', () => {
    if (findings.length) console.log('[FN-MONKEY-002] findings:\n  ' + findings.join('\n  '));
    expect(report('burst')).toEqual([]);
  });
});

// ───────────────────────── 3. stale page / abandon halfway ─────────────────────────
describe('FN-MONKEY-003 stale page (load, someone else changes it, submit the old form)', () => {
  beforeAll(async () => { await fresh(); }, 60000);
  it('every stale submit is refused cleanly or is harmless', async () => {
    phase = 'stale';
    const obs: Record<string, string> = {};
    const t = await mkUser('st', F!.S1, F!.r1a); pool.push(t.id);
    const u0 = await userRow(t.id);
    const form = { username: u0.username, email: u0.email, fullName: 'Stale A', gender: u0.gender, dateOfBirth: u0.dateOfBirth, joinDate: u0.joinDate, guardians: GUARD, expectedUpdatedAt: u0.updatedAt.toISOString() };
    await us.updateUser(captain, t.id, { ...form, fullName: 'Changed by B', expectedUpdatedAt: undefined } as any, M());
    obs.editStale = (await call(A.officer, 'stale.updateUser', usersA.updateUserAction, [t.id, form])).out;
    expect(obs.editStale).toBe('CONFLICT');

    const prof = await userRow(A.madmin.cu.id);
    await us.updateUser(captain, A.madmin.cu.id, { username: prof.username, email: prof.email, fullName: prof.fullName, gender: prof.gender, dateOfBirth: prof.dateOfBirth, joinDate: prof.joinDate, guardians: GUARD, phone: '0198765432' } as any, M());
    obs.profileStale = (await call(A.madmin, 'stale.profile', usersA.updateProfileAction, [{ email: 'qa.mk@example.test', guardians: GUARD, expectedUpdatedAt: prof.updatedAt.toISOString() }])).out;
    expect(obs.profileStale).toBe('CONFLICT');

    const act = (await pl.createActivity(captain, { name: 'qa.mk stale', activityDate: '2001-01-04', scores: [{ platoonId: F!.P2, points: 1 }] }, M())).id;
    myActs.push(act);
    const [a0] = await db.select().from(platoonActivities).where(eq(platoonActivities.id, act));
    await pl.updateActivity(captain, act, { name: 'qa.mk stale B', activityDate: '2001-01-04', scores: [{ platoonId: F!.P2, points: 2 }] }, M());
    obs.activityStale = (await call(A.officer, 'stale.activity', plA.saveActivityAction, [act, { name: 'qa.mk stale A', activityDate: '2001-01-04', note: '', scores: [{ platoonId: F!.P2, points: '9' }], expectedUpdatedAt: a0.updatedAt.toISOString() }])).out;
    expect(obs.activityStale).toBe('CONFLICT');
    await pl.voidActivity(captain, act, { reason: 'B voided' }, M());
    voidedSnap.set(act, await activitySnap(act));
    obs.editVoided = (await call(A.officer, 'stale.editVoided', plA.saveActivityAction, [act, { name: 'x', activityDate: '2001-01-04', note: '', scores: [{ platoonId: F!.P2, points: '9' }] }])).out;
    obs.voidVoided = (await call(A.officer, 'stale.voidVoided', plA.voidActivityAction, [act, 'again'])).out;
    expect([obs.editVoided, obs.voidVoided]).toEqual(['VALIDATION', 'VALIDATION']);

    const p = await mkUser('sp', F!.S1, F!.r1a); pool.push(p.id);
    await us.promoteMembers(captain, { userIds: [p.id], sectionId: F!.S1, rankId: F!.r1b, reason: 'B did it' }, M());
    obs.promoteAgain = (await call(A.officer, 'stale.promote', usersA.promoteAction, [{ userIds: [p.id], sectionId: F!.S1, rankId: F!.r1b, reason: 'A too' }])).out;
    expect(obs.promoteAgain).toBe('VALIDATION');

    const dp = (await pl.createPlatoon(captain, { sectionId: F!.S2, name: `qa.mk.${RUN}.stale${++seq}` }, M()))!.id;
    myPls.push({ id: dp, sectionId: F!.S2 });
    await pl.updatePlatoon(captain, dp, { isActive: false }, M());
    obs.assignToInactive = (await call(A.officer, 'stale.assign', plA.assignMembersAction, [dp, [pool[0]]])).out;
    obs.leadersOnInactive = (await call(A.officer, 'stale.leaders', plA.setLeadersAction, [dp, pool[0], null])).out;
    expect(obs.assignToInactive).toBe('VALIDATION');

    const ex = await mkUser('sx', F!.S1, F!.r1a); pool.push(ex.id);
    const ex0 = await userRow(ex.id);
    await us.setStatus(captain, ex.id, { status: 'inactive', reasonId: await reasonId() }, M());
    obs.editDeactivated = (await call(A.officer, 'stale.editInactive', usersA.updateUserAction, [ex.id, { username: ex0.username, email: ex0.email, fullName: 'Edited after leaving', gender: ex0.gender, dateOfBirth: ex0.dateOfBirth, joinDate: ex0.joinDate, guardians: GUARD, expectedUpdatedAt: ex0.updatedAt.toISOString() }])).out;
    expect(obs.editDeactivated).toBe('CONFLICT');
    obs.deactivateTwice = (await call(A.officer, 'stale.deactivate', usersA.setStatusAction, [ex.id, { status: 'inactive', reasonId: await reasonId() }])).out;
    expect(obs.deactivateTwice).toBe('CONFLICT');

    // reactivate onto a rank that was deactivated meanwhile
    const r9 = (await orgSvc.createRank(captain, { sectionId: F!.S1, name: `qa.mk.r9.${seq}` }, M()))!.id;
    myRanks.push({ id: r9, sectionId: F!.S1 });
    const rx = await mkUser('sr', F!.S1, r9); pool.push(rx.id);
    await us.setStatus(captain, rx.id, { status: 'inactive', reasonId: await reasonId() }, M());
    await orgSvc.updateRank(captain, r9, { isActive: false }, M());
    obs.reactivateOnDeadRank = (await call(A.officer, 'stale.reactivate', usersA.setStatusAction, [rx.id, { status: 'active' }])).out;
    expect(obs.reactivateOnDeadRank).toBe('VALIDATION');

    // role deactivated by B while A still has the edit form open with isActive=true
    const role = Number((await acc.saveRole(captain, null, { name: `qa.mk.${RUN}.srole${++seq}`, description: null, isActive: true, permissions: ['users.view'] }, M())).targetId);
    myRoles.push(role);
    const g = (await acc.getRole(role))!;
    await acc.saveRole(captain, role, { name: g.name, description: null, isActive: false, permissions: g.permissions }, M());
    obs.assignDeadRole = (await call(A.captain, 'stale.assignRole', accessA.saveUserAccessAction, [pool[0], { roleIds: [role], overrides: [] }])).out;
    expect(obs.assignDeadRole).toBe('VALIDATION');
    obs.staleRoleForm = (await call(A.captain, 'stale.roleForm', accessA.saveRoleAction, [role, { name: g.name, description: '', isActive: true, permissions: ['users.view', 'audit.view'] }])).out;
    const after = (await acc.getRole(role))!;
    summary.push('[FN-MONKEY-003] stale outcomes ' + short(obs) + ' role active after stale save: ' + after.isActive);
    if (after.isActive) console.log('[FN-MONKEY-003] finding: a stale role form silently re-activates a role another admin just deactivated (no expectedUpdatedAt on roles / rank access)');
    expect(report('stale')).toEqual([]);
  }, 120000);
});

// ───────────────────────── 4. back-button replays ─────────────────────────
describe('FN-MONKEY-004 back-button replay of already-successful submissions', () => {
  it('replaying successful payloads never produces SERVER / exceptions; create-once actions are not duplicated', async () => {
    phase = 'replay';
    rnd = mulberry32(SEED + 1000);
    const sample = [...replays].sort(() => R.f() - 0.5).slice(0, 150);
    const dupes: Record<string, number> = {};
    const nameTaken = async (rp: (typeof replays)[number]) => {
      if (rp.label === 'createSection') return (await rows(sql`select 1 from sections where lower(name) = lower(trim(${String(rp.args[0])}))`)).length > 0;
      if (rp.label === 'createPlatoon') return (await rows(sql`select 1 from platoons where lower(name) = lower(trim(${String(rp.args[1])}))`)).length > 0;
      if (rp.label === 'createRank') return (await rows(sql`select 1 from ranks where section_id = ${smallOr(rp.args[0])} and lower(name) = lower(trim(${String(rp.args[1])}))`)).length > 0;
      if (rp.label === 'createUser') return (await rows(sql`select 1 from users where lower(username) = lower(trim(${String(rp.args[0]?.username)}))`)).length > 0;
      return false;
    };
    for (const rp of sample) {
      const taken = await nameTaken(rp);
      const res = await call(rp.who, 'replay.' + rp.label, rp.fn, rp.args, { replay: true });
      if (taken && res.out === 'OK') invariantBreaks.push(`replay of ${rp.label} ${short(rp.args)} succeeded although the name was still taken`);
      if (res.out === 'OK' && ['createUser', 'createSection', 'createRank', 'createPlatoon', 'createActivity', 'promote', 'assignMembers', 'removeMembers', 'deactivate', 'reactivate', 'voidActivity', 'decideRequest', 'cancelRequest'].includes(rp.label)) {
        dupes[rp.label] = (dupes[rp.label] ?? 0) + 1;
        if (rp.label === 'createActivity') myActs.push(...(await entityByIp(res.ip, 'PLATOON_ACTIVITY_CREATED')));
      }
    }
    summary.push(`[FN-MONKEY-004] replayed ${sample.length} of ${replays.length} successful submissions; replays that succeeded AGAIN: ${short(dupes)}`);
    await checkInvariants('after replays');
    expect(invariantBreaks).toEqual([]);
    expect(report('replay')).toEqual([]);
    // a void / decision / cancel can never legitimately happen twice; the others can (state may have been changed back meanwhile)
    expect(Object.keys(dupes).filter((k) => ['voidActivity', 'decideRequest', 'cancelRequest'].includes(k))).toEqual([]);
  }, 180000);
});

// ───────────────────────── 5. empty / partial submissions ─────────────────────────
describe('FN-MONKEY-005 empty / partial submissions ({} / null / undefined / [] / "") to every action', () => {
  it('each argument replaced by an empty value -> clean error, never SERVER / exception', async () => {
    phase = 'empty';
    const EMPTY: any[] = [{}, null, undefined, [], ''];
    const PA = myPls[0].id;
    const t = pool.find(Boolean)!;
    const act = myActs[myActs.length - 1];
    const role = myRoles[0] ?? 1;
    const name = () => `qa.mk.${RUN}.e${++seq}`;
    type Spec = [string, Actor | null, (...a: any[]) => Promise<any>, () => any[], string?];
    const specs: Spec[] = [
      ['saveRoleAction', A.captain, accessA.saveRoleAction, () => [role, { name: name(), description: '', isActive: true, permissions: ['users.view'] }]],
      ['saveRankAccessAction', A.captain, accessA.saveRankAccessAction, () => [myRanks[2].id, { permissions: ['users.view'] }]],
      ['saveUserAccessAction', A.captain, accessA.saveUserAccessAction, () => [t, { roleIds: [], overrides: [{ slug: 'audit.view', effect: R.pick(['allow', 'deny']) }] }]],
      ['decideRequestAction', A.captain, accessA.decideRequestAction, () => [randomUUID(), 'reject', 'x']],
      ['cancelRequestAction', A.delegate, accessA.cancelRequestAction, () => [randomUUID()]],
      ['createSectionAction', A.captain, orgA.createSectionAction, () => [name()]],
      ['createRankAction', A.captain, orgA.createRankAction, () => [SB, name()]],
      ['updateOrgItemAction', A.captain, orgA.updateOrgItemAction, () => ['rank', myRanks[2].id, { name: `qa.mk.r2.${++seq}` }]],
      ['moveOrgItemAction', A.captain, orgA.moveOrgItemAction, () => ['rank', myRanks[2].id, 'up']],
      ['setAgeUpAction', A.captain, orgA.setAgeUpAction, () => [SA, { age: 12, rankId: myRanks[3].id }]],
      ['createPlatoonAction', A.officer, plA.createPlatoonAction, () => [SA, name()]],
      ['updatePlatoonAction', A.officer, plA.updatePlatoonAction, () => [PA, { name: name() }]],
      ['movePlatoonAction', A.officer, plA.movePlatoonAction, () => [PA, 'sideways']],
      ['assignMembersAction', A.officer, plA.assignMembersAction, () => [PA, [randomUUID()]]],
      ['removeMembersAction', A.officer, plA.removeMembersAction, () => [PA, [randomUUID()]]],
      ['setLeadersAction', A.officer, plA.setLeadersAction, () => [PA, randomUUID(), null]],
      ['saveActivityAction(new)', A.officer, plA.saveActivityAction, () => [null, { name: 'qa.mk empty', activityDate: '2099-01-01', note: '', scores: [{ platoonId: PA, points: '1' }] }]],
      ['saveActivityAction(edit)', A.officer, plA.saveActivityAction, () => [act, { name: 'qa.mk empty', activityDate: '2099-01-01', note: '', scores: [{ platoonId: PA, points: '1' }] }]],
      ['voidActivityAction', A.officer, plA.voidActivityAction, () => [randomUUID(), 'x']],
      ['createUserAction', A.captain, usersA.createUserAction, () => [{ username: '', sectionId: SB }]],
      ['updateUserAction', A.captain, usersA.updateUserAction, () => [t, { username: '' }]],
      ['promoteAction', A.officer, usersA.promoteAction, () => [{ userIds: [randomUUID()], sectionId: SB, rankId: myRanks[4].id, reason: 'x' }]],
      ['setStatusAction', A.officer, usersA.setStatusAction, () => [randomUUID(), { status: 'inactive', reasonId: 1 }]],
      ['resetPasswordAction', A.officer, usersA.resetPasswordAction, () => [randomUUID(), { reason: 'x' }]],
      ['appointCaptainAction', { key: 'superadmin', cu: sa }, usersA.appointCaptainAction, () => [randomUUID()]],
      ['updateProfileAction', A.plain, usersA.updateProfileAction, () => [{ email: '' }]],
      ['changePasswordAction', A.madmin, authA.changePasswordAction, () => [{ current: 'wrong', next: 'a', confirm: 'a' }]],
    ];
    const bad: string[] = [];
    let calls = 0;
    for (const [label, who, fn, base] of specs) {
      const n = base().length;
      const variants: any[][] = [[], EMPTY.map(() => undefined)];
      for (let i = 0; i < n; i++) for (const e of EMPTY) { const a = base(); a[i] = e; variants.push(a); }
      for (const e of EMPTY) variants.push(Array(n).fill(e));
      for (const args of variants) {
        calls++;
        const res = await call(who, `empty.${label}`, fn, args, { replay: true, mut: false });
        if (!CLEAN.includes(res.out)) bad.push(`${label}(${short(args)}) -> ${res.out}`);
      }
    }
    // login form posted without FormData (direct action call)
    ctx.token = undefined;
    for (const fd of [null, undefined, {}]) {
      calls++;
      try {
        await authA.loginAction(undefined, fd as any);
      } catch (e: any) {
        if (!String(e?.digest ?? '').startsWith('NEXT_REDIRECT')) bad.push(`loginAction(undefined, ${short(fd)}) -> THROW:${String(e?.message).slice(0, 60)}`);
      }
    }
    console.log(`[FN-MONKEY-005] ${calls} empty/partial calls; unclean answers: ${bad.length}\n  ` + [...new Set(bad.map((b) => b.replace(/\(.*\) ->/, ' ->')))].join('\n  '));
    if (bad.length) console.log('[FN-MONKEY-005] examples:\n  ' + bad.slice(0, 40).join('\n  '));
    await checkInvariants('after empty');
    expect(invariantBreaks).toEqual([]);
    expect(bad).toEqual([]);
  }, 180000);
});
