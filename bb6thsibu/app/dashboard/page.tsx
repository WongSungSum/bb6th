import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { requireUser } from '@/lib/server/auth/session';
import { getCaptain } from '@/lib/server/captain';
import Dashboard from "./dashboard";

export const metadata: Metadata = { title: 'Dashboard - BB6th Sibu' };

export default async function DashboardPage(){
  // 新系统还没有 Captain：Superadmin 先去指定（换完密码后也会来这里）
  const user = await requireUser();
  if (user.isSuperadmin && !(await getCaptain())) redirect('/setup');
  return <Dashboard/>;
}
