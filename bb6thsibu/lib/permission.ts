import { db } from './db';
import { userPermissions, permissions, rolePermissions, users, roles, rank } from './schema';
import { and, eq, or } from 'drizzle-orm';

export const PERMISSIONS = {
  ATTENDANCE_VIEW: 'attendance:view',
  ATTENDANCE_WRITE: 'attendance:write',
  AWARDS_EDIT: 'awards:edit',
  USER_MANAGEMENT: 'users:manage',
} as const;

export type PermissionSlug = typeof PERMISSIONS[keyof typeof PERMISSIONS];

/**
 * 核心权限校验函数 (Server Side Only)
 * 逻辑：检查用户是否拥有直接权限，或者通过角色继承了该权限
 */
export async function checkPermission(userId: string, slug: PermissionSlug) {
  const user = await db.query.users.findFirst({
    where: eq(users.id, userId),
  });

  // 如果是管理员，直接返回 true (类似你的 superadmin 逻辑)
  if (user?.username === 'superadmin') return true; 

  const result = await db
    .select({ slug: permissions.slug })
    .from(permissions)
    // 连表 A: 用户直接权限
    .leftJoin(userPermissions, eq(userPermissions.permissionId, permissions.slug))
    // 连表 B: 角色权限
    .leftJoin(rolePermissions, eq(rolePermissions.permissionId, permissions.slug))
    // 连表 C: 用户所属的角色 (用于连接 rolePermissions)
    .leftJoin(roles, eq(rolePermissions.roleId, roles.id)) 
    .where(
      and(
        eq(permissions.slug, slug),
        or(
          eq(userPermissions.userId, userId), // 情况1: 用户直接拥有
          eq(users.roleId, rolePermissions.roleId) // 情况2: 用户所属的角色拥有 (假设 users 表有 roleId)
        )
      )
    )
    .limit(1);

  return result.length > 0;
}