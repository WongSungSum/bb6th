import type { Metadata } from 'next';
import { requireUser } from '@/lib/server/auth/session';
import ComingSoon from '@/app/components/coming-soon';

export const metadata: Metadata = { title: 'Awards - BB6th Sibu' };

export default async function AwardsPage(){
    await requireUser();
    return <ComingSoon title="Awards" text="Members' badges and awards will be shown here. This page is still being built." />;
}
