import type { Metadata } from 'next';
import { requireUser } from '@/lib/server/auth/session';
import { can } from '@/lib/server/authz';
import { scoreboard } from '@/lib/server/platoons/service';
import ScoreboardView from './scoreboard';

export const metadata: Metadata = { title: 'Platoon scoreboard - BB6th Sibu' };

// 所有登入的人都能看；记分需要 platoons.score（只限军官）
export default async function PlatoonsPage({ searchParams }: { searchParams: Promise<{ year?: string }> }) {
  const user = await requireUser();
  const { year } = await searchParams;
  const [data, canScore, canManage] = await Promise.all([scoreboard(year), can(user, 'platoons.score'), can(user, 'platoons.manage')]);
  return <ScoreboardView data={data} canScore={canScore} canManage={canManage} />;
}
