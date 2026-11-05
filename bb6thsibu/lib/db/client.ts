import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

// 开发模式热重载时复用同一个连接池，避免连接数不断增加
const globalForDb = globalThis as unknown as { pgPool?: Pool };

const pool =
  globalForDb.pgPool ??
  new Pool({
    connectionString: process.env.DATABASE_URL,
    // DATABASE_SSL=require 时启用 SSL 并验证证书；本地数据库不需要
    ssl: process.env.DATABASE_SSL === 'require' ? { rejectUnauthorized: true } : false,
  });

if (process.env.NODE_ENV !== 'production') globalForDb.pgPool = pool;

export const db = drizzle(pool, { schema });
export type Db = typeof db;
export type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
