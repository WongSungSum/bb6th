import type { Metadata } from 'next';
import Link from 'next/link';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faLock, faUserSlash } from '@fortawesome/free-solid-svg-icons';
import { getUserAccess } from '@/lib/server/access/service';
import { AppError } from '@/lib/server/errors';
import { RankBadge, SectionBadge, StateCard } from '@/app/components/ui';
import { maintenanceAccess } from '@/app/maintenance/guard';
import AccessForm from './access-form';
import WebOnly from '@/app/maintenance/web-only';

export const metadata: Metadata = { title: 'Member permissions - BB6th Sibu' };

export default async function UserAccessPage({ params }: { params: Promise<{ id: string }> }) {
  const { user, access, grantable } = await maintenanceAccess();
  if (!access) return <StateCard icon={faLock} title="You do not have access" action={<Link href="/dashboard" className="btn-secondary">Back to dashboard</Link>} />;
  const { id } = await params;
  let data;
  try {
    data = await getUserAccess(user, id);
  } catch (err) {
    if (err instanceof AppError) return <StateCard icon={faUserSlash} title="Member not found" action={<Link href="/users" className="btn-secondary">Back to members</Link>} />;
    throw err;
  }
  const t = data.target;
  return (
    <WebOnly>
      <div className="max-w-5xl mx-auto">
        <Link href={`/users/${t.id}`} className="back-link"><FontAwesomeIcon icon={faChevronLeft} /> {t.fullName}</Link>
        <div className="mt-3 mb-4">
          <h1 className="text-xl md:text-2xl font-bold tracking-tight">Permissions</h1>
          <div className="flex flex-wrap items-center gap-2 mt-1 text-sm text-muted">
            {t.fullName} <SectionBadge name={t.sectionName} /> <RankBadge name={t.rankName} captain={t.isCaptain} />
          </div>
        </div>
        <AccessForm
          userId={t.id}
          targetIsOfficer={t.isOfficer}
          roles={data.roles}
          permissions={data.permissions}
          pending={data.pending}
          editable={data.editable}
          reasonNotEditable={data.notEditableReason ?? ''}
          grantable={grantable}
          rankName={t.rankName}
        />
      </div>
    </WebOnly>
  );
}
