'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faMagnifyingGlass, faPlus, faUserMinus } from '@fortawesome/free-solid-svg-icons';
import { assignMembersAction, removeMembersAction, setLeadersAction } from '@/app/actions/platoons';
import { ErrorBanner, Select, SubmitLabel } from '@/app/components/ui';
import type { PlatoonDetail } from '@/lib/server/platoons/service';

const ROLE_LABEL = { leader: 'Leader', assistant: 'Assistant leader' } as const;

export default function PlatoonMembers({ data }: { data: PlatoonDetail }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [perPerson, setPerPerson] = useState<Record<string, string>>({});
  const [removeSel, setRemoveSel] = useState<string[]>([]);
  const [addSel, setAddSel] = useState<string[]>([]);
  const [q, setQ] = useState('');
  const [leader, setLeader] = useState(data.members.find((m) => m.platoonRole === 'leader')?.id ?? '');
  const [assistant, setAssistant] = useState(data.members.find((m) => m.platoonRole === 'assistant')?.id ?? '');
  // 资料刷新后（例如移除了队长）把选单同步回资料库的值
  const [seen, setSeen] = useState(data.members);
  if (seen !== data.members) {
    setSeen(data.members);
    setLeader(data.members.find((m) => m.platoonRole === 'leader')?.id ?? '');
    setAssistant(data.members.find((m) => m.platoonRole === 'assistant')?.id ?? '');
  }

  const nameOf = (id: string) => [...data.members, ...data.candidates].find((m) => m.id === id)?.fullName ?? id;
  const run = (fn: () => Promise<{ ok: boolean; message?: string; fieldErrors?: Record<string, string> }>, after: () => void) =>
    start(async () => {
      setError(null);
      setPerPerson({});
      const res = await fn();
      if (!res.ok) {
        setError(res.fieldErrors?.userIds ?? res.message ?? 'Something went wrong.');
        setPerPerson(res.fieldErrors ?? {});
        return;
      }
      after();
      router.refresh();
    });

  // 先列出还没有 Platoon 的人，再列出别的 Platoon 的人
  const candidates = useMemo(() => {
    const term = q.trim().toLowerCase();
    return data.candidates
      .filter((c) => !term || c.fullName.toLowerCase().includes(term))
      .sort((a, b) => Number(!!a.platoonId) - Number(!!b.platoonId) || a.fullName.localeCompare(b.fullName));
  }, [data.candidates, q]);
  const toggle = (list: string[], set: (v: string[]) => void, id: string) => set(list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
  const memberOptions = data.members.map((m) => ({ value: m.id, label: m.fullName }));
  const leadersDirty = leader !== (data.members.find((m) => m.platoonRole === 'leader')?.id ?? '') || assistant !== (data.members.find((m) => m.platoonRole === 'assistant')?.id ?? '');

  return (
    <div className="space-y-4">
      <ErrorBanner message={error} />
      {Object.keys(perPerson).length > 0 && (
        <ul className="card text-sm text-red-300 space-y-1">
          {Object.entries(perPerson).filter(([k]) => k.includes('-')).map(([id, msg]) => <li key={id}>{nameOf(id)}: {msg}</li>)}
        </ul>
      )}

      <div className="grid lg:grid-cols-2 gap-4 items-start">
        <section className="card">
          <h2 className="card-heading">Leaders</h2>
          <p className="text-sm text-muted mb-3">Leaders will be able to take attendance for their platoon when attendance is added.</p>
          <div className="grid grid-cols-2 gap-x-4">
            <Select label="Leader" name="leader" placeholder="Not set" value={leader} onChange={setLeader} options={memberOptions} error={perPerson.leaderId} />
            <Select label="Assistant leader" name="assistant" placeholder="Not set" value={assistant} onChange={setAssistant} options={memberOptions} error={perPerson.assistantId} />
          </div>
          <div className="flex justify-end">
            <button className="btn-primary" disabled={busy || !leadersDirty} onClick={() => run(() => setLeadersAction(data.platoon.id, leader || null, assistant || null), () => {})}>
              <SubmitLabel pending={busy} idle="Save leaders" busy="Saving..." />
            </button>
          </div>
        </section>

        <section className="card p-0 md:p-0 overflow-hidden">
          <div className="flex items-center justify-between px-6 pt-5 pb-3">
            <h2 className="card-heading mb-0">Members ({data.members.length})</h2>
            <button className="btn-secondary" disabled={busy || !removeSel.length} onClick={() => run(() => removeMembersAction(data.platoon.id, removeSel), () => setRemoveSel([]))}>
              <FontAwesomeIcon icon={faUserMinus} /> Remove {removeSel.length || ''}
            </button>
          </div>
          {data.members.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted">No members yet. Add members below.</p>
          ) : (
            <ul className="divide-y divide-line-soft max-h-[420px] overflow-y-auto">
              {data.members.map((m) => (
                <li key={m.id}>
                  <label className="flex items-center gap-3 px-6 py-2.5 cursor-pointer hover:bg-subtle">
                    <input type="checkbox" className="h-4 w-4 accent-violet-500" checked={removeSel.includes(m.id)} onChange={() => toggle(removeSel, setRemoveSel, m.id)} />
                    <span className="flex-1">{m.fullName}</span>
                    {m.platoonRole && <span className="rounded-full bg-violet-500/20 text-violet-200 text-xs px-2 py-0.5">{ROLE_LABEL[m.platoonRole]}</span>}
                    <span className="text-xs text-muted">{m.rankName}</span>
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      {data.platoon.isActive && (
        <section className="card p-0 md:p-0 overflow-hidden">
          <div className="flex flex-wrap items-center gap-3 justify-between px-6 pt-5 pb-3">
            <div>
              <h2 className="card-heading mb-0">Add members</h2>
              <p className="text-xs text-muted">Members already in another platoon are moved here. Their leader role does not move with them.</p>
            </div>
            <div className="flex gap-2 items-center">
              <div className="relative w-64">
                <FontAwesomeIcon icon={faMagnifyingGlass} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
                <input type="search" className="form-input pl-9 min-h-10 py-2" placeholder="Search name" aria-label="Search name" value={q} onChange={(e) => setQ(e.target.value)} />
              </div>
              <button className="btn-primary" disabled={busy || !addSel.length} onClick={() => run(() => assignMembersAction(data.platoon.id, addSel), () => setAddSel([]))}>
                <FontAwesomeIcon icon={faPlus} /> Add {addSel.length || ''}
              </button>
            </div>
          </div>
          {candidates.length === 0 ? (
            <p className="px-6 pb-6 text-sm text-muted">Everyone in {data.platoon.sectionName} is already in this platoon.</p>
          ) : (
            <ul className="divide-y divide-line-soft max-h-[420px] overflow-y-auto">
              {candidates.map((c) => (
                <li key={c.id}>
                  <label className="flex items-center gap-3 px-6 py-2.5 cursor-pointer hover:bg-subtle">
                    <input type="checkbox" className="h-4 w-4 accent-violet-500" checked={addSel.includes(c.id)} onChange={() => toggle(addSel, setAddSel, c.id)} />
                    <span className="flex-1">{c.fullName}</span>
                    <span className="text-xs text-muted">{c.rankName}</span>
                    {c.platoonName ? <span className="text-xs text-muted">Now in {c.platoonName}</span> : <span className="text-xs text-amber-300">No platoon</span>}
                  </label>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}
