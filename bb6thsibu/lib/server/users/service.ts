import { randomUUID } from 'node:crypto';
import { and, asc, count, desc, eq, ilike, inArray, ne, or, sql, type SQL } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, type Tx } from '@/lib/db/client';
import { auditLogs, guardians, inactiveReasons, platoons, rankHistory, rankPermissions, ranks, sections, users } from '@/lib/db/schema';
import { decryptIdNumber, encryptIdNumber, looksLikeIc, maskIdNumber, normalizeIdNumber, type IdType } from '@/lib/server/auth/crypto';
import { checkTempPasswordPolicy, generateTempPassword, hashPassword } from '@/lib/server/auth/password';
import { clearLoginFailures, idLookupHash } from '@/lib/server/auth/login';
import { revokeAllSessions, type CurrentUser } from '@/lib/server/auth/session';
import { applyOfficerOnly, assertInScope, can, getPermissionsFor, isOfficerOrAbove, loadPermissions, loadRawPermissions, type MemberScope, type PermissionSlug } from '@/lib/server/authz';
import { ALL_PERMISSIONS } from '@/lib/server/authz/catalog';
import { userAccessBlock } from '@/lib/server/access/service';
import { auditSnapshot, writeAudit } from '@/lib/server/audit';
import { AppError, forbidden, notFound } from '@/lib/server/errors';
import { z } from 'zod';
import type { RequestMeta } from '@/lib/server/request';
import {
  createUserSchema, fieldErrorsOf, reasonSchema, updateUserSchema,
  type CreateUserInput, type UpdateUserInput,
} from '@/lib/validation/users';

const PAGE_SIZE = 20;

// 进入审计日志的用户栏位（不含密码、证件密文等）
const USER_AUDIT_FIELDS = [
  'username', 'email', 'idType', 'fullName', 'gender', 'dateOfBirth', 'joinDate', 'phone', 'address',
  'school', 'sectionId', 'rankId', 'platoonId', 'platoonRole', 'status', 'inactiveReasonId', 'inactiveNote', 'mustChangePassword',
] as const;

const validationError = (fieldErrors: Record<string, string>) =>
  new AppError('VALIDATION', 'Please fix the highlighted fields.', fieldErrors);

const isUuid = (v: string) => z.uuid().safeParse(v).success;
/** smallint 主键（组别、军阶、停用原因）的合法范围 */
const isSmallId = (n: number) => Number.isInteger(n) && n > 0 && n <= 32767;

// ─── 组织选项 ─────────────────────────────────────────

export async function getOrgOptions() {
  const [secs, rks] = await Promise.all([
    db.select({ id: sections.id, name: sections.name, isOfficer: sql<boolean>`coalesce(${sections.systemKey} = 'officer', false)` }).from(sections).where(eq(sections.isActive, true)).orderBy(asc(sections.sortOrder)),
    db
      .select({ id: ranks.id, name: ranks.name, sectionId: ranks.sectionId, isCaptain: sql<boolean>`${ranks.systemKey} = 'captain'` })
      .from(ranks)
      .innerJoin(sections, eq(sections.id, ranks.sectionId))
      .where(and(eq(ranks.isActive, true), eq(sections.isActive, true)))
      .orderBy(asc(sections.sortOrder), asc(ranks.sortOrder)), // 按组别顺序排列，下拉选单才不会混在一起
  ]);
  const reasons = await db
    .select({ id: inactiveReasons.id, name: inactiveReasons.name, requiresNote: inactiveReasons.requiresNote })
    .from(inactiveReasons)
    .where(eq(inactiveReasons.isActive, true))
    .orderBy(asc(inactiveReasons.sortOrder));
  const pls = await db
    .select({ id: platoons.id, name: platoons.name, sectionId: platoons.sectionId })
    .from(platoons)
    .where(eq(platoons.isActive, true))
    .orderBy(asc(platoons.sortOrder), asc(platoons.name));
  return { sections: secs, ranks: rks.map((r) => ({ ...r, isCaptain: !!r.isCaptain })), inactiveReasons: reasons, platoons: pls };
}
export type OrgOptions = Awaited<ReturnType<typeof getOrgOptions>>;

/** 只保留看得到的组别和其军阶（筛选与新增成员用） */
export function scopedOrg(org: OrgOptions, scope: MemberScope): OrgOptions {
  if (scope === 'all') return org;
  return {
    ...org,
    sections: org.sections.filter((s) => scope.sections.includes(s.id)),
    ranks: org.ranks.filter((r) => scope.sections.includes(r.sectionId)),
    platoons: org.platoons.filter((p) => scope.sections.includes(p.sectionId) && (scope.platoonId === null || p.id === scope.platoonId)),
  };
}

/** 校验组别/军阶：必须启用、军阶属于该组别、不能是 Captain 军阶 */
async function assertAssignableRank(tx: Tx, sectionId: number, rankId: number, field = 'rankId') {
  if (!isSmallId(sectionId) || !isSmallId(rankId)) throw validationError({ [field]: 'Select a rank.' });
  const [r] = await tx
    .select({ sectionId: ranks.sectionId, isActive: ranks.isActive, systemKey: ranks.systemKey, sectionActive: sections.isActive })
    .from(ranks)
    .innerJoin(sections, eq(sections.id, ranks.sectionId))
    .where(eq(ranks.id, rankId))
    // 锁住军阶和组别到交易结束：同时有人停用它们时会等这边完成，再看到这个成员而拒绝停用
    .for('share');
  if (!r || r.sectionId !== sectionId || !r.isActive || !r.sectionActive || r.systemKey === 'captain') {
    throw validationError({ [field]: 'Select a rank.' });
  }
}

async function isOfficerSection(tx: Tx, sectionId: number) {
  const [s] = await tx.select({ key: sections.systemKey }).from(sections).where(eq(sections.id, sectionId));
  return s?.key === 'officer';
}

// ─── 目标保护 ─────────────────────────────────────────

type Target = { id: string; accountType: 'member' | 'superadmin'; isCaptain: boolean; isOfficer: boolean; status: 'active' | 'inactive'; sectionId: number | null; platoonId: number | null };

/**
 * 组别有启用中的 Platoon 时一定要选；选的 Platoon 必须属于这个组别且启用中。
 * 回传要存的 platoonId（组别没有 Platoon 时为 null）。
 */
async function resolvePlatoon(tx: Tx, sectionId: number, platoonId: number | undefined): Promise<number | null> {
  // 锁住（理由同 assertAssignableRank）：避免同时停用 Platoon
  const list = await tx.select({ id: platoons.id }).from(platoons).where(and(eq(platoons.sectionId, sectionId), eq(platoons.isActive, true))).for('share');
  if (!list.length) {
    if (platoonId) throw validationError({ platoonId: 'This section has no platoons.' });
    return null;
  }
  if (!platoonId) throw validationError({ platoonId: 'Select a platoon.' });
  if (!list.some((p) => p.id === platoonId)) throw validationError({ platoonId: 'Select a valid platoon.' });
  return platoonId;
}

async function loadTarget(tx: Tx | typeof db, id: string): Promise<Target> {
  if (!isUuid(id)) throw notFound();
  const [t] = await tx
    .select({ id: users.id, accountType: users.accountType, status: users.status, rankKey: ranks.systemKey, sectionKey: sections.systemKey, sectionId: users.sectionId, platoonId: users.platoonId })
    .from(users)
    .leftJoin(ranks, eq(ranks.id, users.rankId))
    .leftJoin(sections, eq(sections.id, users.sectionId))
    .where(eq(users.id, id));
  if (!t) throw notFound();
  return { id: t.id, accountType: t.accountType, status: t.status, isCaptain: t.rankKey === 'captain', isOfficer: t.sectionKey === 'officer', sectionId: t.sectionId, platoonId: t.platoonId };
}

/**
 * 防止越权：
 * - Superadmin 账号只有他自己能改（会员列表里也看不到）
 * - Captain 只有 Captain 本人或 Superadmin 能改
 * - 不能重设密码 / 停用 / 改账号资料给一个权限比自己多的人
 * - 不能对自己做重设密码、停用、改军阶
 * - 只能管理自己组别的人（军官、Captain、Superadmin 或有 users.all_sections 的除外）
 * - 升阶、重设密码只能由军官（含 Captain、Superadmin）做
 * - 军官的资料只有军官能改（军员不能改 / 停用军官）
 */
async function assertCanManage(actor: CurrentUser, target: Target, op: 'update' | 'status' | 'rank' | 'reset') {
  if (target.accountType === 'superadmin') {
    if (actor.id !== target.id || op !== 'update') throw notFound();
    return;
  }
  await assertInScope(actor, target);
  if ((op === 'rank' || op === 'reset' || target.isOfficer) && !(await isOfficerOrAbove(actor))) throw new AppError('FORBIDDEN', 'Only officers can do this.');
  if (actor.id === target.id && op !== 'update') throw new AppError('FORBIDDEN', 'You cannot do this to your own account.');
  if (target.isCaptain && !actor.isCaptain && !actor.isSuperadmin) throw forbidden();
  if (actor.isCaptain || actor.isSuperadmin) return;
  const [mine, theirs] = await Promise.all([getPermissionsFor(actor), loadPermissions(target.id)]);
  for (const p of theirs) if (!mine.has(p)) throw forbidden();
}

// ─── 列表 ─────────────────────────────────────────────

export type ListFilters = { q?: string; section?: number; rank?: number; platoon?: number; status?: 'active' | 'inactive' | 'all'; page?: number; pageSize?: number };

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => '\\' + c);

/** canSearchIc：只有 users.view_sensitive 才能用 IC 搜索（IC 号码组合少，否则可被逐一试出） */
export async function listUsers(filters: ListFilters, opts: { canSearchIc: boolean; scope?: MemberScope } = { canSearchIc: false }) {
  const where: SQL[] = [eq(users.accountType, 'member')];
  // 组别范围：只列出看得到的组别
  const scope = opts.scope ?? 'all';
  if (scope !== 'all') {
    where.push(scope.sections.length ? inArray(users.sectionId, scope.sections) : sql`false`);
    if (scope.platoonId !== null) where.push(eq(users.platoonId, scope.platoonId));
  }
  const q = filters.q?.replace(/\0/g, '').trim().slice(0, 100);
  if (q) {
    const ic = looksLikeIc(q);
    if (ic && opts.canSearchIc) where.push(eq(users.idNumberHash, idLookupHash('mykad', ic)));
    else if (ic) where.push(sql`false`);
    else {
      const like = `%${escapeLike(q)}%`;
      where.push(or(ilike(users.fullName, like), ilike(users.username, like))!);
    }
  }
  if (filters.section && isSmallId(filters.section)) where.push(eq(users.sectionId, filters.section));
  if (filters.rank && isSmallId(filters.rank)) where.push(eq(users.rankId, filters.rank));
  if (filters.platoon && isSmallId(filters.platoon)) where.push(eq(users.platoonId, filters.platoon));
  const status = filters.status ?? 'active';
  if (status !== 'all') where.push(eq(users.status, status));

  const page = Number.isInteger(filters.page) ? Math.max(1, Math.min(filters.page!, 10000)) : 1;
  const cond = and(...where);
  const pageSize = filters.pageSize && Number.isInteger(filters.pageSize) ? Math.max(1, Math.min(filters.pageSize, 100)) : PAGE_SIZE;
  const [rows, [{ total }]] = await Promise.all([
    db
      .select({
        id: users.id,
        username: users.username,
        fullName: users.fullName,
        phone: users.phone,
        status: users.status,
        mustChangePassword: users.mustChangePassword,
        hasPassword: sql<boolean>`${users.passwordHash} IS NOT NULL`,
        sectionId: users.sectionId,
        sectionName: sections.name,
        rankId: users.rankId,
        rankName: ranks.name,
        rankKey: ranks.systemKey,
        platoonId: users.platoonId,
        platoonName: platoons.name,
        platoonRole: users.platoonRole,
      })
      .from(users)
      .leftJoin(sections, eq(sections.id, users.sectionId))
      .leftJoin(ranks, eq(ranks.id, users.rankId))
      .leftJoin(platoons, eq(platoons.id, users.platoonId))
      .where(cond)
      .orderBy(asc(users.fullName), asc(users.id))
      .limit(pageSize)
      .offset((page - 1) * pageSize),
    db.select({ total: count() }).from(users).where(cond),
  ]);
  return {
    rows: rows.map(({ rankKey, ...r }) => ({ ...r, isCaptain: rankKey === 'captain' })),
    total,
    page,
    pageSize,
  };
}
export type UserListItem = Awaited<ReturnType<typeof listUsers>>['rows'][number];

// ─── 详情 ─────────────────────────────────────────────

export async function getUserDetail(actor: CurrentUser, id: string, meta: RequestMeta) {
  const target = await loadTarget(db, id);
  if (target.accountType === 'superadmin') throw notFound();
  await assertInScope(actor, target);
  const perms = await getPermissionsFor(actor);
  const sensitive = perms.has('users.view_sensitive');

  const reason = alias(inactiveReasons, 'reason');
  const [u] = await db
    .select({
      id: users.id, username: users.username, email: users.email, fullName: users.fullName,
      idType: users.idType, idNumberEnc: users.idNumberEnc, gender: users.gender,
      dateOfBirth: users.dateOfBirth, joinDate: users.joinDate, phone: users.phone,
      address: users.address, school: users.school, status: users.status,
      inactiveNote: users.inactiveNote, statusChangedAt: users.statusChangedAt,
      inactiveReason: reason.name, mustChangePassword: users.mustChangePassword,
      hasPassword: sql<boolean>`${users.passwordHash} IS NOT NULL`,
      sectionId: users.sectionId, sectionName: sections.name, sectionKey: sections.systemKey,
      rankId: users.rankId, rankName: ranks.name, rankKey: ranks.systemKey,
      platoonId: users.platoonId, platoonName: platoons.name, platoonRole: users.platoonRole,
      updatedAt: users.updatedAt,
    })
    .from(users)
    .leftJoin(sections, eq(sections.id, users.sectionId))
    .leftJoin(ranks, eq(ranks.id, users.rankId))
    .leftJoin(platoons, eq(platoons.id, users.platoonId))
    .leftJoin(reason, eq(reason.id, users.inactiveReasonId))
    .where(eq(users.id, id));

  let idNumber: string | null = null;
  if (u.idNumberEnc) {
    const plain = decryptIdNumber(u.idNumberEnc, u.id);
    idNumber = sensitive ? plain : maskIdNumber(plain);
    if (sensitive) {
      // 每次查看完整证件号都留下记录
      await db.transaction((tx) =>
        writeAudit(tx, { actorId: actor.id, meta }, { action: 'VIEW_SENSITIVE', entityType: 'users', entityId: u.id }),
      );
    }
  }

  const gs = await db
    .select({ slot: guardians.slot, name: guardians.name, relationship: guardians.relationship, phone: guardians.phone, email: guardians.email })
    .from(guardians)
    .where(eq(guardians.userId, id))
    .orderBy(asc(guardians.slot));

  const fromRank = alias(ranks, 'from_rank');
  const toRank = alias(ranks, 'to_rank');
  const changer = alias(users, 'changer');
  const history = await db
    .select({ from: fromRank.name, to: toRank.name, reason: rankHistory.reason, at: rankHistory.changedAt, by: changer.fullName })
    .from(rankHistory)
    .leftJoin(fromRank, eq(fromRank.id, rankHistory.fromRankId))
    .innerJoin(toRank, eq(toRank.id, rankHistory.toRankId))
    .leftJoin(changer, eq(changer.id, rankHistory.changedBy))
    .where(eq(rankHistory.userId, id))
    .orderBy(desc(rankHistory.changedAt));

  let audit: { action: string; at: Date; by: string | null; reason: string | null }[] | null = null;
  if (perms.has('audit.view')) {
    const actorU = alias(users, 'actor');
    audit = await db
      .select({ action: auditLogs.action, at: auditLogs.createdAt, by: actorU.fullName, reason: auditLogs.reason })
      .from(auditLogs)
      .leftJoin(actorU, eq(actorU.id, auditLogs.actorId))
      .where(and(eq(auditLogs.entityType, 'users'), eq(auditLogs.entityId, id), ne(auditLogs.action, 'VIEW_SENSITIVE')))
      .orderBy(desc(auditLogs.createdAt))
      .limit(10);
  }

  const { idNumberEnc: _enc, rankKey, sectionKey, ...rest } = u; // eslint-disable-line @typescript-eslint/no-unused-vars
  return {
    ...rest,
    idNumber,
    idNumberVisible: sensitive,
    isCaptain: rankKey === 'captain',
    isOfficer: sectionKey === 'officer',
    isSelf: actor.id === id,
    guardians: gs.map((g) => (sensitive ? g : { ...g, phone: g.phone ? '••••' : null, email: g.email ? '••••' : null })),
    rankHistory: history,
    audit,
    permissions: [...perms] as PermissionSlug[],
  };
}
export type UserDetail = Awaited<ReturnType<typeof getUserDetail>>;

// ─── 新增 ─────────────────────────────────────────────

/** 覆盖写入监护人；返回旧资料，供审计记录（被移除的监护人内容保存在审计里） */
export async function writeGuardians(tx: Tx, userId: string, list: { name: string; relationship: 'father' | 'mother' | 'guardian' | 'other'; phone: string; email?: string | null }[]) {
  const before = await tx
    .select({ slot: guardians.slot, name: guardians.name, relationship: guardians.relationship, phone: guardians.phone, email: guardians.email })
    .from(guardians)
    .where(eq(guardians.userId, userId));
  await tx.delete(guardians).where(eq(guardians.userId, userId));
  if (list.length) {
    await tx.insert(guardians).values(list.map((g, i) => ({ userId, slot: i + 1, name: g.name, relationship: g.relationship, phone: g.phone, email: g.email ?? null })));
  }
  return before;
}

function mapUniqueViolation(err: unknown): never {
  const c = (err as { cause?: { constraint?: string }; constraint?: string });
  const constraint = c?.constraint ?? c?.cause?.constraint;
  if (constraint === 'users_username_lower_uq') throw validationError({ username: 'That username is already taken.' });
  if (constraint === 'users_id_number_hash_uq') throw validationError({ idNumber: 'This ID number is already registered.' });
  throw err;
}

/**
 * 同一个号码不论登记成哪种证件（MyKad / 护照 / other）都算同一个人。
 * 资料库的唯一索引只比对同类型，所以这里再跨类型比对一次（加锁防止同时登记）。
 */
async function assertIdNumberFree(tx: Tx, idType: string, idNum: string, exceptId: string) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'idnum:' + idNum}))`);
  const others = (['mykad', 'passport', 'other'] as const).filter((t) => t !== idType).map((t) => idLookupHash(t, idNum));
  const [hit] = await tx.select({ id: users.id }).from(users).where(and(inArray(users.idNumberHash, others), ne(users.id, exceptId))).limit(1);
  if (hit) throw validationError({ idNumber: 'This ID number is already registered.' });
}

export async function createUser(actor: CurrentUser, input: CreateUserInput, meta: RequestMeta) {
  const parsed = createUserSchema.safeParse(input);
  if (!parsed.success) throw validationError(fieldErrorsOf(parsed.error));
  const v = parsed.data;
  await assertInScope(actor, { sectionId: v.sectionId, platoonId: v.platoonId ?? null });
  if (v.idType !== 'none' && !(await can(actor, 'users.view_sensitive'))) {
    throw validationError({ idNumber: 'You do not have permission to set ID numbers.' });
  }
  const idNum = v.idType === 'none' ? null : normalizeIdNumber(v.idType as IdType, v.idNumber!);
  if (v.tempPassword) {
    const policy = checkTempPasswordPolicy(v.tempPassword, [v.username, idNum]);
    if (policy) throw validationError({ tempPassword: policy });
  }

  const id = randomUUID();
  const passwordHash = v.tempPassword ? await hashPassword(v.tempPassword) : null;

  try {
    return await db.transaction(async (tx) => {
      await assertAssignableRank(tx, v.sectionId, v.rankId);
      const platoonId = await resolvePlatoon(tx, v.sectionId, v.platoonId);
      const officer = await isOfficerSection(tx, v.sectionId);
      if (!actor.isCaptain && !actor.isSuperadmin) {
        // 只有军官能新增军官
        if (officer && !(await isOfficerOrAbove(actor))) throw new AppError('FORBIDDEN', 'Only officers can add officers.');
        // 军阶可能带有权限：不能借新增成员给出自己没有的权限（例如自己设临时密码再登入）
        const mine = await getPermissionsFor(actor);
        const grants = await tx.select({ slug: rankPermissions.permissionSlug }).from(rankPermissions).where(eq(rankPermissions.rankId, v.rankId));
        const gives = applyOfficerOnly(new Set(grants.map((g) => g.slug as PermissionSlug)), officer);
        if ([...gives].some((p) => !mine.has(p))) throw validationError({ rankId: 'This rank gives permissions you do not have. Ask the Captain to add this member.' });
      }
      if (idNum) await assertIdNumberFree(tx, v.idType, idNum, id);
      const [row] = await tx
        .insert(users)
        .values({
          id, username: v.username, email: v.email, passwordHash, mustChangePassword: !!passwordHash,
          idType: v.idType,
          idNumberEnc: idNum ? encryptIdNumber(idNum, id) : null,
          idNumberHash: idNum ? idLookupHash(v.idType, idNum) : null,
          fullName: v.fullName, gender: v.gender, dateOfBirth: v.dateOfBirth, joinDate: v.joinDate,
          phone: v.phone ?? null, address: v.address ?? null, school: v.school ?? null,
          sectionId: v.sectionId, rankId: v.rankId, platoonId, createdBy: actor.id, updatedBy: actor.id,
        })
        .returning();
      if (!officer) await writeGuardians(tx, id, v.guardians);
      const changeSetId = randomUUID();
      await tx.insert(rankHistory).values({ userId: id, toSectionId: v.sectionId, toRankId: v.rankId, reason: 'Initial rank', changedBy: actor.id, changeSetId });
      await writeAudit(tx, { actorId: actor.id, meta, changeSetId }, {
        action: 'USER_CREATED', entityType: 'users', entityId: id,
        after: { ...auditSnapshot(row, [...USER_AUDIT_FIELDS]), idNumber: idNum ? maskIdNumber(idNum) : null, guardians: officer ? 0 : v.guardians.length },
      });
      return { id };
    });
  } catch (err) {
    mapUniqueViolation(err);
  }
}

// ─── 编辑资料 ─────────────────────────────────────────

export async function updateUser(actor: CurrentUser, id: string, input: UpdateUserInput, meta: RequestMeta) {
  const parsed = updateUserSchema.safeParse(input);
  if (!parsed.success) throw validationError(fieldErrorsOf(parsed.error));
  const v = parsed.data;
  const sensitive = await can(actor, 'users.view_sensitive');

  try {
    return await db.transaction(async (tx) => {
      const target = await loadTarget(tx, id);
      await assertCanManage(actor, target, 'update');
      const [before] = await tx.select().from(users).where(eq(users.id, id)).for('update');

      if (v.expectedUpdatedAt && before.updatedAt.toISOString() !== v.expectedUpdatedAt) {
        throw new AppError('CONFLICT', 'This member was changed by someone else. Reload to see the latest.');
      }

      const changes: Partial<typeof users.$inferInsert> = {
        username: v.username, email: v.email, fullName: v.fullName, gender: v.gender,
        dateOfBirth: v.dateOfBirth, joinDate: v.joinDate, phone: v.phone ?? null,
        address: v.address ?? null, school: v.school ?? null, updatedAt: new Date(), updatedBy: actor.id,
      };
      // 换 Platoon：只有军官能改；换了之后 Leader / Assistant 身份清除
      if (v.platoonId !== undefined && v.platoonId !== before.platoonId && target.accountType === 'member') {
        if (!(await isOfficerOrAbove(actor))) throw new AppError('FORBIDDEN', 'Only officers can change platoons.');
        Object.assign(changes, { platoonId: await resolvePlatoon(tx, before.sectionId!, v.platoonId), platoonRole: null });
      }
      let idChanged = false;
      let idMask: string | null = null;
      if (sensitive && v.idType && target.accountType === 'member') {
        const idNum = v.idType === 'none' ? null : normalizeIdNumber(v.idType as IdType, v.idNumber!);
        const newHash = idNum ? idLookupHash(v.idType, idNum) : null;
        if (newHash !== before.idNumberHash || v.idType !== before.idType) {
          if (idNum) await assertIdNumberFree(tx, v.idType, idNum, id);
          idChanged = true;
          idMask = idNum ? maskIdNumber(idNum) : null;
          Object.assign(changes, { idType: v.idType, idNumberEnc: idNum ? encryptIdNumber(idNum, id) : null, idNumberHash: newHash });
        }
      }

      const [after] = await tx.update(users).set(changes).where(eq(users.id, id)).returning();
      let guardiansBefore: unknown[] | undefined;
      // 没有 users.view_sensitive 的人看不到监护人联络资料，所以也不能改（避免把看不到的资料覆盖掉）
      if (sensitive && target.accountType === 'member' && !(await isOfficerSection(tx, after.sectionId!))) {
        guardiansBefore = await writeGuardians(tx, id, v.guardians);
      }
      await writeAudit(tx, { actorId: actor.id, meta }, {
        action: 'USER_UPDATED', entityType: 'users', entityId: id,
        before: { ...auditSnapshot(before, [...USER_AUDIT_FIELDS]), ...(guardiansBefore ? { guardians: guardiansBefore } : {}) },
        after: {
          ...auditSnapshot(after, [...USER_AUDIT_FIELDS]),
          ...(idChanged ? { idNumber: idMask ?? 'removed' } : {}),
          ...(guardiansBefore ? { guardians: v.guardians } : {}),
        },
      });
      return { id };
    });
  } catch (err) {
    mapUniqueViolation(err);
  }
}

// ─── 改军阶（升阶页面，批量） ─────────────────────────

const MAX_BATCH = 100;

/** 在事务内改一个人的军阶；调用前已校验目标军阶 */
async function applyRankChange(tx: Tx, actor: CurrentUser, id: string, sectionId: number, rankId: number, reason: string, changeSetId: string, meta: RequestMeta) {
  const target = await loadTarget(tx, id);
  await assertCanManage(actor, target, 'rank');
  if (target.isCaptain) throw new AppError('FORBIDDEN', "The Captain's rank can only change through succession.");
  const [before] = await tx.select().from(users).where(eq(users.id, id)).for('update');
  if (before.rankId === rankId) throw new AppError('VALIDATION', 'Already holds this rank.');
  if (before.status !== 'active') throw new AppError('VALIDATION', 'Member is inactive.');
  if (!actor.isCaptain && !actor.isSuperadmin) {
    // 升阶后「新得到」的权限（包括升为军官后才生效的专属权限）都必须是自己有的
    const [now, raw, officerAfter, mine] = await Promise.all([loadPermissions(id), loadRawPermissions(id, rankId), isOfficerSection(tx, sectionId), getPermissionsFor(actor)]);
    const gained = [...applyOfficerOnly(raw, officerAfter)].filter((p) => !now.has(p));
    if (gained.some((p) => !mine.has(p))) throw new AppError('FORBIDDEN', 'This promotion would give permissions you do not have.');
  }

  // 换组别时离开原本的 Platoon（Platoon 属于组别）
  const leave = before.sectionId !== sectionId ? { platoonId: null, platoonRole: null } : {};
  const [after] = await tx.update(users).set({ sectionId, rankId, ...leave, updatedAt: new Date(), updatedBy: actor.id }).where(eq(users.id, id)).returning();
  await tx.insert(rankHistory).values({
    userId: id, fromSectionId: before.sectionId, fromRankId: before.rankId, toSectionId: sectionId, toRankId: rankId,
    reason, changedBy: actor.id, changeSetId,
  });
  await writeAudit(tx, { actorId: actor.id, meta, changeSetId }, {
    action: 'RANK_CHANGED', entityType: 'users', entityId: id, reason,
    before: auditSnapshot(before, ['sectionId', 'rankId', 'platoonId', 'platoonRole']), after: auditSnapshot(after, ['sectionId', 'rankId', 'platoonId', 'platoonRole']),
  });
}

/**
 * 到龄名单：各组别设定了「当年满 N 岁升组」时，列出今年会满 N 岁（含以上）的在职成员。
 * 按出生年份算（马来西亚时间的今年）。只列出操作人看得到的人。
 * 每个组别最多回传 AGE_UP_LIMIT 人（另给总数），避免名单太大拖慢页面。
 */
const AGE_UP_LIMIT = 200;
export async function ageUpCandidates(scope: MemberScope) {
  const year = Number(new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 4));
  const target = alias(ranks, 'target_rank');
  const targetSection = alias(sections, 'target_section');
  const rules = await db
    .select({ sectionId: sections.id, sectionName: sections.name, age: sections.ageUpAge, rankId: target.id, rankName: target.name, toSectionId: target.sectionId, toSectionName: targetSection.name })
    .from(sections)
    .innerJoin(target, eq(target.id, sections.ageUpRankId))
    .innerJoin(targetSection, eq(targetSection.id, target.sectionId))
    .where(and(eq(sections.isActive, true), eq(target.isActive, true), eq(targetSection.isActive, true)))
    .orderBy(asc(sections.sortOrder));
  const groups = [];
  for (const r of rules) {
    if (scope !== 'all' && !scope.sections.includes(r.sectionId)) continue;
    const members = await db
      .select({ id: users.id, fullName: users.fullName, username: users.username, rankName: ranks.name, dateOfBirth: users.dateOfBirth, total: sql<number>`count(*) over ()::int` })
      .from(users)
      .leftJoin(ranks, eq(ranks.id, users.rankId))
      .where(and(
        eq(users.accountType, 'member'), eq(users.status, 'active'), eq(users.sectionId, r.sectionId),
        sql`extract(year from ${users.dateOfBirth}) <= ${year - r.age!}`,
        scope !== 'all' && scope.platoonId !== null ? eq(users.platoonId, scope.platoonId) : undefined,
      ))
      .orderBy(asc(users.dateOfBirth), asc(users.fullName))
      .limit(AGE_UP_LIMIT);
    groups.push({ ...r, age: r.age!, total: members[0]?.total ?? 0, members: members.map(({ total: _t, ...m }) => ({ ...m, turns: year - Number(m.dateOfBirth!.slice(0, 4)) })) }); // eslint-disable-line @typescript-eslint/no-unused-vars
  }
  return { year, groups };
}
export type AgeUpGroup = Awaited<ReturnType<typeof ageUpCandidates>>['groups'][number];

/**
 * 批量升阶：所有选中的人改成同一个军阶，共用一个原因。
 * 全部成功才生效；任何一人不符合就整批不改，并逐一列出原因。
 */
export async function promoteMembers(
  actor: CurrentUser,
  input: { userIds: string[]; sectionId: number; rankId: number; reason: string },
  meta: RequestMeta,
) {
  // 服务层也检查权限（不只靠 action）
  if (!(await can(actor, 'users.change_rank')) || !(await isOfficerOrAbove(actor))) throw forbidden();
  const reason = reasonSchema.safeParse(input.reason);
  if (!reason.success) throw validationError({ reason: reason.error.issues[0].message });
  const ids = [...new Set(Array.isArray(input.userIds) ? input.userIds.map(String) : [])];
  if (ids.length === 0) throw validationError({ userIds: 'Select at least one member.' });
  if (ids.length > MAX_BATCH) throw validationError({ userIds: `Select at most ${MAX_BATCH} members at a time.` });
  const sectionId = Number(input.sectionId);
  const rankId = Number(input.rankId);

  return db.transaction(async (tx) => {
    await assertAssignableRank(tx, sectionId, rankId);
    // 军阶可能带有权限：非 Captain/Superadmin 不能借升阶给出自己没有的权限
    if (!actor.isCaptain && !actor.isSuperadmin) {
      const mine = await getPermissionsFor(actor);
      const grants = await tx.select({ slug: rankPermissions.permissionSlug }).from(rankPermissions).where(eq(rankPermissions.rankId, rankId));
      if (grants.some((g) => !mine.has(g.slug as PermissionSlug))) {
        throw new AppError('FORBIDDEN', 'This rank gives permissions you do not have. Ask the Captain to do this promotion.');
      }
    }
    const changeSetId = randomUUID(); // 整批共用，方便以后整批回退
    const failed: Record<string, string> = {};
    for (const id of ids) {
      try {
        await tx.transaction((sp) => applyRankChange(sp, actor, id, sectionId, rankId, reason.data, changeSetId, meta));
      } catch (err) {
        if (!(err instanceof AppError)) throw err;
        failed[id] = err.code === 'NOT_FOUND' ? 'Member not found.' : err.code === 'FORBIDDEN' && err.message === 'You do not have access.' ? 'You cannot change this member.' : err.message;
      }
    }
    if (Object.keys(failed).length) {
      throw new AppError('VALIDATION', `${Object.keys(failed).length} of ${ids.length} members cannot be changed. Nothing was saved.`, failed);
    }
    return { count: ids.length, changeSetId };
  });
}

/** 单人改军阶（保留给内部与测试使用；界面统一走升阶页面） */
export async function changeRank(actor: CurrentUser, id: string, input: { sectionId: number; rankId: number; reason: string }, meta: RequestMeta) {
  try {
    await promoteMembers(actor, { userIds: [id], sectionId: input.sectionId, rankId: input.rankId, reason: input.reason }, meta);
  } catch (err) {
    // 单人时把逐人错误还原成原来的形式
    if (err instanceof AppError && err.fieldErrors?.[id]) {
      const msg = err.fieldErrors[id];
      if (msg === 'Member not found.') throw notFound();
      if (msg === 'You cannot change this member.') throw forbidden();
      if (msg === 'Already holds this rank.') throw validationError({ rankId: 'Select a new rank.' });
      throw new AppError(msg.startsWith('You cannot') || msg.startsWith("The Captain") ? 'FORBIDDEN' : 'VALIDATION', msg);
    }
    throw err;
  }
}

// ─── 停用 / 启用 ─────────────────────────────────────

export async function setStatus(
  actor: CurrentUser, id: string,
  input: { status: 'active' | 'inactive'; reasonId?: number; note?: string; reason?: string },
  meta: RequestMeta,
) {
  const status = input?.status; // 只读一次
  if (status !== 'active' && status !== 'inactive') throw new AppError('VALIDATION', 'Invalid status.');
  return db.transaction(async (tx) => {
    const target = await loadTarget(tx, id);
    await assertCanManage(actor, target, 'status');
    if (target.isCaptain) throw new AppError('FORBIDDEN', 'The Captain cannot be deactivated.');
    const [before] = await tx.select().from(users).where(eq(users.id, id)).for('update');
    if (before.status === status) throw new AppError('CONFLICT', 'This member was changed by someone else. Reload to see the latest.');

    let changes: Partial<typeof users.$inferInsert>;
    let auditReason: string | null = null;
    if (status === 'inactive') {
      const reasonId = Number(input.reasonId);
      const [r] = isSmallId(reasonId) ? await tx.select().from(inactiveReasons).where(and(eq(inactiveReasons.id, reasonId), eq(inactiveReasons.isActive, true))) : [];
      if (!r) throw validationError({ reasonId: 'Select a reason.' });
      const note = String(input.note ?? '').trim().slice(0, 500) || null;
      if (r.requiresNote && !note) throw validationError({ note: 'Describe the reason.' });
      changes = { status: 'inactive', inactiveReasonId: r.id, inactiveNote: note, platoonRole: null }; // 停用就不再是队长 / 副队长
      auditReason = note ? `${r.name}: ${note}` : r.name;
    } else {
      // 不能复职到已停用的军阶 / 组别；原本的 Platoon 已停用就离开它
      const [org] = await tx
        .select({ rankActive: ranks.isActive, sectionActive: sections.isActive, platoonActive: platoons.isActive })
        .from(users)
        .leftJoin(ranks, eq(ranks.id, users.rankId))
        .leftJoin(sections, eq(sections.id, users.sectionId))
        .leftJoin(platoons, eq(platoons.id, users.platoonId))
        .where(eq(users.id, id));
      if (before.accountType !== 'superadmin' && (!org?.rankActive || !org?.sectionActive)) {
        throw new AppError('VALIDATION', "This member's rank or section is no longer active. Ask the Captain to reactivate it first.");
      }
      changes = { status: 'active', inactiveReasonId: null, inactiveNote: null, ...(org?.platoonActive === false ? { platoonId: null } : {}) };
      auditReason = String(input.reason ?? '').trim().slice(0, 500) || null;
    }

    const [after] = await tx
      .update(users)
      .set({ ...changes, statusChangedAt: new Date(), updatedAt: new Date(), updatedBy: actor.id })
      .where(eq(users.id, id))
      .returning();
    if (status === 'inactive') await revokeAllSessions(tx, id);
    await writeAudit(tx, { actorId: actor.id, meta }, {
      action: status === 'inactive' ? 'USER_DEACTIVATED' : 'USER_REACTIVATED',
      entityType: 'users', entityId: id, reason: auditReason,
      before: auditSnapshot(before, ['status', 'inactiveReasonId', 'inactiveNote', 'platoonId', 'platoonRole']),
      after: auditSnapshot(after, ['status', 'inactiveReasonId', 'inactiveNote', 'platoonId', 'platoonRole']),
    });
  });
}

// ─── 重设临时密码 ─────────────────────────────────────

/** 返回临时密码明文（只给操作人看一次，不存储、不写审计） */
export async function resetPassword(actor: CurrentUser, id: string, input: { password?: string; reason: string }, meta: RequestMeta) {
  const reason = reasonSchema.safeParse(input.reason);
  if (!reason.success) throw validationError({ reason: reason.error.issues[0].message });
  if (!(await can(actor, 'users.reset_password'))) throw forbidden();
  const temp = (typeof input.password === 'string' ? input.password.trim() : '') || generateTempPassword();

  return db.transaction(async (tx) => {
    const target = await loadTarget(tx, id);
    await assertCanManage(actor, target, 'reset');
    const [row] = await tx.select({ username: users.username, idNumberEnc: users.idNumberEnc }).from(users).where(eq(users.id, id));
    const policy = checkTempPasswordPolicy(temp, [row.username, row.idNumberEnc ? decryptIdNumber(row.idNumberEnc, id) : null]);
    if (policy) throw validationError({ password: policy });

    await tx
      .update(users)
      .set({
        passwordHash: await hashPassword(temp), mustChangePassword: true, passwordChangedAt: new Date(),
        failedLoginCount: 0, lockedUntil: null, updatedAt: new Date(), updatedBy: actor.id,
      })
      .where(eq(users.id, id));
    await revokeAllSessions(tx, id);
    await clearLoginFailures(tx, id); // 让新的临时密码可以马上登录
    await writeAudit(tx, { actorId: actor.id, meta }, { action: 'PASSWORD_RESET', entityType: 'users', entityId: id, reason: reason.data });
    return { tempPassword: temp };
  });
}

/** 详情页按钮显示用：当前用户对这个成员能做哪些操作 */
export async function allowedActions(actor: CurrentUser, detail: { id: string; isCaptain: boolean; status: string }) {
  const perms = await getPermissionsFor(actor);
  const target = await loadTarget(db, detail.id);
  const okFor = async (op: 'update' | 'status' | 'rank' | 'reset') => {
    try {
      await assertCanManage(actor, target, op);
      return true;
    } catch {
      return false;
    }
  };
  return {
    edit: perms.has('users.update') && (await okFor('update')),
    // 按钮只在真的能改时显示（权限比自己多的人只有 Captain 能改）
    access: (perms.has('permissions.manage') || actor.isCaptain || actor.isSuperadmin) && !(await userAccessBlock(actor, { id: detail.id, isCaptain: detail.isCaptain })),
    status: perms.has('users.update_status') && !detail.isCaptain && (await okFor('status')),
    resetPassword: perms.has('users.reset_password') && (await okFor('reset')),
  };
}

export { ALL_PERMISSIONS };
