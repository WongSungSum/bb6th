import { randomInt, randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { inactiveReasons, ranks, sections, users } from '@/lib/db/schema';
import type { CurrentUser } from '@/lib/server/auth/session';
import type { RequestMeta } from '@/lib/server/request';
import { createUser } from '@/lib/server/users/service';
import type { CreateUserInput } from '@/lib/validation/users';

export const meta: RequestMeta = { ip: 'test', userAgent: 'vitest' };
export const PW = 'Qa-Fn-Temp-Pass-2026!';

export async function actor(username: string): Promise<CurrentUser> {
  const [u] = await db
    .select({
      id: users.id, username: users.username, fullName: users.fullName, accountType: users.accountType,
      mustChangePassword: users.mustChangePassword, sectionId: users.sectionId, rankId: users.rankId, rankKey: ranks.systemKey,
    })
    .from(users)
    .leftJoin(ranks, eq(ranks.id, users.rankId))
    .where(eq(users.username, username));
  if (!u) throw new Error(`dev account ${username} missing - run npm run db:seed:dev`);
  return {
    id: u.id, sessionId: 'test', username: u.username, fullName: u.fullName, accountType: u.accountType,
    isSuperadmin: u.accountType === 'superadmin', isCaptain: u.rankKey === 'captain',
    mustChangePassword: u.mustChangePassword, sectionId: u.sectionId, rankId: u.rankId,
  };
}

export async function rankId(section: string, rank: string) {
  const [r] = await db
    .select({ id: ranks.id, sectionId: ranks.sectionId })
    .from(ranks)
    .innerJoin(sections, eq(sections.id, ranks.sectionId))
    .where(and(eq(sections.name, section), eq(ranks.name, rank)));
  if (!r) throw new Error(`rank ${section}/${rank} missing`);
  return r;
}

export async function reasonId(name: string) {
  const [r] = await db.select({ id: inactiveReasons.id }).from(inactiveReasons).where(eq(inactiveReasons.name, name));
  if (!r) throw new Error(`reason ${name} missing`);
  return r.id;
}

export const RUN = randomUUID().slice(0, 6);
let seq = 0;
export const uname = (tag = 'u') => `qa.fn.${RUN}.${tag}${++seq}`;
/** unique 12-digit MyKad-looking number per call */
export const newIc = () => `9${String(randomInt(0, 1e11)).padStart(11, '0')}`;

export function isoDate(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 864e5);
  return d.toISOString().slice(0, 10);
}

export async function baseInput(over: Partial<CreateUserInput> = {}): Promise<CreateUserInput> {
  const jr = await rankId('Junior', 'Member');
  return {
    username: uname(), email: 'qa.fn@example.test', idType: 'none', fullName: `QA FN ${RUN} Boy`, gender: 'male',
    dateOfBirth: '2012-05-05', joinDate: '2022-01-01', sectionId: jr.sectionId, rankId: jr.id, guardians: [], ...over,
  } as CreateUserInput;
}

export const guardian = (over: Record<string, unknown> = {}) => ({ name: 'QA Guardian', relationship: 'father' as const, phone: '0123456789', email: 'g@example.test', ...over }) as { name: string; relationship: 'father' | 'mother' | 'guardian' | 'other'; phone: string; email: string };

/** Create a member as captain and return id + input. */
export async function makeUser(cap: CurrentUser, over: Partial<CreateUserInput> = {}) {
  const input = await baseInput(over);
  const res = await createUser(cap, input, meta);
  return { id: res!.id, input };
}

export async function err(fn: () => Promise<unknown>) {
  try {
    await fn();
    return null;
  } catch (e) {
    return e as { code?: string; message: string; fieldErrors?: Record<string, string> };
  }
}
