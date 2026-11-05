'use client';

import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleCheck, faHourglassHalf } from '@fortawesome/free-solid-svg-icons';

export type CatalogItem = { slug: string; module: string; description: string };

const MODULE_LABEL: Record<string, string> = { users: 'Members', permissions: 'Permissions', audit: 'Audit' };

/** 按模块分组的权限勾选清单；被授权者不能勾选自己没有的权限 */
export function PermissionChecklist({
  catalog, value, onChange, grantable, disabled,
}: {
  catalog: CatalogItem[]; value: string[]; onChange: (v: string[]) => void; grantable: string[] | null; disabled?: boolean;
}) {
  const modules = [...new Set(catalog.map((p) => p.module))];
  const toggle = (slug: string) => onChange(value.includes(slug) ? value.filter((s) => s !== slug) : [...value, slug]);
  return (
    <div className="space-y-5">
      {modules.map((m) => (
        <fieldset key={m}>
          <legend className="text-xs uppercase tracking-wider text-muted mb-2">{MODULE_LABEL[m] ?? m}</legend>
          <div className="grid sm:grid-cols-2 gap-2">
            {catalog.filter((p) => p.module === m).map((p) => {
              const checked = value.includes(p.slug);
              // 已有的可以取消；新勾选必须是自己有的
              const locked = disabled || (!checked && grantable !== null && !grantable.includes(p.slug));
              return (
                <label key={p.slug} className={`flex items-start gap-3 rounded-xl border px-3 py-2.5 min-h-11 ${checked ? 'border-violet-400/60 bg-violet-500/10' : 'border-line'} ${locked ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer hover:bg-subtle'}`}>
                  <input type="checkbox" className="mt-0.5 h-4 w-4 accent-violet-500" checked={checked} disabled={locked} onChange={() => toggle(p.slug)} />
                  <span className="text-sm">
                    <span className="text-fg">{p.description}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}
      {grantable !== null && <p className="text-xs text-muted">You can only give permissions you have yourself.</p>}
    </div>
  );
}

/** 保存后的提示：立即生效 / 等 Captain 确认 */
export function SavedBanner({ status }: { status: 'applied' | 'pending' | null }) {
  if (!status) return null;
  return status === 'applied' ? (
    <div role="status" className="mb-4 flex gap-3 rounded-xl border border-emerald-500/30 bg-emerald-500/10 text-emerald-200 text-sm px-4 py-3">
      <FontAwesomeIcon icon={faCircleCheck} className="mt-0.5" /> Saved. The change is now in effect.
    </div>
  ) : (
    <div role="status" className="mb-4 flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-200 text-sm px-4 py-3">
      <FontAwesomeIcon icon={faHourglassHalf} className="mt-0.5" /> Sent to the Captain. It takes effect after the Captain confirms it.
    </div>
  );
}

export function PendingNotice() {
  return (
    <div className="mb-4 flex gap-3 rounded-xl border border-amber-500/30 bg-amber-500/10 text-amber-200 text-sm px-4 py-3">
      <FontAwesomeIcon icon={faHourglassHalf} className="mt-0.5" /> A change is waiting for the Captain to confirm. You can edit again after it is decided.
    </div>
  );
}
