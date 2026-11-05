import { hash, verify } from '@node-rs/argon2';
import { randomInt } from 'node:crypto';

// argon2id，参数参考 docs/security/threat-model.md 5.3（部署后按服务器实测调整到约 250ms）
const OPTIONS = { algorithm: 2 /* Argon2id */, memoryCost: 65536, timeCost: 3, parallelism: 1 } as const;
const PHC_PARAMS = `m=${OPTIONS.memoryCost},t=${OPTIONS.timeCost},p=${OPTIONS.parallelism}`;

import { PASSWORD_MIN } from '@/lib/validation/users';
export { PASSWORD_MIN };
export const PASSWORD_MAX = 128;

// 限制同时进行的 argon2 运算数量，避免被用来做 DoS
const MAX_CONCURRENT = 4;
const MAX_QUEUE = 64; // 排队太长就直接拒绝，不让请求无限堆积占内存
let running = 0;
const queue: (() => void)[] = [];
async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= MAX_CONCURRENT) {
    if (queue.length >= MAX_QUEUE) throw new Error('Password service busy');
    await new Promise<void>((r) => queue.push(r));
  }
  running++;
  try {
    return await fn();
  } finally {
    running--;
    queue.shift()?.();
  }
}

export function hashPassword(plain: string): Promise<string> {
  return withSlot(() => hash(plain, OPTIONS));
}

// 账号不存在或没有密码时也做一次同参数的验证，让响应时间一致
let dummyHash: Promise<string> | null = null;
function getDummyHash() {
  return (dummyHash ??= hash('dummy-password-for-timing', OPTIONS));
}

/** 返回是否匹配；storedHash 为空时仍消耗同样的时间，并返回 false */
export async function verifyPassword(storedHash: string | null, plain: string): Promise<boolean> {
  const target = storedHash ?? (await getDummyHash());
  const ok = await withSlot(() => verify(target, plain).catch(() => false));
  return storedHash !== null && ok;
}

export function needsRehash(storedHash: string): boolean {
  return !storedHash.startsWith('$argon2id$') || !storedHash.includes(PHC_PARAMS);
}

// 常见密码（小写比对）。另外挡：同一个字重复、键盘 / 数字连续、只有字母或数字的常见词加数字
const COMMON = new Set([
  'password', 'password1', 'password12', 'password123', 'password1234', 'password!', 'password@123', 'passw0rd', 'p@ssw0rd', 'p@ssword',
  '12345678', '123456789', '1234567890', '12345678910', '87654321', '0123456789', '11223344', '12341234', '12121212', '01234567',
  'qwerty12', 'qwerty123', 'qwerty1234', 'qwerty12345', 'qwertyui', 'qwertyuiop', 'asdfghjk', 'asdfghjkl', 'zxcvbnm1', '1qaz2wsx', 'qazwsxedc',
  'abcd1234', 'abc12345', 'abcdefgh', 'abcdefghij', 'abcdefg1', 'a1b2c3d4', 'aa123456',
  'iloveyou', 'iloveyou1', 'iloveyou123', 'sunshine', 'princess', 'football', 'baseball', 'superman', 'whatever', 'trustno1',
  'welcome1', 'welcome123', 'letmein1', 'monkey123', 'dragon123', 'master123', 'admin123', 'administrator', 'changeme', 'secret123',
  'bb6thsibu', 'bb6thsibu123', 'boysbrigade', 'boysbrigade1', 'brigade123', 'sibu1234', 'malaysia', 'malaysia1', 'malaysia123',
]);
const SEQUENCES = ['0123456789', '9876543210', 'abcdefghijklmnopqrstuvwxyz', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm'];
/** 太容易猜：常见密码、同一个字重复、连续的数字 / 字母 / 键盘排列 */
function isWeak(lower: string) {
  if (COMMON.has(lower)) return true;
  if (/^(.)\1+$/.test(lower)) return true;
  if (SEQUENCES.some((seq) => seq.includes(lower))) return true;
  return false;
}
/** 比对用户名 / 证件号时忽略大小写、空格和横线 */
const loose = (v: string) => v.toLowerCase().replace(/[\s-]/g, '');

/** 用户自己设定的密码规则：8-128 字符，不能太容易猜，不能等于用户名/证件号 */
export function checkPasswordPolicy(plain: string, avoid: (string | null | undefined)[] = []): string | null {
  if (plain.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (plain.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (isWeak(plain.toLowerCase())) return 'This password is too common.';
  if (avoid.some((a) => a && loose(plain) === loose(a))) return 'Password must not match your username or ID.';
  return null;
}

/**
 * 新增成员时军官设的临时密码：第一次登录一定要换，所以不检查是否常见。
 * 只挡长度，和「等于用户名 / 证件号」（登录用的就是这两个，别人知道了就能直接登录）。
 */
export function checkTempPasswordPolicy(plain: string, avoid: (string | null | undefined)[] = []): string | null {
  if (plain.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  if (plain.length > PASSWORD_MAX) return `Use at most ${PASSWORD_MAX} characters.`;
  if (avoid.some((a) => a && loose(plain) === loose(a))) return 'Password must not match the username or ID.';
  return null;
}

/** 临时密码：14 位，去掉容易混淆的字符 */
export function generateTempPassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  return Array.from({ length: 14 }, () => chars[randomInt(chars.length)]).join('');
}
