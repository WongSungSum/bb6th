'use client';

import { useActionState, useState } from 'react';
import { loginAction, type LoginState } from '@/app/actions/auth';
import { ErrorBanner, Field, SubmitLabel } from '@/app/components/ui';
import { SITE_CONFIG } from '@/lib/constants';

export default function Login({ expired }: { expired?: boolean }) {
  const [state, action, pending] = useActionState<LoginState, FormData>(loginAction, undefined);
  const [identifier, setIdentifier] = useState(state?.identifier ?? '');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<{ identifier?: string; password?: string }>({});

  const validate = (e: React.FormEvent) => {
    const next = {
      identifier: identifier.trim() ? undefined : 'Enter your IC number or username.',
      password: password ? undefined : 'Enter your password.',
    };
    setErrors(next);
    if (next.identifier || next.password) e.preventDefault();
  };

  return (
    <main className="min-h-dvh grid place-items-center px-4 bg-[radial-gradient(60%_50%_at_50%_0%,rgba(139,92,246,0.18),transparent)]">
      <div className="w-full max-w-sm card p-6 md:p-8">
        <div className="flex flex-col items-center mb-6">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/images/icon.png" alt="" className="w-16 h-16 rounded-full object-cover mb-3" />
          <p className="text-sm font-bold bg-clip-text text-transparent bg-gradient-to-r from-fg to-muted">{SITE_CONFIG.shortName} Sibu</p>
          <h1 className="text-xl font-bold mt-2">Sign in</h1>
          <p className="text-sm text-muted">Use your IC number or username.</p>
        </div>

        {expired && !state?.error && <p className="mb-4 text-sm text-fg-2">Your session expired. Please sign in again.</p>}
        <ErrorBanner message={state?.error} />

        <form action={action} onSubmit={validate} noValidate>
          <Field
            label="IC number or username"
            name="identifier"
            value={identifier}
            onChange={setIdentifier}
            error={errors.identifier}
            autoComplete="username"
            disabled={pending}
            maxLength={64}
          />
          <Field
            label="Password"
            name="password"
            type="password"
            value={password}
            onChange={setPassword}
            error={errors.password}
            autoComplete="current-password"
            disabled={pending}
            maxLength={128}
          />
          <button type="submit" disabled={pending} aria-busy={pending} className="btn-primary w-full mt-2">
            <SubmitLabel pending={pending} idle="Sign in" busy="Signing in..." />
          </button>
        </form>
      </div>
    </main>
  );
}
