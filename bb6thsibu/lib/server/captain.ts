import { randomUUID } from 'node:crypto';
import { and, asc, eq, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { rankHistory, ranks, sections, users } from '@/lib/db/schema';
import type { CurrentUser } from '@/lib/server/auth/session';
import { auditSnapshot, writeAudit } from '@/lib/server/audit';
import { AppError, forbidden } from '@/lib/server/errors';
import type { RequestMeta } from '@/lib/server/request';
import { z } from 'zod';
import type { Tx } from '@/lib/db/client';

/** 在当前事务内放行 Captain 军阶变更（数据库触发器检查这个设定）。只允许本文件和开发种子脚本调用。 */
export async function allowCaptainChange(tx: Pick<Tx, 'execute'>) {
  await tx.execute(sql`select set_config('app.captain_change', 'on', true)`);
}

/*
 * Captain 身份的唯一入口。整个代码库只有这个文件可以设定 app.captain_change（数据库触发器据此放行）。
 * 第一阶段：Superadmin 指定第一位 Captain。交接流程以后也放在这里。
 */

export async function getCaptain() {
  const [c] = await db
    .select({ id: users.id, fullName: users.fullName })
    .from(users)
    .innerJoin(ranks, eq(ranks.id, users.rankId))
    .where(eq(ranks.systemKey, 'captain'))
    .limit(1);
  return c ?? null;
}

/** 可被指定为第一位 Captain 的人：启用中的 Officer 组成员 */
export async function listCaptainCandidates() {
  return db
    .select({ id: users.id, fullName: users.fullName, username: users.username, rankName: ranks.name })
    .from(users)
    .innerJoin(sections, eq(sections.id, users.sectionId))
    .innerJoin(ranks, eq(ranks.id, users.rankId))
    .where(and(eq(users.status, 'active'), eq(sections.systemKey, 'officer'), eq(users.accountType, 'member')))
    .orderBy(asc(users.fullName));
}

export async function appointFirstCaptain(actor: CurrentUser, userId: string, meta: RequestMeta) {
  if (!actor.isSuperadmin) throw forbidden();
  if (!z.uuid().safeParse(userId).success) throw new AppError('VALIDATION', 'Select an Officer to appoint.');

  return db.transaction(async (tx) => {
    await allowCaptainChange(tx);
    const [captainRank] = await tx.select({ id: ranks.id, sectionId: ranks.sectionId }).from(ranks).where(eq(ranks.systemKey, 'captain'));
    if (!captainRank) throw new AppError('CONFLICT', 'Captain rank is missing. Run the seed script.');

    const [existing] = await tx.select({ id: users.id }).from(users).where(eq(users.rankId, captainRank.id));
    if (existing) throw new AppError('CONFLICT', 'A Captain is already appointed.');

    const [before] = await tx.select().from(users).where(eq(users.id, userId)).for('update');
    if (!before || before.accountType !== 'member' || before.status !== 'active' || before.sectionId !== captainRank.sectionId) {
      throw new AppError('VALIDATION', 'That member is no longer an active Officer.');
    }

    const [after] = await tx
      .update(users)
      .set({ rankId: captainRank.id, updatedAt: new Date(), updatedBy: actor.id })
      .where(eq(users.id, userId))
      .returning();
    const changeSetId = randomUUID();
    await tx.insert(rankHistory).values({
      userId, fromSectionId: before.sectionId, fromRankId: before.rankId, toSectionId: captainRank.sectionId,
      toRankId: captainRank.id, reason: 'Appointed first Captain at system setup', changedBy: actor.id, changeSetId,
    });
    await writeAudit(tx, { actorId: actor.id, meta, changeSetId }, {
      action: 'CAPTAIN_APPOINTED', entityType: 'users', entityId: userId, reason: 'Initial setup',
      before: auditSnapshot(before, ['rankId']), after: auditSnapshot(after, ['rankId']),
    });
    return { id: userId };
  });
}
