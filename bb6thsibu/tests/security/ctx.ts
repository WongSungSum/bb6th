// Mutable request context used by the mocked next/headers and request modules.
export const ctx: {
  token: string | undefined; headers: Record<string, string>;
  cookiesSet: { name: string; value?: string; opts?: Record<string, unknown>; deleted?: boolean }[]; ip: string;
} = ((globalThis as any).__qaCtx ??= {
  token: undefined as string | undefined,
  headers: {} as Record<string, string>,
  cookiesSet: [] as { name: string; value?: string; opts?: Record<string, unknown>; deleted?: boolean }[],
  ip: 'qa-default' as string,
});

export function resetCtx() {
  ctx.token = undefined;
  ctx.headers = {};
  ctx.cookiesSet = [];
  ctx.ip = 'qa-' + Math.random().toString(36).slice(2, 10);
}

export const headersMock = {
  cookies: async () => ({
    get: (name: string) => (name === 'bb6_session' && ctx.token ? { name, value: ctx.token } : undefined),
    set: (name: string, value: string, opts?: Record<string, unknown>) => {
      ctx.cookiesSet.push({ name, value, opts });
    },
    delete: (name: string) => {
      ctx.cookiesSet.push({ name, deleted: true });
    },
  }),
  headers: async () => ({ get: (k: string) => ctx.headers[k.toLowerCase()] ?? null }),
};

export const requestMock = {
  getRequestMeta: async () => ({ ip: ctx.ip, userAgent: 'vitest' }),
};
