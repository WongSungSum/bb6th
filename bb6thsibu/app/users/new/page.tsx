import type { Metadata } from 'next';
import Link from 'next/link';
import { faLock } from '@fortawesome/free-solid-svg-icons';
import { requireUser } from '@/lib/server/auth/session';
import { can, isOfficerOrAbove, memberScope } from '@/lib/server/authz';
import { getOrgOptions, scopedOrg } from '@/lib/server/users/service';
import { StateCard } from '@/app/components/ui';
import UserForm from '../user-form';

export const metadata: Metadata = { title: 'Add member - BB6th Sibu' };

export default async function NewUserPage() {
  const user = await requireUser();
  if (!(await can(user, 'users.create'))) {
    return <StateCard icon={faLock} title="You do not have access" text="Ask the Captain if you need this permission." action={<Link href="/users" className="btn-secondary">Back to members</Link>} />;
  }
  const [scoped, canEditId, officer] = await Promise.all([getOrgOptions().then(async (o) => scopedOrg(o, await memberScope(user))), can(user, 'users.view_sensitive'), isOfficerOrAbove(user)]);
  const org = officer ? scoped : { ...scoped, sections: scoped.sections.filter((s) => !s.isOfficer), ranks: scoped.ranks.filter((r) => scoped.sections.some((s) => s.id === r.sectionId && !s.isOfficer)) };
  return (
    <UserForm
      mode="create"
      org={org}
      canEditId={canEditId}
      initial={{
        username: '', email: '', idType: canEditId ? 'mykad' : 'none', idNumber: '', fullName: '', gender: '',
        dateOfBirth: '', joinDate: '', phone: '', address: '', school: '', sectionId: '', rankId: '', platoonId: '', guardians: [],
      }}
    />
  );
}
