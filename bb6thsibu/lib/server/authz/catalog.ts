// 权限目录：以代码为准，初始化脚本会同步到 permissions 表。新增模块时在这里加。
export const PERMISSIONS = {
  'users.view': { module: 'users', description: 'View members (own section only, unless they can see every section)' },
  'users.all_sections': { module: 'users', description: 'See and manage members of every section, not only their own' },
  'users.create': { module: 'users', description: 'Create members' },
  'users.update': { module: 'users', description: 'Edit member profiles' },
  'users.update_status': { module: 'users', description: 'Deactivate / reactivate members' },
  'users.change_rank': { module: 'users', description: 'Promote members (batch rank change)' },
  'users.reset_password': { module: 'users', description: 'Reset temporary passwords' },
  'users.view_sensitive': { module: 'users', description: 'View IC numbers and guardian contacts' },
  'platoons.manage': { module: 'platoons', description: 'Manage platoons, assign members and leaders (officers only)' },
  'platoons.score': { module: 'platoons', description: 'Record platoon activity scores (officers only)' },
  'permissions.manage': { module: 'permissions', description: 'Manage roles and permissions (needs Captain confirmation)' },
  'audit.view': { module: 'audit', description: 'View audit logs' },
} as const;

export type PermissionSlug = keyof typeof PERMISSIONS;

/** 只有军官（Officer 组别）才可能拥有的权限；军员就算被给了也不生效 */
export const OFFICER_ONLY: readonly PermissionSlug[] = ['users.change_rank', 'users.reset_password', 'platoons.manage', 'platoons.score'];
export const ALL_PERMISSIONS = Object.keys(PERMISSIONS) as PermissionSlug[];
