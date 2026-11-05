import { and, eq, gt, sql } from 'drizzle-orm';
import { db, type Tx } from '@/lib/db/client';
import { loginAttempts, ranks, users } from '@/lib/db/schema';
import { decryptIdNumber, hmac, looksLikeIc } from '@/lib/server/auth/crypto';
import { checkPasswordPolicy, hashPassword, needsRehash, verifyPassword } from '@/lib/server/auth/password';
import { createSession, revokeAllSessions, type CurrentUser } from '@/lib/server/auth/session';
import { writeAudit } from '@/lib/server/audit';
import { AppError } from '@/lib/server/errors';
import type { RequestMeta } from '@/lib/server/request';

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILS_PER_IDENTIFIER = 5;
const MAX_FAILS_PER_IP = 20;

/** 证件号查找用的哈希（类型 + 号码），与 users 服务一致 */
export const idLookupHash = (idType: string, normalized: string) => hmac(`${idType}:${normalized}`);

/** 登录尝试记录用的识别哈希（不存明文） */
export const usernameAttemptHash = (username: string) => hmac(`u:${username.toLowerCase()}`);
export const icAttemptHash = (ic: string) => hmac(`ic:${ic}`);
const passwordChangeHash = (userId: string) => hmac(`pw:${userId}`);

/**
 * 统计最近 15 分钟内的失败次数。
 * 账号：只算最后一次成功之后的。IP：不因成功而归零（否则登入自己的账号就能把 IP 计数清掉，继续撞别人的密码）。
 * 被限流时不再新增记录，所以攻击者无法让受害者永远处于锁定状态。
 */
async function recentFailures(tx: Tx, column: 'identifier' | 'ip', value: string) {
  const col = column === 'identifier' ? loginAttempts.identifierHash : loginAttempts.ip;
  const since = new Date(Date.now() - WINDOW_MS);
  const [{ n }] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(loginAttempts)
    .where(
      and(
        eq(col, value),
        eq(loginAttempts.success, false),
        gt(loginAttempts.createdAt, since),
        column === 'identifier'
          ? sql`${loginAttempts.createdAt} > coalesce((select max(la2.created_at) from login_attempts la2 where la2.identifier_hash = ${value} and la2.success), '-infinity')`
          : undefined,
      ),
    );
  return n;
}

/** 让某账号的失败计数归零（管理员重设密码后用） */
export async function clearLoginFailures(tx: Tx, userId: string) {
  const [u] = await tx.select({ username: users.username, idType: users.idType, idNumberEnc: users.idNumberEnc }).from(users).where(eq(users.id, userId));
  if (!u) return;
  const rows = [{ identifierHash: usernameAttemptHash(u.username), ip: 'admin-reset', success: true }];
  if (u.idType === 'mykad' && u.idNumberEnc) {
    rows.push({ identifierHash: icAttemptHash(decryptIdNumber(u.idNumberEnc, userId)), ip: 'admin-reset', success: true });
  }
  await tx.insert(loginAttempts).values(rows);
}

export type LoginResult =
  | { ok: true; token: string; expiresAt: Date; mustChangePassword: boolean; needsSetup: boolean }
  | { ok: false };

/**
 * 登录：所有失败情况（账号不存在、密码错、没设密码、已停用、被锁定、IP 限流）一律返回 { ok:false }，
 * 前端只显示同一句话，避免被用来猜账号。
 * 做法：先在短事务里检查限流并「预先记一次失败」，再在事务外做 argon2 验证，成功后把那笔记录改成成功。
 */
export async function login(identifierRaw: string, password: string, meta: RequestMeta): Promise<LoginResult> {
  const identifier = identifierRaw.replace(/\0/g, '').trim().slice(0, 64);
  if (!identifier) return { ok: false };
  const ic = looksLikeIc(identifier);
  const identifierHash = ic ? icAttemptHash(ic) : usernameAttemptHash(identifier);
  const checkIp = meta.ip !== 'unknown'; // 没设定可信代理时无法分辨 IP，只靠账号限流

  const pre = await db.transaction(async (tx) => {
    // 同一账号、同一 IP 的并发登录排队，保证计数不会被并发绕过
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${identifierHash}))`);
    if (checkIp) await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${'ip:' + meta.ip}))`);

    if ((await recentFailures(tx, 'identifier', identifierHash)) >= MAX_FAILS_PER_IDENTIFIER) return null;
    if (checkIp && (await recentFailures(tx, 'ip', meta.ip)) >= MAX_FAILS_PER_IP) return null;

    const [attempt] = await tx
      .insert(loginAttempts)
      .values({ identifierHash, ip: meta.ip, success: false })
      .returning({ id: loginAttempts.id });
    const [user] = await tx
      .select({
        id: users.id,
        passwordHash: users.passwordHash,
        status: users.status,
        mustChangePassword: users.mustChangePassword,
        accountType: users.accountType,
        lockedUntil: users.lockedUntil,
      })
      .from(users)
      .where(ic ? eq(users.idNumberHash, idLookupHash('mykad', ic)) : sql`lower(${users.username}) = ${identifier.toLowerCase()}`)
      .limit(1);
    return { attemptId: attempt.id, user };
  });
  if (!pre) return { ok: false };

  const { attemptId, user } = pre;
  const verified = await verifyPassword(user?.passwordHash ?? null, password);
  // 账号被锁（不论用用户名还是 IC 登录）：照样跑完验证，回应时间一致
  const locked = !!user?.lockedUntil && user.lockedUntil > new Date();
  if (!verified || !user || user.status !== 'active' || locked) {
    if (user && !verified) {
      await db.transaction(async (tx) => {
        const [{ count }] = await tx
          .update(users)
          .set({ failedLoginCount: sql`${users.failedLoginCount} + 1` })
          .where(eq(users.id, user.id))
          .returning({ count: users.failedLoginCount });
        if (count % MAX_FAILS_PER_IDENTIFIER === 0) {
          await tx.update(users).set({ lockedUntil: new Date(Date.now() + WINDOW_MS) }).where(eq(users.id, user.id));
          await writeAudit(tx, { actorId: null, meta }, { action: 'LOGIN_LOCKED', entityType: 'users', entityId: user.id });
        }
      });
    }
    return { ok: false };
  }

  const newHash = needsRehash(user.passwordHash!) ? await hashPassword(password) : null;
  return db.transaction(async (tx) => {
    await tx.update(loginAttempts).set({ success: true }).where(eq(loginAttempts.id, attemptId));
    await tx
      .update(users)
      .set({ lastLoginAt: new Date(), failedLoginCount: 0, lockedUntil: null, ...(newHash ? { passwordHash: newHash } : {}) })
      .where(eq(users.id, user.id));

    const session = await createSession(tx, user.id, meta);
    await writeAudit(tx, { actorId: user.id, meta }, { action: 'LOGIN', entityType: 'users', entityId: user.id });

    let needsSetup = false;
    if (user.accountType === 'superadmin') {
      const [captain] = await tx
        .select({ id: users.id })
        .from(users)
        .innerJoin(ranks, eq(ranks.id, users.rankId))
        .where(eq(ranks.systemKey, 'captain'))
        .limit(1);
      needsSetup = !captain;
    }
    return { ok: true as const, token: session.token, expiresAt: session.expiresAt, mustChangePassword: user.mustChangePassword, needsSetup };
  });
}

/** 自己改密码：验证旧密码（有限流）→ 撤销所有会话 → 发新会话 */
export async function changeOwnPassword(user: CurrentUser, current: string, next: string, meta: RequestMeta) {
  const attemptHash = passwordChangeHash(user.id);
  // 先在锁里「预先记一次失败」，并发请求就无法一起通过限流检查；验证成功后改成成功
  const attemptId = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${attemptHash}))`);
    if ((await recentFailures(tx, 'identifier', attemptHash)) >= MAX_FAILS_PER_IDENTIFIER) return null;
    const [a] = await tx.insert(loginAttempts).values({ identifierHash: attemptHash, ip: meta.ip, success: false }).returning({ id: loginAttempts.id });
    return a.id;
  });
  if (attemptId === null) throw new AppError('VALIDATION', 'Too many attempts. Please wait 15 minutes and try again.');

  const [row] = await db
    .select({ passwordHash: users.passwordHash, idType: users.idType, idNumberEnc: users.idNumberEnc })
    .from(users)
    .where(eq(users.id, user.id));
  if (!(await verifyPassword(row?.passwordHash ?? null, current))) {
    await db.transaction(async (tx) => {
      await writeAudit(tx, { actorId: user.id, meta }, { action: 'PASSWORD_CHANGE_FAILED', entityType: 'users', entityId: user.id });
    });
    throw new AppError('VALIDATION', 'Please fix the highlighted fields.', { current: 'Current password is incorrect.' });
  }
  await db.update(loginAttempts).set({ success: true }).where(eq(loginAttempts.id, attemptId));
  const ownId = row.idNumberEnc ? decryptIdNumber(row.idNumberEnc, user.id) : null;
  const policy = checkPasswordPolicy(next, [user.username, ownId]);
  if (policy) throw new AppError('VALIDATION', 'Please fix the highlighted fields.', { next: policy });
  if (current === next) throw new AppError('VALIDATION', 'Please fix the highlighted fields.', { next: 'New password must be different.' });

  const passwordHash = await hashPassword(next);
  return db.transaction(async (tx) => {
    await tx
      .update(users)
      .set({ passwordHash, mustChangePassword: false, passwordChangedAt: new Date(), updatedAt: new Date(), updatedBy: user.id })
      .where(eq(users.id, user.id));
    await revokeAllSessions(tx, user.id);
    const session = await createSession(tx, user.id, meta);
    await writeAudit(tx, { actorId: user.id, meta }, { action: 'PASSWORD_CHANGED', entityType: 'users', entityId: user.id });
    return session;
  });
}
