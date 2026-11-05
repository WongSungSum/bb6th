import { requireUser, type CurrentUser } from '@/lib/server/auth/session';
import { getPermissionsFor } from '@/lib/server/authz';
import { isPrivileged } from '@/lib/server/access/service';

/** 维护页面的访问判断（显示用；真正的检查在服务层） */
export async function maintenanceAccess(): Promise<{ user: CurrentUser; access: boolean; platoons: boolean; orgAdmin: boolean; grantable: string[] | null }> {
  const user = await requireUser();
  const perms = await getPermissionsFor(user);
  const privileged = isPrivileged(user);
  return {
    user,
    access: privileged || perms.has('permissions.manage'),
    // Platoon 维护（只限军官的权限，军员不会有）
    platoons: perms.has('platoons.manage'),
    orgAdmin: privileged,
    // null = 不受限（Captain / Superadmin）
    grantable: privileged ? null : [...perms],
  };
}
