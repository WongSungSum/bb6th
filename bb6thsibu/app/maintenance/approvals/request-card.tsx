'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cancelRequestAction, decideRequestAction } from '@/app/actions/access';
import { Dialog, ErrorBanner, Field, SubmitLabel } from '@/app/components/ui';
import type { ChangeRequest, RankAccessChanges, RoleChanges, UserAccessChanges } from '@/lib/server/access/service';

const KIND: Record<string, string> = { user_access: 'Member permissions', role: 'Role', rank_access: 'Rank permissions' };
const STATUS: Record<string, string> = {
  pending: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  approved: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  rejected: 'bg-red-500/15 text-red-300 border-red-500/30',
  cancelled: 'bg-slate-500/15 text-fg-2 border-slate-500/30',
};
const fmt = (d: Date | string | null) => (d ? new Date(d).toLocaleString('en-MY', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');

/** 把改动内容转成一行一行的文字 */
function describe(r: ChangeRequest, labels: Record<string, string>): { text: string; tone: 'add' | 'remove' | 'neutral' }[] {
  const L = (s: string) => labels[s] ?? s;
  const out: { text: string; tone: 'add' | 'remove' | 'neutral' }[] = [];
  if (r.kind === 'user_access') {
    const c = r.changes as UserAccessChanges;
    for (const id of c.addRoles) out.push({ text: `Give role ${r.roleNames[id] ?? id}`, tone: 'add' });
    for (const id of c.removeRoles) out.push({ text: `Remove role ${r.roleNames[id] ?? id}`, tone: 'remove' });
    for (const o of c.overrides) {
      const to = o.to === 'inherit' ? 'Default' : o.to === 'allow' ? 'Allow' : 'Deny';
      out.push({ text: `${L(o.slug)}: ${to}${o.reason ? ` (${o.reason})` : ''}`, tone: o.to === 'allow' ? 'add' : o.to === 'deny' ? 'remove' : 'neutral' });
    }
  } else {
    const c = r.changes as RoleChanges & RankAccessChanges;
    if (c.create) out.push({ text: `Create role "${c.name?.to}"`, tone: 'add' });
    else if (c.name) out.push({ text: `Rename "${c.name.from}" to "${c.name.to}"`, tone: 'neutral' });
    if (c.description && !c.create) out.push({ text: `Description: ${c.description.to ?? '(none)'}`, tone: 'neutral' });
    if (c.isActive && !c.create) out.push({ text: c.isActive.to ? 'Reactivate role' : 'Deactivate role', tone: c.isActive.to ? 'add' : 'remove' });
    for (const p of c.addPermissions) out.push({ text: `Add: ${L(p)}`, tone: 'add' });
    for (const p of c.removePermissions) out.push({ text: `Remove: ${L(p)}`, tone: 'remove' });
  }
  return out;
}

export default function RequestCard({ r, labels, canDecide }: { r: ChangeRequest; labels: Record<string, string>; canDecide: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState<null | 'approve' | 'reject'>(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<string | undefined>();
  const [busy, start] = useTransition();
  const lines = describe(r, labels);
  const link = r.kind === 'user_access' ? `/users/${r.targetId}/access` : r.kind === 'role' && !r.targetId.startsWith('new:') ? `/maintenance/roles/${r.targetId}` : r.kind === 'rank_access' ? '/maintenance/rank-permissions' : null;

  const decide = () =>
    start(async () => {
      setError(null);
      const res = await decideRequestAction(r.id, open!, note);
      if (!res.ok) {
        setError(res.message);
        setFieldErr(res.fieldErrors?.note);
        return;
      }
      setOpen(null);
      router.refresh();
    });
  const cancel = () =>
    start(async () => {
      const res = await cancelRequestAction(r.id);
      if (!res.ok) setError(res.message);
      router.refresh();
    });

  return (
    <article className="card">
      <div className="flex flex-wrap items-start gap-2 justify-between">
        <div>
          <p className="text-xs text-muted">{KIND[r.kind]}</p>
          <h2 className="font-semibold">{link ? <a href={link} className="hover:text-violet-300">{r.targetName}</a> : r.targetName}</h2>
          <p className="text-xs text-muted">Requested by {r.requestedBy} · {fmt(r.requestedAt)}</p>
        </div>
        <span className={`inline-flex rounded-full border px-2.5 py-0.5 text-xs font-medium capitalize ${STATUS[r.status]}`}>{r.status === 'pending' ? 'Waiting' : r.status}</span>
      </div>
      <ul className="mt-3 space-y-1 text-sm">
        {lines.map((l, i) => (
          <li key={i} className={l.tone === 'add' ? 'text-emerald-300' : l.tone === 'remove' ? 'text-red-300' : 'text-fg'}>
            {l.tone === 'add' ? '+ ' : l.tone === 'remove' ? '− ' : '• '}{l.text}
          </li>
        ))}
      </ul>
      {r.reason && <p className="mt-2 text-sm text-muted">Reason: {r.reason}</p>}
      {r.status !== 'pending' && (
        <p className="mt-2 text-xs text-muted">
          {r.status === 'cancelled' ? 'Withdrawn' : r.status === 'approved' ? 'Confirmed' : 'Rejected'} by {r.decidedBy} · {fmt(r.decidedAt)}{r.decisionNote ? ` · ${r.decisionNote}` : ''}
        </p>
      )}
      {!open && <div className="mt-3"><ErrorBanner message={error} /></div>}
      {r.status === 'pending' && (canDecide || r.mine) && (
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 mt-4">
          {r.mine && <button className="btn-secondary" disabled={busy} onClick={cancel}>Withdraw</button>}
          {canDecide && <button className="btn-danger" disabled={busy} onClick={() => { setNote(''); setError(null); setFieldErr(undefined); setOpen('reject'); }}>Reject</button>}
          {canDecide && <button className="btn-primary" disabled={busy} onClick={() => { setNote(''); setError(null); setFieldErr(undefined); setOpen('approve'); }}>Confirm</button>}
        </div>
      )}
      <Dialog
        open={!!open} onClose={() => !busy && setOpen(null)} pending={busy} danger={open === 'reject'}
        title={open === 'approve' ? 'Confirm this change?' : 'Reject this change?'}
        body={open === 'approve' ? 'It takes effect immediately.' : 'Nothing changes. The requester will see your reason.'}
        footer={<>
          <button className="btn-secondary" disabled={busy} onClick={() => setOpen(null)}>Cancel</button>
          <button className={open === 'approve' ? 'btn-primary' : 'btn-danger'} disabled={busy} onClick={decide}>
            <SubmitLabel pending={busy} idle={open === 'approve' ? 'Confirm' : 'Reject'} busy="Saving..." />
          </button>
        </>}
      >
        <ErrorBanner message={error} />
        <Field label={open === 'reject' ? 'Reason' : 'Note (optional)'} name="note" textarea value={note} onChange={setNote} required={open === 'reject'} maxLength={500} error={fieldErr} />
      </Dialog>
    </article>
  );
}
