import type { Metadata } from 'next';
import { requireUser } from '@/lib/server/auth/session';
import ComingSoon from '@/app/components/coming-soon';

export const metadata: Metadata = { title: 'Statistics - BB6th Sibu' };

export default async function StaticsPage(){
    await requireUser();
    return <ComingSoon title="Statistics" text="Company statistics will be shown here. This page is still being built." />;
}
