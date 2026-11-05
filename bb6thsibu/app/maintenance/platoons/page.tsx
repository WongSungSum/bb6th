import type { Metadata } from 'next';
import Link from 'next/link';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faLock } from '@fortawesome/free-solid-svg-icons';
import { requireUser } from '@/lib/server/auth/session';
import { can } from '@/lib/server/authz';
import { listPlatoons } from '@/lib/server/platoons/service';
import { StateCard } from '@/app/components/ui';
import WebOnly from '@/app/maintenance/web-only';
import PlatoonList from './platoon-list';

export const metadata: Metadata = { title: 'Platoons - BB6th Sibu' };

export default async function PlatoonsMaintenancePage() {
  const user = await requireUser();
  if (!(await can(user, 'platoons.manage'))) {
    return <StateCard icon={faLock} title="You do not have access" text="Only officers given the platoon permission can manage platoons." action={<Link href="/dashboard" className="btn-secondary">Back to dashboard</Link>} />;
  }
  const data = await listPlatoons();
  return (
    <WebOnly>
      <div className="max-w-6xl mx-auto">
        <Link href="/maintenance" className="back-link"><FontAwesomeIcon icon={faChevronLeft} /> Maintenance</Link>
        <h1 className="text-2xl font-bold tracking-tight mt-3">Platoons</h1>
        <p className="text-sm text-muted mb-5">
          Every member of a section with platoons must be in one platoon. Open a platoon to add or move members and choose its leaders.
          Nothing is deleted: deactivate a platoon after moving its members out.
        </p>
        <PlatoonList data={data} />
      </div>
    </WebOnly>
  );
}
