'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowUpRightDots, faCircleCheck, faUsers } from '@fortawesome/free-solid-svg-icons';
import { promoteAction } from '@/app/actions/users';
import { Dialog, ErrorBanner, Field, RankBadge, SectionBadge, Select, StateCard, SubmitLabel } from '@/app/components/ui';
import type { OrgOptions, UserListItem } from '@/lib/server/users/service';

type Props = { rows: UserListItem[]; total: number; page: number; pageSize: number; org: OrgOptions; selfId: string };

export default function PromotionBoard({ rows, total, page, pageSize, org, selfId }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  // 选择跨页、跨筛选保留：id → 姓名与目前军阶
  const [selected, setSelected] = useState<Map<string, { name: string; rank: string | null }>>(new Map());
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [f, setF] = useState({ sectionId: '', rankId: '', reason: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const selectable = (u: UserListItem) => !u.isCaptain && u.id !== selfId;
  const pageRows = rows.filter(selectable);
  const allOnPage = pageRows.length > 0 && pageRows.every((u) => selected.has(u.id));
  const toggle = (u: UserListItem) =>
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(u.id)) next.delete(u.id);
      else next.set(u.id, { name: u.fullName, rank: u.rankName });
      return next;
    });
  const togglePage = () =>
    setSelected((prev) => {
      const next = new Map(prev);
      for (const u of pageRows) {
        if (allOnPage) next.delete(u.id);
        else next.set(u.id, { name: u.fullName, rank: u.rankName });
      }
      return next;
    });

  const pages = Math.max(1, Math.ceil(total / pageSize));
  const pageHref = (p: number) => {
    const params = new URLSearchParams(sp.toString());
    params.set('page', String(p));
    return `${pathname}?${params}`;
  };

  const show = () => {
    setF({ sectionId: '', rankId: '', reason: '' });
    setErrors({});
    setBanner(null);
    setDone(null);
    setOpen(true);
  };
  const submit = () =>
    start(async () => {
      const res = await promoteAction({ userIds: [...selected.keys()], sectionId: Number(f.sectionId), rankId: Number(f.rankId), reason: f.reason });
      if (res.ok) {
        const rank = org.ranks.find((r) => String(r.id) === f.rankId)?.name;
        setDone(`${res.data.count} member${res.data.count > 1 ? 's' : ''} moved to ${rank}.`);
        setSelected(new Map());
        setOpen(false);
        router.refresh();
      } else {
        setErrors(res.fieldErrors ?? {});
        setBanner(res.fieldErrors?.userIds ?? res.message);
      }
    });

  const rankOptions = org.ranks.filter((r) => String(r.sectionId) === f.sectionId && !r.isCaptain).map((r) => ({ value: String(r.id), label: r.name }));
  const perMember = Object.entries(errors).filter(([k]) => selected.has(k));

  return (
    <>
      {done && (
        <div role="status" className="mb-4 flex gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-200 text-sm px-4 py-3">
          <FontAwesomeIcon icon={faCircleCheck} className="mt-0.5" /> {done}
        </div>
      )}

      {rows.length === 0 ? (
        <StateCard icon={faUsers} title="No active members match your filters" />
      ) : (
        <>
          {/* 电脑版：表格 */}
          <div className="hidden md:block card p-0 md:p-0 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-subtle text-xs uppercase tracking-wider text-muted">
                <tr>
                  <th className="px-4 py-3 w-12">
                    <input type="checkbox" aria-label="Select all on this page" className="h-4 w-4 accent-violet-500" checked={allOnPage} onChange={togglePage} />
                  </th>
                  {['Name', 'Section', 'Current rank'].map((h) => <th key={h} className="px-4 py-3 text-left font-semibold">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((u) => (
                  <tr
                    key={u.id}
                    className={`border-t border-line-soft ${selected.has(u.id) ? 'bg-violet-500/10' : 'hover:bg-subtle'} ${selectable(u) ? 'cursor-pointer' : 'opacity-60'}`}
                    onClick={() => selectable(u) && toggle(u)}
                  >
                    <td className="px-4 py-3">
                      <input
                        type="checkbox" aria-label={`Select ${u.fullName}`} className="h-4 w-4 accent-violet-500"
                        disabled={!selectable(u)} checked={selected.has(u.id)} onChange={() => toggle(u)} onClick={(e) => e.stopPropagation()}
                      />
                    </td>
                    <td className="px-4 py-3">
                      <span className="text-fg font-medium">{u.fullName}</span>
                      <div className="text-xs text-muted">@{u.username}{u.isCaptain ? ' · changes only through succession' : u.id === selfId ? ' · you' : ''}</div>
                    </td>
                    <td className="px-4 py-3"><SectionBadge name={u.sectionName} /></td>
                    <td className="px-4 py-3"><RankBadge name={u.rankName} captain={u.isCaptain} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {/* 手机版：卡片 */}
          <div className="md:hidden space-y-2">
            <label className="flex items-center gap-3 px-1 min-h-11 text-sm text-fg-2">
              <input type="checkbox" className="h-5 w-5 accent-violet-500" checked={allOnPage} onChange={togglePage} /> Select all on this page
            </label>
            {rows.map((u) => (
              <label key={u.id} className={`card p-4 md:p-4 flex items-center gap-3 ${selected.has(u.id) ? 'border-violet-400/60 bg-violet-500/10' : ''} ${selectable(u) ? '' : 'opacity-60'}`}>
                <input type="checkbox" className="h-5 w-5 accent-violet-500 shrink-0" disabled={!selectable(u)} checked={selected.has(u.id)} onChange={() => toggle(u)} />
                <div className="min-w-0 flex-1">
                  <p className="font-semibold truncate">{u.fullName}</p>
                  <div className="flex flex-wrap gap-2 mt-1"><SectionBadge name={u.sectionName} /><RankBadge name={u.rankName} captain={u.isCaptain} /></div>
                </div>
              </label>
            ))}
          </div>
          <div className="flex items-center justify-between mt-4 mb-24 text-sm text-muted">
            <span>Showing {(page - 1) * pageSize + 1}-{Math.min(page * pageSize, total)} of {total}</span>
            <div className="flex gap-2">
              {page > 1 && <Link href={pageHref(page - 1)} className="btn-secondary min-h-10">Prev</Link>}
              {page < pages && <Link href={pageHref(page + 1)} className="btn-secondary min-h-10">Next</Link>}
            </div>
          </div>
        </>
      )}

      {/* 底部操作栏 */}
      {selected.size > 0 && (
        <div className="fixed inset-x-0 bottom-20 md:bottom-6 z-40 px-4 pointer-events-none">
          <div className="pointer-events-auto mx-auto max-w-3xl card md:p-4 p-3 flex items-center gap-3 shadow-2xl border-violet-400/40">
            <span className="flex-1 text-sm"><span className="font-semibold text-fg">{selected.size}</span> selected</span>
            <button className="btn-secondary" onClick={() => setSelected(new Map())}>Clear</button>
            <button className="btn-primary" onClick={show}><FontAwesomeIcon icon={faArrowUpRightDots} /> Change rank</button>
          </div>
        </div>
      )}

      <Dialog
        open={open} onClose={() => !pending && setOpen(false)} pending={pending}
        title={`Change rank for ${selected.size} member${selected.size > 1 ? 's' : ''}`}
        body="Everyone selected moves to the same rank. If anyone cannot be changed, nothing is saved."
        footer={<>
          <button className="btn-secondary" disabled={pending} onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn-primary" disabled={pending} onClick={submit}><SubmitLabel pending={pending} idle="Confirm" busy="Saving..." /></button>
        </>}
      >
        <ErrorBanner message={banner} />
        {perMember.length > 0 && (
          <ul className="mb-4 text-sm space-y-1 max-h-40 overflow-y-auto">
            {perMember.map(([id, msg]) => <li key={id} className="text-red-300"><span className="text-fg">{selected.get(id)?.name}</span>: {msg}</li>)}
          </ul>
        )}
        <details className="mb-4 text-sm text-fg-2">
          <summary className="cursor-pointer text-violet-300">Show selected members</summary>
          <ul className="mt-2 space-y-1 max-h-40 overflow-y-auto">
            {[...selected.entries()].map(([id, s]) => <li key={id}>{s.name} <span className="text-muted">({s.rank})</span></li>)}
          </ul>
        </details>
        <Select label="Section" name="sectionId" value={f.sectionId} onChange={(v) => setF((p) => ({ ...p, sectionId: v, rankId: '' }))} options={org.sections.map((s) => ({ value: String(s.id), label: s.name }))} required />
        <Select label="New rank" name="rankId" value={f.rankId} onChange={(v) => setF((p) => ({ ...p, rankId: v }))} options={rankOptions} required error={errors.rankId} />
        <Field label="Reason" name="reason" textarea value={f.reason} onChange={(v) => setF((p) => ({ ...p, reason: v }))} required maxLength={500} error={errors.reason} />
      </Dialog>
    </>
  );
}
