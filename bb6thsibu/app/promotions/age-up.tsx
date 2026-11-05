'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCakeCandles, faChevronDown } from '@fortawesome/free-solid-svg-icons';
import { promoteAction } from '@/app/actions/users';
import { Dialog, ErrorBanner, Field, SubmitLabel } from '@/app/components/ui';
import type { AgeUpGroup } from '@/lib/server/users/service';

const MAX = 100;

/** 到龄名单：每个组别一张卡，预设全选，军官确认后一起升 */
export default function AgeUpPanel({ year, groups, selfId }: { year: number; groups: AgeUpGroup[]; selfId: string }) {
  const due = groups.filter((g) => g.members.length);
  if (!due.length) return null;
  return (
    <div className="space-y-3 mb-5">
      {due.map((g) => <AgeUpCard key={g.sectionId} year={year} group={g} selfId={selfId} />)}
    </div>
  );
}

function AgeUpCard({ year, group, selfId }: { year: number; group: AgeUpGroup; selfId: string }) {
  const router = useRouter();
  const members = group.members.filter((m) => m.id !== selfId);
  const [expanded, setExpanded] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set(members.slice(0, MAX).map((m) => m.id)));
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [pending, start] = useTransition();
  const [banner, setBanner] = useState<string | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [done, setDone] = useState<string | null>(null);

  // 只算还在名单上的人（升完刷新后，已升的人会从名单消失）
  const chosen = members.filter((m) => picked.has(m.id)).map((m) => m.id);
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const nameOf = (id: string) => members.find((m) => m.id === id)?.fullName ?? id;
  const perMember = Object.entries(errors).filter(([k]) => k !== 'reason' && k !== 'userIds' && k !== 'rankId');

  const show = () => {
    setReason(`Age-up ${year}: turning ${group.age} this year`);
    setBanner(null);
    setErrors({});
    setOpen(true);
  };
  const submit = () =>
    start(async () => {
      const res = await promoteAction({ userIds: chosen, sectionId: group.toSectionId, rankId: group.rankId, reason });
      if (!res.ok) {
        setBanner(res.fieldErrors?.userIds ?? res.fieldErrors?.rankId ?? res.message);
        setErrors(res.fieldErrors ?? {});
        return;
      }
      setOpen(false);
      setDone(`${res.data.count} moved up to ${group.toSectionName} · ${group.rankName}.`);
      router.refresh();
    });

  return (
    <section className="card border-amber-400/30 bg-amber-500/5">
      <header className="flex flex-wrap items-center gap-3">
        <FontAwesomeIcon icon={faCakeCandles} className="text-amber-300" />
        <div className="flex-1 min-w-0">
          <h2 className="font-semibold">{group.total} {group.sectionName} member{group.total === 1 ? '' : 's'} due to move up</h2>
          <p className="text-xs text-muted">Turning {group.age} or older in {year} → {group.toSectionName} · {group.rankName}</p>
        </div>
        <button className="btn-secondary min-h-10" onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
          Review <FontAwesomeIcon icon={faChevronDown} className={`transition-transform ${expanded ? 'rotate-180' : ''}`} />
        </button>
        <button className="btn-primary min-h-10" disabled={!chosen.length} onClick={show}>Move up {chosen.length}</button>
      </header>
      {done && <p role="status" className="mt-3 text-sm text-emerald-300">{done}</p>}
      {expanded && (
        <ul className="mt-3 divide-y divide-line-soft border-t border-line-soft max-h-80 overflow-y-auto">
          {members.map((m) => (
            <li key={m.id}>
              <label className="flex items-center gap-3 py-2 text-sm cursor-pointer">
                <input type="checkbox" className="h-4 w-4 accent-violet-500" checked={picked.has(m.id)} onChange={() => toggle(m.id)} />
                <span className="flex-1 min-w-0">
                  <span className="text-fg">{m.fullName}</span> <span className="text-muted">@{m.username}</span>
                </span>
                <span className="text-xs text-muted">{m.rankName} · turns {m.turns}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {group.total > MAX && <p className="mt-2 text-xs text-amber-300">Only {MAX} can move at a time. Move these first, then the rest.</p>}

      <Dialog
        open={open} onClose={() => !pending && setOpen(false)} pending={pending}
        title={`Move ${chosen.length} to ${group.toSectionName} · ${group.rankName}?`}
        body="Everyone selected moves to this rank. They leave their current platoon. If anyone cannot be moved, nothing is saved."
        footer={<>
          <button className="btn-secondary" disabled={pending} onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn-primary" disabled={pending} onClick={submit}><SubmitLabel pending={pending} idle="Confirm" busy="Saving..." /></button>
        </>}
      >
        <ErrorBanner message={banner} />
        {perMember.length > 0 && (
          <ul className="mb-4 text-sm space-y-1 max-h-40 overflow-y-auto">
            {perMember.map(([id, msg]) => <li key={id} className="text-red-300"><span className="text-fg">{nameOf(id)}</span>: {msg}</li>)}
          </ul>
        )}
        <Field label="Reason" name="reason" textarea value={reason} onChange={setReason} required maxLength={500} error={errors.reason} />
      </Dialog>
    </section>
  );
}
