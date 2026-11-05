import Link from 'next/link';
import { eq } from 'drizzle-orm';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { faArrowUpRightDots, faChevronRight, faClipboardCheck, faFlag, faMedal, faPlus, faRankingStar, faUsers } from '@fortawesome/free-solid-svg-icons';
import { db } from '@/lib/db/client';
import { platoons, ranks, sections, users } from '@/lib/db/schema';
import { requireUser } from '@/lib/server/auth/session';
import { can, memberScope } from '@/lib/server/authz';
import { pendingRequestCount } from '@/lib/server/access/service';
import { scoreboard } from '@/lib/server/platoons/service';
import { ageUpCandidates, listUsers } from '@/lib/server/users/service';
import { RankBadge, SectionBadge } from '@/app/components/ui';

const tile = 'card p-4 md:p-5 flex items-center gap-4 hover:bg-subtle transition-colors';

function Stat({ href, icon, value, label, alert }: { href: string; icon: IconDefinition; value: number; label: string; alert?: boolean }) {
  return (
    <Link href={href} className={tile}>
      <span className={`h-11 w-11 shrink-0 rounded-xl grid place-items-center ${alert ? 'bg-amber-500/15 text-amber-300' : 'bg-violet-500/15 text-violet-300'}`}>
        <FontAwesomeIcon icon={icon} />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-2xl font-bold leading-tight">{value}</span>
        <span className="block text-sm text-muted">{label}</span>
      </span>
      <FontAwesomeIcon icon={faChevronRight} className="text-muted" />
    </Link>
  );
}

export default async function Dashboard() {
  const user = await requireUser();
  const [canView, canCreate, canPromote, canScore, canAccess] = await Promise.all([
    can(user, 'users.view'),
    can(user, 'users.create'),
    can(user, 'users.change_rank'),
    can(user, 'platoons.score'),
    user.isCaptain || user.isSuperadmin ? Promise.resolve(true) : can(user, 'permissions.manage'),
  ]);
  const scope = canView || canPromote ? await memberScope(user) : null;
  const [me, board, members, ageUp, pending] = await Promise.all([
    db
      .select({ section: sections.name, rank: ranks.name, platoonId: users.platoonId, platoon: platoons.name, platoonRole: users.platoonRole })
      .from(users)
      .leftJoin(sections, eq(sections.id, users.sectionId))
      .leftJoin(ranks, eq(ranks.id, users.rankId))
      .leftJoin(platoons, eq(platoons.id, users.platoonId))
      .where(eq(users.id, user.id))
      .then((r) => r[0]),
    scoreboard(undefined),
    canView && scope ? listUsers({ status: 'active', page: 1, pageSize: 1 }, { canSearchIc: false, scope }).then((d) => d.total) : null,
    canPromote && scope ? ageUpCandidates(scope).then((a) => a.groups.reduce((n, g) => n + g.total, 0)) : null,
    canAccess ? pendingRequestCount(user) : 0,
  ]);
  const mine = me?.platoonId ? board.ranking.find((p) => p.id === me.platoonId) : undefined;
  const top = board.ranking.slice(0, 3);

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl md:text-2xl font-bold tracking-tight">Welcome back, {user.fullName}!</h1>
        <div className="flex flex-wrap items-center gap-2 mt-2">
          {user.isSuperadmin ? (
            <span className="text-sm text-muted">System administrator</span>
          ) : (
            <>
              <SectionBadge name={me?.section ?? null} />
              <RankBadge name={me?.rank ?? null} captain={user.isCaptain} />
              {me?.platoon && (
                <span className="text-sm text-fg-2">
                  <FontAwesomeIcon icon={faFlag} className="text-violet-300 mr-1" />
                  {me.platoon}{me.platoonRole === 'leader' ? ' · Leader' : me.platoonRole === 'assistant' ? ' · Assistant leader' : ''}
                </span>
              )}
            </>
          )}
        </div>
      </div>

      {(members !== null || ageUp !== null || pending > 0) && (
        <section aria-labelledby="dash-overview" className="space-y-3">
          <h2 id="dash-overview" className="text-sm font-semibold uppercase tracking-wider text-muted">Overview</h2>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {members !== null && <Stat href="/users" icon={faUsers} value={members} label={members === 1 ? 'Active member' : 'Active members'} />}
            {ageUp !== null && <Stat href="/promotions" icon={faArrowUpRightDots} value={ageUp} label={`Due to move up by age in ${board.year}`} alert={ageUp > 0} />}
            {pending > 0 && <Stat href="/maintenance/approvals" icon={faClipboardCheck} value={pending} label="Waiting for your confirmation" alert />}
          </div>
        </section>
      )}

      {(canCreate || canScore || canPromote) && (
        <section aria-labelledby="dash-actions" className="space-y-3">
          <h2 id="dash-actions" className="text-sm font-semibold uppercase tracking-wider text-muted">Quick actions</h2>
          <div className="flex flex-wrap gap-2">
            {canCreate && <Link href="/users/new" className="btn-primary max-sm:flex-1"><FontAwesomeIcon icon={faPlus} /> Add member</Link>}
            {canScore && <Link href="/platoons" className="btn-secondary max-sm:flex-1"><FontAwesomeIcon icon={faRankingStar} /> Record scores</Link>}
            {canPromote && <Link href="/promotions" className="btn-secondary max-sm:flex-1"><FontAwesomeIcon icon={faArrowUpRightDots} /> Promotions</Link>}
          </div>
        </section>
      )}

      <section aria-labelledby="dash-board" className="card">
        <div className="flex items-center justify-between gap-3 mb-3">
          <h2 id="dash-board" className="text-lg font-semibold">Platoon scoreboard {board.year}</h2>
          <Link href="/platoons" className="back-link">View all <FontAwesomeIcon icon={faChevronRight} /></Link>
        </div>
        {mine && (
          <p className="mb-3 rounded-xl bg-violet-500/10 border border-violet-400/30 px-4 py-3 text-sm">
            Your platoon <strong>{mine.name}</strong> is <strong>#{mine.place}</strong> with <strong>{mine.total}</strong> {mine.total === 1 ? 'point' : 'points'}.
          </p>
        )}
        {top.length ? (
          <ol className="divide-y divide-line-soft">
            {top.map((p) => (
              <li key={p.id} className={`flex items-center gap-3 py-2.5 ${p.id === me?.platoonId ? 'text-violet-200' : ''}`}>
                <span className="w-8 text-center">{p.place <= 3 ? <FontAwesomeIcon icon={faMedal} className={['text-amber-300', 'text-fg-2', 'text-orange-400'][p.place - 1]} /> : `#${p.place}`}</span>
                <span className="flex-1 truncate">{p.name}</span>
                <span className="font-semibold tabular-nums">{p.total}</span>
              </li>
            ))}
          </ol>
        ) : (
          <p className="text-sm text-muted">No platoons yet.</p>
        )}
      </section>
    </div>
  );
}
