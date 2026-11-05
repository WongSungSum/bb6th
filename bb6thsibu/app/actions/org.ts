'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/server/auth/session';
import { AppError, toActionError, type ActionResult } from '@/lib/server/errors';
import { getRequestMeta } from '@/lib/server/request';
import * as org from '@/lib/server/org/service';

// 只有 Captain / Superadmin；检查在服务层 assertOrgAdmin
const done = (): ActionResult => {
  revalidatePath('/', 'layout');
  return { ok: true };
};

export async function createSectionAction(name: string): Promise<ActionResult> {
  try {
    await org.createSection(await requireUser(), { name }, await getRequestMeta());
    return done();
  } catch (err) {
    return toActionError(err);
  }
}

export async function createRankAction(sectionId: number, name: string): Promise<ActionResult> {
  try {
    await org.createRank(await requireUser(), { sectionId, name }, await getRequestMeta());
    return done();
  } catch (err) {
    return toActionError(err);
  }
}

export async function updateOrgItemAction(kind: 'section' | 'rank', id: number, input: { name?: string; isActive?: boolean }): Promise<ActionResult> {
  try {
    const actor = await requireUser();
    if (kind === 'section') await org.updateSection(actor, Number(id), input, await getRequestMeta());
    else if (kind === 'rank') await org.updateRank(actor, Number(id), input, await getRequestMeta());
    else throw new AppError('VALIDATION', 'Invalid request.');
    return done();
  } catch (err) {
    return toActionError(err);
  }
}

export async function moveOrgItemAction(kind: 'section' | 'rank', id: number, dir: 'up' | 'down'): Promise<ActionResult> {
  try {
    if (kind !== 'section' && kind !== 'rank') throw new AppError('VALIDATION', 'Invalid request.');
    await org.moveItem(await requireUser(), kind, Number(id), dir, await getRequestMeta());
    return done();
  } catch (err) {
    return toActionError(err);
  }
}

export async function setAgeUpAction(sectionId: number, input: { age: string | number | null; rankId: string | number | null }): Promise<ActionResult> {
  try {
    await org.setAgeUp(await requireUser(), Number(sectionId), { age: input?.age, rankId: input?.rankId }, await getRequestMeta());
    return done();
  } catch (err) {
    return toActionError(err);
  }
}
