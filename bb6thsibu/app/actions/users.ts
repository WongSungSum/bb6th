'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/server/authz';
import { requireUser } from '@/lib/server/auth/session';
import { appointFirstCaptain } from '@/lib/server/captain';
import { AppError, toActionError, type ActionResult } from '@/lib/server/errors';
import { getRequestMeta } from '@/lib/server/request';
import * as users from '@/lib/server/users/service';
import type { CreateUserInput, OwnProfileInput, UpdateUserInput } from '@/lib/validation/users';
import { updateOwnProfile } from '@/lib/server/users/profile';

// 每个 action 都在服务器上重新检查登录与权限；服务层再检查目标保护规则

export async function createUserAction(input: CreateUserInput): Promise<ActionResult<{ id: string }>> {
  try {
    const actor = await requirePermission('users.create');
    const res = await users.createUser(actor, input, await getRequestMeta());
    revalidatePath('/users');
    return { ok: true, data: res! };
  } catch (err) {
    return toActionError(err);
  }
}

export async function updateUserAction(id: string, input: UpdateUserInput): Promise<ActionResult<{ id: string }>> {
  try {
    const actor = await requirePermission('users.update');
    const res = await users.updateUser(actor, String(id), input, await getRequestMeta());
    revalidatePath('/users', 'layout');
    revalidatePath('/maintenance/platoons', 'layout');
    return { ok: true, data: res! };
  } catch (err) {
    return toActionError(err);
  }
}

export async function promoteAction(input: { userIds: string[]; sectionId: number; rankId: number; reason: string }): Promise<ActionResult<{ count: number }>> {
  try {
    const actor = await requirePermission('users.change_rank');
    const res = await users.promoteMembers(actor, input, await getRequestMeta());
    revalidatePath('/users', 'layout');
    revalidatePath('/maintenance/platoons', 'layout');
    revalidatePath('/promotions');
    return { ok: true, data: { count: res.count } };
  } catch (err) {
    return toActionError(err);
  }
}

export async function setStatusAction(
  id: string,
  input: { status: 'active' | 'inactive'; reasonId?: number; note?: string; reason?: string },
): Promise<ActionResult> {
  try {
    if (input?.status !== 'active' && input?.status !== 'inactive') throw new AppError('VALIDATION', 'Invalid request.');
    const actor = await requirePermission('users.update_status');
    await users.setStatus(actor, String(id), input, await getRequestMeta());
    revalidatePath('/users', 'layout');
    revalidatePath('/maintenance/platoons', 'layout');
    return { ok: true };
  } catch (err) {
    return toActionError(err);
  }
}

export async function resetPasswordAction(id: string, input: { password?: string; reason: string }): Promise<ActionResult<{ tempPassword: string }>> {
  try {
    const actor = await requirePermission('users.reset_password');
    const res = await users.resetPassword(actor, String(id), input, await getRequestMeta());
    revalidatePath(`/users/${id}`);
    return { ok: true, data: res };
  } catch (err) {
    return toActionError(err);
  }
}

export async function appointCaptainAction(userId: string): Promise<ActionResult<{ id: string }>> {
  try {
    const actor = await requireUser();
    const res = await appointFirstCaptain(actor, String(userId), await getRequestMeta());
    revalidatePath('/users');
    return { ok: true, data: res };
  } catch (err) {
    return toActionError(err);
  }
}

/** 自己改自己的联络资料（不需要权限，只能改自己） */
export async function updateProfileAction(input: OwnProfileInput): Promise<ActionResult<{ updatedAt: string }>> {
  try {
    const actor = await requireUser();
    const res = await updateOwnProfile(actor, input, await getRequestMeta());
    revalidatePath('/profile');
    return { ok: true, data: res };
  } catch (err) {
    return toActionError(err);
  }
}
