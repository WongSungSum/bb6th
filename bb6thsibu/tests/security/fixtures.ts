import { readFileSync } from 'node:fs';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import {
  inactiveReasons, ranks, roles, sections, sessions, userPermissionOverrides, userRoles, users,
} from '@/lib/db/schema';
import { createSession, type CurrentUser } from '@/lib/server/auth/session';
import { hashPassword } from '@/lib/server/auth/password';
import { createUser } from '@/lib/server/users/service';
import type { PermissionSlug } from '@/lib/server/authz/catalog';

export const QA_PW = 'QaSec-Pass-2026-x1';
export const DEV_PW = /DEV_PASSWORD = '([^']+)'/.exec(
  readFileSync(path.resolve(__dirname, '../seed-test-accounts.ts'), 'utf8'),
)![1];
export const BASE = 'http://localhost:3000';
export const VICTIM_IC = '991231135599';

export const rand = (n = 5) => Math.random().toString(36).slice(2, 2 + n).replace(/[^a-z0-9]/g, 'x');
export const meta = (tag = 'qa') => ({ ip: `${tag}-${rand(8)}`, userAgent: 'vitest' });

export async function loadCU(username: string): Promise<CurrentUser> {
  const [r] = await db
    .select({
      id: users.id, username: users.username, fullName: users.fullName, accountType: users.accountType,
      sectionId: users.sectionId, rankId: users.rankId, mustChange: users.mustChangePassword, key: ranks.systemKey,
    })
    .from(users)
    .leftJoin(ranks, eq(ranks.id, users.rankId))
    .where(eq(users.username, username));
  if (!r) throw new Error('missing user ' + username);
  return {
    id: r.id, sessionId: 'test', username: r.username, fullName: r.fullName, accountType: r.accountType,
    isSuperadmin: r.accountType === 'superadmin', isCaptain: r.key === 'captain',
    mustChangePassword: r.mustChange, sectionId: r.sectionId, rankId: r.rankId,
  };
}

export async function orgIds() {
  const secs = await db.select().from(sections);
  const rks = await db.select().from(ranks);
  const sec = (n: string) => secs.find((s) => s.name === n)!.id;
  const rk = (s: string, n: string) => rks.find((r) => r.sectionId === sec(s) && r.name === n)!.id;
  return {
    sec, rk,
    captainRankId: rks.find((r) => r.systemKey === 'captain')!.id,
    officer: sec('Officer'), junior: sec('Junior'),
  };
}

export async function reasonId(name = 'Left company') {
  const [r] = await db.select().from(inactiveReasons).where(eq(inactiveReasons.name, name));
  return r.id;
}

export function validCreate(over: Record<string, unknown> = {}) {
  return {
    username: 'qa.sec.' + rand(8), email: 'qa@example.test', fullName: 'QA Sec Person', gender: 'male',
    dateOfBirth: '2012-05-05', joinDate: '2022-01-01', phone: '+60123456789', address: null, school: null,
    idType: 'none', sectionId: 0, rankId: 0, guardians: [], ...over,
  } as any;
}

export function validUpdate(over: Record<string, unknown> = {}) {
  return {
    username: 'qa.sec.victim', email: 'qa@example.test', fullName: 'QA Victim', gender: 'male',
    dateOfBirth: '2012-05-05', joinDate: '2022-01-01', phone: '+60123456789', address: null, school: null,
    guardians: [], ...over,
  } as any;
}

let pwHash: string | undefined;
const MGR_PERMS: PermissionSlug[] = [
  'users.view', 'users.create', 'users.update', 'users.update_status', 'users.change_rank', 'users.reset_password', 'users.view_sensitive',
];

type Spec = {
  section: 'Officer' | 'Junior'; rank: string; perms?: PermissionSlug[]; ic?: string; guardian?: boolean;
  nullPw?: boolean; mustChange?: boolean; roleNames?: string[]; deny?: PermissionSlug[]; fullName?: string; address?: string;
};

const SPECS: Record<string, Spec> = {
  mgr: { section: 'Officer', rank: 'Helper', perms: MGR_PERMS },
  peer: { section: 'Officer', rank: 'Staff Sergeant', perms: ['audit.view', 'users.view'] },
  victim: { section: 'Junior', rank: 'Member', ic: VICTIM_IC, guardian: true },
  user1: { section: 'Junior', rank: 'Member' },
  nopw: { section: 'Junior', rank: 'Member', nullPw: true },
  temp: { section: 'Officer', rank: 'Helper', perms: MGR_PERMS, mustChange: true },
  role1: { section: 'Junior', rank: 'Member', roleNames: ['Member Viewer'] },
  role2: { section: 'Junior', rank: 'Member', roleNames: ['Member Viewer', 'Member Admin'] },
  deny: { section: 'Junior', rank: 'Member', roleNames: ['Member Viewer'], deny: ['users.view'] },
  allowonly: { section: 'Junior', rank: 'Member', perms: ['users.reset_password'] },
  chg: { section: 'Junior', rank: 'Member' },
  rst: { section: 'Junior', rank: 'Member' },
  race: { section: 'Junior', rank: 'Member' },
  deact: { section: 'Junior', rank: 'Member' },
  cap: { section: 'Junior', rank: 'Member' },
  rehash: { section: 'Junior', rank: 'Member' },
  xss: { section: 'Junior', rank: 'Member', fullName: '<script>alert(1)</script><img src=x onerror=alert(1)>', address: '"><svg onload=alert(1)>' },
};

/** Idempotently create/reset a qa.sec.<name> fixture user. Returns its CurrentUser. */
export async function ensureUser(name: string): Promise<CurrentUser> {
  const spec = SPECS[name];
  const username = `qa.sec.${name}`;
  const org = await orgIds();
  pwHash ??= await hashPassword(QA_PW);
  let [row] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
  if (!row) {
    const captain = await loadCU('dev.captain');
    const input = validCreate({
      username, fullName: spec.fullName ?? `QA Sec ${name}`, address: spec.address ?? null,
      sectionId: org.sec(spec.section), rankId: org.rk(spec.section, spec.rank), tempPassword: QA_PW,
      idType: spec.ic ? 'mykad' : 'none', idNumber: spec.ic,
      guardians: spec.guardian ? [{ name: 'QA Guardian', relationship: 'father', phone: '+60111222333', email: '' }] : [],
    });
    const res = await createUser(captain, input, meta('fixture'));
    row = { id: res!.id };
  }
  await db
    .update(users)
    .set({
      passwordHash: spec.nullPw ? null : pwHash, mustChangePassword: !!spec.mustChange, status: 'active',
      inactiveReasonId: null, inactiveNote: null, failedLoginCount: 0, lockedUntil: null,
      sectionId: org.sec(spec.section), rankId: org.rk(spec.section, spec.rank),
      fullName: spec.fullName ?? `QA Sec ${name}`, address: spec.address ?? null,
    })
    .where(eq(users.id, row.id));
  for (const p of spec.perms ?? []) {
    await db.insert(userPermissionOverrides).values({ userId: row.id, permissionSlug: p, effect: 'allow', reason: 'qa.sec fixture' })
      .onConflictDoUpdate({ target: [userPermissionOverrides.userId, userPermissionOverrides.permissionSlug], set: { effect: 'allow' } });
  }
  for (const p of spec.deny ?? []) {
    await db.insert(userPermissionOverrides).values({ userId: row.id, permissionSlug: p, effect: 'deny', reason: 'qa.sec fixture' })
      .onConflictDoUpdate({ target: [userPermissionOverrides.userId, userPermissionOverrides.permissionSlug], set: { effect: 'deny' } });
  }
  for (const rn of spec.roleNames ?? []) {
    const [role] = await db.select().from(roles).where(eq(roles.name, rn));
    if (role) await db.insert(userRoles).values({ userId: row.id, roleId: role.id }).onConflictDoNothing();
  }
  return loadCU(username);
}

/** Fresh random user (lockout/timing tests cannot reuse names because login_attempts is permanent). */
export async function freshUser(tag: string, opts: { ic?: string } = {}) {
  const org = await orgIds();
  const captain = await loadCU('dev.captain');
  const username = `qa.sec.${tag}${rand(5)}`;
  const res = await createUser(
    captain,
    validCreate({
      username, sectionId: org.junior, rankId: org.rk('Junior', 'Member'), tempPassword: QA_PW,
      idType: opts.ic ? 'mykad' : 'none', idNumber: opts.ic,
      guardians: [{ name: 'QA Guardian', relationship: 'father', phone: '+60111222333', email: '' }],
    }),
    meta('fixture'),
  );
  await db.update(users).set({ mustChangePassword: false }).where(eq(users.id, res!.id));
  return { id: res!.id, username };
}

export async function mint(userId: string): Promise<string> {
  const s = await db.transaction((tx) => createSession(tx, userId, { ip: 'qa-mint', userAgent: 'vitest' }));
  return s.token;
}

export async function sessionRow(token: string) {
  const { sha256 } = await import('@/lib/server/auth/crypto');
  const [r] = await db.select().from(sessions).where(eq(sessions.tokenHash, sha256(token)));
  return r;
}

export async function setSession(token: string, patch: Partial<typeof sessions.$inferInsert>) {
  const { sha256 } = await import('@/lib/server/auth/crypto');
  await db.update(sessions).set(patch).where(eq(sessions.tokenHash, sha256(token)));
}

export async function userRow(id: string) {
  const [r] = await db.select().from(users).where(eq(users.id, id));
  return r;
}

export async function redirectOf(p: Promise<unknown>): Promise<string | null> {
  try {
    await p;
    return null;
  } catch (e: any) {
    const d = String(e?.digest ?? '');
    return d.startsWith('NEXT_REDIRECT') ? d.split(';')[2] : `ERR:${e?.message}`;
  }
}

export function errText(e: any): string {
  return [e?.message, e?.cause?.message, e?.cause?.detail].filter(Boolean).join(' | ');
}

class Rollback extends Error {}
/** Run a raw statement in a transaction that is always rolled back. Returns error text if it failed. */
export async function probe(fn: (tx: any) => Promise<unknown>): Promise<{ failed: boolean; text: string }> {
  try {
    await db.transaction(async (tx) => {
      await fn(tx);
      throw new Rollback();
    });
    return { failed: false, text: '' };
  } catch (e: any) {
    if (e instanceof Rollback) return { failed: false, text: '' };
    return { failed: true, text: errText(e) };
  }
}

export async function revokeQaSessions() {
  await db.execute(sql`update sessions set revoked_at = now() where revoked_at is null and user_id in (select id from users where username like 'qa.sec.%')`);
}

export async function closeDb() {
  try {
    await (globalThis as any).pgPool?.end();
  } catch {}
}

export { and, eq };
