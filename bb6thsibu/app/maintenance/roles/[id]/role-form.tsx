'use client';

import { useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { saveRoleAction } from '@/app/actions/access';
import { ErrorBanner, Field, StatusBadge, SubmitLabel } from '@/app/components/ui';
import { PendingNotice, PermissionChecklist, SavedBanner, type CatalogItem } from '../../shared';

type Props = {
  roleId: number | null;
  initial: { name: string; description: string; isActive: boolean; permissions: string[] };
  pending: boolean;
  catalog: CatalogItem[];
  grantable: string[] | null;
  members: { id: string; fullName: string; username: string; status: string }[];
};

export default function RoleForm({ roleId, initial, pending, catalog, grantable, members }: Props) {
  const router = useRouter();
  const [v, setV] = useState({ ...initial, reason: '' });
  const [busy, start] = useTransition();
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [saved, setSaved] = useState<'applied' | 'pending' | null>(null);

  const save = () =>
    start(async () => {
      setBanner(null);
      setErrors({});
      const res = await saveRoleAction(roleId, v);
      if (!res.ok) {
        setErrors(res.fieldErrors ?? {});
        setBanner(res.message);
        return;
      }
      setSaved(res.data.status);
      // 新角色直接生效时跳到它的页面
      if (roleId === null && res.data.status === 'applied') router.replace(`/maintenance/roles/${res.data.targetId}`);
      else router.refresh();
    });

  const locked = pending || saved === 'pending';
  return (
    <div className="grid lg:grid-cols-3 gap-4">
      <div className="lg:col-span-2 space-y-4">
        {pending && !saved && <PendingNotice />}
        <SavedBanner status={saved} />
        <ErrorBanner message={banner} />
        <section className="card">
          <h2 className="card-heading">Details</h2>
          <Field label="Role name" name="name" value={v.name} onChange={(name) => setV((p) => ({ ...p, name }))} required maxLength={50} error={errors.name} disabled={locked} />
          <Field label="Description" name="description" value={v.description} onChange={(description) => setV((p) => ({ ...p, description }))} maxLength={200} disabled={locked} />
          {roleId !== null && (
            <label className="flex items-center gap-3 text-sm min-h-11">
              <input type="checkbox" className="h-4 w-4 accent-violet-500" checked={v.isActive} disabled={locked} onChange={(e) => setV((p) => ({ ...p, isActive: e.target.checked }))} />
              Active (an inactive role gives no permissions)
            </label>
          )}
        </section>
        <section className="card">
          <h2 className="card-heading">Permissions</h2>
          <PermissionChecklist catalog={catalog} value={v.permissions} onChange={(permissions) => setV((p) => ({ ...p, permissions }))} grantable={grantable} disabled={locked} />
        </section>
        <section className="card">
          <Field label="Reason for this change (optional)" name="reason" textarea value={v.reason} onChange={(reason) => setV((p) => ({ ...p, reason }))} maxLength={500} disabled={locked} />
          <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <Link href="/maintenance/roles" className="btn-secondary">Back</Link>
            <button className="btn-primary" disabled={busy || locked} onClick={save}>
              <SubmitLabel pending={busy} idle={grantable === null ? 'Save' : 'Send to Captain'} busy="Saving..." />
            </button>
          </div>
        </section>
      </div>
      {roleId !== null && (
        <aside className="card h-fit">
          <h2 className="card-heading">Members with this role</h2>
          {members.length === 0 ? (
            <p className="text-sm text-muted">Nobody yet. Give this role from a member&apos;s Permissions page.</p>
          ) : (
            <ul className="space-y-2">
              {members.map((m) => (
                <li key={m.id} className="flex items-center justify-between gap-2">
                  <Link href={`/users/${m.id}/access`} className="text-sm hover:text-violet-300 truncate">{m.fullName}</Link>
                  {m.status !== 'active' && <StatusBadge status={m.status} />}
                </li>
              ))}
            </ul>
          )}
        </aside>
      )}
    </div>
  );
}
