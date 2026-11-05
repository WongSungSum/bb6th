import { describe, expect, it } from 'vitest';

// Needs the dev server on http://localhost:3000 (already running). No session cookie is sent.
const BASE = 'http://localhost:3000';
const get = (path: string) => fetch(BASE + path, { redirect: 'manual' });

describe('J http / public behaviour', () => {
  it('FN-UI-001 /login renders form', async () => {
    const r = await get('/login');
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain('name="identifier"');
    expect(html).toContain('name="password"');
    expect(html).toContain('<title>');
  });
  it('FN-UI-002 protected pages redirect to /login when signed out', async () => {
    for (const p of ['/users', '/users/new', '/users/00000000-0000-0000-0000-000000000000', '/setup', '/change-password', '/settings', '/dashboard']) {
      const r = await get(p);
      expect([302, 303, 307, 308], `${p} -> ${r.status}`).toContain(r.status);
      expect(r.headers.get('location'), p).toContain('/login');
    }
  });
  it('FN-UI-003 odd paths do not 500', async () => {
    for (const p of ['/users/abc', "/users/'%20OR%201=1--", '/users/%00', '/users/abc/edit', '/nope', '/users?page=-1&q=%25']) {
      const r = await get(p);
      expect(r.status, p).toBeLessThan(500);
    }
  });
});
