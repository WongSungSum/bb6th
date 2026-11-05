import type { Metadata } from 'next';
import Link from 'next/link';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faLock } from '@fortawesome/free-solid-svg-icons';
import { listPermissionCatalog, listRankAccess } from '@/lib/server/access/service';
import { StateCard } from '@/app/components/ui';
import { maintenanceAccess } from '../guard';
import RankAccessEditor from './editor';
import WebOnly from '@/app/maintenance/web-only';

export const metadata: Metadata = { title: 'Rank permissions - BB6th Sibu' };

export default async function RankPermissionsPage() {
  const { access, grantable, user } = await maintenanceAccess();
  if (!access) return <StateCard icon={faLock} title="You do not have access" action={<Link href="/dashboard" className="btn-secondary">Back to dashboard</Link>} />;
  const [ranks, catalog] = await Promise.all([listRankAccess(), listPermissionCatalog()]);
  return (
    <WebOnly>
      <div className="max-w-6xl mx-auto">
        <Link href="/maintenance" className="back-link"><FontAwesomeIcon icon={faChevronLeft} /> Maintenance</Link>
        <h1 className="text-xl md:text-2xl font-bold tracking-tight mt-3">Rank permissions</h1>
        <p className="text-sm text-muted mb-4">Everyone holding a rank gets these permissions automatically. The Captain always has every permission.</p>
        <RankAccessEditor ranks={ranks} catalog={catalog} grantable={grantable} ownRankId={grantable === null ? null : user.rankId} />
      </div>
    </WebOnly>
  );
}
