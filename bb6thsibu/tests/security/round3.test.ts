import { vi, describe, it, expect, afterAll } from 'vitest';
vi.mock('next/headers', async () => (await import('./ctx')).headersMock);
vi.mock('next/cache', () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));
vi.mock('@/lib/server/request', async () => (await import('./ctx')).requestMock);

import { changeOwnPassword, login } from '@/lib/server/auth/login';
import { setAgeUpAction } from '@/app/actions/org';
import { db } from '@/lib/db/client';
import { sections } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { ctx } from './ctx';
import { QA_PW, closeDb, ensureUser, freshUser, loadCU, mint, rand } from './fixtures';

// 第三轮审查（R-44 ~ R-46）的回归测试
afterAll(closeDb);
const ip = () => `r3-${rand(8)}`;

describe('Round 3 login throttling', () => {
  it('SEC-R3-001 (R-44) logging into your own account does not reset the per-IP failure count', async () => {
    const me = await freshUser('r3ip');
    const IP = ip();
    for (let i = 0; i < 19; i++) await login(`qa.nobody.${rand(8)}`, 'Wrong-Guess-123', { ip: IP, userAgent: 'vitest' });
    expect((await login(me.username, QA_PW, { ip: IP, userAgent: 'vitest' })).ok).toBe(true);
    await login(`qa.nobody.${rand(8)}`, 'Wrong-Guess-123', { ip: IP, userAgent: 'vitest' }); // 第 20 次失败
    // IP 已达上限：就算密码正确也被挡下
    expect((await login(me.username, QA_PW, { ip: IP, userAgent: 'vitest' })).ok).toBe(false);
  }, 120000);

  it('SEC-R3-002 (R-45) parallel change-password guesses cannot exceed the limit', async () => {
    const u = await freshUser('r3pw');
    const cu = await loadCU(u.username);
    const res = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        changeOwnPassword(cu, `guess-${i}-xxxx`, 'Valid-New-Pass-77', { ip: ip(), userAgent: 'vitest' }).then(() => 'OK', (e) => e.message as string),
      ),
    );
    const checked = res.filter((m) => m === 'Please fix the highlighted fields.').length;
    expect(res).not.toContain('OK');
    expect(checked).toBeLessThanOrEqual(5);
  }, 120000);

  it('SEC-R3-003 (R-46) a lock from username failures also blocks login by IC', async () => {
    const ic = `000101130${String(Math.floor(Math.random() * 1000)).padStart(3, '0')}`;
    const u = await freshUser('r3lk', { ic });
    for (let i = 0; i < 5; i++) await login(u.username, 'Wrong-Guess-123', { ip: ip(), userAgent: 'vitest' });
    expect((await login(ic, QA_PW, { ip: ip(), userAgent: 'vitest' })).ok).toBe(false);
  }, 120000);
});

// 到龄升组设定：只有 Captain / Superadmin
describe('Age-up setting', () => {
  const run = async (userId: string | null, fn: () => Promise<{ ok: boolean; code?: string }>) => {
    ctx.token = userId ? await mint(userId) : undefined;
    try {
      const r = await fn();
      return r.ok ? 'OK' : r.code;
    } catch (e: any) { // eslint-disable-line @typescript-eslint/no-explicit-any
      return String(e?.digest ?? '').startsWith('NEXT_REDIRECT') ? 'REDIRECT' : 'THROW';
    } finally {
      ctx.token = undefined;
    }
  };
  const junior = async () => (await db.select({ id: sections.id, age: sections.ageUpAge, rankId: sections.ageUpRankId }).from(sections).where(eq(sections.name, 'Junior')))[0];

  it('SEC-AGE-001 no session, member, officer with many permissions: all refused, nothing changes', async () => {
    const before = await junior();
    const mgr = await ensureUser('mgr');
    const kid = await ensureUser('user1');
    expect(await run(null, () => setAgeUpAction(before.id, { age: 5, rankId: before.rankId }))).toBe('REDIRECT');
    expect(await run(kid.id, () => setAgeUpAction(before.id, { age: 5, rankId: before.rankId }))).toBe('FORBIDDEN');
    expect(await run(mgr.id, () => setAgeUpAction(before.id, { age: 5, rankId: before.rankId }))).toBe('FORBIDDEN');
    expect(await junior()).toEqual(before);
  });

  it('SEC-AGE-002 garbage input from the Captain is refused without a server error', async () => {
    const cap = await loadCU('dev.captain');
    const j = await junior();
    for (const [sid, input] of [
      [j.id, { age: '13; drop table users', rankId: j.rankId }],
      [j.id, { age: 13, rankId: 'abc' }],
      [j.id, { age: -1, rankId: j.rankId }],
      [j.id, { age: 1e9, rankId: 99999 }],
      ['abc', { age: 13, rankId: j.rankId }],
      [-5, { age: 13, rankId: j.rankId }],
    ] as const) {
      expect(['VALIDATION', 'NOT_FOUND']).toContain(await run(cap.id, () => setAgeUpAction(sid as never, input as never)));
    }
    expect(await run(cap.id, () => setAgeUpAction(j.id, null as never))).not.toBe('THROW');
    expect(await junior()).toEqual(j);
  });
});
