'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowDown, faArrowUp, faChevronRight, faPen, faPlus, faTriangleExclamation } from '@fortawesome/free-solid-svg-icons';
import { createPlatoonAction, movePlatoonAction, updatePlatoonAction } from '@/app/actions/platoons';
import { Dialog, ErrorBanner, Field, Select, SubmitLabel } from '@/app/components/ui';
import type { PlatoonList as Data } from '@/lib/server/platoons/service';

type Edit =
  | { mode: 'new' }
  | { mode: 'rename'; id: number; name: string }
  | { mode: 'toggle'; id: number; name: string; activate: boolean };

const iconBtn = 'h-8 w-8 rounded-lg text-muted hover:bg-subtle-2 hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent';

export default function PlatoonList({ data }: { data: Data }) {
  const router = useRouter();
  const [edit, setEdit] = useState<Edit | null>(null);
  const [name, setName] = useState('');
  const [sectionId, setSectionId] = useState(String(data.sections.find((s) => s.name === 'Senior')?.id ?? data.sections[0]?.id ?? ''));
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<Record<string, string>>({});
  const [pageError, setPageError] = useState<string | null>(null);

  const open = (e: Edit) => {
    setEdit(e);
    setName(e.mode === 'rename' ? e.name : '');
    setError(null);
    setFields({});
  };
  const submit = () =>
    start(async () => {
      if (!edit) return;
      const res =
        edit.mode === 'new' ? await createPlatoonAction(Number(sectionId), name)
        : edit.mode === 'rename' ? await updatePlatoonAction(edit.id, { name })
        : await updatePlatoonAction(edit.id, { isActive: edit.activate });
      if (!res.ok) {
        setError(res.message);
        setFields(res.fieldErrors ?? {});
        return;
      }
      setEdit(null);
      router.refresh();
    });
  const move = (id: number, dir: 'up' | 'down') =>
    start(async () => {
      const res = await movePlatoonAction(id, dir);
      setPageError(res.ok ? null : res.message);
      router.refresh();
    });

  return (
    <div className="space-y-4">
      <ErrorBanner message={pageError} />
      {data.unassigned.length > 0 && (
        <section className="card border-amber-500/30">
          <h2 className="card-heading text-amber-300"><FontAwesomeIcon icon={faTriangleExclamation} /> {data.unassigned.length} member{data.unassigned.length > 1 ? 's' : ''} not in a platoon</h2>
          <p className="text-sm text-fg-2">
            {data.unassigned.slice(0, 30).map((u) => u.fullName).join(', ')}
            {data.unassigned.length > 30 && ` and ${data.unassigned.length - 30} more`}
          </p>
          <p className="text-xs text-muted mt-2">Open a platoon and choose Add members to place them.</p>
        </section>
      )}

      <section className="card p-0 md:p-0 overflow-hidden">
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <h2 className="card-heading mb-0">All platoons</h2>
          <button className="btn-primary" onClick={() => open({ mode: 'new' })} disabled={!data.sections.length}><FontAwesomeIcon icon={faPlus} /> New platoon</button>
        </div>
        {data.platoons.length === 0 ? (
          <p className="px-6 pb-6 text-sm text-muted">No platoons yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-subtle text-xs uppercase tracking-wider text-muted">
              <tr>{['Order', 'Platoon', 'Section', 'Members', 'Leader', 'Assistant leader', 'Status', ''].map((h) => <th key={h} className="px-4 py-3 text-left font-semibold">{h}</th>)}</tr>
            </thead>
            <tbody>
              {data.platoons.map((p, i) => (
                <tr key={p.id} className={`border-t border-line-soft ${p.isActive ? '' : 'opacity-60'}`}>
                  <td className="px-4 py-3 whitespace-nowrap">
                    <button className={iconBtn} aria-label={`Move ${p.name} up`} disabled={busy || i === 0} onClick={() => move(p.id, 'up')}><FontAwesomeIcon icon={faArrowUp} /></button>
                    <button className={iconBtn} aria-label={`Move ${p.name} down`} disabled={busy || i === data.platoons.length - 1} onClick={() => move(p.id, 'down')}><FontAwesomeIcon icon={faArrowDown} /></button>
                  </td>
                  <td className="px-4 py-3 font-medium">
                    {p.name}
                    <button className={`${iconBtn} ml-1`} aria-label={`Rename ${p.name}`} onClick={() => open({ mode: 'rename', id: p.id, name: p.name })}><FontAwesomeIcon icon={faPen} /></button>
                  </td>
                  <td className="px-4 py-3 text-fg-2">{p.sectionName}</td>
                  <td className="px-4 py-3">{p.members}</td>
                  <td className="px-4 py-3 text-fg-2">{p.leader ?? <span className="text-muted">Not set</span>}</td>
                  <td className="px-4 py-3 text-fg-2">{p.assistant ?? <span className="text-muted">Not set</span>}</td>
                  <td className="px-4 py-3">
                    <button className="text-xs text-violet-300 hover:text-violet-200" onClick={() => open({ mode: 'toggle', id: p.id, name: p.name, activate: !p.isActive })}>
                      {p.isActive ? 'Active · Deactivate' : 'Inactive · Reactivate'}
                    </button>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Link href={`/maintenance/platoons/${p.id}`} className="btn-secondary min-h-9">Open <FontAwesomeIcon icon={faChevronRight} /></Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <Dialog
        open={!!edit}
        onClose={() => setEdit(null)}
        pending={busy}
        danger={edit?.mode === 'toggle' && !edit.activate}
        title={!edit ? '' : edit.mode === 'new' ? 'New platoon' : edit.mode === 'rename' ? `Rename ${edit.name}` : `${edit.activate ? 'Reactivate' : 'Deactivate'} ${edit.name}?`}
        body={edit?.mode === 'toggle' ? (edit.activate ? 'Members can be added to it again.' : 'Move all members out first. Its past scores are kept.') : undefined}
        footer={
          <>
            <button className="btn-secondary" disabled={busy} onClick={() => setEdit(null)}>Cancel</button>
            <button className={edit?.mode === 'toggle' && !edit.activate ? 'btn-danger' : 'btn-primary'} disabled={busy} onClick={submit}>
              <SubmitLabel pending={busy} idle={edit?.mode === 'toggle' ? (edit.activate ? 'Reactivate' : 'Deactivate') : 'Save'} busy="Saving..." />
            </button>
          </>
        }
      >
        <ErrorBanner message={error} />
        {edit?.mode === 'new' && (
          <Select label="Section" name="sectionId" value={sectionId} onChange={setSectionId} options={data.sections.map((s) => ({ value: String(s.id), label: s.name }))} error={fields.sectionId} required />
        )}
        {edit && edit.mode !== 'toggle' && <Field label="Platoon name" name="name" value={name} onChange={setName} error={fields.name} maxLength={40} required />}
      </Dialog>
    </div>
  );
}
