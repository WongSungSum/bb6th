import type { Metadata } from 'next';
import { requireUser } from '@/lib/server/auth/session';
import ComingSoon from '@/app/components/coming-soon';

export const metadata: Metadata = { title: 'Attendance - BB6th Sibu' };

export default async function AttendancePage(){
    await requireUser();
    return <ComingSoon title="Attendance" text="Platoon leaders will take attendance here. This page is still being built." />;
}
