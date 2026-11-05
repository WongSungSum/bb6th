import type { Metadata } from 'next';
import Link from 'next/link';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faLock, faShield, faUserSlash } from '@fortawesome/free-solid-svg-icons';
import { requireUser } from '@/lib/server/auth/session';
import { can } from '@/lib/server/authz';
import { AppError } from '@/lib/server/errors';
import { getRequestMeta } from '@/lib/server/request';
import { allowedActions, getOrgOptions, getUserDetail } from '@/lib/server/users/service';
import { FlagBadge, RankBadge, SectionBadge, StateCard, StatusBadge } from '@/app/components/ui';
import UserActions from './user-actions';

export const metadata: Metadata = { title: 'Member - BB6th Sibu' };

const fmtDate = (d: string | Date | null) => (d ? new Date(d).toLocaleDateString('en-MY', { day: 'numeric', month: 'short', year: 'numeric' }) : null);
const ID_LABEL: Record<string, string> = { mykad: 'MyKad / MyKid', passport: 'Passport', other: 'Other', none: 'None (stateless)' };

function Item({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`text-sm break-words ${value ? 'text-fg' : 'text-muted'}`}>{value || 'Not provided'}</dd>
    </div>
  );
}

export default async function UserDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!(await can(user, 'users.view'))) {
    return <StateCard icon={faLock} title="You do not have access" text="Ask the Captain if you need this permission." action={<Link href="/dashboard" className="btn-secondary">Back to dashboard</Link>} />;
  }
  const { id } = await params;
  let d;
  try {
    d = await getUserDetail(user, id, await getRequestMeta());
  } catch (err) {
    if (err instanceof AppError) return <StateCard icon={faUserSlash} title="Member not found" action={<Link href="/users" className="btn-secondary">Back to members</Link>} />;
    throw err;
  }
  const [actions, org] = await Promise.all([allowedActions(user, d), getOrgOptions()]);
  const isOfficer = d.isOfficer;

  return (
    <div className="max-w-5xl mx-auto">
      <Link href="/users" className="back-link"><FontAwesomeIcon icon={faChevronLeft} /> Members</Link>

      {d.status === 'inactive' && (
        <div className="mt-4 rounded-xl border border-slate-500/30 bg-slate-500/10 px-4 py-3 text-sm">
          Inactive since {fmtDate(d.statusChangedAt)} - {d.inactiveReason}{d.inactiveNote ? `: ${d.inactiveNote}` : ''}
        </div>
      )}

      <div className="card mt-4 flex flex-col lg:flex-row lg:items-center gap-4">
        <div className="flex items-center gap-4 flex-1 min-w-0">
          <div className="h-16 w-16 shrink-0 rounded-full bg-gradient-to-b from-violet-500 to-indigo-500 text-white text-xl font-bold grid place-items-center">
            {d.fullName.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('')}
          </div>
          <div className="min-w-0">
            <h1 className="text-xl font-bold truncate">{d.fullName}</h1>
            <p className="text-sm text-muted">@{d.username}</p>
            <div className="flex flex-wrap gap-2 mt-2">
              <SectionBadge name={d.sectionName} />
              <RankBadge name={d.rankName} captain={d.isCaptain} />
              {d.platoonName && <span className="rounded-full border border-line text-fg-2 text-xs px-2.5 py-0.5">{d.platoonName}{d.platoonRole === 'leader' ? ' · Leader' : d.platoonRole === 'assistant' ? ' · Assistant leader' : ''}</span>}
              <StatusBadge status={d.status} />
              {d.mustChangePassword && <FlagBadge>Must change password</FlagBadge>}
              {!d.hasPassword && <FlagBadge>No password set</FlagBadge>}
            </div>
            {d.isCaptain && (
              <p className="text-xs text-muted mt-2">
                <FontAwesomeIcon icon={faShield} /> The Captain&apos;s rank and active status are protected. They can only change through succession.
              </p>
            )}
          </div>
        </div>
        <UserActions
          id={d.id}
          fullName={d.fullName}
          status={d.status}
          hasPassword={d.hasPassword}
          actions={actions}
          org={org}
        />
      </div>

      <div className="grid lg:grid-cols-3 gap-4 mt-4">
        <div className="lg:col-span-2 space-y-4">
          <section className="card">
            <h2 className="card-heading">Profile</h2>
            <dl className="grid sm:grid-cols-2 gap-4">
              <Item label="ID type" value={ID_LABEL[d.idType]} />
              <Item label="ID number" value={d.idNumber && <>{d.idNumber} {!d.idNumberVisible && <FontAwesomeIcon icon={faLock} className="text-muted" title="Hidden" />}</>} />
              <Item label="Gender" value={d.gender && d.gender[0].toUpperCase() + d.gender.slice(1)} />
              <Item label="Date of birth" value={fmtDate(d.dateOfBirth)} />
              <Item label="Join date" value={fmtDate(d.joinDate)} />
              <Item label="Phone" value={d.phone} />
              <Item label="Email" value={d.email} />
              <Item label="School" value={d.school} />
              <div className="sm:col-span-2"><Item label="Address" value={d.address} /></div>
            </dl>
          </section>

          {!isOfficer && (
            <section className="card">
              <h2 className="card-heading">Guardians</h2>
              {d.guardians.length === 0 ? (
                <p className="text-sm text-muted">No guardians recorded.</p>
              ) : (
                <div className="grid sm:grid-cols-2 gap-4">
                  {d.guardians.map((g) => (
                    <dl key={g.slot} className="space-y-2">
                      <Item label={`Guardian ${g.slot}`} value={`${g.name} (${g.relationship})`} />
                      <Item label="Phone" value={g.phone} />
                      <Item label="Email" value={g.email} />
                    </dl>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>

        <div className="space-y-4">
          <section className="card">
            <h2 className="card-heading">Rank history</h2>
            {d.rankHistory.length === 0 ? (
              <p className="text-sm text-muted">No rank changes.</p>
            ) : (
              <ol className="border-l border-line pl-4 space-y-4">
                {d.rankHistory.map((h, i) => (
                  <li key={i} className="relative">
                    <span className="absolute -left-[21px] top-1.5 h-2 w-2 rounded-full bg-violet-400" />
                    <p className="text-sm">{h.from ? `${h.from} → ${h.to}` : h.to}</p>
                    <p className="text-xs text-muted">{fmtDate(h.at)}{h.by ? ` · ${h.by}` : ''}</p>
                    <p className="text-xs text-muted">{h.reason}</p>
                  </li>
                ))}
              </ol>
            )}
          </section>

          {d.audit && (
            <section className="card">
              <h2 className="card-heading">Recent activity</h2>
              {d.audit.length === 0 ? (
                <p className="text-sm text-muted">No activity.</p>
              ) : (
                <ul className="space-y-3">
                  {d.audit.map((a, i) => (
                    <li key={i}>
                      <p className="text-sm">{a.action.replace(/_/g, ' ').toLowerCase()}</p>
                      <p className="text-xs text-muted">{fmtDate(a.at)}{a.by ? ` · ${a.by}` : ''}</p>
                      {a.reason && <p className="text-xs text-muted">{a.reason}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
