'use client';

import { useState, useTransition } from 'react';
import { PASSWORD_MIN } from '@/lib/validation/users';
import { useRouter } from 'next/navigation';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faCircle } from '@fortawesome/free-solid-svg-icons';
import { changePasswordAction, logoutAction } from '@/app/actions/auth';
import { ErrorBanner, Field, SubmitLabel } from '@/app/components/ui';

export default function ChangePassword({ forced }: { forced: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [form, setForm] = useState({ current: '', next: '', confirm: '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const set = (k: keyof typeof form) => (v: string) => setForm({ ...form, [k]: v });

  const rules = [
    { ok: form.next.length >= PASSWORD_MIN, text: `At least ${PASSWORD_MIN} characters` },
    { ok: !!form.next && form.next !== form.current, text: 'Different from your current password' },
  ];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!form.current) errs.current = 'Enter your current password.';
    if (form.next.length < PASSWORD_MIN) errs.next = `Use at least ${PASSWORD_MIN} characters.`;
    else if (form.next === form.current) errs.next = 'New password must be different.';
    if (form.confirm !== form.next) errs.confirm = 'Passwords do not match.';
    setErrors(errs);
    if (Object.keys(errs).length) return;
    start(async () => {
      const res = await changePasswordAction(form);
      if (res.ok) router.replace('/dashboard');
      else {
        setErrors(res.fieldErrors ?? {});
        setBanner(res.message);
      }
    });
  };

  return (
    <main className="min-h-dvh grid place-items-center px-4">
      <div className="w-full max-w-md">
        <form onSubmit={submit} noValidate className="card p-6 md:p-8">
          <h1 className="text-xl font-bold">Set a new password</h1>
          <p className="text-sm text-muted mb-6">
            {forced ? 'Your password was set by an administrator. Choose your own to continue.' : 'Choose a new password.'}
          </p>
          <ErrorBanner message={banner} />
          <Field label="Current password" name="current" type="password" value={form.current} onChange={set('current')} error={errors.current} autoComplete="current-password" required />
          <Field label="New password" name="next" type="password" value={form.next} onChange={set('next')} error={errors.next} autoComplete="new-password" required />
          <ul className="-mt-3 mb-5 space-y-1 text-xs">
            {rules.map((r) => (
              <li key={r.text} className={r.ok ? 'text-emerald-400' : 'text-muted'}>
                <FontAwesomeIcon icon={r.ok ? faCheck : faCircle} className={r.ok ? '' : 'text-[6px] align-middle mx-1'} /> {r.text}
              </li>
            ))}
          </ul>
          <Field label="Confirm new password" name="confirm" type="password" value={form.confirm} onChange={set('confirm')} error={errors.confirm} autoComplete="new-password" required />
          <button type="submit" disabled={pending} className="btn-primary w-full">
            <SubmitLabel pending={pending} idle="Save password" busy="Saving..." />
          </button>
        </form>
        <form action={logoutAction} className="text-center mt-4">
          <button className="text-sm text-muted hover:text-fg">Sign out</button>
        </form>
      </div>
    </main>
  );
}
