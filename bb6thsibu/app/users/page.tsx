import type { Metadata } from 'next';
import Link from 'next/link';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faLock, faMagnifyingGlass, faPlus, faUsers } from '@fortawesome/free-solid-svg-icons';
import { requireUser } from '@/lib/server/auth/session';
import { can, memberScope } from '@/lib/server/authz';
import { getOrgOptions, listUsers, scopedOrg } from '@/lib/server/users/service';
import { RankBadge, SectionBadge, StateCard, StatusBadge } from '@/app/components/ui';
import FilterPanel from '@/app/components/filter-panel';

export const metadata: Metadata = { title: 'Members - BB6th Sibu' };

type SP = { q?: string; section?: string; rank?: string; platoon?: string; status?: string; page?: string };

const initials = (name: string) => name.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('');

export default async function UsersPage({ searchParams }: { searchParams: Promise<SP> }) {
  const user = await requireUser();
  if (!(await can(user, 'users.view'))) {
    return <StateCard icon={faLock} title="You do not have access" text="Ask the Captain if you need this permission." action={<Link href="/dashboard" className="btn-secondary">Back to dashboard</Link>} />;
  }
  const sp = await searchParams;
  const status = sp.status === 'inactive' || sp.status === 'all' ? sp.status : 'active';
  const canSearchIc = await can(user, 'users.view_sensitive');
  const scope = await memberScope(user);
  const [data, org, canCreate] = await Promise.all([
    listUsers({ q: sp.q, section: Number(sp.section) || undefined, rank: Number(sp.rank) || undefined, platoon: Number(sp.platoon) || undefined, status, page: Number(sp.page) || 1 }, { canSearchIc, scope }),
    getOrgOptions().then((o) => scopedOrg(o, scope)),
    can(user, 'users.create'),
  ]);
  const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
  const filtered = !!(sp.q || sp.section || sp.rank || sp.platoon || status !== 'active' || data.page > 1);
  const pageHref = (p: number) => {
    const params = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]);
    params.set('page', String(p));
    return `/users?${params}`;
  };

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold tracking-tight">Members</h1>
          <p className="text-sm text-muted">{data.total} total</p>
        </div>
        <div className="flex gap-2 max-md:w-full">
          {canCreate && (
            <Link href="/users/new" className="btn-primary max-md:flex-1">
              <FontAwesomeIcon icon={faPlus} /> Add member
            </Link>
          )}
        </div>
      </div>

      <FilterPanel org={org} />

      {data.rows.length === 0 ? (
        filtered ? (
          <StateCard icon={faMagnifyingGlass} title="No members match your filters" action={<Link href="/users" className="btn-secondary">Clear filters</Link>} />
        ) : (
          <StateCard icon={faUsers} title="No members yet" text={canCreate ? 'Use Add member above to add the first one.' : undefined} />
        )
      ) : (
        <>
          {/* 电脑版：表格 */}
          <div className="hidden md:block card p-0 md:p-0 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-subtle text-xs uppercase tracking-wider text-muted">
                <tr>
                  {['Name', 'Section', 'Rank', 'Status', 'Phone'].map((h) => <th key={h} className="px-4 py-3 text-left font-semibold">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((u) => (
                  <tr key={u.id} className={`hover:bg-subtle ${u.status === 'inactive' ? 'opacity-70' : ''}`}>
                    <td className="px-4 py-3 border-t border-line-soft">
                      <Link href={`/users/${u.id}`} className="text-fg font-medium hover:text-violet-300">{u.fullName}</Link>
                      <div className="text-xs text-muted">@{u.username}</div>
                    </td>
                    <td className="px-4 py-3 border-t border-line-soft">
                      <SectionBadge name={u.sectionName} />
                      {u.platoonName && <div className="text-xs text-muted mt-1">{u.platoonName}{u.platoonRole === 'leader' ? ' · Leader' : u.platoonRole === 'assistant' ? ' · Assistant' : ''}</div>}
                    </td>
                    <td className="px-4 py-3 border-t border-line-soft"><RankBadge name={u.rankName} captain={u.isCaptain} /></td>
                    <td className="px-4 py-3 border-t border-line-soft"><StatusBadge status={u.status} /></td>
                    <td className="px-4 py-3 border-t border-line-soft text-fg">{u.phone ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* 手机版：卡片 */}
          <div className="md:hidden space-y-3">
            {data.rows.map((u) => (
              <Link key={u.id} href={`/users/${u.id}`} className={`card p-4 md:p-4 flex flex-col gap-3 ${u.status === 'inactive' ? 'opacity-70' : ''}`}>
                <div className="flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-gradient-to-b from-violet-500 to-indigo-500 text-white font-bold grid place-items-center text-sm">{initials(u.fullName)}</div>
                  <div className="min-w-0">
                    <p className="font-semibold truncate">{u.fullName}</p>
                    <p className="text-xs text-muted">@{u.username}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  <SectionBadge name={u.sectionName} />
                  <RankBadge name={u.rankName} captain={u.isCaptain} />
                  <StatusBadge status={u.status} />
                  {u.platoonName && <span className="text-xs text-muted self-center">{u.platoonName}{u.platoonRole === 'leader' ? ' · Leader' : u.platoonRole === 'assistant' ? ' · Assistant' : ''}</span>}
                </div>
                {u.phone && <p className="text-sm text-fg"><span className="text-xs text-muted">Phone </span>{u.phone}</p>}
              </Link>
            ))}
          </div>
          <div className="flex items-center justify-between mt-4 text-sm text-muted">
            <span>
              Showing {(data.page - 1) * data.pageSize + 1}-{Math.min(data.page * data.pageSize, data.total)} of {data.total}
            </span>
            <div className="flex gap-2">
              {data.page > 1 && <Link href={pageHref(data.page - 1)} className="btn-secondary min-h-10">Prev</Link>}
              {data.page < pages && <Link href={pageHref(data.page + 1)} className="btn-secondary min-h-10">Next</Link>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
