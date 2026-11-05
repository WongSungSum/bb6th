// lib/migrate.ts
import * as dotenv from 'dotenv';
dotenv.config({ path: '.env.local' });

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';

async function main() {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await migrate(drizzle(pool), { migrationsFolder: './drizzle' });
    console.log('迁移完成！');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('迁移失败：', err);
  process.exit(1);
});
