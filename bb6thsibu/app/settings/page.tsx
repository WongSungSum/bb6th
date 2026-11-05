import type { Metadata } from 'next';
import Link from 'next/link';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUpRightDots, faChevronRight, faIdCard, faKey, faRankingStar, faSignOutAlt, faUsers } from '@fortawesome/free-solid-svg-icons';
import { requireUser } from '@/lib/server/auth/session';
import { getPermissionsFor } from '@/lib/server/authz';
import { pendingRequestCount } from '@/lib/server/access/service';
import { logoutAction } from '@/app/actions/auth';
import MaintenanceRow from './maintenance-row';
import ThemeToggle from '@/app/components/theme-toggle';

export const metadata: Metadata = { title: 'More - BB6th Sibu' };

const row ='card p-4 md:p-4 flex items-center gap-3 min-h-14 hover:bg-subtle w-full text-left';

export default async function SettingsPage() {
  const user = await requireUser();
  const perms = await getPermissionsFor(user);
  const canViewUsers = perms.has('users.view');
  const canPromote = perms.has('users.change_rank');
  const canManageAccess = user.isCaptain || user.isSuperadmin || perms.has('permissions.manage');
  const canPlatoons = perms.has('platoons.manage');
  const canMaintain = canManageAccess || canPlatoons;
  const pending = canManageAccess ? await pendingRequestCount(user) : 0;
  return (
    <div className="max-w-3xl mx-auto space-y-3">
      <h1 className="text-xl md:text-2xl font-bold tracking-tight mb-4">More</h1>
      {canViewUsers && (
        <Link href="/users" className={row}>
          <FontAwesomeIcon icon={faUsers} className="text-violet-300 w-5" />
          <span className="flex-1">Members</span>
          <FontAwesomeIcon icon={faChevronRight} className="text-muted" />
        </Link>
      )}
      {canPromote && (
        <Link href="/promotions" className={row}>
          <FontAwesomeIcon icon={faArrowUpRightDots} className="text-violet-300 w-5" />
          <span className="flex-1">Promotions</span>
          <FontAwesomeIcon icon={faChevronRight} className="text-muted" />
        </Link>
      )}
      <Link href="/platoons" className={row}>
        <FontAwesomeIcon icon={faRankingStar} className="text-violet-300 w-5" />
        <span className="flex-1">Platoon scoreboard</span>
        <FontAwesomeIcon icon={faChevronRight} className="text-muted" />
      </Link>
      {canMaintain && (
        <MaintenanceRow orgAdmin={user.isCaptain || user.isSuperadmin} isCaptain={user.isCaptain} pending={pending} row={row} permissions={canManageAccess} platoons={canPlatoons} />
      )}
      <Link href="/profile" className={row}>
        <FontAwesomeIcon icon={faIdCard} className="text-violet-300 w-5" />
        <span className="flex-1">My profile</span>
        <FontAwesomeIcon icon={faChevronRight} className="text-muted" />
      </Link>
      <Link href="/change-password" className={row}>
        <FontAwesomeIcon icon={faKey} className="text-violet-300 w-5" />
        <span className="flex-1">Change password</span>
        <FontAwesomeIcon icon={faChevronRight} className="text-muted" />
      </Link>
      <div className="card p-4 md:p-4">
        <p className="text-sm mb-2">Appearance</p>
        <ThemeToggle />
      </div>
      <form action={logoutAction}>
        <button type="submit" className={`${row} text-red-400`}>
          <FontAwesomeIcon icon={faSignOutAlt} className="w-5" />
          <span className="flex-1">Logout</span>
        </button>
      </form>
    </div>
  );
}
