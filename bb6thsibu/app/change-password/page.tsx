import type { Metadata } from 'next';
import { requireUser } from '@/lib/server/auth/session';
import ChangePassword from './change-password';

export const metadata: Metadata = { title: 'Set a new password - BB6th Sibu' };

export default async function ChangePasswordPage() {
  const user = await requireUser({ allowMustChange: true });
  return <ChangePassword forced={user.mustChangePassword} />;
}
