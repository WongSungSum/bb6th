// 只给自动测试用的 4 个账号（dev.captain / dev.officer / dev.viewer / dev.boy）。
// 正常安装不要跑；只在「测试专用资料库」跑：npm run test:accounts（见 docs/SETUP.md 第 7 步）。
// 所有测试账号密码统一为 DEV_PASSWORD，不需要首次改密码。
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

export const DEV_PASSWORD = 'DevOnly-Pass-2026';

async function main() {
  // 必须明确开启，并且只能对本机数据库执行
  if (process.env.ALLOW_DEV_SEED !== '1' && !process.argv.includes('--allow-dev-seed')) throw new Error('Pass --allow-dev-seed to create dev accounts');
  if (process.env.NODE_ENV === 'production') throw new Error('Refusing to seed dev accounts in production');
  const url = new URL(process.env.DATABASE_URL ?? '');
  if (!['localhost', '127.0.0.1', '::1'].includes(url.hostname)) throw new Error('Dev accounts can only be seeded into a local database');
  // 只能放进测试专用资料库（名字要有 test），不会混进平常开发用的资料库
  if (!/test/i.test(url.pathname)) throw new Error('Test accounts can only be seeded into a database whose name contains "test" (e.g. bb6thsibu_test)');
  const { randomUUID } = await import('node:crypto');
  const { drizzle } = await import('drizzle-orm/node-postgres');
  const { and, eq } = await import('drizzle-orm');
  const { Pool } = await import('pg');
  const s = await import('../lib/db/schema');
  const { hashPassword } = await import('../lib/server/auth/password');
  const { encryptIdNumber, hmac } = await import('../lib/server/auth/crypto');
  const { allowCaptainChange } = await import('../lib/server/captain');

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  try {
    const hash = await hashPassword(DEV_PASSWORD);
    const rank = async (section: string, name: string) => {
      const [r] = await db
        .select({ id: s.ranks.id, sectionId: s.ranks.sectionId })
        .from(s.ranks)
        .innerJoin(s.sections, eq(s.sections.id, s.ranks.sectionId))
        .where(and(eq(s.sections.name, section), eq(s.ranks.name, name)));
      return r;
    };
    const accounts = [
      { username: 'dev.captain', fullName: 'Dev Captain', section: 'Officer', rank: 'Captain', ic: '800101135001' },
      { username: 'dev.officer', fullName: 'Dev Officer (Member Admin)', section: 'Officer', rank: 'Lieutenant', ic: '850202135003' },
      { username: 'dev.viewer', fullName: 'Dev Viewer (view only)', section: 'Officer', rank: 'Helper', ic: null },
      { username: 'dev.boy', fullName: 'Dev Boy', section: 'Junior', rank: 'Member', ic: '150303135005' },
    ];
    for (const a of accounts) {
      const [exists] = await db.select({ id: s.users.id }).from(s.users).where(eq(s.users.username, a.username));
      if (exists) continue;
      const r = await rank(a.section, a.rank);
      const id = randomUUID();
      await db.transaction(async (tx) => {
        if (a.rank === 'Captain') await allowCaptainChange(tx);
        await tx.insert(s.users).values({
          id, username: a.username, email: `${a.username}@example.test`, fullName: a.fullName,
          passwordHash: hash, sectionId: r.sectionId, rankId: r.id, gender: 'male',
          dateOfBirth: '2000-01-01', joinDate: '2020-01-01',
          idType: a.ic ? 'mykad' : 'none',
          idNumberEnc: a.ic ? encryptIdNumber(a.ic, id) : null,
          idNumberHash: a.ic ? hmac(`mykad:${a.ic}`) : null,
        });
      });
      console.log(`✅ ${a.username}`);
    }

    // 角色：Member Admin（查看/新增/编辑）给 dev.officer；Member Viewer（只看）给 dev.viewer
    const roles: [string, string[], string][] = [
      ['Member Admin', ['users.view', 'users.create', 'users.update'], 'dev.officer'],
      ['Member Viewer', ['users.view'], 'dev.viewer'],
    ];
    for (const [name, perms, holder] of roles) {
      await db.insert(s.roles).values({ name, description: 'Dev test role' }).onConflictDoNothing();
      const [role] = await db.select().from(s.roles).where(eq(s.roles.name, name));
      for (const p of perms) await db.insert(s.rolePermissions).values({ roleId: role.id, permissionSlug: p }).onConflictDoNothing();
      const [u] = await db.select({ id: s.users.id }).from(s.users).where(eq(s.users.username, holder));
      await db.insert(s.userRoles).values({ userId: u.id, roleId: role.id }).onConflictDoNothing();
    }
    console.log(`✅ Dev roles. Password for all dev accounts: ${DEV_PASSWORD}`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('Dev seed failed:', err instanceof Error ? err.message : err);
  process.exit(1);
});
