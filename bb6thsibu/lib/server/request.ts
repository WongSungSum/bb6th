import { headers } from 'next/headers';
import { env } from '@/lib/server/env';

export type RequestMeta = { ip: string; userAgent: string | null };

function normalizeIp(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let ip = raw.trim().toLowerCase();
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (ip.includes(':')) {
    // IPv6 按 /64 归组；先把 '::' 展开，否则 2001:db8::1 和 2001:db8::2 会被当成不同组
    const [head, tail] = ip.split('%')[0].split('::');
    const h = head ? head.split(':') : [];
    const t = tail ? tail.split(':') : [];
    const parts = tail === undefined ? h : [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
    const valid = parts.length >= 4 && parts.slice(0, 4).every((p) => /^[0-9a-f]{1,4}$/.test(p));
    return valid ? parts.slice(0, 4).map((p) => p.replace(/^0+(?=.)/, '')).join(':') + '::/64' : ip.slice(0, 64);
  }
  return ip.slice(0, 64);
}

/**
 * 取得客户端 IP。只信任 TRUSTED_PROXY_MODE 指定的来源，绝不直接用最左边的 X-Forwarded-For。
 * none = 忽略所有转发头；vercel = 平台设定的 x-real-ip；hops:N = 从右数第 N 个。
 */
export async function getRequestMeta(): Promise<RequestMeta> {
  const h = await headers();
  let ip: string | null = null;
  const mode = env.TRUSTED_PROXY_MODE;
  if (mode === 'vercel') {
    ip = h.get('x-real-ip');
  } else if (mode.startsWith('hops:')) {
    const n = Number(mode.slice(5));
    const chain = (h.get('x-forwarded-for') ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    ip = chain.length >= n ? chain[chain.length - n] : null;
  }
  return {
    ip: normalizeIp(ip) ?? 'unknown',
    userAgent: h.get('user-agent')?.slice(0, 300) ?? null,
  };
}
