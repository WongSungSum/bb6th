import type { Metadata } from 'next';
import Link from 'next/link';
import { faLock, faUserSlash } from '@fortawesome/free-solid-svg-icons';
import { requireUser } from '@/lib/server/auth/session';
import { can, isOfficerOrAbove } from '@/lib/server/authz';
import { AppError } from '@/lib/server/errors';
import { getRequestMeta } from '@/lib/server/request';
import { allowedActions, getOrgOptions, getUserDetail } from '@/lib/server/users/service';
import { StateCard } from '@/app/components/ui';
import UserForm from '../../user-form';

export const metadata: Metadata = { title: 'Edit member - BB6th Sibu' };

const denied = <StateCard icon={faLock} title="You do not have access" text="Ask the Captain if you need this permission." action={<Link href="/users" className="btn-secondary">Back to members</Link>} />;

export default async function EditUserPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireUser();
  if (!(await can(user, 'users.update'))) return denied;
  const { id } = await params;
  let detail;
  try {
    detail = await getUserDetail(user, id, await getRequestMeta());
  } catch (err) {
    if (err instanceof AppError) return <StateCard icon={faUserSlash} title="Member not found" action={<Link href="/users" className="btn-secondary">Back to members</Link>} />;
    throw err;
  }
  if (!(await allowedActions(user, detail)).edit) return denied;
  const [org, officer] = await Promise.all([getOrgOptions(), isOfficerOrAbove(user)]);
  return (
    <UserForm
      mode="edit"
      org={org}
      canEditId={detail.idNumberVisible}
      canChangePlatoon={officer}
      initial={{
        id: detail.id, username: detail.username, email: detail.email, idType: detail.idType, idNumber: detail.idNumber ?? '',
        fullName: detail.fullName, gender: detail.gender ?? '', dateOfBirth: detail.dateOfBirth ?? '', joinDate: detail.joinDate ?? '',
        phone: detail.phone ?? '', address: detail.address ?? '', school: detail.school ?? '',
        sectionId: String(detail.sectionId), rankId: String(detail.rankId), platoonId: detail.platoonId ? String(detail.platoonId) : '', sectionName: detail.sectionName, rankName: detail.rankName,
        updatedAt: detail.updatedAt.toISOString(),
        guardians: detail.idNumberVisible
          ? detail.guardians.map((g) => ({ name: g.name, relationship: g.relationship, phone: g.phone ?? '', email: g.email ?? '' }))
          : [],
      }}
    />
  );
}
