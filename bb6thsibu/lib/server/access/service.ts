import { and, asc, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { db, type Tx } from '@/lib/db/client';
import {
  permissionChangeRequests, permissions, rankPermissions, ranks, rolePermissions, roles, sections,
  userPermissionOverrides, userRoles, users,
} from '@/lib/db/schema';
import type { CurrentUser } from '@/lib/server/auth/session';
import { assertInScope, getPermissionsFor, inScope, loadPermissions, memberScopeOf, loadRawPermissions, resolvePermissions, type MemberScope } from '@/lib/server/authz';
import { ALL_PERMISSIONS, OFFICER_ONLY, type PermissionSlug } from '@/lib/server/authz/catalog';
import { writeAudit, type AuditEntry } from '@/lib/server/audit';
import { AppError, forbidden } from '@/lib/server/errors';
import type { RequestMeta } from '@/lib/server/request';
import { cleanName } from '@/lib/validation/text';

/*
 * 权限管理（角色、军阶权限、个人权限）
 * - Captain / Superadmin：改动立即生效
 * - 被授权者（permissions.manage）：改动变成「申请」，Captain 确认后才生效
 * - 被授权者只能给出自己拥有的权限；不能改自己、Captain 或权限比自己多的人
 * 有效权限 =（角色 ∪ 军阶）+ 个人 ALLOW − 个人 DENY
 */

type Effect = 'inherit' | 'allow' | 'deny';
export type UserAccessChanges = {
  addRoles: number[];
  removeRoles: number[];
  overrides: { slug: PermissionSlug; from: Effect; to: Effect; reason: string | null }[];
};
export type RoleChanges = {
  create?: boolean;
  name?: { from: string | null; to: string };
  description?: { from: string | null; to: string | null };
  isActive?: { from: boolean; to: boolean };
  addPermissions: PermissionSlug[];
  removePermissions: PermissionSlug[];
};
export type RankAccessChanges = { addPermissions: PermissionSlug[]; removePermissions: PermissionSlug[] };

const fail = (message: string, fieldErrors?: Record<string, string>) => new AppError('VALIDATION', message, fieldErrors);
const isSmallId = (n: number) => Number.isInteger(n) && n > 0 && n <= 32767;
const isSlug = (s: unknown): s is PermissionSlug => typeof s === 'string' && (ALL_PERMISSIONS as string[]).includes(s);
const reasonOf = (r: unknown) => {
  const v = typeof r === 'string' ? r.trim() : '';
  if (v.length > 500) throw fail('Reason is too long.', { reason: 'Use at most 500 characters.' });
  return v || null;
};
const slugList = (list: unknown) => {
  if (!Array.isArray(list)) return [] as PermissionSlug[];
  const out = [...new Set(list)];
  if (!out.every(isSlug)) throw fail('Unknown permission.');
  return out as PermissionSlug[];
};

export const isPrivileged = (u: CurrentUser) => u.isCaptain || u.isSuperadmin;

/** 能进入权限管理的人 */
export async function assertCanManageAccess(actor: CurrentUser) {
  if (isPrivileged(actor)) return;
  if (!(await getPermissionsFor(actor)).has('permissions.manage')) throw forbidden();
}

/** 被授权者只能给出自己拥有的权限；removed = 也只能拿走自己有的权限（不能削减比自己高的人） */
async function assertCanGrant(actor: CurrentUser, granted: Iterable<PermissionSlug>, removed: Iterable<PermissionSlug> = []) {
  if (isPrivileged(actor)) return;
  const mine = await getPermissionsFor(actor);
  const missing = [...granted].filter((p) => !mine.has(p));
  if (missing.length) throw new AppError('FORBIDDEN', `You cannot grant permissions you do not have: ${missing.join(', ')}.`);
  const notMine = [...removed].filter((p) => !mine.has(p));
  if (notMine.length) throw new AppError('FORBIDDEN', `You cannot remove permissions you do not have: ${notMine.join(', ')}.`);
}

// ─── 目录 ─────────────────────────────────────────────

export async function listPermissionCatalog() {
  return db
    .select({ slug: permissions.slug, module: permissions.module, description: permissions.description })
    .from(permissions)
    .where(eq(permissions.isActive, true))
    .orderBy(asc(permissions.sortOrder));
}

// ─── 角色 ─────────────────────────────────────────────

export async function listRoles() {
  const rows = await db
    .select({
      id: roles.id, name: roles.name, description: roles.description, isActive: roles.isActive,
      // 子查询里明确写表名，避免 "id" 被解析成 users.id
      permissionCount: sql<number>`(select count(*)::int from role_permissions rp where rp.role_id = "roles"."id")`,
      memberCount: sql<number>`(select count(*)::int from user_roles ur join users u on u.id = ur.user_id where ur.role_id = "roles"."id" and u.status = 'active')`,
    })
    .from(roles)
    .orderBy(desc(roles.isActive), asc(roles.name));
  const pending = await pendingTargets('role');
  return rows.map((r) => ({ ...r, pending: pending.has(String(r.id)) }));
}

/** scope：角色页只列出看得到的成员 */
export async function getRole(id: number, scope: MemberScope = 'all') {
  if (!isSmallId(id)) return null;
  const [role] = await db.select().from(roles).where(eq(roles.id, id));
  if (!role) return null;
  const [perms, members] = await Promise.all([
    db.select({ slug: rolePermissions.permissionSlug }).from(rolePermissions).where(eq(rolePermissions.roleId, id)),
    db
      .select({ id: users.id, fullName: users.fullName, username: users.username, status: users.status, sectionId: users.sectionId, platoonId: users.platoonId })
      .from(userRoles)
      .innerJoin(users, eq(users.id, userRoles.userId))
      .where(eq(userRoles.roleId, id))
      .orderBy(asc(users.fullName)),
  ]);
  const pending = await pendingTargets('role');
  const visible = members.filter((m) => inScope(scope, m)).map(({ sectionId: _s, platoonId: _p, ...m }) => m); // eslint-disable-line @typescript-eslint/no-unused-vars
  return { ...role, permissions: perms.map((p) => p.slug as PermissionSlug), members: visible, hiddenMembers: members.length - visible.length, pending: pending.has(String(id)) };
}

async function computeRoleChanges(tx: Tx | typeof db, roleId: number | null, input: { name: unknown; description: unknown; isActive: unknown; permissions: unknown }): Promise<RoleChanges> {
  const cleaned = cleanName(input.name);
  if ('error' in cleaned) throw fail('Please fix the highlighted fields.', { name: cleaned.error === 'empty' ? 'Enter a role name.' : cleaned.error });
  const name = cleaned.name;
  if (name.length > 50) throw fail('Please fix the highlighted fields.', { name: 'Use at most 50 characters.' });
  const description = typeof input.description === 'string' ? input.description.trim().slice(0, 200) || null : null;
  if (input.isActive !== undefined && typeof input.isActive !== 'boolean') throw fail('Invalid value.');
  const isActive = input.isActive !== false;
  const wanted = slugList(input.permissions);

  if (roleId === null) {
    const [dup] = await tx.select({ id: roles.id }).from(roles).where(sql`lower(${roles.name}) = lower(${name})`);
    if (dup) throw fail('Please fix the highlighted fields.', { name: 'A role with this name already exists.' });
    return { create: true, name: { from: null, to: name }, description: { from: null, to: description }, isActive: { from: true, to: isActive }, addPermissions: wanted, removePermissions: [] };
  }
  const [role] = await tx.select().from(roles).where(eq(roles.id, roleId));
  if (!role) throw new AppError('NOT_FOUND', 'Role not found.');
  if (name.toLowerCase() !== role.name.toLowerCase()) {
    const [dup] = await tx.select({ id: roles.id }).from(roles).where(sql`lower(${roles.name}) = lower(${name})`);
    if (dup) throw fail('Please fix the highlighted fields.', { name: 'A role with this name already exists.' });
  }
  const current = (await tx.select({ slug: rolePermissions.permissionSlug }).from(rolePermissions).where(eq(rolePermissions.roleId, roleId))).map((r) => r.slug);
  const c: RoleChanges = {
    addPermissions: wanted.filter((p) => !current.includes(p)),
    removePermissions: current.filter((p) => !wanted.includes(p as PermissionSlug)) as PermissionSlug[],
  };
  if (name !== role.name) c.name = { from: role.name, to: name };
  if (description !== role.description) c.description = { from: role.description, to: description };
  if (isActive !== role.isActive) c.isActive = { from: role.isActive, to: isActive };
  return c;
}

const roleChangeEmpty = (c: RoleChanges) => !c.create && !c.name && !c.description && !c.isActive && !c.addPermissions.length && !c.removePermissions.length;

async function applyRoleChanges(tx: Tx, actorId: string, roleId: number | null, c: RoleChanges): Promise<number> {
  let id = roleId;
  if (c.create) {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'name:role:' + c.name!.to.toLowerCase()}))`); // 同时建立同名角色时排队
    const [dup] = await tx.select({ id: roles.id }).from(roles).where(sql`lower(${roles.name}) = lower(${c.name!.to})`);
    if (dup) throw new AppError('CONFLICT', 'A role with this name now exists. Reject this request and create it again.');
    const [row] = await tx.insert(roles).values({ name: c.name!.to, description: c.description?.to ?? null, isActive: c.isActive?.to ?? true, createdBy: actorId }).returning({ id: roles.id });
    id = row.id;
  } else {
    const [role] = await tx.select().from(roles).where(eq(roles.id, id!)).for('update');
    if (!role) throw new AppError('NOT_FOUND', 'Role not found.');
    const current = (await tx.select({ slug: rolePermissions.permissionSlug }).from(rolePermissions).where(eq(rolePermissions.roleId, id!))).map((r) => r.slug);
    const stale =
      (c.name && c.name.from !== role.name) || (c.description && c.description.from !== role.description) || (c.isActive && c.isActive.from !== role.isActive) ||
      c.addPermissions.some((p) => current.includes(p)) || c.removePermissions.some((p) => !current.includes(p));
    if (stale) throw new AppError('CONFLICT', 'This role has changed since the request was made. Reject it and ask for a new request.');
    const set: Partial<typeof roles.$inferInsert> = {};
    if (c.name) set.name = c.name.to;
    if (c.description) set.description = c.description.to;
    if (c.isActive) set.isActive = c.isActive.to;
    if (Object.keys(set).length) await tx.update(roles).set({ ...set, updatedAt: new Date() }).where(eq(roles.id, id!));
  }
  if (c.removePermissions.length) await tx.delete(rolePermissions).where(and(eq(rolePermissions.roleId, id!), inArray(rolePermissions.permissionSlug, c.removePermissions)));
  if (c.addPermissions.length) await tx.insert(rolePermissions).values(c.addPermissions.map((p) => ({ roleId: id!, permissionSlug: p, grantedBy: actorId })));
  return id!;
}

export async function saveRole(actor: CurrentUser, roleId: number | null, input: { name: unknown; description: unknown; isActive: unknown; permissions: unknown; reason?: unknown }, meta: RequestMeta) {
  await assertCanManageAccess(actor);
  if (roleId !== null && !isSmallId(roleId)) throw new AppError('NOT_FOUND', 'Role not found.');
  const reason = reasonOf(input.reason);
  const changes = await computeRoleChanges(db, roleId, input);
  if (roleChangeEmpty(changes)) throw fail('Nothing has changed.');
  await assertCanGrant(actor, await grantedBy(db, 'role', roleId === null ? 'new' : String(roleId), changes), changes.removePermissions);
  return submit(actor, 'role', roleId === null ? `new:${changes.name!.to.toLowerCase()}` : String(roleId), changes, reason, meta);
}

// ─── 军阶权限 ─────────────────────────────────────────

export async function listRankAccess() {
  const [rks, grants, pending] = await Promise.all([
    db
      .select({ id: ranks.id, name: ranks.name, sectionId: ranks.sectionId, sectionName: sections.name, isCaptain: sql<boolean>`coalesce(${ranks.systemKey} = 'captain', false)` })
      .from(ranks)
      .innerJoin(sections, eq(sections.id, ranks.sectionId))
      .where(and(eq(ranks.isActive, true), eq(sections.isActive, true)))
      .orderBy(asc(sections.sortOrder), asc(ranks.sortOrder)),
    db.select({ rankId: rankPermissions.rankId, slug: rankPermissions.permissionSlug }).from(rankPermissions),
    pendingTargets('rank_access'),
  ]);
  return rks.map((r) => ({
    ...r,
    permissions: grants.filter((g) => g.rankId === r.id).map((g) => g.slug as PermissionSlug),
    pending: pending.has(String(r.id)),
  }));
}

export async function saveRankAccess(actor: CurrentUser, rankId: number, input: { permissions: unknown; reason?: unknown }, meta: RequestMeta) {
  await assertCanManageAccess(actor);
  if (!isSmallId(rankId)) throw new AppError('NOT_FOUND', 'Rank not found.');
  const [rank] = await db.select({ id: ranks.id, systemKey: ranks.systemKey }).from(ranks).where(eq(ranks.id, rankId));
  if (!rank) throw new AppError('NOT_FOUND', 'Rank not found.');
  if (rank.systemKey === 'captain') throw fail('The Captain already has every permission.');
  const reason = reasonOf(input.reason);
  const wanted = slugList(input.permissions);
  const current = (await db.select({ slug: rankPermissions.permissionSlug }).from(rankPermissions).where(eq(rankPermissions.rankId, rankId))).map((r) => r.slug);
  const changes: RankAccessChanges = {
    addPermissions: wanted.filter((p) => !current.includes(p)),
    removePermissions: current.filter((p) => !wanted.includes(p as PermissionSlug)) as PermissionSlug[],
  };
  if (!changes.addPermissions.length && !changes.removePermissions.length) throw fail('Nothing has changed.');
  await assertCanGrant(actor, changes.addPermissions, changes.removePermissions);
  // 被授权者不能改自己的军阶权限（等于改自己的权限）
  if (!isPrivileged(actor) && actor.rankId === rankId) throw new AppError('FORBIDDEN', 'You cannot change the permissions of your own rank.');
  return submit(actor, 'rank_access', String(rankId), changes, reason, meta);
}

async function applyRankAccess(tx: Tx, actorId: string, rankId: number, c: RankAccessChanges) {
  const current = (await tx.select({ slug: rankPermissions.permissionSlug }).from(rankPermissions).where(eq(rankPermissions.rankId, rankId))).map((r) => r.slug);
  if (c.addPermissions.some((p) => current.includes(p)) || c.removePermissions.some((p) => !current.includes(p))) {
    throw new AppError('CONFLICT', 'This rank has changed since the request was made. Reject it and ask for a new request.');
  }
  if (c.removePermissions.length) await tx.delete(rankPermissions).where(and(eq(rankPermissions.rankId, rankId), inArray(rankPermissions.permissionSlug, c.removePermissions)));
  if (c.addPermissions.length) await tx.insert(rankPermissions).values(c.addPermissions.map((p) => ({ rankId, permissionSlug: p, grantedBy: actorId })));
}

// ─── 个人权限 ─────────────────────────────────────────

async function loadAccessTarget(id: string) {
  if (!z.uuid().safeParse(id).success) throw new AppError('NOT_FOUND', 'Member not found.');
  const [t] = await db
    .select({ id: users.id, fullName: users.fullName, username: users.username, accountType: users.accountType, status: users.status, rankId: users.rankId, rankName: ranks.name, rankKey: ranks.systemKey, sectionId: users.sectionId, platoonId: users.platoonId, sectionName: sections.name, sectionKey: sections.systemKey })
    .from(users)
    .leftJoin(ranks, eq(ranks.id, users.rankId))
    .leftJoin(sections, eq(sections.id, users.sectionId))
    .where(eq(users.id, id));
  if (!t || t.accountType === 'superadmin') throw new AppError('NOT_FOUND', 'Member not found.');
  return { ...t, isCaptain: t.rankKey === 'captain', isOfficer: t.sectionKey === 'officer' };
}

/** 为什么不能改这个人的权限；null = 可以改（页面据此决定显示按钮 / 表单） */
export async function userAccessBlock(actor: CurrentUser, target: { id: string; isCaptain: boolean }): Promise<string | null> {
  if (target.isCaptain) return 'The Captain always has every permission.';
  if (actor.id === target.id) return 'You cannot change your own permissions.';
  if (!isPrivileged(actor)) {
    const [mine, theirs] = await Promise.all([getPermissionsFor(actor), loadPermissions(target.id)]);
    if ([...theirs].some((p) => !mine.has(p))) return 'This member has permissions you do not have, so only the Captain can change them.';
  }
  return null;
}

/** 个人权限页的资料：每个权限的来源与最终结果 */
export async function getUserAccess(actor: CurrentUser, userId: string) {
  await assertCanManageAccess(actor);
  const t = await loadAccessTarget(userId);
  await assertInScope(actor, t);
  const [allRoles, myRoles, rankGrants, overrides, catalog, pending] = await Promise.all([
    db.select({ id: roles.id, name: roles.name, isActive: roles.isActive }).from(roles).orderBy(asc(roles.name)),
    db.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, userId)),
    t.rankId ? db.select({ slug: rankPermissions.permissionSlug }).from(rankPermissions).where(eq(rankPermissions.rankId, t.rankId)) : Promise.resolve([]),
    db.select().from(userPermissionOverrides).where(eq(userPermissionOverrides.userId, userId)),
    listPermissionCatalog(),
    pendingTargets('user_access'),
  ]);
  const roleIds = myRoles.map((r) => r.roleId);
  const roleGrants = await db.select({ roleId: rolePermissions.roleId, slug: rolePermissions.permissionSlug }).from(rolePermissions);
  const [effective, block] = await Promise.all([loadPermissions(userId), userAccessBlock(actor, t)]);
  return {
    target: t,
    // 每个角色带上它的权限，方便页面即时预览结果
    roles: allRoles.map((r) => ({ ...r, assigned: roleIds.includes(r.id), permissions: roleGrants.filter((g) => g.roleId === r.id).map((g) => g.slug) })),
    permissions: catalog.map((p) => {
      const o = overrides.find((x) => x.permissionSlug === p.slug);
      return {
        ...p,
        fromRoles: allRoles.filter((r) => r.isActive && roleIds.includes(r.id) && roleGrants.some((g) => g.roleId === r.id && g.slug === p.slug)).map((r) => r.name),
        fromRank: rankGrants.some((g) => g.slug === p.slug),
        override: (o?.effect ?? 'inherit') as Effect,
        overrideReason: o?.reason ?? null,
        // 军员就算被给了也不生效
        officerOnly: OFFICER_ONLY.includes(p.slug as PermissionSlug),
        effective: t.isCaptain || effective.has(p.slug as PermissionSlug),
      };
    }),
    pending: pending.has(userId),
    editable: !block,
    notEditableReason: block,
  };
}

export async function saveUserAccess(
  actor: CurrentUser,
  userId: string,
  input: { roleIds: unknown; overrides: unknown; reason?: unknown },
  meta: RequestMeta,
) {
  await assertCanManageAccess(actor);
  const t = await loadAccessTarget(userId);
  await assertInScope(actor, t);
  if (t.isCaptain) throw new AppError('FORBIDDEN', 'The Captain already has every permission.');
  if (actor.id === userId) throw new AppError('FORBIDDEN', 'You cannot change your own permissions.');
  if (!isPrivileged(actor)) {
    // 不能管理权限比自己多的人
    const [mine, theirs] = await Promise.all([getPermissionsFor(actor), loadPermissions(userId)]);
    for (const p of theirs) if (!mine.has(p)) throw new AppError('FORBIDDEN', 'You cannot change someone who has permissions you do not have.');
  }
  const reason = reasonOf(input.reason);

  const wantedRoles = Array.isArray(input.roleIds) ? [...new Set(input.roleIds.map(Number))] : [];
  if (!wantedRoles.every(isSmallId)) throw fail('Unknown role.');
  const existingRoles = wantedRoles.length ? await db.select({ id: roles.id, isActive: roles.isActive }).from(roles).where(inArray(roles.id, wantedRoles)) : [];
  if (existingRoles.length !== wantedRoles.length) throw fail('Unknown role.');

  const currentRoles = (await db.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, userId))).map((r) => r.roleId);
  const addRoles = wantedRoles.filter((r) => !currentRoles.includes(r));
  if (addRoles.some((r) => !existingRoles.find((e) => e.id === r)?.isActive)) throw fail('An inactive role cannot be assigned.');
  const removeRoles = currentRoles.filter((r) => !wantedRoles.includes(r));

  const rawOverrides = Array.isArray(input.overrides) ? input.overrides : [];
  const currentOverrides = await db.select().from(userPermissionOverrides).where(eq(userPermissionOverrides.userId, userId));
  const overrides: UserAccessChanges['overrides'] = [];
  const seen = new Set<string>();
  for (const raw of rawOverrides as { slug?: unknown; effect?: unknown; reason?: unknown }[]) {
    if (!isSlug(raw?.slug) || seen.has(raw.slug)) throw fail('Unknown permission.');
    seen.add(raw.slug);
    if (raw.effect !== 'inherit' && raw.effect !== 'allow' && raw.effect !== 'deny') throw fail('Unknown setting.');
    const from = (currentOverrides.find((o) => o.permissionSlug === raw.slug)?.effect ?? 'inherit') as Effect;
    const r = reasonOf(raw.reason);
    const curReason = currentOverrides.find((o) => o.permissionSlug === raw.slug)?.reason ?? null;
    if (from !== raw.effect || (raw.effect !== 'inherit' && r !== curReason)) overrides.push({ slug: raw.slug, from, to: raw.effect, reason: r });
  }
  const changes: UserAccessChanges = { addRoles, removeRoles, overrides };
  if (!addRoles.length && !removeRoles.length && !overrides.length) throw fail('Nothing has changed.');

  // 新得到的权限 = 改动后的有效权限 − 改动前（含 Deny 改回 Default 重新得到的）
  await assertCanGrant(actor, await grantedBy(db, 'user_access', userId, changes));
  return submit(actor, 'user_access', userId, changes, reason, meta);
}

async function applyUserAccess(tx: Tx, actorId: string, userId: string, c: UserAccessChanges) {
  const [u] = await tx.select({ rankKey: ranks.systemKey }).from(users).leftJoin(ranks, eq(ranks.id, users.rankId)).where(eq(users.id, userId)).for('update', { of: users });
  if (!u) throw new AppError('NOT_FOUND', 'Member not found.');
  if (u.rankKey === 'captain') throw new AppError('CONFLICT', 'This member is now the Captain.');
  const currentRoles = (await tx.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, userId))).map((r) => r.roleId);
  const currentOverrides = await tx.select().from(userPermissionOverrides).where(eq(userPermissionOverrides.userId, userId));
  const stale =
    c.addRoles.some((r) => currentRoles.includes(r)) || c.removeRoles.some((r) => !currentRoles.includes(r)) ||
    c.overrides.some((o) => (currentOverrides.find((x) => x.permissionSlug === o.slug)?.effect ?? 'inherit') !== o.from);
  if (stale) throw new AppError('CONFLICT', "This member's permissions have changed since the request was made. Reject it and ask for a new request.");
  if (c.addRoles.length) {
    const active = await tx.select({ id: roles.id }).from(roles).where(and(inArray(roles.id, c.addRoles), eq(roles.isActive, true)));
    if (active.length !== c.addRoles.length) throw new AppError('CONFLICT', 'A role in this request is no longer active.');
  }

  if (c.removeRoles.length) await tx.delete(userRoles).where(and(eq(userRoles.userId, userId), inArray(userRoles.roleId, c.removeRoles)));
  if (c.addRoles.length) await tx.insert(userRoles).values(c.addRoles.map((roleId) => ({ userId, roleId, assignedBy: actorId })));
  for (const o of c.overrides) {
    if (o.to === 'inherit') {
      await tx.delete(userPermissionOverrides).where(and(eq(userPermissionOverrides.userId, userId), eq(userPermissionOverrides.permissionSlug, o.slug)));
    } else {
      await tx
        .insert(userPermissionOverrides)
        .values({ userId, permissionSlug: o.slug, effect: o.to, reason: o.reason, setBy: actorId })
        .onConflictDoUpdate({
          target: [userPermissionOverrides.userId, userPermissionOverrides.permissionSlug],
          set: { effect: o.to, reason: o.reason, setBy: actorId, setAt: new Date() },
        });
    }
  }
}

// ─── 申请与批准 ───────────────────────────────────────

type Kind = 'user_access' | 'role' | 'rank_access';
const AUDIT_ENTITY: Record<Kind, string> = { user_access: 'user_access', role: 'roles', rank_access: 'rank_permissions' };

async function pendingTargets(kind: Kind) {
  const rows = await db
    .select({ targetId: permissionChangeRequests.targetId })
    .from(permissionChangeRequests)
    .where(and(eq(permissionChangeRequests.kind, kind), eq(permissionChangeRequests.status, 'pending')));
  return new Set(rows.map((r) => r.targetId));
}

async function applyChanges(tx: Tx, actorId: string, kind: Kind, targetId: string, changes: unknown): Promise<string> {
  if (kind === 'role') {
    const id = await applyRoleChanges(tx, actorId, targetId.startsWith('new:') ? null : Number(targetId), changes as RoleChanges);
    return String(id);
  }
  if (kind === 'rank_access') {
    await applyRankAccess(tx, actorId, Number(targetId), changes as RankAccessChanges);
    return targetId;
  }
  await applyUserAccess(tx, actorId, targetId, changes as UserAccessChanges);
  return targetId;
}

/** 用户在套用改动后的有效权限（只计算，不写入） */
async function simulateUserAccess(tx: Tx | typeof db, userId: string, c: UserAccessChanges) {
  const [u] = await tx.select({ rankId: users.rankId }).from(users).where(eq(users.id, userId));
  const currentRoles = (await tx.select({ roleId: userRoles.roleId }).from(userRoles).where(eq(userRoles.userId, userId))).map((r) => r.roleId);
  const roleSet = [...currentRoles.filter((r) => !c.removeRoles.includes(r)), ...c.addRoles];
  const [roleGrants, rankGrants, overrides] = await Promise.all([
    roleSet.length
      ? tx.select({ slug: rolePermissions.permissionSlug }).from(rolePermissions).innerJoin(roles, and(eq(roles.id, rolePermissions.roleId), eq(roles.isActive, true))).where(inArray(rolePermissions.roleId, roleSet))
      : Promise.resolve([]),
    u?.rankId ? tx.select({ slug: rankPermissions.permissionSlug }).from(rankPermissions).where(eq(rankPermissions.rankId, u.rankId)) : Promise.resolve([]),
    tx.select({ slug: userPermissionOverrides.permissionSlug, effect: userPermissionOverrides.effect }).from(userPermissionOverrides).where(eq(userPermissionOverrides.userId, userId)),
  ]);
  const after = new Map<string, Effect>(overrides.map((o) => [o.slug, o.effect]));
  for (const o of c.overrides) after.set(o.slug, o.to);
  // 不去掉军官专属权限：给军员 ALLOW 一个专属权限也算「给出」，以后升为军官就会生效
  return resolvePermissions(
    [...roleGrants, ...rankGrants].map((g) => g.slug),
    [...after.entries()].filter(([, e]) => e !== 'inherit').map(([slug, effect]) => ({ slug, effect: effect as 'allow' | 'deny' })),
  );
}

/** 一个申请会让人「新得到」哪些权限（被授权者只能给自己有的） */
async function grantedBy(tx: Tx | typeof db, kind: Kind, targetId: string, changes: unknown): Promise<PermissionSlug[]> {
  if (kind === 'rank_access') return (changes as RankAccessChanges).addPermissions;
  if (kind === 'role') {
    const c = changes as RoleChanges;
    if (c.isActive?.to === false) return [];
    const out = new Set<PermissionSlug>(c.addPermissions);
    // 重新启用角色 = 再次给出它全部的权限
    if (c.isActive?.to === true && !c.create && /^\d+$/.test(targetId)) {
      for (const g of await tx.select({ slug: rolePermissions.permissionSlug }).from(rolePermissions).where(eq(rolePermissions.roleId, Number(targetId)))) {
        if (!c.removePermissions.includes(g.slug as PermissionSlug)) out.add(g.slug as PermissionSlug);
      }
    }
    return [...out];
  }
  const before = await loadRawPermissions(targetId);
  const after = await simulateUserAccess(tx, targetId, changes as UserAccessChanges);
  return [...after].filter((p) => !before.has(p));
}

/** Captain / Superadmin：直接生效；被授权者：建立待批申请 */
async function submit(actor: CurrentUser, kind: Kind, targetId: string, changes: object, reason: string | null, meta: RequestMeta) {
  return db.transaction(async (tx) => {
    // 有待批申请时被授权者不能再改；Captain/Superadmin 可直接改，旧申请批准时会被判定为过期
    const [open] = await tx
      .select({ id: permissionChangeRequests.id })
      .from(permissionChangeRequests)
      .where(and(eq(permissionChangeRequests.kind, kind), eq(permissionChangeRequests.targetId, targetId), eq(permissionChangeRequests.status, 'pending')));
    if (open && !isPrivileged(actor)) throw new AppError('CONFLICT', 'There is already a change waiting for the Captain to confirm. Wait for it to be decided first.');

    if (isPrivileged(actor)) {
      const appliedId = await applyChanges(tx, actor.id, kind, targetId, changes);
      await writeAudit(tx, { actorId: actor.id, meta }, { action: 'ACCESS_CHANGED', entityType: AUDIT_ENTITY[kind], entityId: appliedId, after: changes as Record<string, unknown>, reason });
      return { status: 'applied' as const, targetId: appliedId };
    }
    try {
      const [req] = await tx
        .insert(permissionChangeRequests)
        .values({ kind, targetId, changes, reason, requestedBy: actor.id })
        .returning({ id: permissionChangeRequests.id });
      await writeAudit(tx, { actorId: actor.id, meta }, { action: 'ACCESS_CHANGE_REQUESTED', entityType: 'permission_change_requests', entityId: req.id, after: { kind, targetId, changes }, reason });
      return { status: 'pending' as const, requestId: req.id, targetId };
    } catch (err) {
      const c = err as { cause?: { constraint?: string }; constraint?: string };
      if ((c.constraint ?? c.cause?.constraint) === 'permission_change_requests_one_pending_uq') {
        throw new AppError('CONFLICT', 'There is already a change waiting for the Captain to confirm. Wait for it to be decided first.');
      }
      throw err;
    }
  });
}

export async function listRequests(actor: CurrentUser, status: 'pending' | 'decided') {
  await assertCanManageAccess(actor);
  const requester = alias(users, 'requester');
  const decider = alias(users, 'decider');
  const where = [status === 'pending' ? eq(permissionChangeRequests.status, 'pending') : sql`${permissionChangeRequests.status} <> 'pending'`];
  // 被授权者只看到自己的申请
  if (!isPrivileged(actor)) where.push(eq(permissionChangeRequests.requestedBy, actor.id));
  const rows = await db
    .select({
      id: permissionChangeRequests.id, kind: permissionChangeRequests.kind, targetId: permissionChangeRequests.targetId,
      changes: permissionChangeRequests.changes, reason: permissionChangeRequests.reason, status: permissionChangeRequests.status,
      requestedAt: permissionChangeRequests.requestedAt, requestedById: permissionChangeRequests.requestedBy, requestedBy: requester.fullName,
      decidedAt: permissionChangeRequests.decidedAt, decidedBy: decider.fullName, decisionNote: permissionChangeRequests.decisionNote,
    })
    .from(permissionChangeRequests)
    .innerJoin(requester, eq(requester.id, permissionChangeRequests.requestedBy))
    .leftJoin(decider, eq(decider.id, permissionChangeRequests.decidedBy))
    .where(and(...where))
    .orderBy(desc(permissionChangeRequests.requestedAt))
    .limit(status === 'pending' ? 200 : 50);

  // 对象名称（显示用）
  const userIds = rows.filter((r) => r.kind === 'user_access').map((r) => r.targetId);
  const roleIds = rows.filter((r) => r.kind === 'role' && !r.targetId.startsWith('new:')).map((r) => Number(r.targetId));
  const rankIds = rows.filter((r) => r.kind === 'rank_access').map((r) => Number(r.targetId));
  const [us, rs, ks] = await Promise.all([
    userIds.length ? db.select({ id: users.id, name: users.fullName }).from(users).where(inArray(users.id, userIds)) : [],
    roleIds.length ? db.select({ id: roles.id, name: roles.name }).from(roles).where(inArray(roles.id, roleIds)) : [],
    rankIds.length ? db.select({ id: ranks.id, name: ranks.name, section: sections.name }).from(ranks).innerJoin(sections, eq(sections.id, ranks.sectionId)).where(inArray(ranks.id, rankIds)) : [],
  ]);
  const roleNames = await db.select({ id: roles.id, name: roles.name }).from(roles);
  return rows.map((r) => {
    let targetName = r.targetId;
    if (r.kind === 'user_access') targetName = us.find((u) => u.id === r.targetId)?.name ?? 'Unknown member';
    else if (r.kind === 'role') targetName = r.targetId.startsWith('new:') ? `New role: ${(r.changes as RoleChanges).name?.to}` : rs.find((x) => String(x.id) === r.targetId)?.name ?? 'Unknown role';
    else { const k = ks.find((x) => String(x.id) === r.targetId); targetName = k ? `${k.section} · ${k.name}` : 'Unknown rank'; }
    return { ...r, targetName, roleNames: Object.fromEntries(roleNames.map((x) => [x.id, x.name])) as Record<number, string>, mine: r.requestedById === actor.id };
  });
}
export type ChangeRequest = Awaited<ReturnType<typeof listRequests>>[number];

/** Captain 的待批数量（导航提示用） */
export async function pendingRequestCount(actor: CurrentUser) {
  if (!actor.isCaptain) return 0;
  const [{ n }] = await db.select({ n: count() }).from(permissionChangeRequests).where(eq(permissionChangeRequests.status, 'pending'));
  return n;
}

/** 只有 Captain 能批准或拒绝 */
export async function decideRequest(actor: CurrentUser, id: string, decision: 'approve' | 'reject', note: unknown, meta: RequestMeta) {
  if (!actor.isCaptain) throw new AppError('FORBIDDEN', 'Only the Captain can confirm permission changes.');
  if (!z.uuid().safeParse(id).success) throw new AppError('NOT_FOUND', 'Request not found.');
  if (decision !== 'approve' && decision !== 'reject') throw fail('Unknown decision.');
  const decisionNote = reasonOf(note);
  if (decision === 'reject' && !decisionNote) throw fail('Please fix the highlighted fields.', { note: 'Enter a reason for rejecting.' });

  return db.transaction(async (tx) => {
    const [req] = await tx.select().from(permissionChangeRequests).where(eq(permissionChangeRequests.id, id)).for('update');
    if (!req) throw new AppError('NOT_FOUND', 'Request not found.');
    if (req.status !== 'pending') throw new AppError('CONFLICT', 'This request has already been decided.');
    if (req.requestedBy === actor.id) throw new AppError('FORBIDDEN', 'You cannot confirm your own request.');

    let appliedId = req.targetId;
    if (decision === 'approve') {
      // 申请人必须仍然在职且仍有管理权限
      const [r] = await tx.select({ status: users.status }).from(users).where(eq(users.id, req.requestedBy));
      const reqPerms = await loadPermissions(req.requestedBy);
      if (r?.status !== 'active' || !reqPerms.has('permissions.manage')) {
        throw new AppError('CONFLICT', 'The requester no longer has permission to manage access. Reject this request.');
      }
      // 申请人在申请后被收回的权限，也不能再借这个申请给出去
      const granted = await grantedBy(tx, req.kind, req.targetId, req.changes);
      if (granted.some((p) => !reqPerms.has(p))) {
        throw new AppError('CONFLICT', 'The requester no longer has some of the permissions in this request. Reject this request.');
      }
      // 提交时的规则在批准时再检查一次（期间可能有人升阶或权限改变）
      if (req.kind === 'user_access') {
        if (req.targetId === req.requestedBy) throw new AppError('CONFLICT', 'A request cannot change the requester. Reject this request.');
        // 申请后成员可能被调到别的组别 / Platoon，已不在申请人看得到的范围
        const [t] = await tx.select({ sectionId: users.sectionId, platoonId: users.platoonId }).from(users).where(eq(users.id, req.targetId));
        if (!t || !inScope(await memberScopeOf(req.requestedBy, reqPerms), t)) {
          throw new AppError('CONFLICT', 'The member is no longer in the requester\'s section. Reject this request.');
        }
        const theirs = await loadPermissions(req.targetId);
        if ([...theirs].some((p) => !reqPerms.has(p))) throw new AppError('CONFLICT', 'The member now has permissions the requester does not have. Reject this request.');
      }
      if (req.kind === 'rank_access') {
        const [requester] = await tx.select({ rankId: users.rankId }).from(users).where(eq(users.id, req.requestedBy));
        if (String(requester?.rankId) === req.targetId) throw new AppError('CONFLICT', 'The requester now holds this rank. Reject this request.');
      }
      appliedId = await applyChanges(tx, req.requestedBy, req.kind, req.targetId, req.changes);
    }
    await tx
      .update(permissionChangeRequests)
      .set({ status: decision === 'approve' ? 'approved' : 'rejected', decidedBy: actor.id, decidedAt: new Date(), decisionNote })
      .where(eq(permissionChangeRequests.id, id));
    const entries: AuditEntry[] = [{ action: decision === 'approve' ? 'ACCESS_CHANGE_APPROVED' : 'ACCESS_CHANGE_REJECTED', entityType: 'permission_change_requests', entityId: id, reason: decisionNote }];
    if (decision === 'approve') entries.push({ action: 'ACCESS_CHANGED', entityType: AUDIT_ENTITY[req.kind], entityId: appliedId, reason: req.reason, after: req.changes as Record<string, unknown> });
    await writeAudit(tx, { actorId: actor.id, meta }, entries);
  });
}

/** 申请人撤回自己的申请 */
export async function cancelRequest(actor: CurrentUser, id: string, meta: RequestMeta) {
  if (!z.uuid().safeParse(id).success) throw new AppError('NOT_FOUND', 'Request not found.');
  return db.transaction(async (tx) => {
    const [req] = await tx.select().from(permissionChangeRequests).where(eq(permissionChangeRequests.id, id)).for('update');
    if (!req || req.requestedBy !== actor.id) throw new AppError('NOT_FOUND', 'Request not found.');
    if (req.status !== 'pending') throw new AppError('CONFLICT', 'This request has already been decided.');
    await tx.update(permissionChangeRequests).set({ status: 'cancelled', decidedBy: actor.id, decidedAt: new Date() }).where(eq(permissionChangeRequests.id, id));
    await writeAudit(tx, { actorId: actor.id, meta }, { action: 'ACCESS_CHANGE_CANCELLED', entityType: 'permission_change_requests', entityId: id });
  });
}
