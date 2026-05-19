import { defineConfig } from 'drizzle-kit'
import * as dotenv from 'dotenv'

dotenv.config({ path: '.env.local' })

export default defineConfig({
  schema: './lib/schema.ts',
  out: './drizzle',
  dialect: 'postgresql', // CockroachDB 依然使用 postgresql 选项
  dbCredentials: {
    url: process.env.DATABASE_URL!,
  },
})