import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from 'node:crypto';
import { env } from '@/lib/server/env';

const encKey = Buffer.from(env.IC_ENC_KEY, 'base64');
const hmacKey = Buffer.from(env.IC_HMAC_KEY, 'base64');

export type IdType = 'mykad' | 'passport' | 'other' | 'none';

/** 证件号标准化：MyKad 只保留数字；其他证件去空格、转大写 */
export function normalizeIdNumber(idType: IdType, raw: string): string {
  if (idType === 'mykad') return raw.replace(/[\s-]/g, '');
  return raw.replace(/[\s-]/g, '').toUpperCase(); // 和表单验证一致：QB-1234567 = QB1234567
}

/** 登录或搜索时：输入去掉 - 和空格后正好 12 位数字，就当作 IC */
export function looksLikeIc(input: string): string | null {
  const digits = input.replace(/[\s-]/g, '');
  return /^\d{12}$/.test(digits) ? digits : null;
}

/** HMAC-SHA256，用于证件号查找/唯一性，以及登录尝试记录 */
export function hmac(value: string): string {
  return createHmac('sha256', hmacKey).update(value).digest('base64url');
}

/** AES-256-GCM 加密，AAD = 用户 id，防止密文在不同行之间互换。格式 v1:iv:ct:tag */
export function encryptIdNumber(plain: string, userId: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encKey, iv);
  cipher.setAAD(Buffer.from(userId));
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), ct.toString('base64url'), cipher.getAuthTag().toString('base64url')].join(':');
}

export function decryptIdNumber(stored: string, userId: string): string {
  const [version, iv, ct, tag] = stored.split(':');
  if (version !== 'v1') throw new Error('Unknown ciphertext version');
  const decipher = createDecipheriv('aes-256-gcm', encKey, Buffer.from(iv, 'base64url'));
  decipher.setAAD(Buffer.from(userId));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/** 只显示最后 4 位 */
export function maskIdNumber(plain: string): string {
  const last = plain.slice(-4);
  return plain.length === 12 ? `******-**-${last}` : `${'*'.repeat(Math.max(plain.length - 4, 4))}${last}`;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('base64url');
}

export function randomToken(): string {
  return randomBytes(32).toString('base64url');
}
