import { and, asc, eq, ne, sql } from 'drizzle-orm';
import { db, type Tx } from '@/lib/db/client';
import { platoons, ranks, sections, users } from '@/lib/db/schema';
import type { CurrentUser } from '@/lib/server/auth/session';
import { auditSnapshot, writeAudit } from '@/lib/server/audit';
import { AppError, forbidden } from '@/lib/server/errors';
import type { RequestMeta } from '@/lib/server/request';
import { cleanName } from '@/lib/validation/text';

/*
 * 组别与军阶维护：只有 Captain 和 Superadmin（不开放给权限设定）。
 * 不删除，只停用；有在职成员使用中的不能停用；系统组别（Officer）与系统军阶（Captain）受数据库保护。
 */

export function assertOrgAdmin(actor: CurrentUser) {
  if (!actor.isCaptain && !actor.isSuperadmin) throw forbidden();
}

const isSmallId = (n: number) => Number.isInteger(n) && n > 0 && n <= 32767;
const nameOf = (v: unknown) => {
  const r = cleanName(v);
  if ('error' in r) throw new AppError('VALIDATION', 'Please fix the highlighted fields.', { name: r.error === 'empty' ? 'Enter a name.' : r.error });
  const name = r.name;
  if (name.length > 40) throw new AppError('VALIDATION', 'Please fix the highlighted fields.', { name: 'Use at most 40 characters.' });
  return name;
};
/** 名称不分大小写不能重复（同一组别内的军阶） */
async function assertUniqueName(tx: Tx, kind: 'section' | 'rank', name: string, exceptId?: number, sectionId?: number) {
  // 同时建立同名（只差大小写）的请求排队，否则两边都会通过检查
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`name:${kind}:${sectionId ?? ''}:${name.toLowerCase()}`}))`);
  const [dup] = kind === 'section'
    ? await tx.select({ id: sections.id }).from(sections).where(and(sql`lower(${sections.name}) = lower(${name})`, exceptId ? ne(sections.id, exceptId) : undefined))
    : await tx.select({ id: ranks.id }).from(ranks).where(and(eq(ranks.sectionId, sectionId!), sql`lower(${ranks.name}) = lower(${name})`, exceptId ? ne(ranks.id, exceptId) : undefined));
  if (dup) throw dupError();
}
/** 只接受真正的 true/false，其他值一律视为输入错误 */
const activeOf = (v: unknown, current: boolean) => {
  if (v === undefined) return current;
  if (typeof v !== 'boolean') throw new AppError('VALIDATION', 'Invalid value.');
  return v;
};
const dupError = () => new AppError('VALIDATION', 'Please fix the highlighted fields.', { name: 'This name is already used.' });

export async function listOrg() {
  const [secs, rks, counts] = await Promise.all([
    db.select().from(sections).orderBy(asc(sections.sortOrder), asc(sections.id)),
    db.select().from(ranks).orderBy(asc(ranks.sortOrder), asc(ranks.id)),
    db
      .select({ rankId: users.rankId, n: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.status, 'active'), eq(users.accountType, 'member')))
      .groupBy(users.rankId),
  ]);
  const activeCount = (rankId: number) => counts.find((c) => c.rankId === rankId)?.n ?? 0;
  return secs.map((s) => {
    const list = rks.filter((r) => r.sectionId === s.id).map((r) => ({
      id: r.id, name: r.name, isActive: r.isActive, isSystem: !!r.systemKey, activeMembers: activeCount(r.id),
    }));
    return {
      id: s.id, name: s.name, isActive: s.isActive, isSystem: !!s.systemKey,
      ageUp: s.ageUpAge !== null && s.ageUpRankId !== null ? { age: s.ageUpAge, rankId: s.ageUpRankId } : null,
      activeMembers: list.reduce((a, r) => a + r.activeMembers, 0),
      ranks: list,
    };
  });
}
export type OrgSection = Awaited<ReturnType<typeof listOrg>>[number];

function mapDup(err: unknown): never {
  const c = err as { cause?: { constraint?: string; code?: string }; constraint?: string; code?: string };
  const constraint = c.constraint ?? c.cause?.constraint;
  if (constraint === 'sections_name_unique' || constraint === 'ranks_section_name_uq') throw dupError();
  if ((c.code ?? c.cause?.code) === '23001') throw new AppError('FORBIDDEN', 'System sections and ranks cannot be renamed or deactivated.');
  throw err;
}

async function nextSort(tx: Tx, table: typeof sections | typeof ranks, sectionId?: number) {
  const where = sectionId ? eq(ranks.sectionId, sectionId) : undefined;
  const [{ m }] = await tx.select({ m: sql<number>`coalesce(max(${table.sortOrder}), -1)::int` }).from(table).where(where);
  return m + 1;
}

export async function createSection(actor: CurrentUser, input: { name: unknown }, meta: RequestMeta) {
  assertOrgAdmin(actor);
  const name = nameOf(input.name);
  try {
    return await db.transaction(async (tx) => {
      await assertUniqueName(tx, 'section', name);
      const [row] = await tx.insert(sections).values({ name, sortOrder: await nextSort(tx, sections) }).returning();
      await writeAudit(tx, { actorId: actor.id, meta }, { action: 'SECTION_CREATED', entityType: 'sections', entityId: String(row.id), after: auditSnapshot(row, ['name', 'sortOrder', 'isActive']) });
      return { id: row.id };
    });
  } catch (err) {
    mapDup(err);
  }
}

export async function createRank(actor: CurrentUser, input: { sectionId: unknown; name: unknown }, meta: RequestMeta) {
  assertOrgAdmin(actor);
  const name = nameOf(input.name);
  const sectionId = Number(input.sectionId);
  if (!isSmallId(sectionId)) throw new AppError('NOT_FOUND', 'Section not found.');
  try {
    return await db.transaction(async (tx) => {
      const [sec] = await tx.select().from(sections).where(eq(sections.id, sectionId));
      if (!sec) throw new AppError('NOT_FOUND', 'Section not found.');
      if (!sec.isActive) throw new AppError('VALIDATION', 'Reactivate this section first.');
      await assertUniqueName(tx, 'rank', name, undefined, sectionId);
      const [row] = await tx.insert(ranks).values({ sectionId, name, sortOrder: await nextSort(tx, ranks, sectionId) }).returning();
      await writeAudit(tx, { actorId: actor.id, meta }, { action: 'RANK_CREATED', entityType: 'ranks', entityId: String(row.id), after: auditSnapshot(row, ['name', 'sectionId', 'sortOrder', 'isActive']) });
      return { id: row.id };
    });
  } catch (err) {
    mapDup(err);
  }
}

/** 改名 / 停用 / 启用 */
export async function updateSection(actor: CurrentUser, id: number, input: { name?: unknown; isActive?: unknown }, meta: RequestMeta) {
  assertOrgAdmin(actor);
  if (!isSmallId(id)) throw new AppError('NOT_FOUND', 'Section not found.');
  try {
    return await db.transaction(async (tx) => {
      const [before] = await tx.select().from(sections).where(eq(sections.id, id)).for('update');
      if (!before) throw new AppError('NOT_FOUND', 'Section not found.');
      const name = input.name === undefined ? before.name : nameOf(input.name);
      const isActive = activeOf(input.isActive, before.isActive);
      if (name === before.name && isActive === before.isActive) throw new AppError('VALIDATION', 'Nothing has changed.');
      if (before.systemKey && (name !== before.name || !isActive)) throw new AppError('FORBIDDEN', 'The Officer section cannot be renamed or deactivated.');
      if (name !== before.name) await assertUniqueName(tx, 'section', name, id);
      if (!isActive && before.isActive) {
        const [inUse] = await tx.select({ id: users.id }).from(users).where(and(eq(users.sectionId, id), eq(users.status, 'active'))).limit(1);
        if (inUse) throw new AppError('VALIDATION', 'Move or deactivate the active members in this section first.');
        const [activeRank] = await tx.select({ id: ranks.id }).from(ranks).where(and(eq(ranks.sectionId, id), eq(ranks.isActive, true))).limit(1);
        if (activeRank) throw new AppError('VALIDATION', 'Deactivate the ranks in this section first.');
        const [activePlatoon] = await tx.select({ id: platoons.id }).from(platoons).where(and(eq(platoons.sectionId, id), eq(platoons.isActive, true))).limit(1);
        if (activePlatoon) throw new AppError('VALIDATION', 'Deactivate the platoons in this section first.');
      }
      const [after] = await tx.update(sections).set({ name, isActive, updatedAt: new Date() }).where(eq(sections.id, id)).returning();
      await writeAudit(tx, { actorId: actor.id, meta }, {
        action: isActive !== before.isActive ? (isActive ? 'SECTION_REACTIVATED' : 'SECTION_DEACTIVATED') : 'SECTION_RENAMED',
        entityType: 'sections', entityId: String(id),
        before: auditSnapshot(before, ['name', 'isActive']), after: auditSnapshot(after, ['name', 'isActive']),
      });
    });
  } catch (err) {
    mapDup(err);
  }
}

/**
 * 到龄升组设定：当年满 age 岁的在职成员会列入 Promotions 的到龄名单，由军官确认后升到 rankId。
 * age 为 null = 关闭。目标军阶必须启用、在另一个启用中的组别、不能是 Officer 组别。
 */
export async function setAgeUp(actor: CurrentUser, sectionId: number, input: { age?: unknown; rankId?: unknown } | null, meta: RequestMeta) {
  assertOrgAdmin(actor);
  if (!isSmallId(sectionId)) throw new AppError('NOT_FOUND', 'Section not found.');
  // 只有明确送 null / '' 才是关闭；没送（例如空的请求）当作输入错误，避免误关
  if (input?.age === undefined) throw new AppError('VALIDATION', 'Please fix the highlighted fields.', { age: 'Choose an age or Off.' });
  const off = input.age === null || input.age === '';
  const age = off ? null : Number(input.age);
  const rankId = off ? null : Number(input.rankId);
  const errors: Record<string, string> = {};
  if (age !== null && (!Number.isInteger(age) || age < 4 || age > 25)) errors.age = 'Use a whole number from 4 to 25.';
  if (age !== null && !isSmallId(rankId!)) errors.rankId = 'Select the rank they move up to.';
  if (Object.keys(errors).length) throw new AppError('VALIDATION', 'Please fix the highlighted fields.', errors);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(sections).where(eq(sections.id, sectionId)).for('update');
    if (!before) throw new AppError('NOT_FOUND', 'Section not found.');
    if (before.systemKey) throw new AppError('FORBIDDEN', 'The Officer section does not move up by age.');
    if (rankId !== null) {
      const [r] = await tx
        .select({ sectionId: ranks.sectionId, isActive: ranks.isActive, systemKey: ranks.systemKey, sectionActive: sections.isActive, sectionKey: sections.systemKey })
        .from(ranks)
        .innerJoin(sections, eq(sections.id, ranks.sectionId))
        .where(eq(ranks.id, rankId));
      if (!r || !r.isActive || !r.sectionActive || r.systemKey || r.sectionKey || r.sectionId === sectionId) {
        throw new AppError('VALIDATION', 'Please fix the highlighted fields.', { rankId: 'Choose an active rank in another section (not Officer).' });
      }
    }
    if (before.ageUpAge === age && before.ageUpRankId === rankId) throw new AppError('VALIDATION', 'Nothing has changed.');
    const [after] = await tx.update(sections).set({ ageUpAge: age, ageUpRankId: rankId, updatedAt: new Date() }).where(eq(sections.id, sectionId)).returning();
    await writeAudit(tx, { actorId: actor.id, meta }, {
      action: 'SECTION_AGE_UP_CHANGED', entityType: 'sections', entityId: String(sectionId),
      before: auditSnapshot(before, ['ageUpAge', 'ageUpRankId']), after: auditSnapshot(after, ['ageUpAge', 'ageUpRankId']),
    });
  });
}

export async function updateRank(actor: CurrentUser, id: number, input: { name?: unknown; isActive?: unknown }, meta: RequestMeta) {
  assertOrgAdmin(actor);
  if (!isSmallId(id)) throw new AppError('NOT_FOUND', 'Rank not found.');
  try {
    return await db.transaction(async (tx) => {
      const [before] = await tx.select().from(ranks).where(eq(ranks.id, id)).for('update');
      if (!before) throw new AppError('NOT_FOUND', 'Rank not found.');
      const name = input.name === undefined ? before.name : nameOf(input.name);
      const isActive = activeOf(input.isActive, before.isActive);
      if (name === before.name && isActive === before.isActive) throw new AppError('VALIDATION', 'Nothing has changed.');
      if (before.systemKey) throw new AppError('FORBIDDEN', 'The Captain rank cannot be renamed or deactivated.');
      if (name !== before.name) await assertUniqueName(tx, 'rank', name, id, before.sectionId);
      if (!isActive && before.isActive) {
        const [inUse] = await tx.select({ id: users.id }).from(users).where(and(eq(users.rankId, id), eq(users.status, 'active'))).limit(1);
        if (inUse) throw new AppError('VALIDATION', 'Promote or deactivate the active members holding this rank first.');
      }
      if (isActive && !before.isActive) {
        const [sec] = await tx.select({ isActive: sections.isActive }).from(sections).where(eq(sections.id, before.sectionId));
        if (!sec?.isActive) throw new AppError('VALIDATION', 'Reactivate this section first.');
      }
      const [after] = await tx.update(ranks).set({ name, isActive, updatedAt: new Date() }).where(eq(ranks.id, id)).returning();
      await writeAudit(tx, { actorId: actor.id, meta }, {
        action: isActive !== before.isActive ? (isActive ? 'RANK_REACTIVATED' : 'RANK_DEACTIVATED') : 'RANK_RENAMED',
        entityType: 'ranks', entityId: String(id),
        before: auditSnapshot(before, ['name', 'isActive']), after: auditSnapshot(after, ['name', 'isActive']),
      });
    });
  } catch (err) {
    mapDup(err);
  }
}

/** 上移 / 下移（和相邻一项交换顺序） */
export async function moveItem(actor: CurrentUser, kind: 'section' | 'rank', id: number, dir: 'up' | 'down', meta: RequestMeta) {
  assertOrgAdmin(actor);
  if (!isSmallId(id) || (dir !== 'up' && dir !== 'down')) throw new AppError('NOT_FOUND', 'Not found.');
  return db.transaction(async (tx) => {
    // 先把顺序整理成 0..n，再与相邻项交换
    if (kind === 'section') {
      const list = await tx.select({ id: sections.id }).from(sections).orderBy(asc(sections.sortOrder), asc(sections.id)).for('update');
      await reorder(tx, list.map((r) => r.id), id, dir, (rid, i) => tx.update(sections).set({ sortOrder: i }).where(eq(sections.id, rid)));
    } else {
      const [r] = await tx.select({ sectionId: ranks.sectionId }).from(ranks).where(eq(ranks.id, id));
      if (!r) throw new AppError('NOT_FOUND', 'Rank not found.');
      const list = await tx.select({ id: ranks.id }).from(ranks).where(eq(ranks.sectionId, r.sectionId)).orderBy(asc(ranks.sortOrder), asc(ranks.id)).for('update');
      await reorder(tx, list.map((x) => x.id), id, dir, (rid, i) => tx.update(ranks).set({ sortOrder: i }).where(and(eq(ranks.id, rid), ne(ranks.sortOrder, i))));
    }
    await writeAudit(tx, { actorId: actor.id, meta }, { action: kind === 'section' ? 'SECTION_REORDERED' : 'RANK_REORDERED', entityType: kind === 'section' ? 'sections' : 'ranks', entityId: String(id), after: { direction: dir } });
  });
}

async function reorder(_tx: Tx, ids: number[], id: number, dir: 'up' | 'down', write: (id: number, sort: number) => Promise<unknown>) {
  const i = ids.indexOf(id);
  if (i < 0) throw new AppError('NOT_FOUND', 'Not found.');
  const j = dir === 'up' ? i - 1 : i + 1;
  if (j < 0 || j >= ids.length) return;
  [ids[i], ids[j]] = [ids[j], ids[i]];
  for (const [k, rid] of ids.entries()) await write(rid, k);
}
