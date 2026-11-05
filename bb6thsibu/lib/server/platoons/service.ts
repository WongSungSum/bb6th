import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, type Tx } from '@/lib/db/client';
import { platoonActivities, platoons, platoonScores, ranks, sections, users } from '@/lib/db/schema';
import type { CurrentUser } from '@/lib/server/auth/session';
import { can } from '@/lib/server/authz';
import { auditSnapshot, writeAudit } from '@/lib/server/audit';
import { AppError, forbidden } from '@/lib/server/errors';
import type { RequestMeta } from '@/lib/server/request';
import { cleanName } from '@/lib/validation/text';

/*
 * Platoon：组别底下的小队（目前用于 Senior）。
 * - 管理 Platoon、分配成员、指定 Leader：platoons.manage（只限军官）
 * - 记分：platoons.score（只限军官）
 * - 计分板：所有登入的人都能看
 * 不删除：Platoon 只停用，活动只作废（数据库触发器保证）。
 */

const MAX_BATCH = 100;
const isSmallId = (n: number) => Number.isInteger(n) && n > 0 && n <= 32767;
const isUuid = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
const fieldError = (fields: Record<string, string>) => new AppError('VALIDATION', 'Please fix the highlighted fields.', fields);
const notFound = () => new AppError('NOT_FOUND', 'Platoon not found.');

export async function assertPlatoonManager(actor: CurrentUser) {
  if (!(await can(actor, 'platoons.manage'))) throw forbidden();
}
async function assertScorer(actor: CurrentUser) {
  if (!(await can(actor, 'platoons.score'))) throw forbidden();
}

const nameOf = (v: unknown, max = 40) => {
  const r = cleanName(v);
  if ('error' in r) throw fieldError({ name: r.error === 'empty' ? 'Enter a name.' : r.error });
  const name = r.name;
  if (name.length > max) throw fieldError({ name: `Use at most ${max} characters.` });
  return name;
};
const activeOf = (v: unknown, current: boolean) => {
  if (v === undefined) return current;
  if (typeof v !== 'boolean') throw new AppError('VALIDATION', 'Invalid value.');
  return v;
};
async function assertUniqueName(tx: Tx, name: string, exceptId?: number) {
  const [dup] = await tx.select({ id: platoons.id }).from(platoons).where(and(sql`lower(${platoons.name}) = lower(${name})`, exceptId ? ne(platoons.id, exceptId) : undefined));
  if (dup) throw fieldError({ name: 'This name is already used.' });
}
function mapDup(err: unknown): never {
  const c = err as { cause?: { constraint?: string }; constraint?: string };
  if ((c.constraint ?? c.cause?.constraint) === 'platoons_name_lower_uq') throw fieldError({ name: 'This name is already used.' });
  throw err;
}
async function loadPlatoon(tx: Tx | typeof db, id: number, lock = false) {
  if (!isSmallId(id)) throw notFound();
  const q = tx.select().from(platoons).where(eq(platoons.id, id));
  const [p] = lock ? await q.for('update') : await q;
  if (!p) throw notFound();
  return p;
}

// ─── 维护：Platoon 清单 ────────────────────────────────

export async function listPlatoons() {
  const [rows, counts, unassigned, secs] = await Promise.all([
    db
      .select({ id: platoons.id, name: platoons.name, sectionId: platoons.sectionId, sectionName: sections.name, isActive: platoons.isActive })
      .from(platoons)
      .innerJoin(sections, eq(sections.id, platoons.sectionId))
      .orderBy(asc(platoons.sortOrder), asc(platoons.id)),
    db
      .select({ platoonId: users.platoonId, n: sql<number>`count(*)::int` })
      .from(users)
      .where(and(eq(users.status, 'active'), eq(users.accountType, 'member')))
      .groupBy(users.platoonId),
    // 组别有启用中的 Platoon，但人还没分配
    db
      .select({ id: users.id, fullName: users.fullName, sectionName: sections.name, rankName: ranks.name })
      .from(users)
      .innerJoin(sections, eq(sections.id, users.sectionId))
      .leftJoin(ranks, eq(ranks.id, users.rankId))
      .where(and(
        eq(users.status, 'active'), eq(users.accountType, 'member'), isNull(users.platoonId),
        sql`exists (select 1 from ${platoons} p where p.section_id = ${users.sectionId} and p.is_active)`,
      ))
      .orderBy(asc(users.fullName))
      .limit(200),
    db.select({ id: sections.id, name: sections.name }).from(sections).where(and(eq(sections.isActive, true), sql`coalesce(${sections.systemKey}, '') <> 'officer'`)).orderBy(asc(sections.sortOrder)),
  ]);
  const roles = await db
    .select({ platoonId: users.platoonId, role: users.platoonRole, name: users.fullName })
    .from(users)
    .where(and(sql`${users.platoonRole} is not null`, eq(users.status, 'active')));
  return {
    platoons: rows.map((p) => ({
      ...p,
      members: counts.find((c) => c.platoonId === p.id)?.n ?? 0,
      leader: roles.find((r) => r.platoonId === p.id && r.role === 'leader')?.name ?? null,
      assistant: roles.find((r) => r.platoonId === p.id && r.role === 'assistant')?.name ?? null,
    })),
    unassigned,
    sections: secs,
  };
}
export type PlatoonList = Awaited<ReturnType<typeof listPlatoons>>;

export async function createPlatoon(actor: CurrentUser, input: { sectionId: unknown; name: unknown }, meta: RequestMeta) {
  await assertPlatoonManager(actor);
  const name = nameOf(input.name);
  const sectionId = Number(input.sectionId);
  if (!isSmallId(sectionId)) throw fieldError({ sectionId: 'Select a section.' });
  try {
    return await db.transaction(async (tx) => {
      const [sec] = await tx.select().from(sections).where(eq(sections.id, sectionId));
      if (!sec || !sec.isActive) throw fieldError({ sectionId: 'Select a section.' });
      if (sec.systemKey === 'officer') throw fieldError({ sectionId: 'Officers do not have platoons.' });
      await assertUniqueName(tx, name);
      const [{ m }] = await tx.select({ m: sql<number>`coalesce(max(${platoons.sortOrder}), -1)::int` }).from(platoons);
      const [row] = await tx.insert(platoons).values({ sectionId, name, sortOrder: m + 1 }).returning();
      await writeAudit(tx, { actorId: actor.id, meta }, { action: 'PLATOON_CREATED', entityType: 'platoons', entityId: String(row.id), after: auditSnapshot(row, ['name', 'sectionId', 'isActive']) });
      return { id: row.id };
    });
  } catch (err) {
    mapDup(err);
  }
}

/** 改名 / 停用 / 启用。还有成员的 Platoon 不能停用 */
export async function updatePlatoon(actor: CurrentUser, id: number, input: { name?: unknown; isActive?: unknown }, meta: RequestMeta) {
  await assertPlatoonManager(actor);
  try {
    return await db.transaction(async (tx) => {
      const before = await loadPlatoon(tx, id, true);
      const name = input.name === undefined ? before.name : nameOf(input.name);
      const isActive = activeOf(input.isActive, before.isActive);
      if (name === before.name && isActive === before.isActive) throw new AppError('VALIDATION', 'Nothing has changed.');
      if (name !== before.name) await assertUniqueName(tx, name, id);
      if (!isActive && before.isActive) {
        const [inUse] = await tx.select({ id: users.id }).from(users).where(and(eq(users.platoonId, id), eq(users.status, 'active'))).limit(1);
        if (inUse) throw new AppError('VALIDATION', 'Move the members out of this platoon first.');
        // 停用中的成员不显示在页面上，停用 Platoon 时顺便让他们离开（有审计记录）
        const gone = await tx.update(users).set({ platoonId: null, platoonRole: null }).where(eq(users.platoonId, id)).returning({ id: users.id });
        for (const u of gone) {
          await writeAudit(tx, { actorId: actor.id, meta }, { action: 'PLATOON_REMOVED', entityType: 'users', entityId: u.id, reason: 'Platoon deactivated', before: { platoonId: id }, after: { platoonId: null } });
        }
      }
      if (isActive && !before.isActive) {
        const [sec] = await tx.select({ isActive: sections.isActive }).from(sections).where(eq(sections.id, before.sectionId));
        if (!sec?.isActive) throw new AppError('VALIDATION', 'Reactivate the section first.');
      }
      const [after] = await tx.update(platoons).set({ name, isActive, updatedAt: new Date() }).where(eq(platoons.id, id)).returning();
      await writeAudit(tx, { actorId: actor.id, meta }, {
        action: isActive !== before.isActive ? (isActive ? 'PLATOON_REACTIVATED' : 'PLATOON_DEACTIVATED') : 'PLATOON_RENAMED',
        entityType: 'platoons', entityId: String(id),
        before: auditSnapshot(before, ['name', 'isActive']), after: auditSnapshot(after, ['name', 'isActive']),
      });
    });
  } catch (err) {
    mapDup(err);
  }
}

export async function movePlatoon(actor: CurrentUser, id: number, dir: 'up' | 'down', meta: RequestMeta) {
  await assertPlatoonManager(actor);
  if (!isSmallId(id) || (dir !== 'up' && dir !== 'down')) throw notFound();
  return db.transaction(async (tx) => {
    const ids = (await tx.select({ id: platoons.id }).from(platoons).orderBy(asc(platoons.sortOrder), asc(platoons.id)).for('update')).map((r) => r.id);
    const i = ids.indexOf(id);
    if (i < 0) throw notFound();
    const j = dir === 'up' ? i - 1 : i + 1;
    if (j < 0 || j >= ids.length) return;
    [ids[i], ids[j]] = [ids[j], ids[i]];
    for (const [k, pid] of ids.entries()) await tx.update(platoons).set({ sortOrder: k }).where(and(eq(platoons.id, pid), ne(platoons.sortOrder, k)));
    await writeAudit(tx, { actorId: actor.id, meta }, { action: 'PLATOON_REORDERED', entityType: 'platoons', entityId: String(id), after: { direction: dir } });
  });
}

// ─── 维护：一个 Platoon 的成员 ─────────────────────────

export async function getPlatoon(actor: CurrentUser, id: number) {
  await assertPlatoonManager(actor);
  const p = await loadPlatoon(db, id);
  const other = alias(platoons, 'other');
  const [sec] = await db.select({ name: sections.name }).from(sections).where(eq(sections.id, p.sectionId));
  const people = await db
    .select({ id: users.id, fullName: users.fullName, rankName: ranks.name, platoonId: users.platoonId, platoonName: other.name, platoonRole: users.platoonRole })
    .from(users)
    .leftJoin(ranks, eq(ranks.id, users.rankId))
    .leftJoin(other, eq(other.id, users.platoonId))
    .where(and(eq(users.sectionId, p.sectionId), eq(users.status, 'active'), eq(users.accountType, 'member')))
    .orderBy(asc(users.fullName));
  return {
    platoon: { ...p, sectionName: sec?.name ?? '' },
    members: people.filter((u) => u.platoonId === id),
    // 同组别、不在这个 Platoon 的人（包括在别的 Platoon 的人，可直接换过来）
    candidates: people.filter((u) => u.platoonId !== id),
  };
}
export type PlatoonDetail = Awaited<ReturnType<typeof getPlatoon>>;

const idsOf = (v: unknown) => {
  const ids = [...new Set(Array.isArray(v) ? v.map(String) : [])];
  if (!ids.length) throw fieldError({ userIds: 'Select at least one member.' });
  if (ids.length > MAX_BATCH) throw fieldError({ userIds: `Select at most ${MAX_BATCH} members at a time.` });
  if (!ids.every(isUuid)) throw new AppError('NOT_FOUND', 'Member not found.');
  return ids;
};

/** 把多位成员放进这个 Platoon（从别的 Platoon 换过来也可以）。任何一人不符合就整批不改 */
export async function assignMembers(actor: CurrentUser, platoonId: number, input: { userIds: unknown }, meta: RequestMeta) {
  await assertPlatoonManager(actor);
  const ids = idsOf(input.userIds);
  return db.transaction(async (tx) => {
    const p = await loadPlatoon(tx, platoonId, true);
    if (!p.isActive) throw new AppError('VALIDATION', 'Reactivate this platoon first.');
    const rows = await tx.select().from(users).where(inArray(users.id, ids)).for('update');
    const failed: Record<string, string> = {};
    for (const id of ids) {
      const u = rows.find((r) => r.id === id);
      if (!u || u.accountType !== 'member') failed[id] = 'Member not found.';
      else if (u.status !== 'active') failed[id] = 'Member is inactive.';
      else if (u.sectionId !== p.sectionId) failed[id] = 'Member is not in this section.';
      else if (u.platoonId === platoonId) failed[id] = 'Already in this platoon.';
    }
    if (Object.keys(failed).length) throw new AppError('VALIDATION', `${Object.keys(failed).length} of ${ids.length} members cannot be added. Nothing was saved.`, failed);
    const changeSetId = randomUUID();
    for (const u of rows) {
      // 换 Platoon 时 Leader / Assistant 身份不跟着走
      const [after] = await tx.update(users).set({ platoonId, platoonRole: null, updatedAt: new Date(), updatedBy: actor.id }).where(eq(users.id, u.id)).returning();
      await writeAudit(tx, { actorId: actor.id, meta, changeSetId }, {
        action: 'PLATOON_ASSIGNED', entityType: 'users', entityId: u.id,
        before: auditSnapshot(u, ['platoonId', 'platoonRole']), after: auditSnapshot(after, ['platoonId', 'platoonRole']),
      });
    }
    return { count: ids.length };
  });
}

/** 把成员移出这个 Platoon（之后会出现在「未分配」名单） */
export async function removeMembers(actor: CurrentUser, platoonId: number, input: { userIds: unknown }, meta: RequestMeta) {
  await assertPlatoonManager(actor);
  const ids = idsOf(input.userIds);
  return db.transaction(async (tx) => {
    await loadPlatoon(tx, platoonId, true);
    const rows = await tx.select().from(users).where(inArray(users.id, ids)).for('update');
    const failed: Record<string, string> = {};
    for (const id of ids) if (!rows.find((r) => r.id === id && r.platoonId === platoonId)) failed[id] = 'Not in this platoon.';
    if (Object.keys(failed).length) throw new AppError('VALIDATION', `${Object.keys(failed).length} of ${ids.length} members cannot be removed. Nothing was saved.`, failed);
    const changeSetId = randomUUID();
    for (const u of rows) {
      const [after] = await tx.update(users).set({ platoonId: null, platoonRole: null, updatedAt: new Date(), updatedBy: actor.id }).where(eq(users.id, u.id)).returning();
      await writeAudit(tx, { actorId: actor.id, meta, changeSetId }, {
        action: 'PLATOON_REMOVED', entityType: 'users', entityId: u.id,
        before: auditSnapshot(u, ['platoonId', 'platoonRole']), after: auditSnapshot(after, ['platoonId', 'platoonRole']),
      });
    }
    return { count: ids.length };
  });
}

/** 指定 Leader 和 Assistant Leader（都要是这个 Platoon 的成员，可以留空） */
export async function setPlatoonLeaders(actor: CurrentUser, platoonId: number, input: { leaderId: unknown; assistantId: unknown }, meta: RequestMeta) {
  await assertPlatoonManager(actor);
  const pick = (v: unknown) => (v === null || v === undefined || v === '' ? null : String(v));
  const leaderId = pick(input.leaderId);
  const assistantId = pick(input.assistantId);
  if (leaderId && assistantId && leaderId === assistantId) throw fieldError({ assistantId: 'Choose a different person.' });
  return db.transaction(async (tx) => {
    await loadPlatoon(tx, platoonId, true);
    const members = await tx.select().from(users).where(eq(users.platoonId, platoonId)).for('update');
    const ok = (id: string | null) => id === null || members.some((m) => m.id === id && m.status === 'active');
    if (!ok(leaderId)) throw fieldError({ leaderId: 'Choose a member of this platoon.' });
    if (!ok(assistantId)) throw fieldError({ assistantId: 'Choose a member of this platoon.' });
    const want = (id: string) => (id === leaderId ? 'leader' : id === assistantId ? 'assistant' : null);
    const changed = members.filter((m) => m.platoonRole !== want(m.id));
    if (!changed.length) throw new AppError('VALIDATION', 'Nothing has changed.');
    // 先清掉旧的身份，再设定新的（避免唯一索引冲突）
    await tx.update(users).set({ platoonRole: null }).where(and(eq(users.platoonId, platoonId), inArray(users.id, changed.map((m) => m.id))));
    const changeSetId = randomUUID();
    for (const m of changed) {
      const role = want(m.id);
      if (role) await tx.update(users).set({ platoonRole: role }).where(eq(users.id, m.id));
      await tx.update(users).set({ updatedAt: new Date(), updatedBy: actor.id }).where(eq(users.id, m.id));
      await writeAudit(tx, { actorId: actor.id, meta, changeSetId }, {
        action: 'PLATOON_ROLE_CHANGED', entityType: 'users', entityId: m.id,
        before: { platoonId, platoonRole: m.platoonRole }, after: { platoonId, platoonRole: role },
      });
    }
  });
}

// ─── 计分板 ───────────────────────────────────────────

/** 马来西亚时间的今天 */
const todayMy = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const yearOf = (v: unknown) => {
  const y = Number(v);
  return Number.isInteger(y) && y >= 2000 && y <= 2100 ? y : Number(todayMy().slice(0, 4));
};

export async function scoreboard(year: unknown) {
  const y = yearOf(year);
  const [allPlatoons, acts, yearsRows] = await Promise.all([
    db.select({ id: platoons.id, name: platoons.name, isActive: platoons.isActive }).from(platoons).orderBy(asc(platoons.sortOrder), asc(platoons.id)),
    db
      .select()
      .from(platoonActivities)
      .where(sql`${platoonActivities.activityDate} >= make_date(${y}, 1, 1) and ${platoonActivities.activityDate} < make_date(${y + 1}, 1, 1)`) // 用日期范围才用得到索引
      .orderBy(desc(platoonActivities.activityDate), desc(platoonActivities.createdAt)),
    db.select({ y: sql<number>`distinct extract(year from ${platoonActivities.activityDate})::int` }).from(platoonActivities),
  ]);
  const scores = acts.length
    ? await db.select().from(platoonScores).where(inArray(platoonScores.activityId, acts.map((a) => a.id)))
    : [];
  const counted = new Set(acts.filter((a) => !a.voidedAt).map((a) => a.id));
  const total = (pid: number) => scores.filter((s) => s.platoonId === pid && counted.has(s.activityId)).reduce((n, s) => n + (s.points ?? 0), 0);
  // 显示启用中的 Platoon，以及当年有得分的停用 Platoon
  const shown = allPlatoons.filter((p) => p.isActive || scores.some((s) => s.platoonId === p.id && s.points !== null && counted.has(s.activityId)));
  const ranked = shown.map((p) => ({ ...p, total: total(p.id) })).sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  // 同分同名次
  const ranking = ranked.map((p) => ({ ...p, place: ranked.findIndex((q) => q.total === p.total) + 1 }));
  const years = [...new Set([Number(todayMy().slice(0, 4)), y, ...yearsRows.map((r) => Number(r.y))])].sort((a, b) => b - a);
  return {
    year: y,
    years,
    ranking,
    activities: acts.map((a) => ({
      id: a.id, name: a.name, activityDate: a.activityDate, note: a.note, updatedAt: a.updatedAt.toISOString(),
      voided: !!a.voidedAt, voidReason: a.voidReason,
      scores: Object.fromEntries(scores.filter((s) => s.activityId === a.id && s.points !== null).map((s) => [s.platoonId, s.points])) as Record<number, number>,
    })),
    platoons: shown.map((p) => ({ id: p.id, name: p.name, isActive: p.isActive })),
  };
}
export type Scoreboard = Awaited<ReturnType<typeof scoreboard>>;

type ActivityInput = { name: unknown; activityDate: unknown; note?: unknown; scores: unknown; expectedUpdatedAt?: unknown };

function parseActivity(input: ActivityInput) {
  const errors: Record<string, string> = {};
  const name = typeof input.name === 'string' ? input.name.trim().replace(/\s+/g, ' ') : '';
  if (!name) errors.name = 'Enter the activity name.';
  else if (name.length > 80) errors.name = 'Use at most 80 characters.';
  const date = typeof input.activityDate === 'string' ? input.activityDate : '';
  const d = new Date(date + 'T00:00:00Z');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== date || date < '2000-01-01') errors.activityDate = 'Enter a valid date.';
  else if (date > todayMy()) errors.activityDate = 'The date cannot be in the future.';
  const note = typeof input.note === 'string' ? input.note.trim().slice(0, 500) || null : null;
  const all = Array.isArray(input.scores) ? input.scores : [];
  // 超过合理数量直接拒绝，避免超大请求占用服务器
  if (all.length > 500) errors.scores = 'Too many scores.';
  const list = all.length > 500 ? [] : all;
  const scores: { platoonId: number; points: number }[] = [];
  const seen = new Set<number>();
  for (const s of list) {
    const pid = Number((s as { platoonId?: unknown })?.platoonId);
    const raw = (s as { points?: unknown })?.points;
    if (raw === null || raw === undefined || String(raw).trim() === '') continue; // 没填（或只有空格）= 不计分
    // 只接受普通整数（不接受 1e3、0x10、全形或别种数字）
    const pts = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\s*-?\d{1,4}\s*$/.test(raw) ? Number(raw) : NaN;
    if (!isSmallId(pid)) { errors.scores = 'Unknown platoon.'; continue; }
    if (!Number.isInteger(pts) || pts < -1000 || pts > 1000) errors[`score.${pid}`] = 'Use a whole number from -1000 to 1000.';
    else if (seen.has(pid)) errors.scores = 'Each platoon can only have one score.';
    else {
      seen.add(pid);
      scores.push({ platoonId: pid, points: pts });
    }
  }
  if (!scores.length && !errors.scores && !Object.keys(errors).some((k) => k.startsWith('score.'))) errors.scores = 'Enter at least one score.';
  if (Object.keys(errors).length) throw fieldError(errors);
  return { name, activityDate: date, note, scores };
}

async function assertScorablePlatoons(tx: Tx, scores: { platoonId: number }[], existing: number[] = []) {
  const ids = scores.map((s) => s.platoonId);
  const rows = await tx.select({ id: platoons.id, isActive: platoons.isActive }).from(platoons).where(inArray(platoons.id, ids));
  for (const id of ids) {
    const p = rows.find((r) => r.id === id);
    // 停用的 Platoon 不能新加分数（原本已有的分数仍可修改）
    if (!p || (!p.isActive && !existing.includes(id))) throw fieldError({ scores: 'Unknown platoon.' });
  }
}

export async function createActivity(actor: CurrentUser, input: ActivityInput, meta: RequestMeta) {
  await assertScorer(actor);
  const v = parseActivity(input);
  return db.transaction(async (tx) => {
    await assertScorablePlatoons(tx, v.scores);
    const [a] = await tx.insert(platoonActivities).values({ name: v.name, activityDate: v.activityDate, note: v.note, createdBy: actor.id, updatedBy: actor.id }).returning();
    await tx.insert(platoonScores).values(v.scores.map((s) => ({ activityId: a.id, ...s })));
    await writeAudit(tx, { actorId: actor.id, meta }, {
      action: 'PLATOON_ACTIVITY_CREATED', entityType: 'platoon_activities', entityId: a.id,
      after: { name: v.name, activityDate: v.activityDate, note: v.note, scores: v.scores },
    });
    return { id: a.id };
  });
}

/** 修改活动与分数；没填的 Platoon 保留原本分数（要取消请填 0） */
export async function updateActivity(actor: CurrentUser, id: string, input: ActivityInput, meta: RequestMeta) {
  await assertScorer(actor);
  if (!isUuid(id)) throw new AppError('NOT_FOUND', 'Activity not found.');
  const v = parseActivity(input);
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(platoonActivities).where(eq(platoonActivities.id, id)).for('update');
    if (!before) throw new AppError('NOT_FOUND', 'Activity not found.');
    if (before.voidedAt) throw new AppError('VALIDATION', 'A voided activity cannot be changed.');
    if (typeof input.expectedUpdatedAt === 'string' && input.expectedUpdatedAt !== before.updatedAt.toISOString()) {
      throw new AppError('CONFLICT', 'This activity was changed by someone else. Reload to see the latest.');
    }
    const oldScores = await tx.select().from(platoonScores).where(eq(platoonScores.activityId, id));
    await assertScorablePlatoons(tx, v.scores, oldScores.map((s) => s.platoonId));
    await tx.update(platoonActivities).set({ name: v.name, activityDate: v.activityDate, note: v.note, updatedBy: actor.id, updatedAt: new Date() }).where(eq(platoonActivities.id, id));
    for (const s of v.scores) {
      await tx.insert(platoonScores).values({ activityId: id, ...s }).onConflictDoUpdate({ target: [platoonScores.activityId, platoonScores.platoonId], set: { points: s.points } });
    }
    // 送来的是完整的分数表：原本有分、这次留空的 Platoon = 没参加（分数不能删除，所以设为 null）
    const cleared = oldScores.filter((o) => o.points !== null && !v.scores.some((s) => s.platoonId === o.platoonId)).map((o) => o.platoonId);
    if (cleared.length) await tx.update(platoonScores).set({ points: null }).where(and(eq(platoonScores.activityId, id), inArray(platoonScores.platoonId, cleared)));
    await writeAudit(tx, { actorId: actor.id, meta }, {
      action: 'PLATOON_ACTIVITY_UPDATED', entityType: 'platoon_activities', entityId: id,
      before: { name: before.name, activityDate: before.activityDate, note: before.note, scores: oldScores.filter((s) => s.points !== null).map((s) => ({ platoonId: s.platoonId, points: s.points })) },
      after: { name: v.name, activityDate: v.activityDate, note: v.note, scores: v.scores },
    });
  });
}

/** 作废：不再计分，但保留记录。作废后不能再改 */
export async function voidActivity(actor: CurrentUser, id: string, input: { reason: unknown }, meta: RequestMeta) {
  await assertScorer(actor);
  if (!isUuid(id)) throw new AppError('NOT_FOUND', 'Activity not found.');
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (!reason) throw fieldError({ reason: 'Enter a reason.' });
  if (reason.length > 500) throw fieldError({ reason: 'Use at most 500 characters.' });
  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(platoonActivities).where(eq(platoonActivities.id, id)).for('update');
    if (!before) throw new AppError('NOT_FOUND', 'Activity not found.');
    if (before.voidedAt) throw new AppError('VALIDATION', 'This activity is already voided.');
    await tx.update(platoonActivities).set({ voidedAt: new Date(), voidedBy: actor.id, voidReason: reason, updatedBy: actor.id, updatedAt: new Date() }).where(eq(platoonActivities.id, id));
    await writeAudit(tx, { actorId: actor.id, meta }, { action: 'PLATOON_ACTIVITY_VOIDED', entityType: 'platoon_activities', entityId: id, reason });
  });
}
