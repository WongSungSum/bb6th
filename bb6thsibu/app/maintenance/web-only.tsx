import Link from 'next/link';
import { faDesktop } from '@fortawesome/free-solid-svg-icons';
import { StateCard } from '@/app/components/ui';

/** 只在电脑版（md 以上）显示内容；手机显示「请用电脑」。手机上只保留 Confirmations */
export default function WebOnly({ children }: { children: React.ReactNode }) {
  return (
    <>
      <div className="md:hidden">
        <StateCard
          icon={faDesktop}
          title="Use a computer for this page"
          text="This page can only be used from the web version on a larger screen."
          action={<Link href="/maintenance/approvals" className="btn-secondary">Go to Confirmations</Link>}
        />
      </div>
      <div className="hidden md:block">{children}</div>
    </>
  );
}
