'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCopy, faPen, faShieldHalved } from '@fortawesome/free-solid-svg-icons';
import { resetPasswordAction, setStatusAction } from '@/app/actions/users';
import { Dialog, ErrorBanner, Field, Select, SubmitLabel } from '@/app/components/ui';
import type { OrgOptions } from '@/lib/server/users/service';

type Props = {
  id: string; fullName: string; status: string; hasPassword: boolean;
  actions: { edit: boolean; status: boolean; resetPassword: boolean; access: boolean };
  org: OrgOptions;
};
type Open = null | 'deactivate' | 'reactivate' | 'reset' | 'resetDone';

export default function UserActions({ id, fullName, status, hasPassword, actions, org }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState<Open>(null);
  const [pending, start] = useTransition();
  const [f, setF] = useState({ reason: '', reasonId: '', note: '', password: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [temp, setTemp] = useState('');
  const set = (k: keyof typeof f) => (v: string) => setF((p) => ({ ...p, [k]: v }));

  const show = (o: Open) => {
    setF({ reason: '', reasonId: '', note: '', password: '' });
    setErrors({});
    setBanner(null);
    setOpen(o);
  };
  const close = () => !pending && setOpen(null);

  const run = (fn: () => Promise<{ ok: boolean; message?: string; fieldErrors?: Record<string, string> }>, after?: () => void) =>
    start(async () => {
      const res = await fn();
      if (res.ok) {
        if (after) after();
        else setOpen(null);
        router.refresh();
      } else {
        setErrors(res.fieldErrors ?? {});
        setBanner(res.message ?? null);
      }
    });

  const reason = org.inactiveReasons.find((r) => String(r.id) === f.reasonId);

  const cancelBtn = <button className="btn-secondary" disabled={pending} onClick={close}>Cancel</button>;
  const any = actions.edit || actions.access || actions.status || actions.resetPassword;
  if (!any) return null;

  return (
    <div className="grid grid-cols-2 lg:flex lg:flex-wrap lg:justify-end gap-2">
      {actions.edit && <Link href={`/users/${id}/edit`} className="btn-secondary"><FontAwesomeIcon icon={faPen} /> Edit</Link>}
      {actions.access && <Link href={`/users/${id}/access`} className="btn-secondary max-md:hidden"><FontAwesomeIcon icon={faShieldHalved} /> Permissions</Link>}
      {actions.resetPassword && <button className="btn-secondary" onClick={() => show('reset')}>Reset password</button>}
      {actions.status && status === 'active' && <button className="btn-danger" onClick={() => show('deactivate')}>Deactivate</button>}
      {actions.status && status === 'inactive' && <button className="btn-primary" onClick={() => show('reactivate')}>Reactivate</button>}

      <Dialog
        open={open === 'deactivate'} onClose={close} pending={pending} danger title={`Deactivate ${fullName}?`}
        body="They will no longer be able to sign in. Their records are kept."
        footer={<>{cancelBtn}<button className="btn-danger" disabled={pending} onClick={() => run(() => setStatusAction(id, { status: 'inactive', reasonId: Number(f.reasonId), note: f.note }))}><SubmitLabel pending={pending} idle="Deactivate" busy="Saving..." /></button></>}
      >
        <ErrorBanner message={banner} />
        <Select label="Reason" name="reasonId" value={f.reasonId} onChange={set('reasonId')} options={org.inactiveReasons.map((r) => ({ value: String(r.id), label: r.name }))} required error={errors.reasonId} />
        <Field label="Note" name="note" textarea value={f.note} onChange={set('note')} required={reason?.requiresNote} maxLength={500} error={errors.note} />
      </Dialog>

      <Dialog
        open={open === 'reactivate'} onClose={close} pending={pending} title={`Reactivate ${fullName}?`}
        body={<>They can sign in again.{!hasPassword && ' This member has no password; set a temporary password so they can sign in.'}</>}
        footer={<>{cancelBtn}<button className="btn-primary" disabled={pending} onClick={() => run(() => setStatusAction(id, { status: 'active', reason: f.reason }))}><SubmitLabel pending={pending} idle="Reactivate" busy="Saving..." /></button></>}
      >
        <ErrorBanner message={banner} />
        <Field label="Reason (optional)" name="reason" textarea value={f.reason} onChange={set('reason')} maxLength={500} />
      </Dialog>

      <Dialog
        open={open === 'reset'} onClose={close} pending={pending} title="Reset temporary password"
        body="Set a new temporary password. The member must change it at next sign in and will be signed out everywhere. Leave the password empty to generate one."
        footer={<>{cancelBtn}<button className="btn-primary" disabled={pending} onClick={() => run(async () => {
          const res = await resetPasswordAction(id, { password: f.password, reason: f.reason });
          if (res.ok) setTemp(res.data.tempPassword);
          return res;
        }, () => setOpen('resetDone'))}><SubmitLabel pending={pending} idle="Reset password" busy="Saving..." /></button></>}
      >
        <ErrorBanner message={banner} />
        <Field label="Temporary password" name="password" type="password" value={f.password} onChange={set('password')} autoComplete="new-password" error={errors.password} hint="At least 8 characters, or leave empty to generate." />
        <Field label="Reason" name="reason" textarea value={f.reason} onChange={set('reason')} required maxLength={500} error={errors.reason} />
      </Dialog>

      <Dialog
        open={open === 'resetDone'} onClose={() => { setTemp(''); setOpen(null); }} title="Temporary password set"
        body="Share it securely. It will not be shown again."
        footer={<button className="btn-primary" onClick={() => { setTemp(''); setOpen(null); }}>Done</button>}
      >
        <div className="flex gap-2 items-center">
          <code className="flex-1 font-mono bg-subtle rounded-lg px-3 py-2 break-all">{temp}</code>
          <button className="btn-secondary" aria-label="Copy" onClick={() => navigator.clipboard?.writeText(temp)}><FontAwesomeIcon icon={faCopy} /></button>
        </div>
      </Dialog>
    </div>
  );
}
