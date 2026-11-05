// Data-efficiency checks for the DB layer (PERF-DATA-xxx).
// Read-only against the shared local DB except: login() failure runs insert their own
// login_attempts rows (unique qa.perf.* identifiers), exactly like the functional login tests.
// EXPLAIN runs inside a transaction that is rolled back. Nothing is updated or deleted.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// login() timing must exclude argon2: verifyPassword always fails fast here (only this file).
vi.mock('@/lib/server/auth/password', async (orig) => ({
  ...(await orig<typeof import('@/lib/server/auth/password')>()),
  verifyPassword: async () => false,
}));

import pg from 'pg';
import { eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { ranks, sessions, users } from '@/lib/db/schema';
import { sha256 } from '@/lib/server/auth/crypto';
import { login } from '@/lib/server/auth/login';
import type { CurrentUser } from '@/lib/server/auth/session';
import { getPermissionsFor, loadPermissions, memberScope } from '@/lib/server/authz';
import { listOrg } from '@/lib/server/org/service';
import { listPlatoons, scoreboard } from '@/lib/server/platoons/service';
import { ageUpCandidates, getUserDetail, listUsers } from '@/lib/server/users/service';
import { actor, meta, RUN } from '../functional/helpers';

// ─── query capture (patches pg.Client so pool + transaction queries are all seen) ───

type Q = { text: string; values: unknown[] };
let capturing = false;
let captured: Q[] = [];
const origQuery = pg.Client.prototype.query;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(pg.Client.prototype as any).query = function (this: pg.Client, ...args: any[]) {
  if (capturing) {
    const a = args[0];
    if (typeof a === 'string') captured.push({ text: a, values: Array.isArray(args[1]) ? args[1] : [] });
    else if (a && typeof a.text === 'string') captured.push({ text: a.text, values: a.values ?? (Array.isArray(args[1]) ? args[1] : []) });
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (origQuery as any).apply(this, args);
};
afterAll(() => {
  pg.Client.prototype.query = origQuery;
});

async function capture<T>(fn: () => Promise<T>) {
  captured = [];
  capturing = true;
  try {
    const result = await fn();
    return { result, queries: [...captured] };
  } finally {
    capturing = false;
  }
}
const isTxControl = (t: string) => /^\s*(begin|commit|rollback|savepoint|release)/i.test(t);
const selects = (qs: Q[]) => qs.filter((q) => /^\s*select/i.test(q.text) && !/pg_advisory/i.test(q.text));

// ─── EXPLAIN helpers ───

type PlanNode = { 'Node Type': string; 'Relation Name'?: string; 'Index Name'?: string; 'Index Cond'?: string; 'Total Cost': number; 'Actual Total Time'?: number; Plans?: PlanNode[] };
const BIG = ['users', 'audit_logs', 'login_attempts', 'sessions', 'rank_history', 'guardians'];

async function explain(q: Q, opts: { noSeq?: boolean; analyze?: boolean } = {}): Promise<{ plan: PlanNode; exec?: number }> {
  const client = await db.$client.connect();
  try {
    await client.query('begin');
    if (opts.noSeq) await client.query('set local enable_seqscan = off');
    const r = await origQuery.call(client, `explain (format json${opts.analyze ? ', analyze' : ''}) ${q.text}`, q.values as never, undefined as never) as unknown as pg.QueryResult;
    const top = r.rows[0]['QUERY PLAN'][0];
    return { plan: top.Plan, exec: top['Execution Time'] };
  } finally {
    await client.query('rollback');
    client.release();
  }
}
function walk(n: PlanNode, out: PlanNode[] = []) {
  out.push(n);
  for (const c of n.Plans ?? []) walk(c, out);
  return out;
}
const seqScansOnBig = (p: PlanNode) => walk(p).filter((n) => n['Node Type'] === 'Seq Scan' && BIG.includes(n['Relation Name']!)).map((n) => n['Relation Name']!);
const indexesUsed = (p: PlanNode) => [...new Set(walk(p).map((n) => n['Index Name']).filter(Boolean) as string[])];
const shape = (p: PlanNode) => walk(p).map((n) => `${n['Node Type']}${n['Relation Name'] ? ':' + n['Relation Name'] : ''}${n['Index Name'] ? '(' + n['Index Name'] + ')' : ''}`).join(' > ');

// ─── report ───

const report: Record<string, string> = {};
const rec = (id: string, v: string) => {
  report[id] = v;
};
afterAll(() => {
  console.log('\n===== PERF-DATA report =====');
  for (const [k, v] of Object.entries(report)) console.log(`${k}: ${v}`);
});

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
async function timeIt(fn: () => Promise<unknown>, n = 5) {
  await fn(); // warm-up
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn();
    xs.push(performance.now() - t);
  }
  return median(xs);
}
const kb = (v: unknown) => Buffer.byteLength(JSON.stringify(v)) / 1024;

// ─── fixtures (existing data only) ───

let cap: CurrentUser;
let officer: CurrentUser;
let boy: CurrentUser;
let SECTION = 0; // largest member section
let RANK = 0;
let PLATOON = 0;
let TARGET = ''; // member without IC → getUserDetail writes no VIEW_SENSITIVE audit row
let YEAR = 0;
let RULES = 0;

beforeAll(async () => {
  cap = await actor('dev.captain');
  officer = await actor('dev.officer');
  boy = await actor('dev.boy');
  const [s] = await db.execute<{ section_id: number; rank_id: number }>(sql`
    select section_id, rank_id from users where account_type='member' and status='active'
    group by section_id, rank_id order by count(*) desc limit 1`).then((r) => r.rows);
  SECTION = Number(s.section_id);
  RANK = Number(s.rank_id);
  const [p] = await db.execute<{ platoon_id: number }>(sql`select platoon_id from users where platoon_id is not null group by 1 order by count(*) desc limit 1`).then((r) => r.rows);
  PLATOON = Number(p.platoon_id);
  // a target that actually has audit + rank history rows, so the detail page does real work
  const [t] = await db.execute<{ id: string }>(sql`
    select u.id from users u where u.account_type='member' and u.id_type='none'
      and exists (select 1 from rank_history h where h.user_id=u.id)
    order by (select count(*) from audit_logs a where a.entity_type='users' and a.entity_id=u.id::text) desc limit 1`).then((r) => r.rows);
  TARGET = t.id;
  YEAR = Number(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 4));
  const [r] = await db.execute<{ n: number }>(sql`select count(*)::int n from sections where age_up_age is not null and is_active`).then((x) => x.rows);
  RULES = Number(r.n);
  const [c] = await db.execute<{ n: number }>(sql`select count(*)::int n from users`).then((x) => x.rows);
  rec('fixture', `users=${c.n} section=${SECTION} rank=${RANK} platoon=${PLATOON} ageUpRules=${RULES}`);
});

// ═══════════════════════════════════════════════════════════════════
describe('1. Index use (EXPLAIN on the real SQL)', () => {
  async function planOf(label: string, q: Q) {
    const { plan, exec } = await explain(q, { analyze: true });
    rec(label, `${shape(plan)} | cost=${plan['Total Cost'].toFixed(0)} exec=${exec?.toFixed(2)}ms`);
    return plan;
  }
  /** index must be usable as a filter: with seqscan disabled, some index on `rel` gets an Index Cond
   *  (a full index scan used only for ordering does not count) */
  async function indexUsable(q: Q, rel: string) {
    const { plan } = await explain(q, { noSeq: true });
    return walk(plan).some((n) => !!n['Index Cond'] && (n['Relation Name'] === rel || (n['Node Type'] === 'Bitmap Index Scan' && !!n['Index Name']?.startsWith(rel))));
  }

  it('PERF-DATA-001 login by username uses users_username_lower_uq; throttle counts use login_attempts indexes', async () => {
    const { queries } = await capture(() => login(`qa.perf.${RUN}.nobody`, 'x', { ip: `qa-perf-${RUN}`, userAgent: 'vitest' }));
    const sel = selects(queries);
    const lookup = sel.find((q) => /from "users"/.test(q.text))!;
    const throttles = sel.filter((q) => /from "login_attempts"/.test(q.text));
    expect(lookup).toBeTruthy();
    expect(throttles.length).toBe(2); // identifier + ip
    const p = await planOf('PERF-DATA-001 username lookup', lookup);
    expect(seqScansOnBig(p)).toEqual([]);
    expect(indexesUsed(p)).toContain('users_username_lower_uq');
    for (const [i, t] of throttles.entries()) {
      const tp = await planOf(`PERF-DATA-001 throttle#${i + 1}`, t);
      expect(seqScansOnBig(tp)).toEqual([]);
    }
  });

  it('PERF-DATA-002 login by IC uses users_id_number_hash_uq', async () => {
    const { queries } = await capture(() => login('990101139999', 'x', { ip: `qa-perf-${RUN}`, userAgent: 'vitest' }));
    const lookup = selects(queries).find((q) => /from "users"/.test(q.text))!;
    const p = await planOf('PERF-DATA-002 IC lookup', lookup);
    expect(indexesUsed(p)).toContain('users_id_number_hash_uq');
  });

  it('PERF-DATA-003 session lookup by token hash uses sessions_token_hash_unique (mirror of session.ts getCurrentUser)', async () => {
    const q = db
      .select({ sessionId: sessions.id, userId: users.id, rankKey: ranks.systemKey })
      .from(sessions)
      .innerJoin(users, eq(users.id, sessions.userId))
      .leftJoin(ranks, eq(ranks.id, users.rankId))
      .where(eq(sessions.tokenHash, sha256('qa-perf-not-a-token')))
      .limit(1)
      .toSQL();
    const p = await planOf('PERF-DATA-003 session lookup', { text: q.sql, values: q.params });
    expect(seqScansOnBig(p)).toEqual([]);
    expect(indexesUsed(p)).toContain('sessions_token_hash_unique');
  });

  it('PERF-DATA-004 member list filtered by section/rank/platoon/status: no seq scan on users', async () => {
    const cases: [string, Parameters<typeof listUsers>[0]][] = [
      ['section', { section: SECTION, pageSize: 50 }],
      ['rank', { rank: RANK, pageSize: 50 }],
      ['platoon', { platoon: PLATOON, pageSize: 50 }],
      ['section+rank+status=inactive', { section: SECTION, rank: RANK, status: 'inactive', pageSize: 50 }],
    ];
    const bad: string[] = [];
    for (const [name, f] of cases) {
      const { queries } = await capture(() => listUsers(f, { canSearchIc: true }));
      for (const [i, q] of selects(queries).entries()) {
        const p = await planOf(`PERF-DATA-004 list[${name}]#${i ? 'count' : 'rows'}`, q);
        if (seqScansOnBig(p).length) {
          // legit only if the filter matches a large share of the table – prove the index is at least usable
          bad.push(`${name}#${i}`);
          expect(await indexUsable(q, 'users')).toBe(true);
        }
      }
    }
    rec('PERF-DATA-004 seq-scan cases', bad.join(', ') || 'none');
  });

  it('PERF-DATA-005 [fixed] default member list (status=active, ORDER BY full_name LIMIT 50) can stop early via an index', async () => {
    // listUsers (lib/server/users/service.ts .orderBy(asc(users.fullName), asc(users.id))) sorts every matching row
    // (Seq Scan + Sort) because there is no index on (full_name, id). Measured with a throw-away index in a
    // rolled-back tx: first page 4.7 ms -> 0.35 ms (Index Scan + Limit). Fix: create index users_full_name_idx on users (full_name, id).
    const { queries } = await capture(() => listUsers({ pageSize: 50 }, { canSearchIc: false }));
    const [rows] = selects(queries);
    const p = await planOf('PERF-DATA-005 default list rows', rows);
    const sortsAll = walk(p).some((n) => n['Node Type'] === 'Sort');
    rec('PERF-DATA-005 needs full sort', String(sortsAll));
    expect(sortsAll, 'no index on users(full_name, id): every page sorts all active members – add one').toBe(false);
  });

  it('PERF-DATA-006 IC search uses users_id_number_hash_uq', async () => {
    const { queries } = await capture(() => listUsers({ q: '990101-13-9999', pageSize: 50 }, { canSearchIc: true }));
    for (const [i, q] of selects(queries).entries()) {
      const p = await planOf(`PERF-DATA-006 IC search#${i}`, q);
      expect(seqScansOnBig(p)).toEqual([]);
      expect(indexesUsed(p)).toContain('users_id_number_hash_uq');
    }
  });

  it('PERF-DATA-007 detail page: audit by entity, rank history, guardians all index-driven', async () => {
    const { queries } = await capture(() => getUserDetail(cap, TARGET, meta));
    const sel = selects(queries);
    const audit = sel.find((q) => /from "audit_logs"/.test(q.text))!;
    const hist = sel.find((q) => /from "rank_history"/.test(q.text))!;
    const guards = sel.find((q) => /from "guardians"/.test(q.text))!;
    // TARGET is the member with the MOST audit rows; for it the planner may walk audit_logs_created_idx backwards
    // (its rows are recent) – that is a valid choice. A typical member (few rows) must use audit_logs_entity_idx.
    const pa = await planOf('PERF-DATA-007 audit by entity (heaviest member)', audit);
    expect(seqScansOnBig(pa)).toEqual([]);
    const [rare] = (await db.execute<{ id: string }>(sql`
      select entity_id id from audit_logs where entity_type='users' group by 1 order by count(*), max(created_at) limit 1`)).rows;
    const rareQ = { text: audit.text, values: audit.values.map((v) => (v === TARGET ? rare.id : v)) };
    const pr = await planOf('PERF-DATA-007 audit by entity (typical member)', rareQ);
    expect(seqScansOnBig(pr)).toEqual([]);
    expect(indexesUsed(pr)).toContain('audit_logs_entity_idx');
    const ph = await planOf('PERF-DATA-007 rank history', hist);
    expect(seqScansOnBig(ph)).toEqual([]);
    const pg2 = await planOf('PERF-DATA-007 guardians', guards);
    expect(seqScansOnBig(pg2)).toEqual([]);
  });

  it('PERF-DATA-008 scoreboard: scores by activity use platoon_scores_pk (tiny table → checked with seqscan off)', async () => {
    const { queries } = await capture(() => scoreboard(YEAR));
    const sel = selects(queries);
    const scores = sel.find((q) => /from "platoon_scores"/.test(q.text));
    const acts = sel.find((q) => /from "platoon_activities"/.test(q.text) && /extract\(year/.test(q.text))!;
    if (scores) {
      await planOf('PERF-DATA-008 scores natural', scores);
      expect(await indexUsable(scores, 'platoon_scores')).toBe(true);
    }
    const pa = await planOf('PERF-DATA-008 activities by year', acts);
    // Informational: extract(year from activity_date) = $1 is not sargable, so platoon_activities_date_idx can never
    // filter. Table is ~50 rows/year, so a full scan stays sub-millisecond; not failed. Fix if it grows:
    // activity_date >= make_date(y,1,1) and activity_date < make_date(y+1,1,1).
    const usable = await indexUsable(acts, 'platoon_activities');
    rec('PERF-DATA-008 activity date index usable as filter', `${usable} (cost ${pa['Total Cost'].toFixed(0)})`);
    expect(pa['Total Cost']).toBeLessThan(1000);
  });

  it('PERF-DATA-009 permission load (user_roles / rank_permissions / overrides) uses PK indexes', async () => {
    const { queries } = await capture(() => loadPermissions(boy.id));
    const bad: string[] = [];
    for (const [i, q] of selects(queries).entries()) {
      const p = await planOf(`PERF-DATA-009 perm#${i}`, q);
      if (seqScansOnBig(p).length) bad.push(String(i));
      for (const rel of ['user_roles', 'user_permission_overrides', 'rank_permissions']) {
        if (walk(p).some((n) => n['Relation Name'] === rel && n['Node Type'] === 'Seq Scan')) {
          // these tables are small; prove an index is usable
          expect(await indexUsable(q, rel), `${rel} in perm#${i}`).toBe(true);
        }
      }
    }
    expect(bad).toEqual([]);
  });

  it('PERF-DATA-010 ageUpCandidates member query', async () => {
    const { queries } = await capture(() => ageUpCandidates('all'));
    const memberQs = selects(queries).filter((q) => /from "users"/.test(q.text));
    for (const [i, q] of memberQs.entries()) {
      const p = await planOf(`PERF-DATA-010 ageUp#${i}`, q);
      if (seqScansOnBig(p).length) expect(await indexUsable(q, 'users')).toBe(true);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('2. Query counts / N+1', () => {
  async function count(label: string, fn: () => Promise<unknown>) {
    const { queries } = await capture(fn);
    const data = queries.filter((q) => !isTxControl(q.text));
    rec(label, `${data.length} queries (+${queries.length - data.length} tx control)`);
    return data.length;
  }

  it('PERF-DATA-011 listUsers page of 50 = 2 queries, same for page of 10 (not per row)', async () => {
    const n50 = await count('PERF-DATA-011 listUsers(50)', () => listUsers({ pageSize: 50 }, { canSearchIc: false }));
    const n10 = await count('PERF-DATA-011 listUsers(10)', () => listUsers({ pageSize: 10 }, { canSearchIc: false }));
    expect(n50).toBeLessThanOrEqual(2);
    expect(n50).toBe(n10);
  });

  it('PERF-DATA-012 getUserDetail: constant, captain ≤ 6, permission-based officer ≤ 10', async () => {
    expect(await count('PERF-DATA-012 getUserDetail(captain)', () => getUserDetail(cap, TARGET, meta))).toBeLessThanOrEqual(6);
    expect(await count('PERF-DATA-012 getUserDetail(dev.officer)', () => getUserDetail(officer, TARGET, meta))).toBeLessThanOrEqual(10);
  });

  it('PERF-DATA-013 loadPermissions / getPermissionsFor ≤ 4', async () => {
    expect(await count('PERF-DATA-013 loadPermissions(dev.boy)', () => loadPermissions(boy.id))).toBeLessThanOrEqual(4);
    expect(await count('PERF-DATA-013 getPermissionsFor(dev.boy)', () => getPermissionsFor(boy))).toBeLessThanOrEqual(4);
    expect(await count('PERF-DATA-013 getPermissionsFor(captain)', () => getPermissionsFor(cap))).toBe(0);
  });

  it('PERF-DATA-014 memberScope ≤ 6 for a section member, 0 for captain', async () => {
    expect(await count('PERF-DATA-014 memberScope(dev.boy)', () => memberScope(boy))).toBeLessThanOrEqual(6);
    expect(await count('PERF-DATA-014 memberScope(captain)', () => memberScope(cap))).toBe(0);
  });

  it('PERF-DATA-015 scoreboard(year) ≤ 4 regardless of activity count', async () => {
    expect(await count('PERF-DATA-015 scoreboard', () => scoreboard(YEAR))).toBeLessThanOrEqual(4);
  });

  it('PERF-DATA-016 listPlatoons ≤ 5', async () => {
    expect(await count('PERF-DATA-016 listPlatoons', () => listPlatoons())).toBeLessThanOrEqual(5);
  });

  it('PERF-DATA-017 ageUpCandidates = 1 + one query per age-up rule (bounded by #sections, not #members)', async () => {
    const n = await count('PERF-DATA-017 ageUpCandidates', () => ageUpCandidates('all'));
    expect(n).toBeLessThanOrEqual(1 + RULES);
  });

  it('PERF-DATA-018 listOrg ≤ 3', async () => {
    expect(await count('PERF-DATA-018 listOrg', () => listOrg())).toBeLessThanOrEqual(3);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('3. Payload size', () => {
  const HEAVY = ['passwordHash', 'idNumberEnc', 'idNumberHash', 'idNumber', 'address', 'email'];

  it('PERF-DATA-019 listUsers(50) is small and selects no secret/heavy columns', async () => {
    const { result, queries } = await capture(() => listUsers({ pageSize: 50 }, { canSearchIc: true }));
    const size = kb(result);
    rec('PERF-DATA-019 listUsers(50) JSON', `${size.toFixed(1)} KB, ${result.rows.length} rows, keys=${Object.keys(result.rows[0]).length}`);
    expect(result.rows.length).toBe(50);
    expect(size).toBeLessThan(50);
    for (const k of HEAVY) expect(Object.keys(result.rows[0])).not.toContain(k);
    const rowsSql = selects(queries)[0].text;
    expect(rowsSql).not.toMatch(/"id_number_enc"|"id_number_hash"\s*(,|from)|"address"/);
    expect(rowsSql).not.toMatch(/"password_hash"\s*(,|from)/); // only used inside IS NOT NULL
  });

  it('PERF-DATA-020 [fixed] scoreboard / ageUpCandidates / listPlatoons < 200 KB (ageUpCandidates unbounded)', async () => {
    const sb = kb(await scoreboard(YEAR));
    const au = await ageUpCandidates('all');
    const auKb = kb(au);
    const pl = kb(await listPlatoons());
    const members = au.groups.reduce((n, g) => n + g.members.length, 0);
    rec('PERF-DATA-020 sizes', `scoreboard=${sb.toFixed(1)}KB ageUp=${auKb.toFixed(1)}KB (${members} members) listPlatoons=${pl.toFixed(1)}KB`);
    expect(sb).toBeLessThan(200);
    expect(pl).toBeLessThan(200);
    expect(auKb, '[finding] ageUpCandidates is unbounded (no limit/paging)').toBeLessThan(200);
  });
});

// ═══════════════════════════════════════════════════════════════════
describe('4. Timing (median of 5, informational, < 500 ms)', () => {
  let ip = 0;
  const cases: [string, () => Promise<unknown>][] = [
    ['listUsers default', () => listUsers({ pageSize: 50 }, { canSearchIc: false })],
    ['listUsers search "qa"', () => listUsers({ q: 'qa', pageSize: 50 }, { canSearchIc: false })],
    ['listUsers search miss', () => listUsers({ q: 'zzqqxx', pageSize: 50 }, { canSearchIc: false })],
    ['listUsers filters', () => listUsers({ section: SECTION, rank: RANK, status: 'all', pageSize: 50 }, { canSearchIc: false })],
    ['listUsers last page', () => listUsers({ page: 70, pageSize: 50 }, { canSearchIc: false })],
    ['login failure (no argon2)', () => login(`qa.perf.${RUN}.t${++ip}`, 'x', { ip: `qa-perf-${RUN}-${ip}`, userAgent: 'vitest' })],
    ['scoreboard', () => scoreboard(YEAR)],
    ['ageUpCandidates', () => ageUpCandidates('all')],
    ['getUserDetail', () => getUserDetail(cap, TARGET, meta)],
  ];
  for (const [i, [name, fn]] of cases.entries()) {
    it(`PERF-DATA-${String(21 + i).padStart(3, '0')} ${name}`, async () => {
      const ms = await timeIt(fn);
      rec(`PERF-DATA-${String(21 + i).padStart(3, '0')} ${name}`, `${ms.toFixed(1)} ms`);
      expect(ms).toBeLessThan(500);
    });
  }
});

// ═══════════════════════════════════════════════════════════════════
describe('5. Missing indexes on FK columns', () => {
  type Fk = { tbl: string; conname: string; cols: string[] };
  let fks: Fk[] = [];
  let idx: { tbl: string; cols: string[] }[] = [];
  const covered = (tbl: string, cols: string[]) =>
    idx.some((i) => i.tbl === tbl && i.cols.length >= cols.length && cols.every((c) => i.cols.slice(0, cols.length).includes(c)));

  beforeAll(async () => {
    fks = (await db.execute<Fk>(sql`
      select c.conrelid::regclass::text tbl, c.conname, array_agg(a.attname::text order by k.ord) cols
      from pg_constraint c cross join lateral unnest(c.conkey) with ordinality k(attnum, ord)
      join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.attnum
      where c.contype = 'f' and c.connamespace = 'public'::regnamespace
      group by 1, 2 order by 1, 2`)).rows;
    idx = (await db.execute<{ tbl: string; cols: string[] }>(sql`
      select i.indrelid::regclass::text tbl,
             array(select coalesce(a.attname::text, '<expr>') from unnest(i.indkey::int2[]) with ordinality k(attnum, ord)
                   left join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum order by k.ord) cols
      from pg_index i join pg_class c on c.oid = i.indrelid
      where c.relnamespace = 'public'::regnamespace`)).rows;
  });

  it('PERF-DATA-030 hot FK / lookup columns all have a leading index', () => {
    const hot: [string, string[]][] = [
      ['users', ['section_id']], ['users', ['rank_id']], ['users', ['platoon_id']],
      ['guardians', ['user_id']], ['user_roles', ['user_id']], ['user_roles', ['role_id']],
      ['user_permission_overrides', ['user_id']], ['rank_history', ['user_id']],
      ['platoon_scores', ['activity_id']], ['audit_logs', ['actor_id']], ['audit_logs', ['entity_type', 'entity_id']],
      ['sessions', ['user_id']], ['sessions', ['token_hash']],
    ];
    const missing = hot.filter(([t, c]) => !covered(t, c)).map(([t, c]) => `${t}(${c})`);
    rec('PERF-DATA-030 hot columns missing index', missing.join(', ') || 'none');
    expect(missing).toEqual([]);
  });

  it('PERF-DATA-031 inventory: every FK without a covering index (informational)', async () => {
    const missing = fks.filter((f) => !covered(f.tbl, f.cols)).map((f) => `${f.tbl}(${f.cols.join(',')})`);
    rec('PERF-DATA-031 FKs without index', `${missing.length}: ${missing.join(', ')}`);
    const unused = (await db.execute<{ idx: string; scans: number }>(sql`
      select indexrelname idx, idx_scan::int scans from pg_stat_user_indexes where schemaname='public' and idx_scan = 0 order by 1`)).rows;
    rec('PERF-DATA-031 indexes never scanned (since stats reset)', unused.map((u) => u.idx).join(', ') || 'none');
    // advisory only: no hard deletes exist, so an unindexed FK only costs on parent-key updates (never happen)
    expect(Array.isArray(missing)).toBe(true);
  });
});

