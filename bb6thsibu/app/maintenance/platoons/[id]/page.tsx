import type { Metadata } from 'next';
import Link from 'next/link';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faLock, faPeopleGroup } from '@fortawesome/free-solid-svg-icons';
import { requireUser } from '@/lib/server/auth/session';
import { can } from '@/lib/server/authz';
import { AppError } from '@/lib/server/errors';
import { getPlatoon } from '@/lib/server/platoons/service';
import { StateCard } from '@/app/components/ui';
import WebOnly from '@/app/maintenance/web-only';
import PlatoonMembers from './platoon-members';

export const metadata: Metadata = { title: 'Platoon - BB6th Sibu' };

export default async function PlatoonPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!(await can(user, 'platoons.manage'))) {
    return <StateCard icon={faLock} title="You do not have access" action={<Link href="/dashboard" className="btn-secondary">Back to dashboard</Link>} />;
  }
  const { id } = await params;
  let data;
  try {
    data = await getPlatoon(user, Number(id));
  } catch (err) {
    if (err instanceof AppError) return <StateCard icon={faPeopleGroup} title="Platoon not found" action={<Link href="/maintenance/platoons" className="btn-secondary">Back to platoons</Link>} />;
    throw err;
  }
  return (
    <WebOnly>
      <div className="max-w-6xl mx-auto">
        <Link href="/maintenance/platoons" className="back-link"><FontAwesomeIcon icon={faChevronLeft} /> Platoons</Link>
        <h1 className="text-2xl font-bold tracking-tight mt-3">{data.platoon.name}</h1>
        <p className="text-sm text-muted mb-5">
          {data.platoon.sectionName} · {data.members.length} member{data.members.length === 1 ? '' : 's'}
          {!data.platoon.isActive && ' · Inactive'}
        </p>
        <PlatoonMembers data={data} />
      </div>
    </WebOnly>
  );
}
