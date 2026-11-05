import { z } from 'zod';

// 启动时校验必需的环境变量，缺失或格式不对就直接报错（fail closed）
const key32 = z.string().refine((v) => Buffer.from(v, 'base64').length === 32, 'must be 32 bytes, base64');

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  IC_ENC_KEY: key32,
  IC_HMAC_KEY: key32,
  TRUSTED_PROXY_MODE: z.string().regex(/^(none|vercel|hops:[1-9])$/),
  NODE_ENV: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  throw new Error(
    'Invalid server environment: ' + parsed.error.issues.map((i) => i.path.join('.')).join(', '),
  );
}

export const env = parsed.data;
export const isProd = env.NODE_ENV === 'production';
