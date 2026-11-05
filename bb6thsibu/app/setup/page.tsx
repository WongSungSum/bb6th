import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { faLock } from '@fortawesome/free-solid-svg-icons';
import { requireUser } from '@/lib/server/auth/session';
import { getCaptain, listCaptainCandidates } from '@/lib/server/captain';
import { StateCard } from '@/app/components/ui';
import Setup from './setup';

export const metadata: Metadata = { title: 'Set up - BB6th Sibu' };

export default async function SetupPage() {
  const user = await requireUser();
  if (!user.isSuperadmin) {
    return <div className="max-w-2xl mx-auto px-4 py-10"><StateCard icon={faLock} title="You do not have access" text="Only the system administrator can run setup." /></div>;
  }
  if (await getCaptain()) redirect('/dashboard');
  const candidates = await listCaptainCandidates();
  return <Setup candidates={candidates} />;
}
