'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/server/auth/session';
import { toActionError, type ActionResult } from '@/lib/server/errors';
import { getRequestMeta } from '@/lib/server/request';
import * as svc from '@/lib/server/platoons/service';

// 权限检查在服务层（platoons.manage / platoons.score，都只限军官）
const done = (): ActionResult => {
  revalidatePath('/', 'layout');
  return { ok: true };
};
async function run(fn: () => Promise<unknown>): Promise<ActionResult> {
  try {
    await fn();
    return done();
  } catch (err) {
    return toActionError(err);
  }
}

export async function createPlatoonAction(sectionId: number, name: string) {
  return run(async () => svc.createPlatoon(await requireUser(), { sectionId, name }, await getRequestMeta()));
}
export async function updatePlatoonAction(id: number, input: { name?: string; isActive?: boolean }) {
  return run(async () => svc.updatePlatoon(await requireUser(), Number(id), input, await getRequestMeta()));
}
export async function movePlatoonAction(id: number, dir: 'up' | 'down') {
  return run(async () => svc.movePlatoon(await requireUser(), Number(id), dir, await getRequestMeta()));
}
export async function assignMembersAction(platoonId: number, userIds: string[]) {
  return run(async () => svc.assignMembers(await requireUser(), Number(platoonId), { userIds }, await getRequestMeta()));
}
export async function removeMembersAction(platoonId: number, userIds: string[]) {
  return run(async () => svc.removeMembers(await requireUser(), Number(platoonId), { userIds }, await getRequestMeta()));
}
export async function setLeadersAction(platoonId: number, leaderId: string | null, assistantId: string | null) {
  return run(async () => svc.setPlatoonLeaders(await requireUser(), Number(platoonId), { leaderId, assistantId }, await getRequestMeta()));
}

type ActivityForm = { name: string; activityDate: string; note: string; scores: { platoonId: number; points: string }[]; expectedUpdatedAt?: string };
export async function saveActivityAction(id: string | null, input: ActivityForm) {
  return run(async () => {
    const actor = await requireUser();
    if (id) await svc.updateActivity(actor, String(id), input, await getRequestMeta());
    else await svc.createActivity(actor, input, await getRequestMeta());
  });
}
export async function voidActivityAction(id: string, reason: string) {
  return run(async () => svc.voidActivity(await requireUser(), String(id), { reason }, await getRequestMeta()));
}
