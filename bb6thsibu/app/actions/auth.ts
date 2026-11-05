'use server';

import { redirect } from 'next/navigation';
import { db } from '@/lib/db/client';
import { changeOwnPassword, login } from '@/lib/server/auth/login';
import { clearSessionCookie, getCurrentUser, requireUser, revokeSession, setSessionCookie } from '@/lib/server/auth/session';
import { writeAudit } from '@/lib/server/audit';
import { toActionError, type ActionResult } from '@/lib/server/errors';
import { getRequestMeta } from '@/lib/server/request';

export type LoginState = { error?: string; identifier?: string } | undefined;

const GENERIC_LOGIN_ERROR = 'Incorrect login details or account unavailable. Please try again or contact your Captain.';

export async function loginAction(_prev: LoginState, formData: FormData): Promise<LoginState> {
  if (!(formData instanceof FormData)) return { error: GENERIC_LOGIN_ERROR };
  const identifier = String(formData.get('identifier') ?? '');
  const password = String(formData.get('password') ?? '');
  if (!identifier.trim() || !password || password.length > 128) {
    return { error: GENERIC_LOGIN_ERROR, identifier };
  }
  let target: string;
  try {
    const result = await login(identifier, password, await getRequestMeta());
    if (!result.ok) return { error: GENERIC_LOGIN_ERROR, identifier };
    await setSessionCookie(result.token, result.expiresAt);
    target = result.mustChangePassword ? '/change-password' : result.needsSetup ? '/setup' : '/dashboard';
  } catch (err) {
    toActionError(err);
    return { error: 'Cannot sign in right now. Please try again.', identifier };
  }
  redirect(target);
}

export async function logoutAction() {
  const user = await getCurrentUser();
  if (user) {
    await revokeSession(user.sessionId);
    const meta = await getRequestMeta();
    await db.transaction((tx) => writeAudit(tx, { actorId: user.id, meta }, { action: 'LOGOUT', entityType: 'users', entityId: user.id }));
  }
  await clearSessionCookie();
  redirect('/login');
}

export async function changePasswordAction(input: { current: string; next: string; confirm: string }): Promise<ActionResult> {
  const user = await requireUser({ allowMustChange: true });
  try {
    if (input?.next !== input?.confirm) {
      return { ok: false, code: 'VALIDATION', message: 'Please fix the highlighted fields.', fieldErrors: { confirm: 'Passwords do not match.' } };
    }
    const session = await changeOwnPassword(user, String(input?.current ?? ''), String(input?.next ?? ''), await getRequestMeta());
    await setSessionCookie(session.token, session.expiresAt);
    return { ok: true };
  } catch (err) {
    return toActionError(err);
  }
}
