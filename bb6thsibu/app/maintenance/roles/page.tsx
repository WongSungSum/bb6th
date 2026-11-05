import type { Metadata } from 'next';
import Link from 'next/link';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faLock, faPlus, faUsersGear } from '@fortawesome/free-solid-svg-icons';
import { listRoles } from '@/lib/server/access/service';
import { FlagBadge, StateCard } from '@/app/components/ui';
import { maintenanceAccess } from '../guard';
import WebOnly from '@/app/maintenance/web-only';

export const metadata: Metadata = { title: 'Roles - BB6th Sibu' };

export default async function RolesPage() {
  const { access } = await maintenanceAccess();
  if (!access) return <StateCard icon={faLock} title="You do not have access" action={<Link href="/dashboard" className="btn-secondary">Back to dashboard</Link>} />;
  const roles = await listRoles();
  return (
    <WebOnly>
      <div className="max-w-5xl mx-auto">
        <Link href="/maintenance" className="back-link"><FontAwesomeIcon icon={faChevronLeft} /> Maintenance</Link>
        <div className="flex flex-wrap items-start justify-between gap-3 mt-3 mb-4">
          <div>
            <h1 className="text-xl md:text-2xl font-bold tracking-tight">Roles</h1>
            <p className="text-sm text-muted">Roles only give permissions. Use member permissions to Deny for one person.</p>
          </div>
          <Link href="/maintenance/roles/new" className="btn-primary max-md:w-full"><FontAwesomeIcon icon={faPlus} /> New role</Link>
        </div>
        {roles.length === 0 ? (
          <StateCard icon={faUsersGear} title="No roles yet" text="Create a role, tick its permissions, then give it to members." />
        ) : (
          <div className="grid md:grid-cols-2 gap-3">
            {roles.map((r) => (
              <Link key={r.id} href={`/maintenance/roles/${r.id}`} className={`card p-4 md:p-5 hover:bg-subtle ${r.isActive ? '' : 'opacity-60'}`}>
                <div className="flex items-center gap-2 flex-wrap">
                  <p className="font-semibold">{r.name}</p>
                  {!r.isActive && <span className="text-xs rounded-full border border-slate-500/30 bg-slate-500/15 px-2 py-0.5">Inactive</span>}
                  {r.pending && <FlagBadge>Waiting for Captain</FlagBadge>}
                </div>
                {r.description && <p className="text-sm text-muted mt-1">{r.description}</p>}
                <p className="text-xs text-muted mt-2">{r.permissionCount} {r.permissionCount === 1 ? 'permission' : 'permissions'} · {r.memberCount} active {r.memberCount === 1 ? 'member' : 'members'}</p>
              </Link>
            ))}
          </div>
        )}
      </div>
    </WebOnly>
  );
}
