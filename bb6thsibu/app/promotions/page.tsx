import type { Metadata } from 'next';
import Link from 'next/link';
import { faLock } from '@fortawesome/free-solid-svg-icons';
import { requireUser } from '@/lib/server/auth/session';
import { can, memberScope } from '@/lib/server/authz';
import { ageUpCandidates, getOrgOptions, listUsers, scopedOrg } from '@/lib/server/users/service';
import { StateCard } from '@/app/components/ui';
import FilterPanel from '@/app/components/filter-panel';
import PromotionBoard from './board';
import AgeUpPanel from './age-up';

export const metadata: Metadata = { title: 'Promotions - BB6th Sibu' };

type SP = { q?: string; section?: string; rank?: string; platoon?: string; page?: string };

export default async function PromotionsPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser();
  if (!(await can(user, 'users.change_rank'))) {
    return <StateCard icon={faLock} title="You do not have access" text="Only the Captain and members given the promotion permission can change ranks." action={<Link href="/dashboard" className="btn-secondary">Back to dashboard</Link>} />;
  }
  const sp = await searchParams;
  const canSearchIc = await can(user, 'users.view_sensitive');
  const scope = await memberScope(user);
  const [data, org, ageUp] = await Promise.all([
    listUsers({ q: sp.q, section: Number(sp.section) || undefined, rank: Number(sp.rank) || undefined, platoon: Number(sp.platoon) || undefined, status: 'active', page: Number(sp.page) || 1, pageSize: 50 }, { canSearchIc, scope }),
    getOrgOptions().then((o) => scopedOrg(o, scope)),
    ageUpCandidates(scope),
  ]);

  return (
    <div className="max-w-7xl mx-auto">
      <div className="mb-4">
        <h1 className="text-xl md:text-2xl font-bold tracking-tight">Promotions</h1>
        <p className="text-sm text-muted">Select members, then move them all to the same rank. Every change is recorded in their rank history.</p>
      </div>
      <AgeUpPanel year={ageUp.year} groups={ageUp.groups} selfId={user.id} />
      <FilterPanel org={org} showStatus={false} />
      <PromotionBoard rows={data.rows} total={data.total} page={data.page} pageSize={data.pageSize} org={org} selfId={user.id} />
    </div>
  );
}
