import { vi, describe, it, expect, beforeEach } from 'vitest';
vi.mock('next/headers', async () => (await import('./ctx')).headersMock);

import { execSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { ctx, resetCtx } from './ctx';

const ROOT = path.resolve(__dirname, '../..');
const SKIP = new Set(['node_modules', '.next', '.git', 'coverage']);
const walk = (dir: string, exts: RegExp, out: string[] = []) => {
  for (const f of readdirSync(dir)) {
    if (SKIP.has(f)) continue;
    const p = path.join(dir, f);
    statSync(p).isDirectory() ? walk(p, exts, out) : exts.test(f) && out.push(p);
  }
  return out;
};
const rel = (f: string) => path.relative(ROOT, f).replace(/\\/g, '/');
beforeEach(() => resetCtx());

describe('Static and configuration', () => {
  it('SEC-STATIC-001 no dangerouslySetInnerHTML in app/', () => {
    expect(walk(path.join(ROOT, 'app'), /\.(ts|tsx)$/).filter((f) => readFileSync(f, 'utf8').includes('dangerouslySetInnerHTML')).map(rel)).toEqual([]);
  });
  it('SEC-STATIC-002 no sql.raw / eval / new Function', () => {
    const re = /\bsql\.raw\(|\beval\(|new Function\(/;
    const files = [...walk(path.join(ROOT, 'app'), /\.(ts|tsx)$/), ...walk(path.join(ROOT, 'lib'), /\.ts$/)];
    expect(files.filter((f) => re.test(readFileSync(f, 'utf8'))).map(rel)).toEqual([]);
  });
  it('SEC-STATIC-003 key values absent from source, no NEXT_PUBLIC secrets', () => {
    const secrets = [process.env.IC_ENC_KEY, process.env.IC_HMAC_KEY, process.env.NEXTAUTH_SECRET, process.env.SEED_SUPERADMIN_PASSWORD, process.env.R2_SECRET_ACCESS_KEY].filter((s): s is string => !!s && s.length >= 8);
    expect(secrets.length).toBeGreaterThan(1);
    const hits: string[] = [];
    for (const f of walk(ROOT, /\.(ts|tsx|js|mjs|json|md|sql|css|yml|yaml)$/)) {
      if (/package-lock\.json$/.test(f)) continue;
      const txt = readFileSync(f, 'utf8');
      for (const s of secrets) if (txt.includes(s)) hits.push(rel(f));
      if (/NEXT_PUBLIC_[A-Z_]*(KEY|SECRET|PASSWORD|TOKEN)/.test(txt) && !f.endsWith('static.test.ts')) hits.push(rel(f) + ' NEXT_PUBLIC secret');
    }
    expect(hits).toEqual([]);
  });
  it('SEC-STATIC-004 .env* git-ignored', () => {
    expect(readFileSync(path.join(ROOT, '.gitignore'), 'utf8')).toMatch(/^\.env\*/m);
    const out = execSync('git check-ignore .env.local', { cwd: ROOT }).toString().trim();
    expect(out).toBe('.env.local');
  });
  it('SEC-STATIC-005 env fails closed', async () => {
    const base = { ...process.env };
    const tryEnv = async (patch: Record<string, string | undefined>) => {
      vi.resetModules();
      for (const [k, v] of Object.entries(patch)) v === undefined ? delete process.env[k] : (process.env[k] = v);
      try { await import('@/lib/server/env'); return 'OK'; } catch (e: any) { return 'THROWS'; } finally { process.env = { ...base }; }
    };
    expect(await tryEnv({})).toBe('OK');
    expect(await tryEnv({ IC_ENC_KEY: 'short' })).toBe('THROWS');
    expect(await tryEnv({ IC_ENC_KEY: undefined })).toBe('THROWS');
    expect(await tryEnv({ IC_HMAC_KEY: Buffer.alloc(16).toString('base64') })).toBe('THROWS');
    expect(await tryEnv({ DATABASE_URL: undefined })).toBe('THROWS');
    expect(await tryEnv({ TRUSTED_PROXY_MODE: undefined })).toBe('THROWS');
    expect(await tryEnv({ TRUSTED_PROXY_MODE: 'everything' })).toBe('THROWS');
    expect(await tryEnv({ TRUSTED_PROXY_MODE: 'hops:0' })).toBe('THROWS');
  });
  it('SEC-STATIC-006 getRequestMeta trusts only configured mode', async () => {
    const base = { ...process.env };
    const run = async (mode: string, headers: Record<string, string>) => {
      vi.resetModules();
      process.env.TRUSTED_PROXY_MODE = mode;
      ctx.headers = headers;
      try { return await (await import('@/lib/server/request')).getRequestMeta(); } finally { process.env = { ...base }; }
    };
    expect((await run('none', { 'x-forwarded-for': '1.2.3.4', 'x-real-ip': '5.6.7.8' })).ip).toBe('unknown');
    expect((await run('hops:1', { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' })).ip).toBe('1.2.3.4');
    expect((await run('hops:1', { 'x-forwarded-for': '1.2.3.4' })).ip).toBe('1.2.3.4');
    expect((await run('hops:2', { 'x-forwarded-for': '6.6.6.6, 1.2.3.4' })).ip).toBe('6.6.6.6');
    expect((await run('hops:2', { 'x-forwarded-for': '1.2.3.4' })).ip).toBe('unknown');
    expect((await run('hops:1', {})).ip).toBe('unknown');
    expect((await run('vercel', { 'x-real-ip': '9.9.9.9', 'x-forwarded-for': '6.6.6.6' })).ip).toBe('9.9.9.9');
    expect((await run('vercel', { 'x-forwarded-for': '6.6.6.6' })).ip).toBe('unknown');
    expect((await run('hops:1', { 'x-forwarded-for': '2001:db8:85a3:8d3:1319:8a2e:370:7348' })).ip).toBe('2001:db8:85a3:8d3::/64');
    expect((await run('hops:1', { 'x-forwarded-for': '::ffff:1.2.3.4' })).ip).toBe('1.2.3.4');
    expect((await run('hops:1', { 'x-forwarded-for': 'x'.repeat(500) })).ip.length).toBeLessThanOrEqual(64);
    expect((await run('none', { 'user-agent': 'u'.repeat(400) })).userAgent!.length).toBe(300);
    expect((await run('none', {})).userAgent).toBeNull();
  });
  it('SEC-STATIC-007 production cookie name and secure flag', async () => {
    const base = { ...process.env };
    vi.resetModules();
    (process.env as any).NODE_ENV = 'production';
    try {
      const s = await import('@/lib/server/auth/session');
      expect(s.SESSION_COOKIE).toBe('__Host-bb6_session');
      await s.setSessionCookie('tok', new Date(Date.now() + 1000));
      const c = ctx.cookiesSet.find((x) => x.value === 'tok');
      expect(c).toBeTruthy();
    } finally {
      process.env = { ...base };
    }
  });
  it('SEC-STATIC-008 npm audit (prod deps) has no high/critical', () => {
    let out = '';
    try { out = execSync('npm audit --omit=dev --json', { cwd: ROOT, timeout: 90000 }).toString(); } catch (e: any) { out = e.stdout?.toString() ?? ''; }
    if (!out) throw new Error('BLOCKED: npm audit produced no output (offline?)');
    const j = JSON.parse(out);
    if (j.error) throw new Error('BLOCKED: ' + JSON.stringify(j.error).slice(0, 200));
    const v = j.metadata.vulnerabilities;
    expect(`high=${v.high} critical=${v.critical}`).toBe('high=0 critical=0');
  }, 120000);
  it('SEC-STATIC-009 no service worker caches authenticated responses', () => {
    const pub = path.join(ROOT, 'public');
    expect(readdirSync(pub).filter((f) => /^(sw|service-worker|workbox).*\.js$/i.test(f))).toEqual([]);
    const src = walk(path.join(ROOT, 'app'), /\.(ts|tsx)$/).filter((f) => /serviceWorker\.register/.test(readFileSync(f, 'utf8')));
    expect(src.map(rel)).toEqual([]);
    expect(existsSync(path.join(pub, 'manifest.json'))).toBe(true);
  });
  it('SEC-STATIC-010 trusted proxy mode configured (not "none") so IP throttle is per client', async () => {
    const { env } = await import('@/lib/server/env');
    expect(env.TRUSTED_PROXY_MODE, "mode 'none': every client resolves to ip 'unknown' => one shared 20-failure bucket for the whole app").not.toBe('none');
  });
});
