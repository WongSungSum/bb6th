'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faBan, faMedal, faPen, faPlus, faRankingStar } from '@fortawesome/free-solid-svg-icons';
import { saveActivityAction, voidActivityAction } from '@/app/actions/platoons';
import { Dialog, ErrorBanner, Field, StateCard, SubmitLabel } from '@/app/components/ui';
import type { Scoreboard } from '@/lib/server/platoons/service';

type Activity = Scoreboard['activities'][number];
type Form = { id: string | null; name: string; activityDate: string; note: string; points: Record<number, string>; expectedUpdatedAt?: string };

const MEDAL = ['text-amber-300', 'text-fg-2', 'text-orange-400'];
const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);

export default function ScoreboardView({ data, canScore, canManage = false }: { data: Scoreboard; canScore: boolean; canManage?: boolean }) {
  const router = useRouter();
  const [busy, start] = useTransition();
  const [form, setForm] = useState<Form | null>(null);
  const [voiding, setVoiding] = useState<Activity | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const activePlatoons = data.platoons.filter((p) => p.isActive);

  const openNew = () => { setError(null); setFields({}); setForm({ id: null, name: '', activityDate: today(), note: '', points: {} }); };
  const openEdit = (a: Activity) => {
    setError(null);
    setFields({});
    setForm({ id: a.id, name: a.name, activityDate: a.activityDate, note: a.note ?? '', expectedUpdatedAt: a.updatedAt, points: Object.fromEntries(Object.entries(a.scores).map(([k, v]) => [Number(k), String(v)])) });
  };
  const save = () =>
    start(async () => {
      if (!form) return;
      const res = await saveActivityAction(form.id, {
        name: form.name, activityDate: form.activityDate, note: form.note, expectedUpdatedAt: form.expectedUpdatedAt,
        scores: Object.entries(form.points).map(([platoonId, points]) => ({ platoonId: Number(platoonId), points: points.trim() })),
      });
      if (!res.ok) { setError(res.message); setFields(res.fieldErrors ?? {}); return; }
      setForm(null);
      router.refresh();
    });
  const doVoid = () =>
    start(async () => {
      if (!voiding) return;
      const res = await voidActivityAction(voiding.id, voidReason);
      if (!res.ok) { setError(res.message); setFields(res.fieldErrors ?? {}); return; }
      setVoiding(null);
      router.refresh();
    });
  // 编辑时：原本有分数的停用 Platoon 也要能改
  const formPlatoons = form ? data.platoons.filter((p) => p.isActive || form.points[p.id] !== undefined) : [];

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
        <div>
          <h1 className="text-xl md:text-2xl font-bold tracking-tight">Platoon scoreboard</h1>
          <p className="text-sm text-muted">Total points from every platoon activity in {data.year}.</p>
        </div>
        <div className="flex gap-2 max-md:w-full">
          <nav aria-label="Year" className="flex gap-1 flex-wrap">
            {data.years.map((y) => (
              <Link key={y} href={`/platoons?year=${y}`} className={`px-3 min-h-10 inline-flex items-center rounded-full text-sm border ${y === data.year ? 'bg-violet-500/20 text-fg border-violet-400/50' : 'text-fg-2 border-line hover:bg-subtle'}`}>{y}</Link>
            ))}
          </nav>
          {canScore && activePlatoons.length > 0 && <button className="btn-primary max-md:flex-1" onClick={openNew}><FontAwesomeIcon icon={faPlus} /> Add activity</button>}
        </div>
      </div>

      {data.platoons.length === 0 ? (
        <StateCard icon={faRankingStar} title="No platoons yet" text={canManage ? 'Create the first platoon to start keeping score.' : 'Officers can create platoons in Maintenance.'} action={canManage ? <Link href="/maintenance/platoons" className="btn-primary"><FontAwesomeIcon icon={faPlus} /> New platoon</Link> : undefined} />
      ) : (
        <>
          <section className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-6" aria-label="Ranking">
            {data.ranking.map((p) => (
              <div key={p.id} className={`card p-4 md:p-5 flex items-center gap-4 ${p.place === 1 && p.total > 0 ? 'border-amber-400/40' : ''}`}>
                {/* 还没有任何分数时不颁奖牌 */}
                <div className={`h-12 w-12 shrink-0 rounded-full grid place-items-center text-lg font-bold ${p.place <= 3 && p.total > 0 ? `bg-subtle ${MEDAL[p.place - 1]}` : 'bg-subtle text-muted'}`}>
                  {p.place <= 3 && p.total > 0 ? <FontAwesomeIcon icon={faMedal} /> : p.place}
                </div>
                <div className="min-w-0">
                  <p className="text-xs text-muted">#{p.place}{!p.isActive && ' · inactive'}</p>
                  <p className="font-semibold truncate">{p.name}</p>
                  <p className="text-2xl font-bold tabular-nums">{p.total}<span className="text-sm text-muted font-normal"> pts</span></p>
                </div>
              </div>
            ))}
          </section>

          <section className="card p-0 md:p-0 overflow-hidden">
            <h2 className="card-heading px-4 md:px-6 pt-4 md:pt-6">Activities in {data.year}</h2>
            {data.activities.length === 0 ? (
              <p className="px-6 pb-6 text-sm text-muted">No activities recorded for this year.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-subtle text-xs uppercase tracking-wider text-muted">
                    <tr>
                      <th className="px-4 py-3 text-left font-semibold">Date</th>
                      <th className="px-4 py-3 text-left font-semibold">Activity</th>
                      {data.platoons.map((p) => <th key={p.id} className="px-4 py-3 text-right font-semibold whitespace-nowrap">{p.name}</th>)}
                      {canScore && <th className="px-4 py-3" />}
                    </tr>
                  </thead>
                  <tbody>
                    {data.activities.map((a) => (
                      <tr key={a.id} className={`border-t border-line-soft ${a.voided ? 'opacity-50' : ''}`}>
                        <td className="px-4 py-3 whitespace-nowrap text-fg-2">{a.activityDate}</td>
                        <td className="px-4 py-3">
                          <span className={a.voided ? 'line-through' : ''}>{a.name}</span>
                          {a.voided && <span className="block text-xs text-red-300">Voided: {a.voidReason}</span>}
                          {a.note && !a.voided && <span className="block text-xs text-muted">{a.note}</span>}
                        </td>
                        {data.platoons.map((p) => <td key={p.id} className="px-4 py-3 text-right tabular-nums">{a.scores[p.id] ?? <span className="text-faint">-</span>}</td>)}
                        {canScore && (
                          <td className="px-4 py-3 text-right whitespace-nowrap">
                            {!a.voided && (
                              <>
                                <button className="h-8 w-8 rounded-lg text-muted hover:bg-subtle-2 hover:text-fg" aria-label={`Edit ${a.name}`} onClick={() => openEdit(a)}><FontAwesomeIcon icon={faPen} /></button>
                                <button className="h-8 w-8 rounded-lg text-red-400 hover:bg-red-500/10" aria-label={`Void ${a.name}`} onClick={() => { setError(null); setFields({}); setVoidReason(''); setVoiding(a); }}><FontAwesomeIcon icon={faBan} /></button>
                              </>
                            )}
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      <Dialog
        open={!!form}
        onClose={() => setForm(null)}
        pending={busy}
        title={form?.id ? 'Edit activity' : 'Add activity'}
        body="Leave a platoon empty if it did not take part. Use 0 to clear a score."
        footer={
          <>
            <button className="btn-secondary" disabled={busy} onClick={() => setForm(null)}>Cancel</button>
            <button className="btn-primary" disabled={busy} onClick={save}><SubmitLabel pending={busy} idle="Save" busy="Saving..." /></button>
          </>
        }
      >
        <ErrorBanner message={error} />
        {form && (
          <>
            <Field label="Activity name" name="name" value={form.name} onChange={(name) => setForm({ ...form, name })} error={fields.name} maxLength={80} required />
            <Field label="Date" name="activityDate" type="date" value={form.activityDate} onChange={(activityDate) => setForm({ ...form, activityDate })} error={fields.activityDate} required />
            <Field label="Note (optional)" name="note" value={form.note} onChange={(note) => setForm({ ...form, note })} maxLength={500} />
            <fieldset>
              <legend className="text-xs text-muted mb-2">Points</legend>
              <p className="text-xs text-muted mb-2">Leave blank if the platoon did not take part. Clear a box to remove its points.</p>
              {fields.scores && <p className="text-xs text-red-300 mb-2">{fields.scores}</p>}
              <div className="grid grid-cols-2 gap-x-3">
                {formPlatoons.map((p) => (
                  <Field
                    key={p.id} label={p.name} name={`p${p.id}`} value={form.points[p.id] ?? ''} error={fields[`score.${p.id}`]} maxLength={5}
                    onChange={(v) => setForm((f) => f && { ...f, points: { ...f.points, [p.id]: v } })}
                  />
                ))}
              </div>
            </fieldset>
          </>
        )}
      </Dialog>

      <Dialog
        open={!!voiding}
        onClose={() => setVoiding(null)}
        pending={busy}
        danger
        title={`Void ${voiding?.name ?? ''}?`}
        body="Its points will no longer count. The record is kept and cannot be edited afterwards."
        footer={
          <>
            <button className="btn-secondary" disabled={busy} onClick={() => setVoiding(null)}>Cancel</button>
            <button className="btn-danger" disabled={busy} onClick={doVoid}><SubmitLabel pending={busy} idle="Void activity" busy="Saving..." /></button>
          </>
        }
      >
        <ErrorBanner message={error} />
        <Field label="Reason" name="reason" textarea value={voidReason} onChange={setVoidReason} error={fields.reason} maxLength={500} required />
      </Dialog>
    </div>
  );
}
