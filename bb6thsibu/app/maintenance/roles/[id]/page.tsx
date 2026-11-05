import type { Metadata } from 'next';
import Link from 'next/link';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft, faLock, faUsersGear } from '@fortawesome/free-solid-svg-icons';
import { getRole, listPermissionCatalog } from '@/lib/server/access/service';
import { memberScope } from '@/lib/server/authz';
import { StateCard } from '@/app/components/ui';
import { maintenanceAccess } from '../../guard';
import RoleForm from './role-form';
import WebOnly from '@/app/maintenance/web-only';

export const metadata: Metadata = { title: 'Role - BB6th Sibu' };

export default async function RolePage({ params }: { params: Promise<{ id: string }> }) {
  const { user, access, grantable } = await maintenanceAccess();
  if (!access) return <StateCard icon={faLock} title="You do not have access" action={<Link href="/dashboard" className="btn-secondary">Back to dashboard</Link>} />;
  const { id } = await params;
  const isNew = id === 'new';
  const [role, catalog] = await Promise.all([isNew ? null : getRole(Number(id), await memberScope(user)), listPermissionCatalog()]);
  if (!isNew && !role) return <StateCard icon={faUsersGear} title="Role not found" action={<Link href="/maintenance/roles" className="btn-secondary">Back to roles</Link>} />;

  return (
    <WebOnly>
      <div className="max-w-4xl mx-auto">
        <Link href="/maintenance/roles" className="back-link"><FontAwesomeIcon icon={faChevronLeft} /> Roles</Link>
        <h1 className="text-xl md:text-2xl font-bold tracking-tight mt-3 mb-4">{isNew ? 'New role' : role!.name}</h1>
        <RoleForm
          roleId={isNew ? null : role!.id}
          initial={{ name: role?.name ?? '', description: role?.description ?? '', isActive: role?.isActive ?? true, permissions: role?.permissions ?? [] }}
          pending={role?.pending ?? false}
          catalog={catalog}
          grantable={grantable}
          members={role?.members ?? []}
        />
      </div>
    </WebOnly>
  );
}
