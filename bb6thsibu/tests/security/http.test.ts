import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { sessions } from '@/lib/db/schema';
import {
  BASE, QA_PW, VICTIM_IC, closeDb, ensureUser, freshUser, loadCU, mint, reasonId, revokeQaSessions, sessionRow, setSession,
} from './fixtures';
import { setStatus } from '@/lib/server/users/service';

const GENERIC = 'Incorrect login details or account unavailable';
let up = false;
let F: Record<string, Awaited<ReturnType<typeof ensureUser>>> = {};
let captain: Awaited<ReturnType<typeof loadCU>>, sa: Awaited<ReturnType<typeof loadCU>>;
const devTok: Record<string, string> = {};
const dev = async (n: string) => (devTok[n] ??= await mint((await loadCU(n)).id));

type Res = { status: number; headers: Headers; body: string; location: string | null; cookies: string[] };
async function get(p: string, o: { cookie?: string; headers?: Record<string, string>; rsc?: boolean } = {}): Promise<Res> {
  const headers: Record<string, string> = { ...(o.headers ?? {}) };
  if (o.cookie !== undefined) headers.Cookie = o.cookie;
  if (o.rsc) headers.RSC = '1';
  const r = await fetch(BASE + p, { redirect: 'manual', headers });
  return { status: r.status, headers: r.headers, body: await r.text(), location: r.headers.get('location'), cookies: r.headers.getSetCookie() };
}
const unesc = (s: string) => s.replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

async function formLogin(identifier: string, password: string, origin: string | null = BASE): Promise<Res> {
  const page = await (await fetch(BASE + '/login')).text();
  const fd = new FormData();
  for (const m of page.matchAll(/<input type="hidden" name="([^"]+)"(?: value="([^"]*)")?\s*\/>/g)) fd.set(unesc(m[1]), unesc(m[2] ?? ''));
  fd.set('identifier', identifier);
  fd.set('password', password);
  const headers: Record<string, string> = {};
  if (origin) headers.Origin = origin;
  const r = await fetch(BASE + '/login', { method: 'POST', body: fd, redirect: 'manual', headers });
  return { status: r.status, headers: r.headers, body: await r.text(), location: r.headers.get('location'), cookies: r.headers.getSetCookie() };
}
const isLoginRedirect = (r: Res) => r.status >= 300 && r.status < 400 && /\/login/.test(r.location ?? '');
const NAMES = ['Dev Captain', 'Dev Officer', 'QA Victim', 'QA Sec victim', 'qa.sec.victim', 'dev.captain', 'dev.officer'];

beforeAll(async () => {
  try { up = (await fetch(BASE + '/login')).status === 200; } catch { up = false; }
  captain = await loadCU('dev.captain');
  sa = await loadCU('superadmin');
  for (const n of ['user1', 'victim', 'mgr', 'xss', 'deact']) F[n] = await ensureUser(n);
}, 120000);
afterAll(async () => {
  await db.execute(sql`update sessions set revoked_at = now() where revoked_at is null and ip = 'qa-mint'`);
  await closeDb();
});
const t = (name: string, fn: () => Promise<void>) => it(name, async () => { if (!up) throw new Error('BLOCKED: dev server not reachable'); await fn(); }, 60000);

describe('HTTP (dev server)', () => {
  t('SEC-HTTP-001 anonymous protected pages redirect to /login', async () => {
    const bad: string[] = [];
    for (const p of ['/', '/dashboard', '/users', '/users/new', '/setup', '/settings', '/change-password', `/users/${F.victim.id}`, `/users/${F.victim.id}/edit`]) {
      const r = await get(p);
      if (!isLoginRedirect(r)) bad.push(`${p} -> ${r.status}`);
    }
    expect(bad).toEqual([]);
  });
  t('SEC-HTTP-002 forged cookies yield no content and no 5xx', async () => {
    const bad: string[] = [];
    for (const c of ['bb6_session=garbage', 'bb6_session=' + 'x'.repeat(5000), "bb6_session=' OR 1=1 --", 'bb6_session=%00', 'bb6_session=', 'bb6_session=' + 'A'.repeat(43)]) {
      for (const p of ['/users', '/dashboard', `/users/${F.victim.id}`]) {
        const r = await get(p, { cookie: c });
        if (r.status >= 500 || NAMES.some((n) => r.body.includes(n)) || (r.status === 200 && !/Sign in/.test(r.body))) bad.push(`${c.slice(0, 20)} ${p} -> ${r.status}`);
      }
    }
    expect(bad).toEqual([]);
  });
  let loginCookie = '';
  t('SEC-HTTP-003 form login cookie flags', async () => {
    const r = await formLogin('qa.sec.user1', QA_PW);
    expect(r.status, 'login did not succeed (IP bucket saturated?) body: ' + r.body.slice(0, 100)).toBeGreaterThanOrEqual(300);
    const c = r.cookies.find((x) => x.startsWith('bb6_session='));
    expect(c, 'no session cookie, set-cookie=' + JSON.stringify(r.cookies)).toBeTruthy();
    expect(c).toMatch(/;\s*HttpOnly/i);
    expect(c).toMatch(/;\s*SameSite=lax/i);
    expect(c).toMatch(/;\s*Path=\//i);
    expect(c).not.toMatch(/Domain=/i);
    const exp = /Expires=([^;]+)/i.exec(c!);
    expect(exp).toBeTruthy();
    expect(new Date(exp![1]).getTime() - Date.now()).toBeLessThanOrEqual(12 * 3600 * 1000 + 60000);
    loginCookie = c!.split(';')[0];
    expect(r.location ?? '').toMatch(/dashboard/);
  });
  t('SEC-HTTP-004 cross-origin form POST rejected', async () => {
    for (const origin of ['http://evil.example', 'null']) {
      const r = await formLogin('qa.sec.user1', QA_PW, origin);
      expect(r.cookies.some((x) => x.startsWith('bb6_session=')), `session issued for Origin ${origin} (status ${r.status})`).toBe(false);
      expect(r.status, 'origin ' + origin).toBeGreaterThanOrEqual(400);
    }
  });
  t('SEC-HTTP-005 failed form login: same generic text', async () => {
    const u = await freshUser('hb');
    const a = await formLogin(u.username, 'wrong-password-123');
    const b = await formLogin('qa.sec.nobody' + Date.now(), 'wrong-password-123');
    for (const r of [a, b]) {
      expect(r.cookies.some((x) => x.startsWith('bb6_session='))).toBe(false);
      expect(r.body.includes(GENERIC), r.status + ' ' + r.body.slice(0, 80)).toBe(true);
    }
  });
  t('SEC-HTTP-006 authenticated page no-store', async () => {
    const r = await get('/dashboard', { cookie: loginCookie || 'bb6_session=' + (await mint(F.user1.id)) });
    expect(r.status).toBe(200);
    expect(r.headers.get('cache-control') ?? '').toMatch(/no-store/);
  });
  const hdr = async () => (await get('/login')).headers;
  t('SEC-HTTP-007 CSP', async () => {
    const csp = (await hdr()).get('content-security-policy') ?? '';
    expect(csp, 'no Content-Security-Policy header').not.toBe('');
    for (const d of ['frame-ancestors', "object-src", 'base-uri']) expect(csp).toContain(d);
  });
  t('SEC-HTTP-008 nosniff', async () => { expect((await hdr()).get('x-content-type-options') ?? '', 'missing X-Content-Type-Options').toMatch(/nosniff/i); });
  t('SEC-HTTP-009 Referrer-Policy', async () => { expect((await hdr()).get('referrer-policy'), 'missing Referrer-Policy').toBe('strict-origin-when-cross-origin'); });
  t('SEC-HTTP-010 no X-Powered-By', async () => { expect((await hdr()).get('x-powered-by'), 'X-Powered-By present').toBeNull(); });
  t('SEC-HTTP-011 dev.boy sees no member data', async () => {
    const cookie = 'bb6_session=' + (await dev('dev.boy'));
    const bad: string[] = [];
    for (const p of ['/users', '/users/new', `/users/${F.victim.id}`, `/users/${F.victim.id}/edit`, `/users/${captain.id}`, '/setup', '/users?q=dev']) {
      for (const rsc of [false, true]) {
        const r = await get(p, { cookie, rsc });
        if (r.status >= 500) bad.push(`${p} rsc=${rsc} -> ${r.status}`);
        for (const n of [...NAMES, '991231135599', '800101135001', 'QA Guardian', '+60111222333']) if (r.body.includes(n)) bad.push(`${p} rsc=${rsc} leaks ${n}`);
      }
    }
    expect(bad).toEqual([]);
  });
  t('SEC-HTTP-012 dev.viewer: IC masked, no ciphertext/hash', async () => {
    const cookie = 'bb6_session=' + (await dev('dev.viewer'));
    const bad: string[] = [];
    for (const id of [captain.id, F.victim.id]) {
      for (const rsc of [false, true]) {
        const r = await get(`/users/${id}`, { cookie, rsc });
        expect(r.status).toBeLessThan(500);
        if (r.status === 200 && !/\*{4,}/.test(r.body) && !/(●|•){2,}/.test(r.body)) bad.push(`no mask on ${id} rsc=${rsc}`);
        for (const n of ['800101135001', VICTIM_IC, '$argon2', 'passwordHash', 'idNumberEnc', 'idNumberHash']) if (r.body.includes(n)) bad.push(`${id} rsc=${rsc} leaks ${n}`);
        if (/v1:[A-Za-z0-9_-]{10,}:[A-Za-z0-9_-]{4,}:/.test(r.body)) bad.push(`${id} rsc=${rsc} ciphertext`);
      }
    }
    expect(bad).toEqual([]);
  });
  t('SEC-HTTP-013 superadmin page not found for Captain', async () => {
    const r = await get(`/users/${sa.id}`, { cookie: 'bb6_session=' + (await dev('dev.captain')) });
    expect(r.status === 404 || /not found/i.test(r.body)).toBe(true);
    expect(r.body.includes('Super Admin')).toBe(false);
  });
  t('SEC-HTTP-014 revoked / deactivated / idle cookies redirected', async () => {
    const tok = await mint(F.user1.id);
    expect((await get('/dashboard', { cookie: 'bb6_session=' + tok })).status).toBe(200);
    await setSession(tok, { revokedAt: new Date() });
    expect(isLoginRedirect(await get('/dashboard', { cookie: 'bb6_session=' + tok }))).toBe(true);
    const t2 = await mint(F.user1.id);
    await setSession(t2, { lastSeenAt: new Date(Date.now() - 31 * 60000) });
    expect(isLoginRedirect(await get('/dashboard', { cookie: 'bb6_session=' + t2 }))).toBe(true);
    const t3 = await mint(F.deact.id);
    expect((await get('/dashboard', { cookie: 'bb6_session=' + t3 })).status).toBe(200);
    await setStatus(captain, F.deact.id, { status: 'inactive', reasonId: await reasonId() }, { ip: 'qa-http', userAgent: 'v' });
    try {
      expect(isLoginRedirect(await get('/dashboard', { cookie: 'bb6_session=' + t3 }))).toBe(true);
    } finally {
      await setStatus(captain, F.deact.id, { status: 'active' }, { ip: 'qa-http', userAgent: 'v' });
    }
    void sessionRow;
  });
  t('SEC-HTTP-015 x-middleware-subrequest does not bypass', async () => {
    const bad: string[] = [];
    for (const v of ['middleware', 'src/middleware', 'proxy', 'src/proxy', 'middleware:middleware:middleware:middleware:middleware', 'proxy:proxy:proxy:proxy:proxy']) {
      const r = await get('/users', { headers: { 'x-middleware-subrequest': v } });
      if (r.status === 200 && !/Sign in/.test(r.body)) bad.push(v + ' -> 200');
      if (NAMES.some((n) => r.body.includes(n))) bad.push(v + ' leaks');
    }
    expect(bad).toEqual([]);
  });
  t('SEC-HTTP-016 secret/source files not served', async () => {
    const bad: string[] = [];
    for (const p of ['/.env.local', '/.env', '/.git/config', '/drizzle/0000_init_schema.sql', '/lib/server/env.ts', '/package.json', '/docs/security/threat-model.md', '/tests/setup.ts', '/_next/static/../../.env.local', '/..%2f.env.local']) {
      const r = await get(p, { cookie: 'bb6_session=' + (await dev('dev.captain')) });
      if (r.status === 200 && !/<html/i.test(r.body)) bad.push(`${p} -> 200 non-html`);
      if (/IC_ENC_KEY|DATABASE_URL|CREATE TABLE/.test(r.body)) bad.push(`${p} leaks`);
    }
    expect(bad).toEqual([]);
  });
  t('SEC-DATA-010 stored XSS escaped in HTML', async () => {
    const cookie = 'bb6_session=' + (await mint(F.mgr.id));
    const bad: string[] = [];
    for (const [p, rsc] of [[`/users/${F.xss.id}`, false], [`/users/${F.xss.id}`, true], ['/users?q=alert&status=all', false], [`/users/${F.xss.id}/edit`, false]] as const) {
      const r = await get(p, { cookie, rsc });
      if (rsc) { if (!/text\/x-component/.test(r.headers.get('content-type') ?? '')) bad.push(`${p} RSC content-type ${r.headers.get('content-type')}`); continue; }
      for (const raw of ['<script>alert(1)</script>', '<img src=x onerror', '<svg onload']) if (r.body.includes(raw)) bad.push(`${p} rsc=${rsc} has raw ${raw}`);
      if (!rsc && r.status === 200 && p.startsWith('/users/') && !p.endsWith('edit') && !r.body.includes('&lt;script&gt;')) bad.push(`${p} payload not visible escaped (status ${r.status})`);
    }
    expect(bad).toEqual([]);
  });
});

void revokeQaSessions; void sessions;
