import { randomUUID } from 'node:crypto';
import type { Tx } from '@/lib/db/client';
import { auditLogs } from '@/lib/db/schema';
import type { RequestMeta } from '@/lib/server/request';

// 绝对不能进入审计日志的字段（审计只能新增，写进去就删不掉）
const FORBIDDEN = new Set(['passwordHash', 'idNumberEnc', 'idNumberHash', 'tokenHash', 'token', 'password']);

/** 只保留允许的字段，并剔除敏感字段 */
export function auditSnapshot<T extends Record<string, unknown>>(row: T | null | undefined, allow?: (keyof T)[]) {
  if (!row) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) {
    if (FORBIDDEN.has(k)) continue;
    if (allow && !allow.includes(k as keyof T)) continue;
    out[k] = v instanceof Date ? v.toISOString() : v;
  }
  return out;
}

export type AuditEntry = {
  action: string;
  entityType: string;
  entityId: string;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  reason?: string | null;
};

export type AuditContext = { actorId: string | null; meta: RequestMeta; changeSetId?: string };

/** 在同一个事务里写审计；同一操作共用 changeSetId，方便以后整组回退 */
export async function writeAudit(tx: Tx, ctx: AuditContext, entries: AuditEntry | AuditEntry[]) {
  const changeSetId = ctx.changeSetId ?? randomUUID();
  const list = Array.isArray(entries) ? entries : [entries];
  await tx.insert(auditLogs).values(
    list.map((e) => ({
      changeSetId,
      actorId: ctx.actorId,
      action: e.action,
      entityType: e.entityType,
      entityId: e.entityId,
      before: e.before ?? null,
      after: e.after ?? null,
      reason: e.reason ?? null,
      ip: ctx.meta.ip,
      userAgent: ctx.meta.userAgent,
    })),
  );
  return changeSetId;
}
