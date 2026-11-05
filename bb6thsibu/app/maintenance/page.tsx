import type { Metadata } from 'next';
import Link from 'next/link';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronRight, faDesktop, faLock } from '@fortawesome/free-solid-svg-icons';
import { pendingRequestCount } from '@/lib/server/access/service';
import { StateCard } from '@/app/components/ui';
import { maintenanceAccess } from './guard';
import { maintenanceItems, type MaintenanceItem } from './menu';

export const metadata: Metadata = { title: 'Maintenance - BB6th Sibu' };

function Tile({ href, icon, title, text, badge, desktopOnly }: MaintenanceItem) {
  return (
    <Link href={href} className={`card p-4 md:p-5 flex items-start gap-4 hover:bg-subtle ${desktopOnly ? 'hidden md:flex' : ''}`}>
      <div className="h-11 w-11 shrink-0 rounded-xl bg-violet-500/15 text-violet-300 grid place-items-center"><FontAwesomeIcon icon={icon} /></div>
      <div className="flex-1 min-w-0">
        <p className="font-semibold flex items-center gap-2">
          {title}
          {!!badge && <span className="rounded-full bg-amber-500 text-black text-xs font-bold px-2 py-0.5">{badge} to confirm</span>}
          {desktopOnly && <span className="text-xs text-muted font-normal"><FontAwesomeIcon icon={faDesktop} /> Web only</span>}
        </p>
        <p className="text-sm text-muted">{text}</p>
      </div>
      <FontAwesomeIcon icon={faChevronRight} className="text-muted mt-1" />
    </Link>
  );
}

export default async function MaintenancePage() {
  const { user, access, orgAdmin, platoons } = await maintenanceAccess();
  if (!access && !platoons) return <StateCard icon={faLock} title="You do not have access" action={<Link href="/dashboard" className="btn-secondary">Back to dashboard</Link>} />;
  const pending = access ? await pendingRequestCount(user) : 0;
  return (
    <div className="max-w-5xl mx-auto">
      <h1 className="text-xl md:text-2xl font-bold tracking-tight mb-1">Maintenance</h1>
      <p className="text-sm text-muted mb-5">
        Permissions come from a member&apos;s roles and rank. Per-person Allow / Deny settings override both.
        {!orgAdmin && ' Your changes take effect after the Captain confirms them.'}
      </p>
      <div className="grid md:grid-cols-2 gap-3">
        {maintenanceItems({ orgAdmin, isCaptain: user.isCaptain, pending, permissions: access, platoons }).map((it) => <Tile key={it.href} {...it} />)}
      </div>
    </div>
  );
}
