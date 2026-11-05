'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCheck, faXmark } from '@fortawesome/free-solid-svg-icons';
import { saveUserAccessAction } from '@/app/actions/access';
import { ErrorBanner, Field, SubmitLabel } from '@/app/components/ui';
import { PendingNotice, SavedBanner } from '@/app/maintenance/shared';

type Effect = 'inherit' | 'allow' | 'deny';
type Role = { id: number; name: string; isActive: boolean; assigned: boolean; permissions: string[] };
type Perm = { slug: string; module: string; description: string; fromRoles: string[]; fromRank: boolean; override: Effect; overrideReason: string | null; effective: boolean; officerOnly: boolean };

type Props = {
  userId: string; roles: Role[]; permissions: Perm[]; pending: boolean; editable: boolean; reasonNotEditable: string;
  grantable: string[] | null; rankName: string | null; targetIsOfficer: boolean;
};

const EFFECTS: { value: Effect; label: string }[] = [
  { value: 'inherit', label: 'Default' },
  { value: 'allow', label: 'Allow' },
  { value: 'deny', label: 'Deny' },
];

export default function AccessForm({ userId, roles, permissions, pending, editable, reasonNotEditable, grantable, rankName, targetIsOfficer }: Props) {
  const router = useRouter();
  const [roleIds, setRoleIds] = useState<number[]>(roles.filter((r) => r.assigned).map((r) => r.id));
  const [ov, setOv] = useState<Record<string, { effect: Effect; reason: string }>>(
    Object.fromEntries(permissions.map((p) => [p.slug, { effect: p.override, reason: p.overrideReason ?? '' }])),
  );
  const [reason, setReason] = useState('');
  const [busy, start] = useTransition();
  const [banner, setBanner] = useState<string | null>(null);
  const [saved, setSaved] = useState<'applied' | 'pending' | null>(null);
  const locked = !editable || pending || saved === 'pending';
  const can = (slug: string) => grantable === null || grantable.includes(slug);

  // 即时预览：（角色 ∪ 军阶）+ Allow − Deny
  const preview = useMemo(() => {
    const out: Record<string, { base: boolean; sources: string[]; result: boolean }> = {};
    for (const p of permissions) {
      const fromRoles = roles.filter((r) => r.isActive && roleIds.includes(r.id) && r.permissions.includes(p.slug)).map((r) => r.name);
      const sources = [...fromRoles, ...(p.fromRank ? [`Rank: ${rankName}`] : [])];
      const e = ov[p.slug].effect;
      const raw = e === 'allow' ? true : e === 'deny' ? false : sources.length > 0;
      // 只限军官的权限：军员就算设了也不生效
      out[p.slug] = { base: sources.length > 0, sources, result: raw && (targetIsOfficer || !p.officerOnly) };
    }
    return out;
  }, [permissions, roles, roleIds, ov, rankName, targetIsOfficer]);

  const dirty =
    roleIds.length !== roles.filter((r) => r.assigned).length || roles.some((r) => r.assigned !== roleIds.includes(r.id)) ||
    permissions.some((p) => ov[p.slug].effect !== p.override || (ov[p.slug].effect !== 'inherit' && ov[p.slug].reason !== (p.overrideReason ?? '')));

  const save = () =>
    start(async () => {
      setBanner(null);
      const res = await saveUserAccessAction(userId, {
        roleIds,
        overrides: Object.entries(ov).map(([slug, o]) => ({ slug, effect: o.effect, reason: o.reason })),
        reason,
      });
      if (!res.ok) return setBanner(res.message);
      setSaved(res.data.status);
      router.refresh();
    });

  const toggleRole = (r: Role) => setRoleIds((p) => (p.includes(r.id) ? p.filter((x) => x !== r.id) : [...p, r.id]));

  return (
    <div className="space-y-4">
      {!editable && <p className="card text-sm text-fg-2">{reasonNotEditable}</p>}
      {pending && !saved && <PendingNotice />}
      <SavedBanner status={saved} />
      <ErrorBanner message={banner} />

      <section className="card">
        <h2 className="card-heading">Roles</h2>
        {roles.length === 0 ? (
          <p className="text-sm text-muted">No roles exist yet.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {/* 停用的角色只在仍被分配时显示 */}
            {roles.filter((r) => r.isActive || r.assigned).map((r) => {
              const on = roleIds.includes(r.id);
              // 未分配的停用角色不能选；被授权者不能加上含有自己没有权限的角色
              const disabled = locked || (!on && (!r.isActive || r.permissions.some((s) => !can(s))));
              return (
                <label key={r.id} className={`inline-flex items-center gap-2 rounded-full border px-3 min-h-10 text-sm ${on ? 'border-violet-400/60 bg-violet-500/15 text-fg' : 'border-line text-fg-2'} ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-subtle'}`}>
                  <input type="checkbox" className="h-4 w-4 accent-violet-500" checked={on} disabled={disabled} onChange={() => toggleRole(r)} />
                  {r.name}{!r.isActive && ' (inactive)'}
                </label>
              );
            })}
          </div>
        )}
      </section>

      <section className="card p-0 md:p-0 overflow-hidden">
        <div className="px-4 md:px-6 pt-4 md:pt-6">
          <h2 className="card-heading">Permissions</h2>
          <p className="text-sm text-muted mb-3">Default follows roles and rank. Allow or Deny overrides them for this person only.</p>
        </div>
        {/* 电脑版：表格 */}
        <table className="hidden md:table w-full text-sm">
          <thead className="bg-subtle text-xs uppercase tracking-wider text-muted">
            <tr>{['Permission', 'Comes from', 'Setting', 'Result'].map((h) => <th key={h} className="px-4 py-3 text-left font-semibold">{h}</th>)}</tr>
          </thead>
          <tbody>
            {permissions.map((p) => (
              <Row key={p.slug} p={p} o={ov[p.slug]} pv={preview[p.slug]} locked={locked} allowable={can(p.slug)} onChange={(o) => setOv((x) => ({ ...x, [p.slug]: o }))} />
            ))}
          </tbody>
        </table>
        {/* 手机版：卡片 */}
        <div className="md:hidden divide-y divide-line-soft">
          {permissions.map((p) => (
            <Row key={p.slug} card p={p} o={ov[p.slug]} pv={preview[p.slug]} locked={locked} allowable={can(p.slug)} onChange={(o) => setOv((x) => ({ ...x, [p.slug]: o }))} />
          ))}
        </div>
      </section>

      {editable && (
        <section className="card">
          <Field label="Reason for this change (optional)" name="reason" textarea value={reason} onChange={setReason} maxLength={500} disabled={locked} />
          <div className="flex justify-end">
            <button className="btn-primary max-sm:w-full" disabled={busy || locked || !dirty} onClick={save}>
              <SubmitLabel pending={busy} idle={grantable === null ? 'Save' : 'Send to Captain'} busy="Saving..." />
            </button>
          </div>
        </section>
      )}
    </div>
  );
}

function Row({ p, o, pv, locked, allowable, onChange, card }: {
  p: Perm; o: { effect: Effect; reason: string }; pv: { sources: string[]; result: boolean }; locked: boolean; allowable: boolean;
  onChange: (o: { effect: Effect; reason: string }) => void; card?: boolean;
}) {
  const setting = (
    <div className="flex flex-col gap-2">
      <div className="inline-flex rounded-xl border border-line overflow-hidden" role="radiogroup" aria-label={`Setting for ${p.description}`}>
        {EFFECTS.map((e) => {
          // 被授权者不能新设 Allow 给自己没有的权限
          const disabled = locked || (e.value === 'allow' && o.effect !== 'allow' && !allowable);
          const on = o.effect === e.value;
          const color = on ? (e.value === 'allow' ? 'bg-emerald-500/25 text-emerald-200' : e.value === 'deny' ? 'bg-red-500/25 text-red-200' : 'bg-subtle-2 text-fg') : 'text-muted hover:bg-subtle';
          return (
            <button key={e.value} type="button" role="radio" aria-checked={on} disabled={disabled} onClick={() => onChange({ ...o, effect: e.value })}
              className={`px-3 min-h-9 text-xs font-medium ${color} ${disabled && !on ? 'opacity-40 cursor-not-allowed' : ''}`}>
              {e.label}
            </button>
          );
        })}
      </div>
      {o.effect !== 'inherit' && (
        <input
          className="form-input py-2 text-sm" placeholder="Reason (optional)" aria-label={`Reason for ${p.description}`} maxLength={500}
          value={o.reason} disabled={locked} onChange={(e) => onChange({ ...o, reason: e.target.value })}
        />
      )}
    </div>
  );
  const result = pv.result ? (
    <span className="inline-flex items-center gap-1 text-emerald-300 text-sm"><FontAwesomeIcon icon={faCheck} /> Has</span>
  ) : (
    <span className="inline-flex items-center gap-1 text-muted text-sm"><FontAwesomeIcon icon={faXmark} /> No</span>
  );
  const sources = pv.sources.length ? pv.sources.join(', ') : <span className="text-muted">Nothing</span>;

  if (card) {
    return (
      <div className="px-4 py-4 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm text-fg">{p.description}</p>
            {p.officerOnly && <p className="text-xs text-amber-300/80">Officers only</p>}
            <p className="text-xs text-muted">From: {sources}</p>
          </div>
          {result}
        </div>
        {setting}
      </div>
    );
  }
  return (
    <tr className="border-t border-line-soft align-top">
      <td className="px-4 py-3">
        <p className="text-fg">{p.description}</p>
        <p className="text-xs text-muted font-mono">{p.slug}</p>
        {p.officerOnly && <p className="text-xs text-amber-300/80">Officers only</p>}
      </td>
      <td className="px-4 py-3 text-fg-2">{sources}</td>
      <td className="px-4 py-3 w-64">{setting}</td>
      <td className="px-4 py-3">{result}</td>
    </tr>
  );
}
