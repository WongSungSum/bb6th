// Exotic / creative attack tests 2026-11-04 (SEC-EXO-*).
// Type confusion, unicode tricks, identifier/cookie tricks, business-logic abuse, resource abuse, oracles.
// Calls real server actions with a minted session (ctx.token) and services directly. Creates its own
// qa.exo.* sections / ranks / platoons / roles / users and deactivates them afterwards (nothing can be deleted).
// Tests assert SECURE behaviour: a failing test is a candidate finding.
import { vi, describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
vi.mock('next/headers', async () => (await import('./ctx')).headersMock);
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/server/request', async () => (await import('./ctx')).requestMock);

import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLogs, loginAttempts, platoonActivities, platoonScores, ranks, roles, sections, users, userPermissionOverrides } from '@/lib/db/schema';
import type { PermissionSlug } from '@/lib/server/authz/catalog';
import { loadPermissions } from '@/lib/server/authz';
import * as acc from '@/lib/server/access/service';
import * as orgSvc from '@/lib/server/org/service';
import * as pl from '@/lib/server/platoons/service';
import * as us from '@/lib/server/users/service';
import { getCurrentUser } from '@/lib/server/auth/session';
import { login, icAttemptHash } from '@/lib/server/auth/login';
import { hashPassword } from '@/lib/server/auth/password';
import * as accessA from '@/app/actions/access';
import * as authA from '@/app/actions/auth';
import * as orgA from '@/app/actions/org';
import * as plA from '@/app/actions/platoons';
import * as usersA from '@/app/actions/users';
import { ctx, resetCtx } from './ctx';
import { BASE, closeDb, loadCU, meta, mint, orgIds, rand, reasonId, sessionRow, userRow, validCreate } from './fixtures';

type CU = Awaited<ReturnType<typeof loadCU>>;
const PW = 'QaExo-Pass-2026-k7';
const M = () => meta('exo');
const GUARD = [{ name: 'QA Guardian', relationship: 'father', phone: '+60111222333', email: '' }];
const ic12 = () => '0' + Array.from({ length: 11 }, () => Math.floor(Math.random() * 10)).join('');
const todayMy = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const tomorrowMy = () => new Date(Date.now() + 32 * 3600_000).toISOString().slice(0, 10);
const median = (a: number[]) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

const ex = async (p: Promise<unknown>): Promise<{ code: string; message?: string; v?: any }> => {
  try { return { code: 'OK', v: await p }; } catch (e: any) {
    const isApp = typeof e?.code === 'string' && /^[A-Z_]+$/.test(e.code);
    return { code: isApp ? e.code : 'THROW', message: String(e?.message) };
  }
};

const toks = new Map<string, string>();
async function tok(who: CU) {
  // other testers may push dev.captain past the 10-live-session cap: re-mint when ours was revoked
  const cur = toks.get(who.id);
  if (!cur || (await sessionRow(cur))?.revokedAt) toks.set(who.id, await mint(who.id));
  return toks.get(who.id)!;
}
/** Action call as `who` (null = no cookie) → normalised outcome. */
async function act(who: CU | null, fn: () => Promise<unknown>): Promise<{ out: string; r?: any }> {
  ctx.token = who ? await tok(who) : undefined;
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
let SX = 0, SY = 0, RX1 = 0, RX2 = 0, RY1 = 0, RY2 = 0, PX1 = 0, PX2 = 0, PY1 = 0;
let mgr: CU, del: CU, xs: CU, low: CU, m1: CU, m2: CU, m3: CU, mx2: CU, my1: CU;
const created: string[] = [];
const createdSections: number[] = [];
const createdRanks: number[] = [];
const createdPlatoons: number[] = [];
const createdRoles: number[] = [];
const createdActs: string[] = [];
let pwHash: string | undefined;

async function setOv(userId: string, slug: PermissionSlug) {
  await db.insert(userPermissionOverrides).values({ userId, permissionSlug: slug, effect: 'allow', reason: 'qa.exo' })
    .onConflictDoUpdate({ target: [userPermissionOverrides.userId, userPermissionOverrides.permissionSlug], set: { effect: 'allow' } });
}
async function mk(tag: string, o: { sectionId: number; rankId: number; platoonId?: number; perms?: PermissionSlug[]; officer?: boolean; ic?: string }): Promise<CU> {
  const username = `qa.exo.${tag}${rand(5)}`;
  const r = await us.createUser(captain, validCreate({
    username, sectionId: o.sectionId, rankId: o.rankId, platoonId: o.platoonId, guardians: o.officer ? [] : GUARD,
    idType: o.ic ? 'mykad' : 'none', idNumber: o.ic, fullName: `QA Exo ${tag}`,
  }), M());
  pwHash ??= await hashPassword(PW);
  await db.update(users).set({ mustChangePassword: false, passwordHash: pwHash }).where(eq(users.id, r!.id));
  for (const p of o.perms ?? []) await setOv(r!.id, p);
  created.push(r!.id);
  return loadCU(username);
}
async function mkSection(name: string) { const id = (await orgSvc.createSection(captain, { name }, M()))!.id; createdSections.push(id); return id; }
async function mkRank(sectionId: number, name: string) { const id = (await orgSvc.createRank(captain, { sectionId, name }, M()))!.id; createdRanks.push(id); return id; }
async function mkPlatoon(sectionId: number, name: string) { const id = (await pl.createPlatoon(captain, { sectionId, name }, M()))!.id; createdPlatoons.push(id); return id; }
/** pg session that holds locks while a service call is paused on them */
async function locker() {
  const c = await (globalThis as any).pgPool.connect();
  return c as { query: (q: string, p?: unknown[]) => Promise<any>; release: () => void };
}
/** wait until some backend is waiting on a lock */
async function waitBlocked(ms = 5000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const r = await db.execute(sql`select count(*)::int n from pg_locks where not granted`);
    if (Number((r as any).rows?.[0]?.n ?? (r as any)[0]?.n) > 0) return true;
    await pause(25);
  }
  return false;
}

beforeAll(async () => {
  captain = await loadCU('dev.captain');
  sa = await loadCU('superadmin');
  org = await orgIds();
  SX = await mkSection(`qa.exo.sx${rand(6)}`);
  SY = await mkSection(`qa.exo.sy${rand(6)}`);
  RX1 = await mkRank(SX, 'qa.x1');
  RX2 = await mkRank(SX, 'qa.x2');
  RY1 = await mkRank(SY, 'qa.y1');
  RY2 = await mkRank(SY, 'qa.y2');
  PX1 = await mkPlatoon(SX, `qa.exo.px1.${rand(6)}`);
  PX2 = await mkPlatoon(SX, `qa.exo.px2.${rand(6)}`);
  PY1 = await mkPlatoon(SY, `qa.exo.py1.${rand(6)}`);
  const helper = org.rk('Officer', 'Helper');
  mgr = await mk('mgr', { sectionId: org.officer, rankId: helper, officer: true, perms: ['platoons.manage', 'platoons.score', 'users.view', 'users.change_rank', 'users.update'] });
  del = await mk('del', { sectionId: SX, rankId: RX1, platoonId: PX1, perms: ['permissions.manage', 'users.view'] });
  xs = await mk('xs', { sectionId: SY, rankId: RY1, platoonId: PY1, perms: ['users.view', 'permissions.manage'] });
  low = await mk('low', { sectionId: SX, rankId: RX1, platoonId: PX1 });
  m1 = await mk('m1', { sectionId: SX, rankId: RX1, platoonId: PX1 });
  m2 = await mk('m2', { sectionId: SX, rankId: RX1, platoonId: PX1 });
  m3 = await mk('m3', { sectionId: SX, rankId: RX1, platoonId: PX1 });
  mx2 = await mk('mx2', { sectionId: SX, rankId: RX1, platoonId: PX2 });
  my1 = await mk('my1', { sectionId: SY, rankId: RY1, platoonId: PY1 });
}, 300000);
beforeEach(() => resetCtx());
afterAll(async () => {
  try {
    for (const a of createdActs) await pl.voidActivity(captain, a, { reason: 'qa.exo cleanup' }, M()).catch(() => {});
    const open = await db.execute(sql`select pcr.id from permission_change_requests pcr join users u on u.id = pcr.requested_by where u.username like 'qa.exo.%' and pcr.status = 'pending'`);
    for (const r of ((open as any).rows ?? open) as { id: string }[]) await acc.decideRequest(captain, r.id, 'reject', 'qa.exo cleanup', M()).catch(() => {});
    // anything left over in qa.exo sections (also from earlier runs)
    const secs = (await db.select({ id: sections.id }).from(sections).where(and(sql`${sections.name} like 'qa.exo%'`, eq(sections.isActive, true)))).map((s) => s.id);
    createdSections.push(...secs.filter((s) => !createdSections.includes(s)));
    if (createdSections.length) {
      const pls = await db.execute(sql`select id from platoons where is_active and section_id in (${sql.join(createdSections.map((s) => sql`${s}`), sql`, `)})`);
      for (const p of ((pls as any).rows ?? pls) as { id: number }[]) if (!createdPlatoons.includes(p.id)) createdPlatoons.push(p.id);
      const rks = await db.select({ id: ranks.id }).from(ranks).where(and(inArray(ranks.sectionId, createdSections), eq(ranks.isActive, true)));
      for (const r of rks) if (!createdRanks.includes(r.id)) createdRanks.push(r.id);
    }
    await orgSvc.setAgeUp(captain, SX, { age: null }, M()).catch(() => {});
    const rid = await reasonId();
    const extra = (await db.select({ id: users.id }).from(users).where(and(sql`${users.username} like 'qa.exo.%'`, eq(users.status, 'active')))).map((u) => u.id);
    for (const id of [...new Set([...created, ...extra])]) await us.setStatus(captain, id, { status: 'inactive', reasonId: rid }, M()).catch(() => {});
    for (const p of createdPlatoons) await pl.updatePlatoon(captain, p, { isActive: false }, M()).catch(() => {});
    for (const r of createdRanks) await orgSvc.updateRank(captain, r, { isActive: false }, M()).catch(() => {});
    for (const s of createdSections) await orgSvc.updateSection(captain, s, { isActive: false }, M()).catch(() => {});
    const rl = (await db.select({ id: roles.id }).from(roles).where(and(sql`${roles.name} like 'qa.exo%'`, eq(roles.isActive, true)))).map((r) => r.id);
    for (const r of [...new Set([...createdRoles, ...rl])]) {
      const g = await acc.getRole(r);
      if (g?.isActive) await acc.saveRole(captain, r, { name: g.name, description: null, isActive: false, permissions: g.permissions }, M()).catch(() => {});
    }
  } catch (e) { console.error('cleanup', e); }
  await db.execute(sql`update sessions set revoked_at = now() where revoked_at is null and ip = 'qa-mint'`);
  await closeDb();
}, 300000);

// ───────────────────────── 1. Type confusion ─────────────────────────
// Values a browser can really send through React's server-action encoding (JSON + $n BigInt, $D Date, Map, Set, NaN, Infinity, -0).
const WIRE: [string, unknown][] = [
  ['NaN', NaN], ['Infinity', Infinity], ['-Infinity', -Infinity], ['-0', -0], ['1e308', 1e308], ['2^53+1', 2 ** 53 + 1],
  ['1.5', 1.5], ['-1', -1], ['32768', 32768], ['huge BigInt', BigInt(2) ** BigInt(70)], ["'7abc'", '7abc'], ["'٣' arabic", '٣'], ["'７' fullwidth", '７'],
  ['[]', []], ['{}', {}], ['null', null], ["''", ''], ['Date', new Date()], ['Map', new Map([[1, 1]])], ['Set', new Set([1])],
];

describe('1. Type confusion', () => {
  it('SEC-EXO-001 exotic id values: non-admin always FORBIDDEN, admin never crashes or hits a row', async () => {
    const bad: string[] = [];
    for (const [label, v] of WIRE) {
      const a = await act(low, () => orgA.updateOrgItemAction('rank', v as any, {}));
      if (a.out !== 'FORBIDDEN') bad.push(`low ${label} -> ${a.out}`);
      const c = await act(captain, () => orgA.updateOrgItemAction('rank', v as any, {}));
      if (c.out !== 'NOT_FOUND') bad.push(`captain ${label} -> ${c.out} ${c.r?.message ?? ''}`);
      const p = await act(mgr, () => plA.assignMembersAction(v as any, [m1.id]));
      if (p.out !== 'NOT_FOUND') bad.push(`assign platoon=${label} -> ${p.out}`);
      const s = await act(captain, () => usersA.setStatusAction(v as any, { status: 'inactive', reasonId: 1 }));
      if (s.out !== 'NOT_FOUND') bad.push(`setStatus id=${label} -> ${s.out}`);
    }
    expect(bad, bad.join('; ')).toEqual([]);
  });

  it('SEC-EXO-002 lax numeric strings resolve to real rows (observation) — but only within normal authorization', async () => {
    // ' 7 ', '0x..', '1e0', [id], BigInt and true are all coerced by Number(); record which ones hit the row.
    const hex = '0x' + RX1.toString(16);
    const forms: [string, unknown][] = [[`' ${RX1} '`, ` ${RX1} `], [hex, hex], [`'${RX1}e0'`, `${RX1}e0`], [`[${RX1}]`, [RX1]], [`${RX1}n`, BigInt(RX1)], ['0b' + RX1.toString(2), '0b' + RX1.toString(2)]];
    const hits: string[] = [];
    for (const [label, v] of forms) {
      const c = await act(captain, () => orgA.updateOrgItemAction('rank', v as any, {}));
      if (c.out === 'VALIDATION') hits.push(label); // "Nothing has changed" = resolved to RX1
      expect((await act(low, () => orgA.updateOrgItemAction('rank', v as any, {}))).out).toBe('FORBIDDEN');
    }
    console.info('[SEC-EXO-002] id forms coerced to a real rank:', hits.join(', '));
    expect(true).toBe(true);
  });

  it('SEC-EXO-003 objects with toString / valueOf / Symbol.toPrimitive / Proxy (in-process only)', async () => {
    const tricky: [string, unknown][] = [
      ['valueOf', { valueOf: () => RX1 }],
      ['toString', { toString: () => String(RX1) }],
      ['toPrimitive', { [Symbol.toPrimitive]: () => RX1 }],
      ['toPrimitive throws', { [Symbol.toPrimitive]: () => { throw new Error('boom'); } }],
      ['Proxy', new Proxy({}, { get: (_t, k) => (k === Symbol.toPrimitive ? () => RX1 : undefined) })],
    ];
    const bad: string[] = [];
    for (const [label, v] of tricky) {
      const a = await act(low, () => orgA.updateOrgItemAction('rank', v as any, { name: v as any }));
      // a throwing toPrimitive is not wire-sendable; a generic SERVER result (no detail) is acceptable
      if (a.out !== 'FORBIDDEN' && !(label === 'toPrimitive throws' && a.out === 'SERVER')) bad.push(`low ${label} -> ${a.out}`);
      const n = await act(captain, () => orgA.createSectionAction(v as any));
      if (n.out !== 'VALIDATION') bad.push(`createSection(name=${label}) -> ${n.out}`);
      const pr = await act(mgr, () => usersA.promoteAction({ userIds: [m1.id], sectionId: v as any, rankId: v as any, reason: v as any }));
      if (pr.out === 'OK' || pr.out.startsWith('THROW')) bad.push(`promote(${label}) -> ${pr.out}`);
    }
    expect((await userRow(m1.id)).rankId).toBe(RX1);
    expect(bad, bad.join('; ')).toEqual([]);
  });

  it('SEC-EXO-004 TOCTOU getter: setStatus input.status read once (deactivate vs audit/session revoke)', async () => {
    const t = await mk('toctou', { sectionId: SX, rankId: RX1, platoonId: PX1 });
    const victimTok = await mint(t.id);
    const rid = await reasonId();
    // reads: action check -> 'active'; service compare -> 'inactive'; branch -> 'inactive'; revoke -> 'active'; audit -> 'active'
    const seq = ['active', 'inactive', 'inactive', 'active', 'active', 'active', 'active'];
    let i = 0;
    const input = { reasonId: rid, get status() { return seq[Math.min(i++, seq.length - 1)]; } };
    const r = await act(captain, () => usersA.setStatusAction(t.id, input as any));
    const after = await userRow(t.id);
    const [log] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, t.id), sql`${auditLogs.action} in ('USER_DEACTIVATED','USER_REACTIVATED')`)).orderBy(sql`${auditLogs.createdAt} desc`).limit(1);
    const live = await sessionRow(victimTok);
    console.info('[SEC-EXO-004]', r.out, 'reads', i, 'status', after.status, 'audit', log?.action, 'sessionRevoked', !!live?.revokedAt);
    // secure: either refused, or the stored state, the audit action and session revocation all agree
    if (after.status === 'inactive') {
      expect(log?.action).toBe('USER_DEACTIVATED');
      expect(live?.revokedAt).not.toBeNull();
    }
  });

  it('SEC-EXO-005 Proxy that changes username between reads cannot sneak an invalid username in', async () => {
    let n = 0;
    const base = validCreate({ sectionId: SX, rankId: RX1, platoonId: PX1, guardians: GUARD });
    const good = base.username;
    const p = new Proxy(base, { get: (t, k) => (k === 'username' ? (n++ === 0 ? good : 'DEV.CAPTAIN‮<x>') : (t as any)[k]) });
    const r = await act(captain, () => usersA.createUserAction(p));
    if (r.out === 'OK') {
      created.push(r.r.data.id);
      expect((await userRow(r.r.data.id)).username).toMatch(/^[a-z0-9._-]{3,30}$/);
    }
    expect(r.out.startsWith('THROW')).toBe(false);
  });

  it('SEC-EXO-006 prototype-pollution payloads (JSON __proto__ / constructor.prototype / inherited props)', async () => {
    const payloads = [
      JSON.parse('{"__proto__":{"isCaptain":true,"isSuperadmin":true,"slug":"audit.view","effect":"allow","isActive":false}}'),
      JSON.parse('{"constructor":{"prototype":{"isCaptain":true,"slug":"audit.view"}}}'),
    ];
    const before = await loadPermissions(low.id);
    const outs: string[] = [];
    for (const p of payloads) {
      outs.push((await act(del, () => accessA.saveUserAccessAction(low.id, { roleIds: [], overrides: [p] }))).out);
      outs.push((await act(low, () => orgA.createSectionAction(p))).out);
      outs.push((await act(captain, () => orgA.updateOrgItemAction('rank', RX1, p))).out);
      // own-profile save is allowed; the payload must simply be ignored
      expect((await act(low, () => usersA.updateProfileAction({ email: 'qa@example.test', guardians: GUARD, ...p } as any))).out).toBe('OK');
      outs.push((await act(low, () => accessA.decideRequestAction(randomUUID(), p as any))).out);
      outs.push((await act(low, () => usersA.createUserAction({ ...validCreate({ sectionId: SX, rankId: RX1, platoonId: PX1 }), ...p }))).out);
      const fd = new FormData(); fd.set('identifier', '__proto__'); fd.set('password', 'x'.repeat(10));
      outs.push(String((await authA.loginAction(undefined, fd))?.error ? 'GENERIC' : 'OK?'));
    }
    // inherited (non-own) props are read by plain property access: authorization must still apply
    const inh = Object.create({ slug: 'audit.view', effect: 'allow' });
    outs.push((await act(del, () => accessA.saveUserAccessAction(low.id, { roleIds: [], overrides: [inh] }))).out);
    expect(({} as any).isCaptain).toBeUndefined();
    expect(({} as any).slug).toBeUndefined();
    expect(Object.keys(Object.prototype)).toEqual([]);
    expect([...(await loadPermissions(low.id))].sort()).toEqual([...before].sort());
    expect((await userRow(low.id)).rankId).toBe(RX1);
    expect(outs.filter((o) => o === 'OK' || o.startsWith('THROW') || o === 'OK?'), outs.join(',')).toEqual([]);
  });

  it('SEC-EXO-007 score points accept only plain integers (no true/false/hex/exponent/array/BigInt)', async () => {
    const forms: [string, unknown][] = [['true', true], ['false', false], ["'0x10'", '0x10'], ["'1e2'", '1e2'], ["'0b11'", '0b11'], ['[5]', [5]], ['5n', BigInt(5)], ['{valueOf:5}', { valueOf: () => 5 }], ["'٣'", '٣'], ['NaN', NaN], ['Infinity', Infinity]];
    const accepted: string[] = [];
    for (const [label, v] of forms) {
      const r = await act(mgr, () => plA.saveActivityAction(null, { name: `qa.exo pts ${label}`, activityDate: '2026-01-05', note: '', scores: [{ platoonId: PX1, points: v as any }] }));
      if (r.out === 'OK') accepted.push(label);
      if (r.out.startsWith('THROW')) accepted.push(label + ' THROW');
      console.info('[SEC-EXO-007]', label, r.out, r.r?.fieldErrors ? JSON.stringify(r.r.fieldErrors) : '');
    }
    const acts = await db.select({ id: platoonActivities.id }).from(platoonActivities).where(sql`${platoonActivities.name} like 'qa.exo pts %'`);
    createdActs.push(...acts.map((a) => a.id));
    expect(accepted, 'accepted: ' + accepted.join(', ')).toEqual([]);
  });

  it('SEC-EXO-008 age-up age accepts only plain integers (observation, Captain-only)', async () => {
    const forms: [string, unknown][] = [["'0x10'", '0x10'], ["'1e1'", '1e1'], ['[12]', [12]], ['12n', BigInt(12)], ['true', true], ["' 12 '", ' 12 ']];
    const accepted: string[] = [];
    for (const [label, v] of forms) {
      const r = await act(captain, () => orgA.setAgeUpAction(SX, { age: v as any, rankId: RY2 }));
      if (r.out === 'OK') { accepted.push(label); await orgSvc.setAgeUp(captain, SX, { age: null }, M()).catch(() => {}); }
      expect(r.out.startsWith('THROW')).toBe(false);
    }
    console.info('[SEC-EXO-008] age forms accepted:', accepted.join(', '));
  });
});

// ───────────────────────── 2. Unicode tricks ─────────────────────────
describe('2. Unicode tricks', () => {
  it('SEC-EXO-010 usernames: homoglyph / zero-width / RTL / fullwidth / Turkish / Kelvin', async () => {
    const tries: [string, string][] = [
      ['cyrillic a', 'dev.captаin'], ['zero-width', 'dev.cap​tain'], ['RTL', 'dev.‮captain'], ['fullwidth', 'ｄｅｖ.captain'],
      ['turkish I', 'DEV.CAPTAİN'], ['combining', 'dev.captaín'], ['uppercase dup', 'DEV.CAPTAIN'], ['NBSP inside', 'dev. captain'],
    ];
    const bad: string[] = [];
    for (const [label, u] of tries) {
      const r = await act(captain, () => usersA.createUserAction(validCreate({ username: u, sectionId: SX, rankId: RX1, platoonId: PX1, guardians: GUARD })));
      if (r.out !== 'VALIDATION') { bad.push(`${label} -> ${r.out}`); if (r.out === 'OK') created.push(r.r.data.id); }
    }
    // Kelvin sign lower-cases to ASCII 'k': must end up as plain ASCII or be refused
    const k = await act(captain, () => usersA.createUserAction(validCreate({ username: `qa.exo.K${rand(5)}`, sectionId: SX, rankId: RX1, platoonId: PX1, guardians: GUARD })));
    if (k.out === 'OK') { created.push(k.r.data.id); expect((await userRow(k.r.data.id)).username).toMatch(/^[a-z0-9._-]+$/); }
    expect(bad, bad.join('; ')).toEqual([]);
  });

  it('SEC-EXO-011 look-alike duplicates of section / rank / platoon / role names are refused', async () => {
    const base = `qa.exo Café ${rand(4)}`; // NFC é
    const variants: [string, string][] = [
      ['NFD', base.normalize('NFD')], ['ZWSP', base.replace(' ', ' ​')], ['ZWJ end', base + '‍'], ['RLM', '‏' + base],
      ['BOM', '﻿' + base], ['cyrillic a', base.replace('a', 'а')], ['NBSP', base.replace(' ', ' ')], ['double space', base.replace(' ', '  ')],
      ['upper', base.toUpperCase()],
    ];
    const accepted: string[] = [];
    // sections
    createdSections.push((await orgSvc.createSection(captain, { name: base }, M()))!.id);
    for (const [l, v] of variants) {
      const r = await act(captain, () => orgA.createSectionAction(v));
      if (r.out === 'OK') { accepted.push('section/' + l); const [s] = await db.select({ id: sections.id }).from(sections).where(eq(sections.name, v.trim().replace(/\s+/g, ' '))); if (s) createdSections.push(s.id); }
    }
    // ranks (inside SY)
    createdRanks.push((await orgSvc.createRank(captain, { sectionId: SY, name: base }, M()))!.id);
    for (const [l, v] of variants) {
      const r = await act(captain, () => orgA.createRankAction(SY, v));
      if (r.out === 'OK') { accepted.push('rank/' + l); const [k] = await db.select({ id: ranks.id }).from(ranks).where(and(eq(ranks.sectionId, SY), eq(ranks.name, v.trim().replace(/\s+/g, ' ')))); if (k) createdRanks.push(k.id); }
    }
    // platoons (SY)
    createdPlatoons.push((await pl.createPlatoon(captain, { sectionId: SY, name: base }, M()))!.id);
    for (const [l, v] of variants) {
      const r = await act(captain, () => plA.createPlatoonAction(SY, v));
      if (r.out === 'OK') accepted.push('platoon/' + l);
    }
    // roles
    const rbase = 'qa.exo' + base.slice(6);
    createdRoles.push(Number((await acc.saveRole(captain, null, { name: rbase, description: null, isActive: true, permissions: [] }, M())).targetId));
    for (const [l, v] of variants) {
      const vv = 'qa.exo' + v.slice(6);
      const r = await act(captain, () => accessA.saveRoleAction(null, { name: vv, description: '', isActive: true, permissions: [] }));
      if (r.out === 'OK') {
        createdRoles.push(Number(r.r.data.targetId));
        // 名称会先清理再存：只有存进去的名称跟原本的一样（重复）才算漏洞
        const [k] = await db.select({ name: roles.name }).from(roles).where(eq(roles.id, Number(r.r.data.targetId)));
        if (k && k.name.toLowerCase() === rbase.toLowerCase()) accepted.push('role/' + l);
      }
    }
    const plats = await db.execute(sql`select id from platoons where name like ${'%' + base.slice(-4)} or name like ${'%' + base.normalize('NFD').slice(-4)}`);
    for (const p of ((plats as any).rows ?? plats) as { id: number }[]) if (!createdPlatoons.includes(p.id)) createdPlatoons.push(p.id);
    expect(accepted, 'look-alike duplicates accepted: ' + accepted.join(', ')).toEqual([]);
  });

  it('SEC-EXO-012 invisible / bidi-control names are refused (Captain look-alike rank, blank member name)', async () => {
    const accepted: string[] = [];
    // "Captain" + zero-width space inside the Officer section → a member could appear as Captain
    const r1 = await act(captain, () => orgA.createRankAction(org.officer, 'Captain​'));
    if (r1.out === 'OK') { accepted.push('Officer rank "Captain\\u200b"'); const [k] = await db.select({ id: ranks.id }).from(ranks).where(and(eq(ranks.sectionId, org.officer), eq(ranks.name, 'Captain​'))); if (k) createdRanks.push(k.id); }
    const r2 = await act(captain, () => orgA.createSectionAction('​​'));
    if (r2.out === 'OK') { accepted.push('section "\\u200b\\u200b"'); const [s] = await db.select({ id: sections.id }).from(sections).where(eq(sections.name, '​​')); if (s) createdSections.push(s.id); }
    for (const [label, name] of [['RTL override', 'QA ‮niatpaC veD'], ['only ZWSP', '​'], ['zalgo', 'Q' + '̶'.repeat(90)]] as const) {
      const r = await act(captain, () => usersA.createUserAction(validCreate({ fullName: name, sectionId: SX, rankId: RX1, platoonId: PX1, guardians: GUARD })));
      if (r.out === 'OK') {
        created.push(r.r.data.id);
        // 隐形 / 方向控制字元会被去掉再存；存进去的名称不能有这些字元
        const [k] = await db.select({ fullName: users.fullName }).from(users).where(eq(users.id, r.r.data.id));
        if (!k || /\p{Cf}/u.test(k.fullName) || /\p{M}{4,}/u.test(k.fullName)) accepted.push(`fullName ${label}`);
      }
    }
    const rr = await act(captain, () => accessA.saveRoleAction(null, { name: 'qa.exo‮' + rand(4), description: '', isActive: true, permissions: [] }));
    if (rr.out === 'OK') {
      createdRoles.push(Number(rr.r.data.targetId));
      const [k] = await db.select({ name: roles.name }).from(roles).where(eq(roles.id, Number(rr.r.data.targetId)));
      if (!k || /\p{Cf}/u.test(k.name)) accepted.push('role with RTL override');
    }
    expect(accepted, accepted.join('; ')).toEqual([]);
  });

  it('SEC-EXO-013 case-folding behaviour of unique names (observation: ß/SS, Turkish i, Kelvin)', async () => {
    const pairs: [string, string][] = [['straße', 'STRASSE'], ['qa.exo.i', 'QA.EXO.İ'], ['qa.exo.ı', 'QA.EXO.I'], ['k', 'K']];
    const collide: string[] = [];
    for (const [a, b] of pairs) {
      const sfx = ' ' + rand(4);
      const s1 = await act(captain, () => orgA.createSectionAction(`qa.exo ${a}${sfx}`));
      const s2 = await act(captain, () => orgA.createSectionAction(`qa.exo ${b}${sfx}`));
      if (s1.out === 'OK' && s2.out !== 'OK') collide.push(`${a}=${b}`);
      for (const n of [`qa.exo ${a}${sfx}`, `qa.exo ${b}${sfx}`]) { const [s] = await db.select({ id: sections.id }).from(sections).where(eq(sections.name, n)); if (s) createdSections.push(s.id); }
    }
    console.info('[SEC-EXO-013] treated as duplicates:', collide.join(', ') || 'none');
  });
});

// ───────────────────────── 3. Login identifier tricks ─────────────────────────
describe('3. Login identifiers', () => {
  let U: CU, IC = '';
  beforeAll(async () => { IC = ic12(); U = await mk('ic', { sectionId: SX, rankId: RX1, platoonId: PX1, ic: IC }); });
  const L = (id: string, pw = PW) => login(id, pw, M());
  const fmt = (s: string) => `${s.slice(0, 6)}-${s.slice(6, 8)}-${s.slice(8)}`;

  it('SEC-EXO-020 IC look-alikes with the right password never log in (unicode dashes, digits, +, ZWSP)', async () => {
    const d = (sep: string) => `${IC.slice(0, 6)}${sep}${IC.slice(6, 8)}${sep}${IC.slice(8)}`;
    const toFull = (s: string) => s.replace(/\d/g, (c) => String.fromCharCode(0xff10 + Number(c)));
    const toArabic = (s: string) => s.replace(/\d/g, (c) => String.fromCharCode(0x0660 + Number(c)));
    const bad: string[] = [];
    for (const [label, v] of [['U+2010', d('‐')], ['U+2013', d('–')], ['U+2212', d('−')], ['+IC', '+' + IC], ['fullwidth', toFull(IC)], ['arabic-indic', toArabic(IC)], ['ZWSP', d('​')], ['dots', d('.')], ['13 digits', IC + '0']] as const) {
      if ((await L(v)).ok) bad.push(label);
    }
    expect((await L(fmt(IC))).ok).toBe(true);
    expect(bad, 'logged in with: ' + bad.join(', ')).toEqual([]);
  });

  it('SEC-EXO-021 whitespace-separated IC variants share the canonical throttle bucket', async () => {
    for (const sep of [' ', '　', '\t', ' ']) {
      const v = `${IC.slice(0, 6)}${sep}${IC.slice(6, 8)}${sep}${IC.slice(8)}`;
      const { looksLikeIc } = await import('@/lib/server/auth/crypto');
      const n = looksLikeIc(v);
      // either not treated as an IC at all, or treated as exactly this IC (same throttle key)
      if (n) expect(icAttemptHash(n)).toBe(icAttemptHash(IC));
    }
  });

  it('SEC-EXO-022 username with control chars / SQL / LIKE / very long identifier', async () => {
    const bad: string[] = [];
    for (const v of [U.username + '\u0001', U.username + '​', '‮' + U.username, U.username.replace('.', '%'), U.username.slice(0, -2) + '__', `' OR '1'='1`, `${U.username}' --`, `"; select pg_sleep(5); --`]) {
      const t = performance.now();
      const r = await L(v);
      if (r.ok) bad.push(JSON.stringify(v));
      if (performance.now() - t > 2500) bad.push('slow ' + JSON.stringify(v));
    }
    const t = performance.now();
    const fd = new FormData(); fd.set('identifier', 'a'.repeat(1_000_000)); fd.set('password', 'x'.repeat(128));
    const r = await authA.loginAction(undefined, fd);
    expect(performance.now() - t).toBeLessThan(2000);
    expect(r?.error).toMatch(/Incorrect login details/);
    // NUL is stripped: same account, same throttle key
    expect((await L(U.username + '\u0000')).ok).toBe(true);
    expect(bad, bad.join('; ')).toEqual([]);
  });

  it('SEC-EXO-023 nobody can hold a username that is also a valid IC', async () => {
    const bad: string[] = [];
    for (const u of [IC, fmt(IC), `${IC.slice(0, 6)}-${IC.slice(6)}`, `${IC.slice(0, 11)}-${IC.slice(11)}`]) {
      const r = await act(captain, () => usersA.createUserAction(validCreate({ username: u, sectionId: SX, rankId: RX1, platoonId: PX1, guardians: GUARD })));
      if (r.out !== 'VALIDATION') { bad.push(`${u} -> ${r.out}`); if (r.out === 'OK') created.push(r.r.data.id); }
    }
    expect(bad, bad.join('; ')).toEqual([]);
  });

  it('SEC-EXO-024 case / NUL / whitespace variants of a username share one lockout bucket', async () => {
    const f = await mk('lock', { sectionId: SX, rankId: RX1, platoonId: PX1 });
    const vs = [f.username.toUpperCase(), ` ${f.username} `, f.username + '\u0000', f.username.replace(/^q/, 'Q'), '　' + f.username];
    for (const v of vs) expect((await L(v, 'Wrong-Pass-123x')).ok).toBe(false);
    expect((await L(f.username)).ok).toBe(false); // locked by the 5 variant failures
  });
});

// ───────────────────────── 4. Session / cookie ─────────────────────────
describe('4. Session and cookie tricks', () => {
  it('SEC-EXO-030 token look-alikes (case, padding, base64 std alphabet, whitespace, encoding) are rejected', async () => {
    const t = await mint(low.id);
    ctx.token = t;
    expect((await getCurrentUser())?.id).toBe(low.id);
    const swap = (s: string) => s.replace(/[a-zA-Z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
    const variants: [string, string][] = [
      ['upper', t.toUpperCase()], ['lower', t.toLowerCase()], ['swapcase', swap(t)], ['=', t + '='], ['==', t + '=='],
      ['std b64', t.replace(/-/g, '+').replace(/_/g, '/')], ['lead space', ' ' + t], ['trail space', t + ' '], ['tab', t + '\t'],
      ['url-enc', encodeURIComponent(t).replace(/-/g, '%2D')], ['double', t + t], ['NUL', t + '\u0000'], ['quoted', `"${t}"`], ['prefix', 'bb6_session=' + t],
    ];
    const bad: string[] = [];
    for (const [l, v] of variants) {
      if (v === t) continue;
      ctx.token = v;
      if ((await getCurrentUser())?.id) bad.push(l);
    }
    expect(bad, bad.join(', ')).toEqual([]);
  });

  it('SEC-EXO-031 session fixation: a pre-set cookie (garbage or attacker\'s own token) is never adopted', async () => {
    const victim = await mk('fix', { sectionId: SX, rankId: RX1, platoonId: PX1 });
    const attackerTok = await mint(low.id);
    for (const pre of ['attacker-chosen-token-0000000000000000000000', attackerTok]) {
      ctx.token = pre;
      ctx.cookiesSet = [];
      const fd = new FormData(); fd.set('identifier', victim.username); fd.set('password', PW);
      const r = await act(null, async () => { ctx.token = pre; return authA.loginAction(undefined, fd); });
      expect(r.out).toBe('REDIRECT:/dashboard');
      const set = ctx.cookiesSet.find((c) => c.name === 'bb6_session' && c.value);
      expect(set?.value).toBeTruthy();
      expect(set!.value).not.toBe(pre);
      expect((await sessionRow(set!.value!))?.userId).toBe(victim.id);
    }
    expect((await sessionRow(attackerTok))?.userId).toBe(low.id);
    expect(await sessionRow('attacker-chosen-token-0000000000000000000000')).toBeUndefined();
  });

  it('SEC-EXO-032 deactivate → reactivate does not resurrect old sessions; admin reset kills them too', async () => {
    const u = await mk('resur', { sectionId: SX, rankId: RX1, platoonId: PX1 });
    const t1 = await mint(u.id);
    await us.setStatus(captain, u.id, { status: 'inactive', reasonId: await reasonId() }, M());
    await us.setStatus(captain, u.id, { status: 'active', reason: 'back' }, M());
    ctx.token = t1;
    expect(await getCurrentUser()).toBeNull();
    const t2 = await mint(u.id);
    await us.resetPassword(captain, u.id, { reason: 'qa' }, M());
    ctx.token = t2;
    expect(await getCurrentUser()).toBeNull();
  });

  it('SEC-EXO-033 HTTP: two session cookies / case-variant cookie never 5xx and never upgrade a bad cookie', async () => {
    let up = false;
    try { up = (await fetch(BASE + '/login')).status === 200; } catch { up = false; }
    if (!up) { console.info('[SEC-EXO-033] BLOCKED: dev server not reachable'); return; }
    const good = await mint(low.id);
    const get = async (cookie: string) => { const r = await fetch(BASE + '/dashboard', { redirect: 'manual', headers: { Cookie: cookie } }); await r.text(); return { s: r.status, loc: r.headers.get('location') ?? '' }; };
    const res: Record<string, { s: number; loc: string }> = {
      valid: await get(`bb6_session=${good}`),
      garbageFirst: await get(`bb6_session=garbage; bb6_session=${good}`),
      validFirst: await get(`bb6_session=${good}; bb6_session=garbage`),
      upper: await get(`bb6_session=${good.toUpperCase()}`),
      nameCase: await get(`BB6_SESSION=${good}`),
      hostPrefix: await get(`__Host-bb6_session=${good}`),
    };
    console.info('[SEC-EXO-033]', JSON.stringify(res));
    for (const [k, v] of Object.entries(res)) expect(v.s, k).toBeLessThan(500);
    expect(res.valid.s).toBe(200);
    expect(res.upper.loc).toMatch(/\/login/);
    expect(res.nameCase.loc).toMatch(/\/login/);
  });
});

// ───────────────────────── 5. Business logic abuse ─────────────────────────
describe('5. Business logic', () => {
  it('SEC-EXO-040 [race] promotion into a rank that is deactivated mid-transaction', async () => {
    const R_T = await mkRank(SX, 'qa.race' + rand(4));
    const v = await mk('race', { sectionId: SX, rankId: RX1, platoonId: PX1 });
    const c = await locker();
    await c.query('begin');
    await c.query('select 1 from users where id = $1 for update', [v.id]);
    const p = ex(us.promoteMembers(captain, { userIds: [v.id], sectionId: SX, rankId: R_T, reason: 'qa race' }, M()));
    expect(await waitBlocked()).toBe(true); // promote passed its rank check and now waits on the member row
    // 修好后：停用会等升阶完成（军阶被 FOR SHARE 锁住），所以先发出、再放锁
    const dP = ex(orgSvc.updateRank(captain, R_T, { isActive: false }, M()));
    await new Promise((r) => setTimeout(r, 300));
    await c.query('commit'); c.release();
    const [pr, d] = await Promise.all([p, dP]);
    const [rk] = await db.select().from(ranks).where(eq(ranks.id, R_T));
    const u = await userRow(v.id);
    console.info('[SEC-EXO-040] deactivate:', d.code, 'promote:', pr.code, 'rank active:', rk.isActive, 'member rank:', u.rankId === R_T ? 'R_T' : u.rankId, u.status);
    // invariant: an active member never holds an inactive rank
    expect(!(u.status === 'active' && u.rankId === R_T && !rk.isActive)).toBe(true);
  });

  it('SEC-EXO-041 [race] createUser into a rank / platoon deactivated mid-transaction', async () => {
    const R_T = await mkRank(SX, 'qa.race2' + rand(4));
    const P_T = await mkPlatoon(SX, `qa.exo.prace.${rand(6)}`);
    const IC = ic12();
    const c = await locker();
    await c.query('select pg_advisory_lock(hashtext($1))', ['idnum:' + IC]);
    const username = `qa.exo.cr${rand(5)}`;
    const p = ex(us.createUser(captain, validCreate({ username, sectionId: SX, rankId: R_T, platoonId: P_T, guardians: GUARD, idType: 'mykad', idNumber: IC }), M()));
    expect(await waitBlocked()).toBe(true); // createUser passed rank + platoon checks, waits on the ID lock
    const d1P = ex(orgSvc.updateRank(captain, R_T, { isActive: false }, M()));
    const d2P = ex(pl.updatePlatoon(captain, P_T, { isActive: false }, M()));
    await new Promise((r) => setTimeout(r, 300));
    await c.query('select pg_advisory_unlock(hashtext($1))', ['idnum:' + IC]); c.release();
    const [r, d1, d2] = await Promise.all([p, d1P, d2P]);
    const [u] = await db.select().from(users).where(eq(users.username, username));
    if (u) created.push(u.id);
    const [rk] = await db.select().from(ranks).where(eq(ranks.id, R_T));
    const [pt] = await db.execute(sql`select is_active from platoons where id = ${P_T}`).then((x: any) => x.rows ?? x);
    console.info('[SEC-EXO-041] rank deact:', d1.code, 'platoon deact:', d2.code, 'create:', r.code, 'rank active:', rk.isActive, 'platoon active:', pt?.is_active);
    if (u && u.status === 'active') {
      expect(rk.isActive, 'active member created in an inactive rank').toBe(true);
      expect(pt?.is_active, 'active member created in an inactive platoon').toBe(true);
    }
  });

  it('SEC-EXO-042 age-up rule whose target rank is later deactivated: no candidates, promotion refused', async () => {
    const RT = await mkRank(SY, 'qa.ageup' + rand(4));
    await orgSvc.setAgeUp(captain, SX, { age: 4, rankId: RT }, M());
    expect((await us.ageUpCandidates('all')).groups.some((g) => g.sectionId === SX)).toBe(true);
    await orgSvc.updateRank(captain, RT, { isActive: false }, M());
    expect((await us.ageUpCandidates('all')).groups.some((g) => g.sectionId === SX)).toBe(false);
    expect((await act(mgr, () => usersA.promoteAction({ userIds: [m3.id], sectionId: SY, rankId: RT, reason: 'age up' }))).out).toBe('VALIDATION');
    expect((await userRow(m3.id)).rankId).toBe(RX1);
    await orgSvc.setAgeUp(captain, SX, { age: null }, M());
  });

  it('SEC-EXO-043 platoon assignment / leaders across sections are refused', async () => {
    expect((await act(mgr, () => plA.assignMembersAction(PX1, [my1.id]))).out).toBe('VALIDATION');
    expect((await act(mgr, () => plA.setLeadersAction(PX1, my1.id, null))).out).toBe('VALIDATION');
    const u = await userRow(m2.id);
    const upd = await act(mgr, () => usersA.updateUserAction(m2.id, { username: u.username, email: u.email, fullName: u.fullName, gender: u.gender, dateOfBirth: u.dateOfBirth!, joinDate: u.joinDate!, phone: u.phone ?? '', platoonId: PY1, guardians: GUARD } as any));
    expect(upd.out).toBe('VALIDATION');
    expect((await userRow(m2.id)).platoonId).toBe(PX1);
    expect((await userRow(my1.id)).platoonId).toBe(PY1);
  });

  it('SEC-EXO-044 platoon leader moved out (section change / deactivate / other platoon) loses the role', async () => {
    const L = await mk('lead', { sectionId: SX, rankId: RX1, platoonId: PX1 });
    const role = async () => (await userRow(L.id)).platoonRole;
    expect((await act(mgr, () => plA.setLeadersAction(PX1, L.id, null))).out).toBe('OK');
    expect(await role()).toBe('leader');
    expect((await act(mgr, () => usersA.promoteAction({ userIds: [L.id], sectionId: SY, rankId: RY1, reason: 'move' }))).out).toBe('OK');
    let r = await userRow(L.id);
    expect([r.platoonId, r.platoonRole]).toEqual([null, null]);
    // stale leaderId afterwards is refused
    expect((await act(mgr, () => plA.setLeadersAction(PX1, L.id, null))).out).toBe('VALIDATION');
    // back to SX, leader again, then to another platoon
    await us.promoteMembers(captain, { userIds: [L.id], sectionId: SX, rankId: RX1, reason: 'back' }, M()).catch(() => {});
    await db.update(users).set({ platoonId: PX1 }).where(eq(users.id, L.id));
    expect((await act(mgr, () => plA.setLeadersAction(PX1, L.id, null))).out).toBe('OK');
    expect((await act(mgr, () => plA.assignMembersAction(PX2, [L.id]))).out).toBe('OK');
    r = await userRow(L.id);
    expect([r.platoonId, r.platoonRole]).toEqual([PX2, null]);
    expect((await act(mgr, () => plA.setLeadersAction(PX2, L.id, null))).out).toBe('OK');
    await us.setStatus(captain, L.id, { status: 'inactive', reasonId: await reasonId() }, M());
    expect(await role()).toBeNull();
  });

  it('SEC-EXO-045 voided activity cannot be re-scored through the update path or SQL', async () => {
    const a = await pl.createActivity(mgr, { name: 'qa.exo void', activityDate: '2026-01-06', scores: [{ platoonId: PX1, points: 5 }] }, M());
    createdActs.push(a.id);
    await pl.voidActivity(mgr, a.id, { reason: 'qa' }, M());
    const [row] = await db.select().from(platoonActivities).where(eq(platoonActivities.id, a.id));
    const outs = [
      (await act(mgr, () => plA.saveActivityAction(a.id, { name: 'qa.exo void', activityDate: '2026-01-06', note: '', scores: [{ platoonId: PX1, points: '999' }] }))).out,
      (await act(mgr, () => plA.saveActivityAction(a.id, { name: 'x', activityDate: '2026-01-06', note: '', scores: [{ platoonId: PX2, points: '1' }], expectedUpdatedAt: row.updatedAt.toISOString() }))).out,
      (await act(mgr, () => plA.saveActivityAction(a.id.toUpperCase(), { name: 'x', activityDate: '2026-01-06', note: '', scores: [{ platoonId: PX1, points: '1' }] }))).out,
      (await act(mgr, () => plA.voidActivityAction(a.id, 'again'))).out,
    ];
    expect(outs.every((o) => o === 'VALIDATION' || o === 'NOT_FOUND'), outs.join(',')).toBe(true);
    const sqlUpd = await ex(db.update(platoonScores).set({ points: 999 }).where(eq(platoonScores.activityId, a.id)));
    expect(sqlUpd.code).not.toBe('OK');
    const sc = await db.select().from(platoonScores).where(eq(platoonScores.activityId, a.id));
    expect(sc.map((s) => [s.platoonId, s.points])).toEqual([[PX1, 5]]);
  });

  it('SEC-EXO-046 activity dates: 1999 / 2099 / Feb 30 / tomorrow / odd formats refused, Feb 29 leap OK', async () => {
    const dates = ['1999-12-31', '2099-01-01', '2026-02-30', '2025-02-29', '2026-13-01', '0000-00-00', '2026-1-1', ' 2026-01-01', '2026-01-01T00:00:00Z', '+002026-01-01', '２０２６-01-01', tomorrowMy(), '2026-01-01\u0000'];
    const accepted: string[] = [];
    for (const d of dates) {
      const r = await act(mgr, () => plA.saveActivityAction(null, { name: 'qa.exo date', activityDate: d, note: '', scores: [{ platoonId: PX1, points: '1' }] }));
      if (r.out !== 'VALIDATION') accepted.push(`${JSON.stringify(d)} -> ${r.out}`);
    }
    const ok = await act(mgr, () => plA.saveActivityAction(null, { name: 'qa.exo date leap', activityDate: '2024-02-29', note: '', scores: [{ platoonId: PX1, points: '1' }] }));
    const acts = await db.select({ id: platoonActivities.id }).from(platoonActivities).where(sql`${platoonActivities.name} like 'qa.exo date%' and ${platoonActivities.voidedAt} is null`);
    createdActs.push(...acts.map((a) => a.id));
    expect(ok.out).toBe('OK');
    expect(accepted, accepted.join('; ')).toEqual([]);
    expect(todayMy() >= '2026-01-01').toBe(true);
  });

  it('SEC-EXO-047 self-referential requests: own access, own rank, requester later promoted into the target rank', async () => {
    expect((await act(del, () => accessA.saveUserAccessAction(del.id, { roleIds: [], overrides: [{ slug: 'audit.view', effect: 'allow' }] }))).out).toBe('FORBIDDEN');
    expect((await act(del, () => accessA.saveRankAccessAction(RX1, { permissions: ['users.view'] }))).out).toBe('FORBIDDEN');
    // del asks for RX2 to get users.view, then is promoted into RX2 before the Captain approves
    const r = await act(del, () => accessA.saveRankAccessAction(RX2, { permissions: ['users.view'] }));
    expect(r.out).toBe('OK');
    const [req] = await db.execute(sql`select id from permission_change_requests where requested_by = ${del.id} and status = 'pending' and kind = 'rank_access'`).then((x: any) => x.rows ?? x);
    await us.promoteMembers(captain, { userIds: [del.id], sectionId: SX, rankId: RX2, reason: 'qa' }, M());
    const d = await act(captain, () => accessA.decideRequestAction(req.id, 'approve'));
    expect(d.out).toBe('CONFLICT');
    await acc.decideRequest(captain, req.id, 'reject', 'qa cleanup', M()).catch(() => {});
    await us.promoteMembers(captain, { userIds: [del.id], sectionId: SX, rankId: RX1, reason: 'qa back' }, M());
    // nobody but the Captain decides: superadmin / all-permission officer
    const r2 = await act(del, () => accessA.saveUserAccessAction(m1.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'allow' }] }));
    expect(r2.out).toBe('OK');
    const [req2] = await db.execute(sql`select id from permission_change_requests where requested_by = ${del.id} and status = 'pending'`).then((x: any) => x.rows ?? x);
    expect((await act(sa, () => accessA.decideRequestAction(req2.id, 'approve'))).out).toBe('FORBIDDEN');
    expect((await act(mgr, () => accessA.decideRequestAction(req2.id, 'approve'))).out).toBe('FORBIDDEN');
    expect((await act(del, () => accessA.decideRequestAction(req2.id, 'approve'))).out).toBe('FORBIDDEN');
    await acc.decideRequest(captain, req2.id, 'reject', 'qa cleanup', M());
  });

  it('SEC-EXO-048 Captain cannot demote / deactivate / move himself (age-up, promote, status, platoon, access)', async () => {
    const before = await userRow(captain.id);
    const outs = {
      ageUpOfficer: (await act(captain, () => orgA.setAgeUpAction(org.officer, { age: 4, rankId: RY1 }))).out,
      promoteSelf: (await act(captain, () => usersA.promoteAction({ userIds: [captain.id], sectionId: SX, rankId: RX1, reason: 'step down' }))).out,
      deactivateSelf: (await act(captain, () => usersA.setStatusAction(captain.id, { status: 'inactive', reasonId: 1 }))).out,
      resetSelf: (await act(captain, () => usersA.resetPasswordAction(captain.id, { reason: 'x' }))).out,
      accessSelf: (await act(captain, () => accessA.saveUserAccessAction(captain.id, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'deny' }] }))).out,
      platoonSelf: (await act(captain, () => plA.assignMembersAction(PX1, [captain.id]))).out,
      leaderSelf: (await act(captain, () => plA.setLeadersAction(PX1, captain.id, null))).out,
      captainRankOff: (await act(captain, () => orgA.updateOrgItemAction('rank', org.captainRankId, { isActive: false }))).out,
      officerSecOff: (await act(captain, () => orgA.updateOrgItemAction('section', org.officer, { isActive: false }))).out,
    };
    expect(Object.values(outs).filter((o) => o === 'OK' || o.startsWith('THROW')), JSON.stringify(outs)).toEqual([]);
    const after = await userRow(captain.id);
    expect([after.rankId, after.status, after.sectionId, after.platoonId, after.passwordHash]).toEqual([before.rankId, before.status, before.sectionId, before.platoonId, before.passwordHash]);
  });

  it('SEC-EXO-049 Superadmin as the target of every action (by Captain and by himself)', async () => {
    const before = await userRow(sa.id);
    const S = sa.id;
    const outs: Record<string, string> = {};
    for (const [who, label] of [[captain, 'cap'], [sa, 'sa']] as const) {
      outs[`${label}.promote`] = (await act(who, () => usersA.promoteAction({ userIds: [S], sectionId: SX, rankId: RX1, reason: 'x' }))).out;
      outs[`${label}.status`] = (await act(who, () => usersA.setStatusAction(S, { status: 'inactive', reasonId: 1 }))).out;
      outs[`${label}.reset`] = (await act(who, () => usersA.resetPasswordAction(S, { reason: 'x' }))).out;
      outs[`${label}.access`] = (await act(who, () => accessA.saveUserAccessAction(S, { roleIds: [], overrides: [{ slug: 'users.view', effect: 'deny' }] }))).out;
      outs[`${label}.assign`] = (await act(who, () => plA.assignMembersAction(PX1, [S]))).out;
      outs[`${label}.leader`] = (await act(who, () => plA.setLeadersAction(PX1, S, null))).out;
      outs[`${label}.appoint`] = (await act(who, () => usersA.appointCaptainAction(S))).out;
    }
    outs['cap.update'] = (await act(captain, () => usersA.updateUserAction(S, validCreate({ username: before.username, fullName: 'pwn' })))).out;
    outs['cap.detail'] = (await ex(us.getUserDetail(captain, S, M()))).code;
    expect(Object.entries(outs).filter(([, o]) => o === 'OK' || o.startsWith('THROW')), JSON.stringify(outs)).toEqual([]);
    const after = await userRow(S);
    expect([after.status, after.rankId, after.sectionId, after.platoonId, after.passwordHash, after.fullName, after.accountType]).toEqual([before.status, before.rankId, before.sectionId, before.platoonId, before.passwordHash, before.fullName, 'superadmin']);
  });
});

// ───────────────────────── 6. Resource abuse ─────────────────────────
describe('6. Resource abuse', () => {
  it('SEC-EXO-060 1000 rapid failing calls: no crash, no leak, no writes, pool still healthy', async () => {
    const [{ n: a0 }] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLogs).where(eq(auditLogs.actorId, low.id));
    ctx.token = await tok(low);
    const outs = new Map<string, number>();
    const t = performance.now();
    for (let b = 0; b < 20; b++) {
      const rs = await Promise.all(Array.from({ length: 50 }, (_, i) => (i % 2
        ? orgA.createSectionAction('qa.exo.flood')
        : accessA.decideRequestAction(randomUUID(), 'approve')).then((r: any) => r.code ?? 'OK', (e: any) => 'THROW:' + e?.message)));
      for (const r of rs) outs.set(r, (outs.get(r) ?? 0) + 1);
    }
    const ms = performance.now() - t;
    const [{ n: a1 }] = await db.select({ n: sql<number>`count(*)::int` }).from(auditLogs).where(eq(auditLogs.actorId, low.id));
    console.info('[SEC-EXO-060]', Math.round(ms), 'ms', JSON.stringify([...outs]), 'pool', (globalThis as any).pgPool.totalCount);
    expect([...outs.keys()]).toEqual(['FORBIDDEN']);
    expect(a1).toBe(a0);
    expect((await act(captain, () => orgA.moveOrgItemAction('rank', RX1, 'up'))).out).toBe('OK');
  }, 120000);

  it('SEC-EXO-061 1000 failed logins from one IP add at most the throttle quota of rows', async () => {
    const ip = 'exo-flood-' + rand(8);
    const t = performance.now();
    for (let b = 0; b < 20; b++) await Promise.all(Array.from({ length: 50 }, () => login(`qa.exo.nobody.${rand(8)}`, 'Wrong-Pass-123x', { ip, userAgent: 'vitest' })));
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(loginAttempts).where(eq(loginAttempts.ip, ip));
    console.info('[SEC-EXO-061]', Math.round(performance.now() - t), 'ms rows', n);
    expect(n).toBeLessThanOrEqual(25);
  }, 120000);

  it('SEC-EXO-062 1e5-element arrays to batch actions are rejected in < 1 s each', async () => {
    const N = 100_000;
    const uuids = Array.from({ length: N }, () => randomUUID());
    const big = <T,>(f: (i: number) => T) => Array.from({ length: N }, (_, i) => f(i));
    const cases: [string, CU, () => Promise<unknown>][] = [
      ['promote', captain, () => usersA.promoteAction({ userIds: uuids, sectionId: SX, rankId: RX2, reason: 'x' })],
      ['assign', captain, () => plA.assignMembersAction(PX1, uuids)],
      ['remove', captain, () => plA.removeMembersAction(PX1, uuids)],
      ['roleIds 1..32767', captain, () => accessA.saveUserAccessAction(m1.id, { roleIds: big((i) => (i % 32767) + 1), overrides: [] })],
      ['overrides dup', captain, () => accessA.saveUserAccessAction(m1.id, { roleIds: [], overrides: big(() => ({ slug: 'users.view', effect: 'allow' })) })],
      ['role perms', captain, () => accessA.saveRoleAction(null, { name: 'qa.exo.big' + rand(4), description: '', isActive: true, permissions: [...big(() => 'users.view'), 'bogus'] })],
      ['rank perms', captain, () => accessA.saveRankAccessAction(RX2, { permissions: [...big(() => 'users.view'), 'bogus'] })],
      ['guardians', captain, () => usersA.createUserAction(validCreate({ sectionId: SX, rankId: RX1, platoonId: PX1, guardians: big(() => GUARD[0]) }))],
      ['scores distinct platoons', mgr, () => plA.saveActivityAction(null, { name: 'qa.exo big', activityDate: '2026-01-05', note: '', scores: big((i) => ({ platoonId: (i % 32767) + 1, points: '1' })) })],
    ];
    const slow: string[] = [];
    for (const [l, who, fn] of cases) {
      const t = performance.now();
      const r = await act(who, fn);
      const ms = performance.now() - t;
      console.info(`[SEC-EXO-062] ${l}: ${r.out} ${Math.round(ms)} ms`);
      if (r.out === 'OK') slow.push(`${l} accepted`);
      if (ms > 1000) slow.push(`${l} ${Math.round(ms)}ms`);
    }
    expect(slow, slow.join('; ')).toEqual([]);
  }, 120000);

  it('SEC-EXO-063 deeply nested input (5k objects, 100k arrays) is rejected fast without crashing', async () => {
    const depth = 5000;
    const deep = JSON.parse('{"a":'.repeat(depth) + '1' + '}'.repeat(depth));
    let arr: any = 1; for (let i = 0; i < 100_000; i++) arr = [arr];
    const cases: [string, CU, () => Promise<unknown>][] = [
      ['profile address', low, () => usersA.updateProfileAction({ email: 'qa@example.test', address: deep, guardians: GUARD } as any)],
      ['override', del, () => accessA.saveUserAccessAction(m1.id, { roleIds: [], overrides: [deep] })],
      ['leader', mgr, () => plA.setLeadersAction(PX1, deep, null)],
      ['points nested array', mgr, () => plA.saveActivityAction(null, { name: 'qa.exo deep', activityDate: '2026-01-05', note: deep, scores: [{ platoonId: PX1, points: arr }] })],
      ['roleIds nested', del, () => accessA.saveUserAccessAction(m1.id, { roleIds: [arr], overrides: [] })],
      ['promote ids nested', mgr, () => usersA.promoteAction({ userIds: [arr], sectionId: SX, rankId: RX2, reason: 'x' })],
    ];
    const bad: string[] = [];
    for (const [l, who, fn] of cases) {
      const t = performance.now();
      const r = await act(who, fn);
      const ms = performance.now() - t;
      console.info(`[SEC-EXO-063] ${l}: ${r.out} ${Math.round(ms)} ms`);
      if (r.out === 'OK' || r.out.startsWith('THROW') || ms > 1000) bad.push(`${l} ${r.out} ${Math.round(ms)}ms`);
    }
    expect(bad, bad.join('; ')).toEqual([]);
  }, 60000);
});

// ───────────────────────── 7. Oracles (timing / error shape) ─────────────────────────
describe('7. Existence oracles', () => {
  async function profile(fn: (id: string) => Promise<unknown>, ids: Record<string, string>, runs = 25) {
    const shape: Record<string, string> = {};
    const times: Record<string, number[]> = {};
    for (const k of Object.keys(ids)) { times[k] = []; await ex(fn(ids[k])); } // warm-up
    for (let i = 0; i < runs; i++) {
      for (const k of Object.keys(ids)) {
        const t = performance.now();
        const r = await ex(fn(ids[k]));
        times[k].push(performance.now() - t);
        shape[k] = `${r.code}|${r.message}`;
      }
    }
    const med = Object.fromEntries(Object.entries(times).map(([k, v]) => [k, +median(v).toFixed(2)]));
    return { shape, med, spread: Math.max(...Object.values(med)) - Math.min(...Object.values(med)) };
  }

  it('SEC-EXO-070 getUserDetail: ghost / out-of-scope / Captain / Superadmin / inactive look identical (shape + timing)', async () => {
    const ina = await mk('ina', { sectionId: SX, rankId: RX1, platoonId: PX1 });
    await us.setStatus(captain, ina.id, { status: 'inactive', reasonId: await reasonId() }, M());
    const xsCU = await loadCU(xs.username);
    const p = await profile((id) => us.getUserDetail(xsCU, id, M()), { ghost: randomUUID(), outScope: m1.id, captain: captain.id, superadmin: sa.id, inactiveOut: ina.id });
    console.info('[SEC-EXO-070]', JSON.stringify(p.med), 'spread', p.spread.toFixed(2), 'ms');
    expect(new Set(Object.values(p.shape)).size, JSON.stringify(p.shape)).toBe(1);
    expect(p.spread).toBeLessThan(5);
  }, 60000);

  it('SEC-EXO-071 getUserAccess (access page): ghost / out-of-scope / Captain / Superadmin identical', async () => {
    const xsCU = await loadCU(xs.username);
    const p = await profile((id) => acc.getUserAccess(xsCU, id), { ghost: randomUUID(), outScope: m1.id, captain: captain.id, superadmin: sa.id, garbage: 'not-a-uuid' });
    console.info('[SEC-EXO-071]', JSON.stringify(p.med), 'spread', p.spread.toFixed(2), 'ms', JSON.stringify(p.shape));
    expect(new Set(Object.values(p.shape)).size, JSON.stringify(p.shape)).toBe(1);
    expect(p.spread).toBeLessThan(5);
  }, 60000);

  it('SEC-EXO-072 platoon page / role save for non-managers: existing vs missing ids identical', async () => {
    const lowCU = await loadCU(low.username);
    const pp = await profile((id) => pl.getPlatoon(lowCU, Number(id)), { existing: String(PX1), missing: '32000', garbage: 'abc' });
    expect(new Set(Object.values(pp.shape)).size, JSON.stringify(pp.shape)).toBe(1);
    const rp = await profile((id) => acc.saveRole(lowCU, Number(id), { name: 'x', description: null, isActive: true, permissions: [] }, M()), { existing: String(createdRoles[0] ?? 1), missing: '32000' });
    expect(new Set(Object.values(rp.shape)).size, JSON.stringify(rp.shape)).toBe(1);
    console.info('[SEC-EXO-072]', JSON.stringify(pp.med), JSON.stringify(rp.med));
  }, 60000);

  it('SEC-EXO-073 action-level error shape: update/status/reset/promote on ghost vs out-of-scope vs Superadmin', async () => {
    const actor = await mk('orc', { sectionId: SY, rankId: RY1, platoonId: PY1, perms: ['users.view', 'users.update', 'users.update_status'] });
    const ids = { ghost: randomUUID(), outScope: m1.id, superadmin: sa.id, captain: captain.id };
    const shapes: Record<string, Set<string>> = { update: new Set(), status: new Set() };
    for (const id of Object.values(ids)) {
      const u = await act(actor, () => usersA.updateUserAction(id, validCreate({ username: 'qa.exo.zz' })));
      shapes.update.add(`${u.out}|${u.r?.message}`);
      const s = await act(actor, () => usersA.setStatusAction(id, { status: 'inactive', reasonId: 1 }));
      shapes.status.add(`${s.out}|${s.r?.message}`);
    }
    expect([...shapes.update]).toHaveLength(1);
    expect([...shapes.status]).toHaveLength(1);
  });
});

// keep imports used
void inArray;
