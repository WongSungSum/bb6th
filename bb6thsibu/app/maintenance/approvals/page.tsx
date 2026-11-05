import type { Metadata } from 'next';
import Link from 'next/link';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faClipboardCheck, faLock } from '@fortawesome/free-solid-svg-icons';
import { listPermissionCatalog, listRequests } from '@/lib/server/access/service';
import { StateCard } from '@/app/components/ui';
import { maintenanceAccess } from '../guard';
import RequestCard from './request-card';

export const metadata: Metadata = { title: 'Confirmations - BB6th Sibu' };

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ tab?: string }> }) {
  const { user, access } = await maintenanceAccess();
  if (!access) return <StateCard icon={faLock} title="You do not have access" action={<Link href="/dashboard" className="btn-secondary">Back to dashboard</Link>} />;
  const tab = (await searchParams).tab === 'history' ? 'decided' : 'pending';
  const [rows, catalog] = await Promise.all([listRequests(user, tab), listPermissionCatalog()]);
  const labels = Object.fromEntries(catalog.map((p) => [p.slug, p.description]));
  const tabCls = (on: boolean) => `px-4 min-h-10 inline-flex items-center rounded-full text-sm ${on ? 'bg-violet-500/20 text-fg border border-violet-400/50' : 'text-fg-2 border border-line hover:bg-subtle'}`;

  return (
    <div className="max-w-4xl mx-auto">
      <Link href="/maintenance" className="back-link"><FontAwesomeIcon icon={faChevronLeft} /> Maintenance</Link>
      <h1 className="text-xl md:text-2xl font-bold tracking-tight mt-3">Confirmations</h1>
      <p className="text-sm text-muted mb-4">
        {user.isCaptain
          ? 'Permission changes made by others only take effect after you confirm them.'
          : user.isSuperadmin
            ? 'Only the Captain can confirm these. Your own changes take effect immediately.'
            : 'Your permission changes take effect after the Captain confirms them.'}
      </p>
      <div className="flex gap-2 mb-4">
        <Link href="/maintenance/approvals" className={tabCls(tab === 'pending')}>Waiting</Link>
        <Link href="/maintenance/approvals?tab=history" className={tabCls(tab === 'decided')}>History</Link>
      </div>
      {rows.length === 0 ? (
        <StateCard icon={faClipboardCheck} title={tab === 'pending' ? 'Nothing waiting' : 'No history yet'} />
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <RequestCard key={r.id} r={r} labels={labels} canDecide={user.isCaptain && !r.mine} />
          ))}
        </div>
      )}
    </div>
  );
}
