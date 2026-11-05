'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faStar } from '@fortawesome/free-solid-svg-icons';
import { saveRankAccessAction } from '@/app/actions/access';
import { ErrorBanner, Field, Select, SubmitLabel } from '@/app/components/ui';
import { PendingNotice, PermissionChecklist, SavedBanner, type CatalogItem } from '../shared';

type Rank = { id: number; name: string; sectionName: string; isCaptain: boolean; permissions: string[]; pending: boolean };

export default function RankAccessEditor({ ranks, catalog, grantable, ownRankId }: { ranks: Rank[]; catalog: CatalogItem[]; grantable: string[] | null; ownRankId: number | null }) {
  const router = useRouter();
  const first = ranks.find((r) => !r.isCaptain);
  const [rankId, setRankId] = useState(first?.id ?? 0);
  const rank = ranks.find((r) => r.id === rankId);
  const [perms, setPerms] = useState<string[]>(rank?.permissions ?? []);
  const [reason, setReason] = useState('');
  const [busy, start] = useTransition();
  const [banner, setBanner] = useState<string | null>(null);
  const [saved, setSaved] = useState<'applied' | 'pending' | null>(null);

  const pick = (id: number) => {
    const r = ranks.find((x) => x.id === id);
    setRankId(id);
    setPerms(r?.permissions ?? []);
    setReason('');
    setBanner(null);
    setSaved(null);
  };
  const save = () =>
    start(async () => {
      setBanner(null);
      const res = await saveRankAccessAction(rankId, { permissions: perms, reason });
      if (!res.ok) return setBanner(res.message);
      setSaved(res.data.status);
      router.refresh();
    });

  const sections = [...new Set(ranks.map((r) => r.sectionName))];
  const own = ownRankId === rankId;
  const locked = !rank || rank.isCaptain || rank.pending || own || saved === 'pending';

  return (
    <div className="grid md:grid-cols-[260px_1fr] gap-4">
      {/* 电脑：左边军阶清单；手机：下拉选单 */}
      <div className="md:hidden">
        <Select label="Rank" name="rank" value={String(rankId)} onChange={(v) => pick(Number(v))} options={ranks.map((r) => ({ value: String(r.id), label: `${r.name}${r.pending ? ' (waiting)' : ''}`, group: r.sectionName }))} />
      </div>
      <nav className="hidden md:block card p-2 md:p-2 h-fit" aria-label="Ranks">
        {sections.map((s) => (
          <div key={s} className="mb-2">
            <p className="text-xs uppercase tracking-wider text-muted px-3 pt-2 pb-1">{s}</p>
            {ranks.filter((r) => r.sectionName === s).map((r) => (
              <button
                key={r.id}
                onClick={() => pick(r.id)}
                aria-current={r.id === rankId ? 'true' : undefined}
                className={`w-full text-left text-sm rounded-lg px-3 py-2 flex items-center justify-between gap-2 ${r.id === rankId ? 'bg-violet-500/20 text-fg' : 'text-fg-2 hover:bg-subtle'}`}
              >
                <span>{r.isCaptain && <FontAwesomeIcon icon={faStar} className="text-violet-300 mr-1" />}{r.name}</span>
                <span className="text-xs text-muted">{r.pending ? 'waiting' : r.isCaptain ? 'all' : r.permissions.length}</span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      {rank && (
        <section className="card">
          <h2 className="text-lg font-semibold mb-1">{rank.sectionName} · {rank.name}</h2>
          {rank.isCaptain ? (
            <p className="text-sm text-muted">The Captain always has every permission. This cannot be changed.</p>
          ) : (
            <>
              <p className="text-sm text-muted mb-4">Tick the permissions every {rank.name} should get.</p>
              {rank.pending && !saved && <PendingNotice />}
              {own && <p className="mb-4 text-sm text-amber-300">This is your own rank. Ask the Captain to change it.</p>}
              <SavedBanner status={saved} />
              <ErrorBanner message={banner} />
              <PermissionChecklist catalog={catalog} value={perms} onChange={setPerms} grantable={grantable} disabled={locked} />
              <div className="mt-5">
                <Field label="Reason for this change (optional)" name="reason" textarea value={reason} onChange={setReason} maxLength={500} disabled={locked} />
              </div>
              <div className="flex justify-end">
                <button className="btn-primary max-sm:w-full" disabled={busy || locked} onClick={save}>
                  <SubmitLabel pending={busy} idle={grantable === null ? 'Save' : 'Send to Captain'} busy="Saving..." />
                </button>
              </div>
            </>
          )}
        </section>
      )}
    </div>
  );
}
