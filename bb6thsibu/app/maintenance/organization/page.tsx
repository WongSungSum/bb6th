import type { Metadata } from 'next';
import Link from 'next/link';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faDesktop, faLock } from '@fortawesome/free-solid-svg-icons';
import { listOrg } from '@/lib/server/org/service';
import { StateCard } from '@/app/components/ui';
import { maintenanceAccess } from '../guard';
import OrgEditor from './org-editor';

export const metadata: Metadata = { title: 'Ranks & Sections - BB6th Sibu' };

export default async function OrganizationPage() {
  const { orgAdmin } = await maintenanceAccess();
  if (!orgAdmin) return <StateCard icon={faLock} title="Only the Captain and Superadmin can manage ranks and sections" action={<Link href="/maintenance" className="btn-secondary">Back to maintenance</Link>} />;
  const sections = await listOrg();
  return (
    <div className="max-w-6xl mx-auto">
      <Link href="/maintenance" className="back-link"><FontAwesomeIcon icon={faChevronLeft} /> Maintenance</Link>
      {/* 只在电脑版提供 */}
      <div className="md:hidden mt-4">
        <StateCard icon={faDesktop} title="Use a computer for this page" text="Ranks and sections can only be managed from the web version on a larger screen." />
      </div>
      <div className="hidden md:block">
        <h1 className="text-2xl font-bold tracking-tight mt-3">Ranks &amp; Sections</h1>
        <p className="text-sm text-muted mb-5">
          Nothing is deleted: deactivate instead. A rank or section still used by active members cannot be deactivated.
          The Officer section and the Captain rank are fixed.
        </p>
        <OrgEditor sections={sections} />
      </div>
    </div>
  );
}
