'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faArrowDown, faArrowUp, faLock, faPen, faPlus } from '@fortawesome/free-solid-svg-icons';
import { createRankAction, createSectionAction, moveOrgItemAction, updateOrgItemAction } from '@/app/actions/org';
import { Dialog, ErrorBanner, Field, SubmitLabel } from '@/app/components/ui';
import type { OrgSection } from '@/lib/server/org/service';
import AgeUpSetting from './age-up';

type Edit =
  | { mode: 'newSection' }
  | { mode: 'newRank'; sectionId: number; sectionName: string }
  | { mode: 'rename'; kind: 'section' | 'rank'; id: number; name: string }
  | { mode: 'toggle'; kind: 'section' | 'rank'; id: number; name: string; activate: boolean };

const iconBtn = 'h-8 w-8 rounded-lg text-muted hover:bg-subtle-2 hover:text-fg disabled:opacity-30 disabled:hover:bg-transparent';

export default function OrgEditor({ sections }: { sections: OrgSection[] }) {
  const router = useRouter();
  const [edit, setEdit] = useState<Edit | null>(null);
  const [name, setName] = useState('');
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErr, setFieldErr] = useState<string | undefined>();
  const [pageError, setPageError] = useState<string | null>(null);

  const openEdit = (e: Edit) => {
    setEdit(e);
    setName(e.mode === 'rename' ? e.name : '');
    setError(null);
    setFieldErr(undefined);
  };
  const run = (fn: () => Promise<{ ok: boolean; message?: string; fieldErrors?: Record<string, string> }>) =>
    start(async () => {
      const res = await fn();
      if (!res.ok) {
        setError(res.message ?? null);
        setFieldErr(res.fieldErrors?.name);
        return;
      }
      setEdit(null);
      router.refresh();
    });
  const move = (kind: 'section' | 'rank', id: number, dir: 'up' | 'down') =>
    start(async () => {
      const res = await moveOrgItemAction(kind, id, dir);
      setPageError(res.ok ? null : res.message);
      router.refresh();
    });
  const submit = () => {
    if (!edit) return;
    if (edit.mode === 'newSection') run(() => createSectionAction(name));
    else if (edit.mode === 'newRank') run(() => createRankAction(edit.sectionId, name));
    else if (edit.mode === 'rename') run(() => updateOrgItemAction(edit.kind, edit.id, { name }));
    else run(() => updateOrgItemAction(edit.kind, edit.id, { isActive: edit.activate }));
  };

  const title = !edit ? '' : edit.mode === 'newSection' ? 'New section' : edit.mode === 'newRank' ? `New rank in ${edit.sectionName}` : edit.mode === 'rename' ? `Rename ${edit.name}` : `${edit.activate ? 'Reactivate' : 'Deactivate'} ${edit.name}?`;

  return (
    <>
      <ErrorBanner message={pageError} />
      <div className="flex justify-end mb-3">
        <button className="btn-primary" onClick={() => openEdit({ mode: 'newSection' })}><FontAwesomeIcon icon={faPlus} /> New section</button>
      </div>
      <div className="grid lg:grid-cols-2 gap-4">
        {sections.map((s, si) => (
          <section key={s.id} className={`card ${s.isActive ? '' : 'opacity-60'}`}>
            <header className="flex items-center gap-2 mb-3">
              <div className="flex-1 min-w-0">
                <h2 className="font-semibold flex items-center gap-2">
                  {s.name}
                  {s.isSystem && <FontAwesomeIcon icon={faLock} className="text-xs text-muted" title="System section" />}
                  {!s.isActive && <span className="text-xs rounded-full border border-slate-500/30 bg-slate-500/15 px-2 py-0.5 font-normal">Inactive</span>}
                </h2>
                <p className="text-xs text-muted">{s.activeMembers} active {s.activeMembers === 1 ? 'member' : 'members'}</p>
              </div>
              <button className={iconBtn} aria-label={`Move ${s.name} up`} disabled={busy || si === 0} onClick={() => move('section', s.id, 'up')}><FontAwesomeIcon icon={faArrowUp} /></button>
              <button className={iconBtn} aria-label={`Move ${s.name} down`} disabled={busy || si === sections.length - 1} onClick={() => move('section', s.id, 'down')}><FontAwesomeIcon icon={faArrowDown} /></button>
              {!s.isSystem && <button className={iconBtn} aria-label={`Rename ${s.name}`} onClick={() => openEdit({ mode: 'rename', kind: 'section', id: s.id, name: s.name })}><FontAwesomeIcon icon={faPen} /></button>}
              {!s.isSystem && (
                <button className="text-xs px-2 min-h-8 rounded-lg text-fg-2 hover:bg-subtle-2" onClick={() => openEdit({ mode: 'toggle', kind: 'section', id: s.id, name: s.name, activate: !s.isActive })}>
                  {s.isActive ? 'Deactivate' : 'Reactivate'}
                </button>
              )}
            </header>
            <ul className="divide-y divide-line-soft border-y border-line-soft">
              {s.ranks.map((r, ri) => (
                <li key={r.id} className={`flex items-center gap-2 py-2 ${r.isActive ? '' : 'opacity-60'}`}>
                  <span className="flex-1 text-sm flex items-center gap-2">
                    {r.name}
                    {r.isSystem && <FontAwesomeIcon icon={faLock} className="text-xs text-muted" title="System rank" />}
                    {!r.isActive && <span className="text-xs text-muted">(inactive)</span>}
                    <span className="text-xs text-muted">· {r.activeMembers}</span>
                  </span>
                  <button className={iconBtn} aria-label={`Move ${r.name} up`} disabled={busy || ri === 0} onClick={() => move('rank', r.id, 'up')}><FontAwesomeIcon icon={faArrowUp} /></button>
                  <button className={iconBtn} aria-label={`Move ${r.name} down`} disabled={busy || ri === s.ranks.length - 1} onClick={() => move('rank', r.id, 'down')}><FontAwesomeIcon icon={faArrowDown} /></button>
                  {!r.isSystem && <button className={iconBtn} aria-label={`Rename ${r.name}`} onClick={() => openEdit({ mode: 'rename', kind: 'rank', id: r.id, name: r.name })}><FontAwesomeIcon icon={faPen} /></button>}
                  {!r.isSystem && (
                    <button className="text-xs px-2 min-h-8 rounded-lg text-fg-2 hover:bg-subtle-2" onClick={() => openEdit({ mode: 'toggle', kind: 'rank', id: r.id, name: r.name, activate: !r.isActive })}>
                      {r.isActive ? 'Deactivate' : 'Reactivate'}
                    </button>
                  )}
                </li>
              ))}
              {s.ranks.length === 0 && <li className="py-2 text-sm text-muted">No ranks yet.</li>}
            </ul>
            {s.isActive && !s.isSystem && <AgeUpSetting section={s} sections={sections} />}
            {s.isActive && (
              <button className="mt-3 text-sm text-violet-300 hover:text-violet-200" onClick={() => openEdit({ mode: 'newRank', sectionId: s.id, sectionName: s.name })}>
                <FontAwesomeIcon icon={faPlus} /> Add rank
              </button>
            )}
          </section>
        ))}
      </div>

      <Dialog
        open={!!edit} onClose={() => !busy && setEdit(null)} pending={busy} title={title} danger={edit?.mode === 'toggle' && !edit.activate}
        body={edit?.mode === 'toggle' ? (edit.activate ? 'It can be chosen again.' : 'It can no longer be chosen for members. Existing records are kept.') : undefined}
        footer={<>
          <button className="btn-secondary" disabled={busy} onClick={() => setEdit(null)}>Cancel</button>
          <button className={edit?.mode === 'toggle' && !edit.activate ? 'btn-danger' : 'btn-primary'} disabled={busy} onClick={submit}>
            <SubmitLabel pending={busy} idle={edit?.mode === 'toggle' ? (edit.activate ? 'Reactivate' : 'Deactivate') : 'Save'} busy="Saving..." />
          </button>
        </>}
      >
        <ErrorBanner message={error} />
        {edit && edit.mode !== 'toggle' && <Field label="Name" name="name" value={name} onChange={setName} required maxLength={40} error={fieldErr} />}
      </Dialog>
    </>
  );
}
