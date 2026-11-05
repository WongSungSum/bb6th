import type { Metadata } from 'next';
import { requireUser } from '@/lib/server/auth/session';
import { getOwnProfile } from '@/lib/server/users/profile';
import ProfileForm from './profile-form';

export const metadata: Metadata = { title: 'My profile - BB6th Sibu' };

export default async function ProfilePage() {
  const user = await requireUser();
  const p = await getOwnProfile(user);
  return <ProfileForm profile={p} />;
}
