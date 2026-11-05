import { cache } from 'react';
import { and, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { rankPermissions, rolePermissions, roles, sections, userPermissionOverrides, userRoles, users } from '@/lib/db/schema';
import { ALL_PERMISSIONS, OFFICER_ONLY, PERMISSIONS, type PermissionSlug } from './catalog';
import { requireUser, type CurrentUser } from '@/lib/server/auth/session';
import { forbidden, notFound } from '@/lib/server/errors';

export { PERMISSIONS, type PermissionSlug } from './catalog';

/**
 * 权限计算规则（唯一实现，所有页面和 action 都调用这里）：
 * - Superadmin、Captain：全部权限
 * - 其他人：（启用角色给的 ∪ 军阶给的）+ 个人 ALLOW − 个人 DENY；没给的一律拒绝。个人设定优先。
 * - 不是军官的人，OFFICER_ONLY 里的权限一律不生效（升阶、重设密码只能由军官做）
 */
export function resolvePermissions(
  grants: Iterable<string>,
  overrides: { slug: string; effect: 'allow' | 'deny' }[],
): Set<PermissionSlug> {
  const result = new Set<string>(grants);
  for (const o of overrides) {
    if (o.effect === 'allow') result.add(o.slug);
    else result.delete(o.slug);
  }
  return new Set(ALL_PERMISSIONS.filter((p) => result.has(p)));
}

/** 去掉军员不能拥有的权限 */
export function applyOfficerOnly(perms: Set<PermissionSlug>, isOfficer: boolean): Set<PermissionSlug> {
  if (isOfficer) return perms;
  return new Set([...perms].filter((p) => !OFFICER_ONLY.includes(p)));
}

/** 这个用户是否属于 Officer 组别 */
export async function isOfficerUser(userId: string): Promise<boolean> {
  const [r] = await db
    .select({ key: sections.systemKey })
    .from(users)
    .innerJoin(sections, eq(sections.id, users.sectionId))
    .where(eq(users.id, userId));
  return r?.key === 'officer';
}

/**
 * 未去掉军官专属权限前的有效权限（角色 ∪ 军阶 + ALLOW − DENY）。
 * rankId 可指定另一个军阶，用来计算「升阶后」会有哪些权限。
 */
export async function loadRawPermissions(userId: string, rankId?: number | null): Promise<Set<PermissionSlug>> {
  const [grants, rankGrants, overrides] = await Promise.all([
    db
      .select({ slug: rolePermissions.permissionSlug })
      .from(userRoles)
      .innerJoin(roles, and(eq(roles.id, userRoles.roleId), eq(roles.isActive, true)))
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .where(eq(userRoles.userId, userId)),
    rankId === undefined
      ? db
          .select({ slug: rankPermissions.permissionSlug })
          .from(users)
          .innerJoin(rankPermissions, eq(rankPermissions.rankId, users.rankId))
          .where(eq(users.id, userId))
      : rankId === null
        ? Promise.resolve([])
        : db.select({ slug: rankPermissions.permissionSlug }).from(rankPermissions).where(eq(rankPermissions.rankId, rankId)),
    db
      .select({ slug: userPermissionOverrides.permissionSlug, effect: userPermissionOverrides.effect })
      .from(userPermissionOverrides)
      .where(eq(userPermissionOverrides.userId, userId)),
  ]);
  return resolvePermissions([...grants, ...rankGrants].map((g) => g.slug), overrides);
}

export async function loadPermissions(userId: string): Promise<Set<PermissionSlug>> {
  const [raw, officer] = await Promise.all([loadRawPermissions(userId), isOfficerUser(userId)]);
  return applyOfficerOnly(raw, officer);
}

/** 当前用户的有效权限（同一请求只算一次） */
export const getPermissionsFor = cache(async (user: CurrentUser): Promise<Set<PermissionSlug>> => {
  if (user.isSuperadmin || user.isCaptain) return new Set(ALL_PERMISSIONS);
  return loadPermissions(user.id);
});

export async function can(user: CurrentUser, slug: PermissionSlug): Promise<boolean> {
  if (!(slug in PERMISSIONS)) throw new Error(`Unknown permission ${slug}`);
  return (await getPermissionsFor(user)).has(slug);
}

/** Captain、Superadmin、军官 */
export const isOfficerOrAbove = cache(async (user: CurrentUser): Promise<boolean> => {
  return user.isCaptain || user.isSuperadmin || (await isOfficerUser(user.id));
});

/** 'all' = 全部；否则只看 sections 里的组别，有 platoonId 时只看那个 Platoon */
export type MemberScope = 'all' | { sections: number[]; platoonId: number | null };

/**
 * 能看 / 管理哪些成员：
 * - Captain、Superadmin、军官、或有 users.all_sections 的人：全部
 * - 有 Platoon 的人：只有自己的 Platoon
 * - 其他人：只有自己的组别
 */
export async function memberScope(user: CurrentUser): Promise<MemberScope> {
  if (await isOfficerOrAbove(user)) return 'all';
  if ((await getPermissionsFor(user)).has('users.all_sections')) return 'all';
  const [me] = await db.select({ platoonId: users.platoonId }).from(users).where(eq(users.id, user.id));
  return { sections: user.sectionId ? [user.sectionId] : [], platoonId: me?.platoonId ?? null };
}

/** 用 id 算某人的范围（不是目前登入的人，例如批准申请时的申请人）；perms 为那人的有效权限 */
export async function memberScopeOf(userId: string, perms: Set<PermissionSlug>): Promise<MemberScope> {
  const [u] = await db.select({ sectionId: users.sectionId, platoonId: users.platoonId, accountType: users.accountType }).from(users).where(eq(users.id, userId));
  if (!u) return { sections: [], platoonId: null };
  if (u.accountType === 'superadmin' || (await isOfficerUser(userId)) || perms.has('users.all_sections')) return 'all';
  return { sections: u.sectionId ? [u.sectionId] : [], platoonId: u.platoonId };
}

export function inScope(scope: MemberScope, target: { sectionId: number | null; platoonId?: number | null }) {
  if (scope === 'all') return true;
  if (target.sectionId === null || !scope.sections.includes(target.sectionId)) return false;
  return scope.platoonId === null || target.platoonId === scope.platoonId;
}

/** 不在范围内当作「找不到」，不透露对方存在 */
export async function assertInScope(user: CurrentUser, target: { sectionId: number | null; platoonId?: number | null }) {
  if (!inScope(await memberScope(user), target)) throw notFound();
}

/** 登录 + 权限检查；没有权限抛 FORBIDDEN */
export async function requirePermission(slug: PermissionSlug): Promise<CurrentUser> {
  const user = await requireUser();
  if (!(await can(user, slug))) throw forbidden();
  return user;
}
