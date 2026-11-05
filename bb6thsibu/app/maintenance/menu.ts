import { faClipboardCheck, faIdBadge, faPeopleGroup, faSitemap, faUserShield, faUsersGear } from '@fortawesome/free-solid-svg-icons';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';

export type MaintenanceItem = { href: string; icon: IconDefinition; title: string; text: string; badge?: number; desktopOnly?: boolean };

/** 维护功能清单：首页卡片、电脑版下拉、手机版展开共用，确保三处一致。手机只开放 Confirmations */
export function maintenanceItems({ orgAdmin, isCaptain, pending, permissions = true, platoons = false }: { orgAdmin: boolean; isCaptain: boolean; pending: number; permissions?: boolean; platoons?: boolean }): MaintenanceItem[] {
  const items: MaintenanceItem[] = !permissions ? [] : [
    {
      href: '/maintenance/approvals', icon: faClipboardCheck, title: 'Confirmations', badge: pending,
      text: isCaptain ? 'Confirm or reject permission changes made by others.' : 'Permission changes waiting for the Captain, and their results.',
    },
    { href: '/maintenance/roles', icon: faUsersGear, title: 'Roles', text: 'Groups of permissions you can give to members, such as Member Admin.', desktopOnly: true },
    { href: '/maintenance/rank-permissions', icon: faIdBadge, title: 'Rank permissions', text: 'Permissions every holder of a rank gets automatically.', desktopOnly: true },
    { href: '/users', icon: faUserShield, title: 'Member permissions', text: 'Open a member and choose Permissions to set roles and Allow / Deny.', desktopOnly: true },
  ];
  if (platoons) items.push({ href: '/maintenance/platoons', icon: faPeopleGroup, title: 'Platoons', text: 'Create platoons, move members between them and choose leaders.', desktopOnly: true });
  if (orgAdmin) items.push({ href: '/maintenance/organization', icon: faSitemap, title: 'Ranks & Sections', text: 'Add, rename, reorder or deactivate sections and ranks.', desktopOnly: true });
  return items;
}
