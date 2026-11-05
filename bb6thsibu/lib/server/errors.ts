import { unstable_rethrow } from 'next/navigation';

// 服务层统一的错误类型。Server Action 只把 code 和安全的 message 回传给前端，绝不回传数据库原始错误。
export type ErrorCode = 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'VALIDATION' | 'CONFLICT';

export class AppError extends Error {
  constructor(
    public code: ErrorCode,
    message: string,
    public fieldErrors?: Record<string, string>,
  ) {
    super(message);
  }
}

export const notFound = () => new AppError('NOT_FOUND', 'Member not found.');
export const forbidden = () => new AppError('FORBIDDEN', 'You do not have access.');

export type ActionResult<T = undefined> =
  | ({ ok: true } & (T extends undefined ? object : { data: T }))
  | { ok: false; code: ErrorCode | 'SERVER'; message: string; fieldErrors?: Record<string, string> };

/** 把任意错误转成安全的 ActionResult；未知错误只记录在服务器日志里。Next 的 redirect 等内部错误照常抛出。 */
export function toActionError(err: unknown): Extract<ActionResult, { ok: false }> {
  unstable_rethrow(err);
  if (err instanceof AppError) {
    return { ok: false, code: err.code, message: err.message, fieldErrors: err.fieldErrors };
  }
  // 文字里有 Postgres 不接受的字元（例如 \0）：当作输入错误，不是服务器错误
  if ((err as { code?: string; cause?: { code?: string } })?.code === '22021' || (err as { cause?: { code?: string } })?.cause?.code === '22021') {
    return { ok: false, code: 'VALIDATION', message: 'Remove invalid characters and try again.' };
  }
  // 送来的资料是空的 / 格式不对（例如 null 而不是物件）：当作输入错误
  if (err instanceof TypeError && /Cannot read properties of (null|undefined)/.test(err.message)) {
    return { ok: false, code: 'VALIDATION', message: 'Invalid request.' };
  }
  // 只记录错误类型和 Postgres 错误码；不记录 message（Drizzle 的 message 会带 SQL 参数，含个人资料）
  const e = err as { name?: string; code?: string; cause?: { code?: string; constraint?: string } };
  console.error('[action error]', e?.name ?? 'unknown', e?.code ?? e?.cause?.code ?? '', e?.cause?.constraint ?? '');
  return { ok: false, code: 'SERVER', message: 'Something went wrong. Please try again.' };
}
