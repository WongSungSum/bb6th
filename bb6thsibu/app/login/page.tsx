import type { Metadata } from 'next';
import { redirect } from 'next/navigation';
import { getCurrentUser } from '@/lib/server/auth/session';
import Login from './login';

export const metadata: Metadata = { title: 'Sign in - BB6th Sibu' };

export default async function LoginPage({ searchParams }: { searchParams: Promise<{ expired?: string }> }) {
  if (await getCurrentUser()) redirect('/dashboard');
  const { expired } = await searchParams;
  return <Login expired={expired === '1'} />;
}
