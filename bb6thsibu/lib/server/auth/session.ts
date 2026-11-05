import { cache } from 'react';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db, type Tx } from '@/lib/db/client';
import { ranks, sessions, users } from '@/lib/db/schema';
import { isProd } from '@/lib/server/env';
import { randomToken, sha256 } from '@/lib/server/auth/crypto';
import type { RequestMeta } from '@/lib/server/request';

// 网页端：闲置 30 分钟失效（滑动），最长 12 小时。APK 端（90 天）等 APK 出现后再做专用登录接口。
const WEB_IDLE_MS = 30 * 60 * 1000;
const WEB_ABSOLUTE_MS = 12 * 60 * 60 * 1000;
const TOUCH_INTERVAL_MS = 60 * 1000;
const MAX_SESSIONS_PER_USER = 10;

export const SESSION_COOKIE = isProd ? '__Host-bb6_session' : 'bb6_session';

export type CurrentUser = {
  id: string;
  sessionId: string;
  username: string;
  fullName: string;
  accountType: 'member' | 'superadmin';
  isSuperadmin: boolean;
  isCaptain: boolean;
  mustChangePassword: boolean;
  sectionId: number | null;
  rankId: number | null;
};

/** 登录成功后建立新会话（每次都生成新 token，防止会话固定攻击） */
export async function createSession(tx: Tx, userId: string, meta: RequestMeta) {
  const token = randomToken();
  const now = Date.now();
  const [row] = await tx
    .insert(sessions)
    .values({
      tokenHash: sha256(token),
      userId,
      platform: 'web',
      expiresAt: new Date(now + WEB_ABSOLUTE_MS),
      ip: meta.ip,
      userAgent: meta.userAgent,
    })
    .returning({ id: sessions.id });

  // 每人最多 10 个有效会话，超过就撤销最旧的
  const live = await tx
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt)))
    .orderBy(desc(sessions.createdAt));
  const extra = live.slice(MAX_SESSIONS_PER_USER).map((s) => s.id);
  if (extra.length) {
    await tx.update(sessions).set({ revokedAt: new Date() }).where(inArray(sessions.id, extra));
  }
  return { token, sessionId: row.id, expiresAt: new Date(now + WEB_ABSOLUTE_MS) };
}

/** 只能在 Server Action / Route Handler 里调用 */
export async function setSessionCookie(token: string, expiresAt: Date) {
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function revokeSession(sessionId: string) {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
}

/** 撤销某用户的全部会话（可保留当前这一个） */
export async function revokeAllSessions(tx: Tx, userId: string, exceptSessionId?: string) {
  await tx
    .update(sessions)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(sessions.userId, userId),
        isNull(sessions.revokedAt),
        exceptSessionId ? sql`${sessions.id} <> ${exceptSessionId}` : undefined,
      ),
    );
}

/** 读取并验证当前会话；同一个请求内只查一次数据库 */
export const getCurrentUser = cache(async (): Promise<CurrentUser | null> => {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token || token.length > 100) return null;

  const [row] = await db
    .select({
      sessionId: sessions.id,
      revokedAt: sessions.revokedAt,
      expiresAt: sessions.expiresAt,
      lastSeenAt: sessions.lastSeenAt,
      userId: users.id,
      username: users.username,
      fullName: users.fullName,
      accountType: users.accountType,
      status: users.status,
      hasPassword: sql<boolean>`${users.passwordHash} IS NOT NULL`,
      mustChangePassword: users.mustChangePassword,
      sectionId: users.sectionId,
      rankId: users.rankId,
      rankKey: ranks.systemKey,
    })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .leftJoin(ranks, eq(ranks.id, users.rankId))
    .where(eq(sessions.tokenHash, sha256(token)))
    .limit(1);

  const now = Date.now();
  if (
    !row ||
    row.revokedAt ||
    row.expiresAt.getTime() <= now ||
    now - row.lastSeenAt.getTime() > WEB_IDLE_MS ||
    row.status !== 'active' ||
    !row.hasPassword
  ) {
    return null;
  }

  if (now - row.lastSeenAt.getTime() > TOUCH_INTERVAL_MS) {
    await db.update(sessions).set({ lastSeenAt: new Date(now) }).where(eq(sessions.id, row.sessionId));
  }

  return {
    id: row.userId,
    sessionId: row.sessionId,
    username: row.username,
    fullName: row.fullName,
    accountType: row.accountType,
    isSuperadmin: row.accountType === 'superadmin',
    isCaptain: row.rankKey === 'captain',
    mustChangePassword: row.mustChangePassword,
    sectionId: row.sectionId,
    rankId: row.rankId,
  };
});

/**
 * 页面与 Server Action 的入口检查。没登录 → /login；
 * 必须改密码时，除了改密码和登出，其他一律 → /change-password。
 */
export async function requireUser(opts: { allowMustChange?: boolean } = {}): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect('/login');
  if (user.mustChangePassword && !opts.allowMustChange) redirect('/change-password');
  return user;
}
