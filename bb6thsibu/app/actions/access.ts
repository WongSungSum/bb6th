'use server';

import { revalidatePath } from 'next/cache';
import { requireUser } from '@/lib/server/auth/session';
import { toActionError, type ActionResult } from '@/lib/server/errors';
import { getRequestMeta } from '@/lib/server/request';
import * as access from '@/lib/server/access/service';

// 权限检查都在服务层（assertCanManageAccess / Captain 专属）
type Saved = { status: 'applied' | 'pending' };

export async function saveRoleAction(roleId: number | null, input: { name: string; description: string; isActive: boolean; permissions: string[]; reason?: string }): Promise<ActionResult<Saved & { targetId: string }>> {
  try {
    const actor = await requireUser();
    const res = await access.saveRole(actor, roleId === null ? null : Number(roleId), input, await getRequestMeta());
    revalidatePath('/maintenance', 'layout');
    return { ok: true, data: { status: res.status, targetId: res.targetId } };
  } catch (err) {
    return toActionError(err);
  }
}

export async function saveRankAccessAction(rankId: number, input: { permissions: string[]; reason?: string }): Promise<ActionResult<Saved>> {
  try {
    const actor = await requireUser();
    const res = await access.saveRankAccess(actor, Number(rankId), input, await getRequestMeta());
    revalidatePath('/maintenance', 'layout');
    return { ok: true, data: { status: res.status } };
  } catch (err) {
    return toActionError(err);
  }
}

export async function saveUserAccessAction(userId: string, input: { roleIds: number[]; overrides: { slug: string; effect: string; reason?: string }[]; reason?: string }): Promise<ActionResult<Saved>> {
  try {
    const actor = await requireUser();
    const res = await access.saveUserAccess(actor, String(userId), input, await getRequestMeta());
    revalidatePath(`/users/${userId}/access`);
    revalidatePath('/maintenance', 'layout');
    return { ok: true, data: { status: res.status } };
  } catch (err) {
    return toActionError(err);
  }
}

export async function decideRequestAction(id: string, decision: 'approve' | 'reject', note?: string): Promise<ActionResult> {
  try {
    const actor = await requireUser();
    await access.decideRequest(actor, String(id), decision, note, await getRequestMeta());
    revalidatePath('/', 'layout');
    return { ok: true };
  } catch (err) {
    return toActionError(err);
  }
}

export async function cancelRequestAction(id: string): Promise<ActionResult> {
  try {
    const actor = await requireUser();
    await access.cancelRequest(actor, String(id), await getRequestMeta());
    revalidatePath('/', 'layout');
    return { ok: true };
  } catch (err) {
    return toActionError(err);
  }
}
