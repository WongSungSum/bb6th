import { asc, eq } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { guardians, platoons, ranks, sections, users } from '@/lib/db/schema';
import { decryptIdNumber } from '@/lib/server/auth/crypto';
import type { CurrentUser } from '@/lib/server/auth/session';
import { auditSnapshot, writeAudit } from '@/lib/server/audit';
import { AppError } from '@/lib/server/errors';
import type { RequestMeta } from '@/lib/server/request';
import { writeGuardians } from './service';
import { fieldErrorsOf, ownProfileSchema, type OwnProfileInput } from '@/lib/validation/users';

// 自己的资料：每个登入的人都能看、能改联络资料，不需要任何权限。
// 姓名、证件、性别、生日、组别、军阶等身份资料只能由有权限的人改。

const PROFILE_FIELDS = ['email', 'phone', 'address', 'school'] as const;

export async function getOwnProfile(actor: CurrentUser) {
  const [u] = await db
    .select({
      id: users.id, username: users.username, email: users.email, fullName: users.fullName,
      idType: users.idType, idNumberEnc: users.idNumberEnc, gender: users.gender,
      dateOfBirth: users.dateOfBirth, joinDate: users.joinDate, phone: users.phone,
      address: users.address, school: users.school, updatedAt: users.updatedAt,
      accountType: users.accountType, sectionName: sections.name, sectionKey: sections.systemKey,
      rankName: ranks.name, rankKey: ranks.systemKey, platoonName: platoons.name, platoonRole: users.platoonRole,
    })
    .from(users)
    .leftJoin(sections, eq(sections.id, users.sectionId))
    .leftJoin(ranks, eq(ranks.id, users.rankId))
    .leftJoin(platoons, eq(platoons.id, users.platoonId))
    .where(eq(users.id, actor.id));
  if (!u) throw new AppError('NOT_FOUND', 'Account not found.');
  const gs = await db
    .select({ name: guardians.name, relationship: guardians.relationship, phone: guardians.phone, email: guardians.email })
    .from(guardians)
    .where(eq(guardians.userId, actor.id))
    .orderBy(asc(guardians.slot));
  const { idNumberEnc, sectionKey, rankKey, ...rest } = u;
  return {
    ...rest,
    // 自己的证件号可以看
    idNumber: idNumberEnc ? decryptIdNumber(idNumberEnc, u.id) : null,
    isCaptain: rankKey === 'captain',
    // 军官和 Superadmin 没有监护人
    hasGuardians: u.accountType === 'member' && sectionKey !== 'officer',
    guardians: gs.map((g) => ({ ...g, phone: g.phone ?? '', email: g.email ?? '' })),
    updatedAt: u.updatedAt.toISOString(),
  };
}
export type OwnProfile = Awaited<ReturnType<typeof getOwnProfile>>;

export async function updateOwnProfile(actor: CurrentUser, input: OwnProfileInput, meta: RequestMeta) {
  const parsed = ownProfileSchema.safeParse(input);
  if (!parsed.success) throw new AppError('VALIDATION', 'Please fix the highlighted fields.', fieldErrorsOf(parsed.error));
  const v = parsed.data;

  return db.transaction(async (tx) => {
    const [before] = await tx.select().from(users).where(eq(users.id, actor.id)).for('update');
    if (!before) throw new AppError('NOT_FOUND', 'Account not found.');
    if (v.expectedUpdatedAt && before.updatedAt.toISOString() !== v.expectedUpdatedAt) {
      throw new AppError('CONFLICT', 'Your profile was changed somewhere else. Reload to see the latest.');
    }
    const [after] = await tx
      .update(users)
      .set({ email: v.email, phone: v.phone ?? null, address: v.address ?? null, school: v.school ?? null, updatedAt: new Date(), updatedBy: actor.id })
      .where(eq(users.id, actor.id))
      .returning();

    // 监护人：只有非军官的成员才有
    let guardiansBefore: unknown[] | undefined;
    const [sec] = before.sectionId ? await tx.select({ key: sections.systemKey }).from(sections).where(eq(sections.id, before.sectionId)) : [];
    if (before.accountType === 'member' && sec?.key !== 'officer') {
      guardiansBefore = await writeGuardians(tx, actor.id, v.guardians);
    }

    await writeAudit(tx, { actorId: actor.id, meta }, {
      action: 'PROFILE_UPDATED', entityType: 'users', entityId: actor.id,
      before: { ...auditSnapshot(before, [...PROFILE_FIELDS]), ...(guardiansBefore ? { guardians: guardiansBefore } : {}) },
      after: { ...auditSnapshot(after, [...PROFILE_FIELDS]), ...(guardiansBefore ? { guardians: v.guardians } : {}) },
    });
    return { updatedAt: after.updatedAt.toISOString() };
  });
}
