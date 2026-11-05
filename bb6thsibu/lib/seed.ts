// 初始化基础资料（可重复执行，不会覆盖已有资料）：组别、军阶、停用原因、权限目录、Superadmin 账号
// 用法：npm run db:seed
// Superadmin 密码：读取 SEED_SUPERADMIN_PASSWORD；没有就随机生成并只显示一次。首次登录必须修改。
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/node-postgres';
import { and, eq, notInArray, sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { inactiveReasons, permissions, ranks, sections, users } from './db/schema';
import { PERMISSIONS } from './server/authz/catalog';
import { generateTempPassword, hashPassword } from './server/auth/password';

const ORG: { section: string; systemKey?: string; ranks: { name: string; systemKey?: string }[]; ageUp?: { age: number; section: string; rank: string } }[] = [
  { section: 'Officer', systemKey: 'officer', ranks: [{ name: 'Captain', systemKey: 'captain' }, { name: 'Lieutenant' }, { name: 'Warrant Officer' }, { name: 'Helper' }, { name: 'Staff Sergeant' }] },
  { section: 'Senior', ranks: [{ name: 'Sergeant' }, { name: 'Corporal' }, { name: 'Lance Corporal' }, { name: 'Private' }, { name: 'Recruit' }] },
  { section: 'Junior', ranks: [{ name: 'Chief-Leading Boy' }, { name: 'Leading Boy' }, { name: 'Assisting Leading Boy' }, { name: 'Member' }], ageUp: { age: 13, section: 'Senior', rank: 'Recruit' } },
  { section: 'Pre-Junior', ranks: [{ name: 'Member' }], ageUp: { age: 9, section: 'Junior', rank: 'Member' } },
];

const REASONS = [
  { name: 'Stepped down', requiresNote: false },
  { name: 'Left company', requiresNote: false },
  { name: 'Transferred', requiresNote: false },
  { name: 'Terminated', requiresNote: false },
  { name: 'Other', requiresNote: true },
];

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const db = drizzle(pool);
  try {
    const created: string[] = [];
    for (const [i, org] of ORG.entries()) {
      const ins = await db.insert(sections).values({ name: org.section, systemKey: org.systemKey ?? null, sortOrder: i }).onConflictDoNothing().returning({ id: sections.id });
      if (ins.length) created.push(org.section);
      const [sec] = await db.select().from(sections).where(eq(sections.name, org.section));
      for (const [j, r] of org.ranks.entries()) {
        await db.insert(ranks).values({ sectionId: sec.id, name: r.name, systemKey: r.systemKey ?? null, sortOrder: j }).onConflictDoNothing();
      }
    }
    // 到龄升组的默认值：只在新建的组别（还没设定过）时写入，之后由 Captain 在 Ranks & Sections 页调整
    const fresh = new Set(created);
    for (const org of ORG) {
      if (!org.ageUp || !fresh.has(org.section)) continue;
      const [to] = await db.select({ id: ranks.id }).from(ranks).innerJoin(sections, eq(sections.id, ranks.sectionId)).where(and(eq(sections.name, org.ageUp.section), eq(ranks.name, org.ageUp.rank)));
      if (to) await db.update(sections).set({ ageUpAge: org.ageUp.age, ageUpRankId: to.id }).where(eq(sections.name, org.section));
    }
    console.log('✅ Sections & ranks');

    for (const [i, r] of REASONS.entries()) {
      await db.insert(inactiveReasons).values({ ...r, sortOrder: i }).onConflictDoNothing();
    }
    console.log('✅ Inactive reasons');

    // 权限目录同步：代码里有的就新增/更新，代码里没有的就停用（不删除）
    const slugs = Object.keys(PERMISSIONS);
    for (const [i, [slug, p]] of Object.entries(PERMISSIONS).entries()) {
      await db
        .insert(permissions)
        .values({ slug, module: p.module, description: p.description, sortOrder: i, isActive: true })
        .onConflictDoUpdate({ target: permissions.slug, set: { module: p.module, description: p.description, sortOrder: i, isActive: true } });
    }
    await db.update(permissions).set({ isActive: false }).where(notInArray(permissions.slug, slugs));
    console.log('✅ Permissions synced');

    const [existing] = await db.select({ id: users.id }).from(users).where(eq(users.accountType, 'superadmin'));
    if (existing) {
      console.log('ℹ️  Superadmin already exists, skipped');
    } else {
      const username = (process.env.SEED_SUPERADMIN_USERNAME ?? 'superadmin').toLowerCase();
      const email = process.env.SEED_SUPERADMIN_EMAIL ?? 'admin@bb6thsibu.local';
      const password = process.env.SEED_SUPERADMIN_PASSWORD || generateTempPassword();
      await db.insert(users).values({
        accountType: 'superadmin', username, email, fullName: 'Super Admin',
        passwordHash: await hashPassword(password), mustChangePassword: true,
      });
      console.log(`✅ Superadmin "${username}" created`);
      if (!process.env.SEED_SUPERADMIN_PASSWORD) {
        console.log(`   Temporary password (shown once, change at first login): ${password}`);
      }
    }
    await db.execute(sql`select 1`);
  } finally {
    await pool.end();
  }
}

main()
  .then(() => console.log('\n🎉 Seed complete'))
  .catch((err) => {
    console.error('Seed failed:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
