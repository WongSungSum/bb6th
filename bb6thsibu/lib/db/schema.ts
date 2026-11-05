import { sql } from 'drizzle-orm';
import {
  pgTable, pgEnum, uuid, text, boolean, timestamp, date, jsonb,
  integer, smallint, smallserial, primaryKey, unique, uniqueIndex, index,
  foreignKey, check, type AnyPgColumn,
} from 'drizzle-orm/pg-core';

/*
 * 设计原则：
 * - 主资料（用户、组别、军阶、角色）一律不删除，只停用。
 * - 关系类资料（角色分配、个人权限调整）可移除，但移除前的内容会写入 audit_logs。
 * - Captain 身份 = 持有 system_key = 'captain' 的军阶；唯一性与变更限制由数据库触发器保证。
 */

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
};

// ─── 枚举 ─────────────────────────────────────────────

export const accountTypeEnum = pgEnum('account_type', ['member', 'superadmin']);
export const userStatusEnum = pgEnum('user_status', ['active', 'inactive']);
export const idTypeEnum = pgEnum('id_type', ['mykad', 'passport', 'other', 'none']);
export const genderEnum = pgEnum('gender', ['male', 'female']);
export const platformEnum = pgEnum('platform', ['web', 'apk']);
export const permissionEffectEnum = pgEnum('permission_effect', ['allow', 'deny']);
export const guardianRelationshipEnum = pgEnum('guardian_relationship', ['father', 'mother', 'guardian', 'other']);
export const changeRequestStatusEnum = pgEnum('change_request_status', ['pending', 'approved', 'rejected', 'cancelled']);
export const changeRequestKindEnum = pgEnum('change_request_kind', ['user_access', 'role', 'rank_access']);
export const platoonRoleEnum = pgEnum('platoon_role', ['leader', 'assistant']);

// ─── 组织结构 ─────────────────────────────────────────

export const sections = pgTable('sections', {
  id: smallserial('id').primaryKey(),
  name: text('name').notNull().unique(),
  // 系统固定组别的标记（目前只有 'officer'：不需要监护人、Captain 所属组别），不可停用
  systemKey: text('system_key').unique(),
  sortOrder: smallint('sort_order').default(0).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  // 到龄升组：当年满 age_up_age 岁的在职成员，列入名单升到 age_up_rank_id（另一个组别的军阶）；两者都空 = 不升
  ageUpAge: smallint('age_up_age'),
  ageUpRankId: smallint('age_up_rank_id').references((): AnyPgColumn => ranks.id, { onDelete: 'restrict' }),
  ...timestamps,
}, (t) => [
  check('sections_age_up_ck', sql`(${t.ageUpAge} is null) = (${t.ageUpRankId} is null) and (${t.ageUpAge} is null or ${t.ageUpAge} between 4 and 25)`),
]);

export const ranks = pgTable('ranks', {
  id: smallserial('id').primaryKey(),
  sectionId: smallint('section_id').notNull().references(() => sections.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  // 系统固定军阶的标记（目前只有 'captain'），不可改名、停用或删除
  systemKey: text('system_key').unique(),
  sortOrder: smallint('sort_order').default(0).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  ...timestamps,
}, (t) => [
  unique('ranks_section_name_uq').on(t.sectionId, t.name),
  // 供 users (rank_id, section_id) 复合外键使用，保证军阶属于所选组别
  unique('ranks_id_section_uq').on(t.id, t.sectionId),
]);

// Platoon：组别底下的小队（目前用于 Senior）。每人同时只在一个 Platoon。
export const platoons = pgTable('platoons', {
  id: smallserial('id').primaryKey(),
  sectionId: smallint('section_id').notNull().references(() => sections.id, { onDelete: 'restrict' }),
  name: text('name').notNull(),
  sortOrder: smallint('sort_order').default(0).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  ...timestamps,
}, (t) => [
  uniqueIndex('platoons_name_lower_uq').on(sql`lower(${t.name})`),
  // 供 users (platoon_id, section_id) 复合外键使用，保证 Platoon 属于成员的组别
  unique('platoons_id_section_uq').on(t.id, t.sectionId),
]);

export const inactiveReasons = pgTable('inactive_reasons', {
  id: smallserial('id').primaryKey(),
  name: text('name').notNull().unique(),
  requiresNote: boolean('requires_note').default(false).notNull(),
  sortOrder: smallint('sort_order').default(0).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
  ...timestamps,
});

// ─── 用户 ─────────────────────────────────────────────

export const users = pgTable('users', {
  id: uuid('id').defaultRandom().primaryKey(),
  accountType: accountTypeEnum('account_type').default('member').notNull(),

  username: text('username').notNull(),
  email: text('email').notNull(), // 可重复（兄弟可共用父母 email）

  passwordHash: text('password_hash'), // 为空 = 不能登录
  mustChangePassword: boolean('must_change_password').default(false).notNull(),
  passwordChangedAt: timestamp('password_changed_at', { withTimezone: true }),

  idType: idTypeEnum('id_type').default('none').notNull(),
  idNumberEnc: text('id_number_enc'),   // AES-GCM 加密后的证件号
  idNumberHash: text('id_number_hash'), // HMAC，用于登录查找与唯一性

  fullName: text('full_name').notNull(),
  gender: genderEnum('gender'),
  dateOfBirth: date('date_of_birth'),
  joinDate: date('join_date'),
  phone: text('phone'),
  address: text('address'),
  school: text('school'),
  avatarUrl: text('avatar_url'),

  sectionId: smallint('section_id').references(() => sections.id, { onDelete: 'restrict' }),
  rankId: smallint('rank_id'),
  platoonId: smallint('platoon_id'),
  platoonRole: platoonRoleEnum('platoon_role'), // 空 = 普通队员

  status: userStatusEnum('status').default('active').notNull(),
  inactiveReasonId: smallint('inactive_reason_id').references(() => inactiveReasons.id, { onDelete: 'restrict' }),
  inactiveNote: text('inactive_note'),
  statusChangedAt: timestamp('status_changed_at', { withTimezone: true }),

  failedLoginCount: smallint('failed_login_count').default(0).notNull(),
  lockedUntil: timestamp('locked_until', { withTimezone: true }),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),

  ...timestamps,
  createdBy: uuid('created_by').references((): AnyPgColumn => users.id, { onDelete: 'restrict' }),
  updatedBy: uuid('updated_by').references((): AnyPgColumn => users.id, { onDelete: 'restrict' }),
}, (t) => [
  uniqueIndex('users_username_lower_uq').on(sql`lower(${t.username})`),
  uniqueIndex('users_id_number_hash_uq').on(t.idNumberHash),
  // 全系统只能有一个 superadmin
  uniqueIndex('users_single_superadmin_uq').on(t.accountType).where(sql`${t.accountType} = 'superadmin'`),
  index('users_section_idx').on(t.sectionId),
  index('users_rank_idx').on(t.rankId),
  index('users_status_idx').on(t.status),
  foreignKey({
    name: 'users_rank_section_fk',
    columns: [t.rankId, t.sectionId],
    foreignColumns: [ranks.id, ranks.sectionId],
  }).onDelete('restrict'),
  foreignKey({
    name: 'users_platoon_section_fk',
    columns: [t.platoonId, t.sectionId],
    foreignColumns: [platoons.id, platoons.sectionId],
  }).onDelete('restrict'),
  index('users_platoon_idx').on(t.platoonId),
  // 成员列表预设按姓名排序：有索引就不用每页都把全部成员排一次
  index('users_full_name_idx').on(t.fullName, t.id),
  check('users_platoon_role_ck', sql`${t.platoonRole} IS NULL OR ${t.platoonId} IS NOT NULL`),
  // 每个 Platoon 最多一位 Leader、一位 Assistant Leader
  uniqueIndex('users_platoon_role_uq').on(t.platoonId, t.platoonRole).where(sql`${t.platoonRole} IS NOT NULL`),
  check('users_account_type_org_ck', sql`
    (${t.accountType} = 'superadmin' AND ${t.sectionId} IS NULL AND ${t.rankId} IS NULL)
    OR (${t.accountType} = 'member' AND ${t.sectionId} IS NOT NULL AND ${t.rankId} IS NOT NULL)
  `),
  check('users_id_number_ck', sql`
    (${t.idType} = 'none' AND ${t.idNumberEnc} IS NULL AND ${t.idNumberHash} IS NULL)
    OR (${t.idType} <> 'none' AND ${t.idNumberEnc} IS NOT NULL AND ${t.idNumberHash} IS NOT NULL)
  `),
  check('users_status_reason_ck', sql`
    (${t.status} = 'active' AND ${t.inactiveReasonId} IS NULL)
    OR (${t.status} = 'inactive' AND ${t.inactiveReasonId} IS NOT NULL)
  `),
]);

export const guardians = pgTable('guardians', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  slot: smallint('slot').notNull(), // 第 1 位或第 2 位
  name: text('name').notNull(),
  relationship: guardianRelationshipEnum('relationship').notNull(),
  phone: text('phone'),
  email: text('email'),
  ...timestamps,
}, (t) => [
  unique('guardians_user_slot_uq').on(t.userId, t.slot),
  check('guardians_slot_ck', sql`${t.slot} IN (1, 2)`),
]);

export const rankHistory = pgTable('rank_history', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  fromSectionId: smallint('from_section_id').references(() => sections.id),
  fromRankId: smallint('from_rank_id').references(() => ranks.id),
  toSectionId: smallint('to_section_id').notNull().references(() => sections.id),
  toRankId: smallint('to_rank_id').notNull().references(() => ranks.id),
  reason: text('reason').notNull(),
  changedBy: uuid('changed_by').references(() => users.id),
  changedAt: timestamp('changed_at', { withTimezone: true }).defaultNow().notNull(),
  changeSetId: uuid('change_set_id').notNull(),
}, (t) => [
  index('rank_history_user_idx').on(t.userId, t.changedAt),
]);

// ─── 登录安全 ─────────────────────────────────────────

export const sessions = pgTable('sessions', {
  id: uuid('id').defaultRandom().primaryKey(),
  tokenHash: text('token_hash').notNull().unique(), // 只存 token 的 SHA-256
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  platform: platformEnum('platform').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  ip: text('ip'),
  userAgent: text('user_agent'),
}, (t) => [
  index('sessions_user_idx').on(t.userId),
]);

export const loginAttempts = pgTable('login_attempts', {
  id: uuid('id').defaultRandom().primaryKey(),
  identifierHash: text('identifier_hash').notNull(), // 输入的账号经 HMAC，不存明文
  ip: text('ip'),
  success: boolean('success').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('login_attempts_ip_idx').on(t.ip, t.createdAt),
  index('login_attempts_identifier_idx').on(t.identifierHash, t.createdAt),
]);

// ─── 权限 ─────────────────────────────────────────────

export const permissions = pgTable('permissions', {
  slug: text('slug').primaryKey(), // 例如 users.view
  module: text('module').notNull(),
  description: text('description').notNull(),
  sortOrder: smallint('sort_order').default(0).notNull(),
  isActive: boolean('is_active').default(true).notNull(),
});

export const roles = pgTable('roles', {
  id: smallserial('id').primaryKey(),
  name: text('name').notNull().unique(),
  description: text('description'),
  isActive: boolean('is_active').default(true).notNull(),
  ...timestamps,
  createdBy: uuid('created_by').references(() => users.id),
});

// 角色只负责「给」权限
export const rolePermissions = pgTable('role_permissions', {
  roleId: smallint('role_id').notNull().references(() => roles.id, { onDelete: 'restrict' }),
  permissionSlug: text('permission_slug').notNull().references(() => permissions.slug, { onDelete: 'restrict' }),
  grantedBy: uuid('granted_by').references(() => users.id),
  grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ name: 'role_permissions_pk', columns: [t.roleId, t.permissionSlug] }),
]);

export const userRoles = pgTable('user_roles', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  roleId: smallint('role_id').notNull().references(() => roles.id, { onDelete: 'restrict' }),
  assignedBy: uuid('assigned_by').references(() => users.id),
  assignedAt: timestamp('assigned_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ name: 'user_roles_pk', columns: [t.userId, t.roleId] }),
  index('user_roles_role_idx').on(t.roleId),
]);

// 没有记录 = 跟随角色（INHERIT）
export const userPermissionOverrides = pgTable('user_permission_overrides', {
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'restrict' }),
  permissionSlug: text('permission_slug').notNull().references(() => permissions.slug, { onDelete: 'restrict' }),
  effect: permissionEffectEnum('effect').notNull(),
  reason: text('reason'),
  setBy: uuid('set_by').references(() => users.id),
  setAt: timestamp('set_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ name: 'user_permission_overrides_pk', columns: [t.userId, t.permissionSlug] }),
]);

// 军阶给的权限（持有该军阶的人自动获得）
export const rankPermissions = pgTable('rank_permissions', {
  rankId: smallint('rank_id').notNull().references(() => ranks.id, { onDelete: 'restrict' }),
  permissionSlug: text('permission_slug').notNull().references(() => permissions.slug, { onDelete: 'restrict' }),
  grantedBy: uuid('granted_by').references(() => users.id),
  grantedAt: timestamp('granted_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  primaryKey({ name: 'rank_permissions_pk', columns: [t.rankId, t.permissionSlug] }),
]);

/*
 * 权限变更申请：被授权者（permissions.manage）提出的改动，要 Captain 确认后才生效。
 * changes 存「要做的改动」，批准时才套用。申请记录不能删除。
 */
export const permissionChangeRequests = pgTable('permission_change_requests', {
  id: uuid('id').defaultRandom().primaryKey(),
  kind: changeRequestKindEnum('kind').notNull(),
  targetId: text('target_id').notNull(), // user uuid / role id / rank id
  changes: jsonb('changes').notNull(),
  reason: text('reason'),
  status: changeRequestStatusEnum('status').default('pending').notNull(),
  requestedBy: uuid('requested_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  requestedAt: timestamp('requested_at', { withTimezone: true }).defaultNow().notNull(),
  decidedBy: uuid('decided_by').references(() => users.id, { onDelete: 'restrict' }),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionNote: text('decision_note'),
}, (t) => [
  index('permission_change_requests_status_idx').on(t.status, t.requestedAt),
  // 同一对象同时只能有一个待批申请
  uniqueIndex('permission_change_requests_one_pending_uq').on(t.kind, t.targetId).where(sql`${t.status} = 'pending'`),
]);

// ─── Platoon 计分 ─────────────────────────────────────

// Platoon 活动：不删除，作废用 voided_at
export const platoonActivities = pgTable('platoon_activities', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  activityDate: date('activity_date').notNull(),
  note: text('note'),
  voidedAt: timestamp('voided_at', { withTimezone: true }),
  voidedBy: uuid('voided_by').references(() => users.id, { onDelete: 'restrict' }),
  voidReason: text('void_reason'),
  createdBy: uuid('created_by').notNull().references(() => users.id, { onDelete: 'restrict' }),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'restrict' }),
  ...timestamps,
}, (t) => [
  index('platoon_activities_date_idx').on(t.activityDate),
  check('platoon_activities_void_ck', sql`(${t.voidedAt} IS NULL) = (${t.voidReason} IS NULL)`),
]);

// 每个活动每个 Platoon 的得分
export const platoonScores = pgTable('platoon_scores', {
  activityId: uuid('activity_id').notNull().references(() => platoonActivities.id, { onDelete: 'restrict' }),
  platoonId: smallint('platoon_id').notNull().references(() => platoons.id, { onDelete: 'restrict' }),
  // null = 没参加（分数被清掉）。分数不能删除，所以用 null 表示
  points: integer('points'),
}, (t) => [
  primaryKey({ name: 'platoon_scores_pk', columns: [t.activityId, t.platoonId] }),
  check('platoon_scores_points_ck', sql`${t.points} BETWEEN -1000 AND 1000`),
]);

// ─── 审计 ─────────────────────────────────────────────

// 只能新增，不能修改或删除（由数据库触发器保证）
export const auditLogs = pgTable('audit_logs', {
  id: uuid('id').defaultRandom().primaryKey(),
  changeSetId: uuid('change_set_id').notNull(), // 同一操作的多条记录共用，便于整组回退
  actorId: uuid('actor_id').references(() => users.id), // 为空 = 系统
  action: text('action').notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  before: jsonb('before'),
  after: jsonb('after'),
  reason: text('reason'),
  ip: text('ip'),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (t) => [
  index('audit_logs_entity_idx').on(t.entityType, t.entityId, t.createdAt.desc()),
  index('audit_logs_change_set_idx').on(t.changeSetId),
  index('audit_logs_actor_idx').on(t.actorId),
  index('audit_logs_created_idx').on(t.createdAt),
]);
