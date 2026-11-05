import { z } from 'zod';
import { cleanName } from './text';

/** 密码最少字数（前后端共用） */
export const PASSWORD_MIN = 8;

// 前后端共用的表单校验（这个文件不能引用任何服务器代码）

// 以马来西亚时间（UTC+8）计算「今天」
const today = () => new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
const isRealDate = (v: string) => {
  const d = new Date(v + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v && v >= '1900-01-01';
};
/** Postgres 不接受文字里的 \0 */
const noNul = (v: string) => !v.includes('\0');
/** 姓名：用 cleanName 清理（去掉看不见的字元、防假冒字母） */
const personName = (empty: string, max: number) =>
  z.string().max(max * 4).transform((v, ctx) => {
    const r = cleanName(v);
    if ('error' in r) ctx.addIssue({ code: 'custom', message: r.error === 'empty' ? empty : r.error });
    else if (r.name.length > max) ctx.addIssue({ code: 'custom', message: `Use at most ${max} characters.` });
    else return r.name;
    return z.NEVER;
  });
const optionalText = (max: number) =>
  z.string().trim().max(max, `Use at most ${max} characters.`).refine(noNul, 'Remove invalid characters.').transform((v) => v || null).nullable().optional();

export const usernameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(1, 'Enter a username.')
  .regex(/^[a-z0-9._-]{3,30}$/, 'Use 3-30 letters, numbers, dots, dashes or underscores.')
  .refine((v) => !/^\d{12}$/.test(v.replace(/[\s-]/g, '')), 'A username cannot look like an IC number.');

export const emailSchema = z.string().trim().min(1, 'Enter an email.').max(254).email('Enter a valid email address.');

const phoneSchema = z
  .string()
  .trim()
  .refine((v) => v === '' || (/^\+?[\d\s-]+$/.test(v) && v.replace(/\D/g, '').length >= 8 && v.replace(/\D/g, '').length <= 15), 'Enter a valid phone number.')
  .transform((v) => v || null)
  .nullable()
  .optional();

const pastDate = (label: string) =>
  z.string().min(1, `Enter the ${label}.`).regex(/^\d{4}-\d{2}-\d{2}$/, `Enter a valid ${label}.`).refine(isRealDate, `Enter a valid ${label}.`).refine((v) => v <= today(), `${label[0].toUpperCase() + label.slice(1)} cannot be in the future.`);

export const ID_TYPES = ['mykad', 'passport', 'other', 'none'] as const;
export const GENDERS = ['male', 'female'] as const;
export const RELATIONSHIPS = ['father', 'mother', 'guardian', 'other'] as const;

export const guardianSchema = z.object({
  name: personName("Enter the guardian's name.", 100),
  relationship: z.enum(RELATIONSHIPS, { message: 'Select a relationship.' }),
  phone: z.string().trim().min(1, 'Enter a phone number.').refine((v) => /^\+?[\d\s-]+$/.test(v) && v.replace(/\D/g, '').length >= 8 && v.replace(/\D/g, '').length <= 15, 'Enter a valid phone number.'),
  email: z.string().trim().max(254).refine((v) => v === '' || z.string().email().safeParse(v).success, 'Enter a valid email address.').transform((v) => v || null).nullable().optional(),
});

const identity = {
  idType: z.enum(ID_TYPES, { message: 'Select an ID type.' }),
  idNumber: z.string().trim().max(30).optional(),
};

/** 证件号规则：MyKad 12 位数字（可含 -），护照/其他 4-20 位字母数字 */
export function idNumberError(idType: (typeof ID_TYPES)[number], idNumber: string | undefined): string | null {
  if (idType === 'none') return null;
  const v = (idNumber ?? '').replace(/[\s-]/g, '');
  if (idType === 'mykad') return /^\d{12}$/.test(v) ? null : 'MyKad must be 12 digits.';
  return /^[A-Za-z0-9]{4,20}$/.test(v) ? null : 'Enter a valid ID number.';
}

const profile = {
  email: emailSchema,
  fullName: personName('Enter the full name.', 100),
  gender: z.enum(GENDERS, { message: 'Select a gender.' }),
  dateOfBirth: pastDate('date of birth'),
  joinDate: pastDate('join date'),
  phone: phoneSchema,
  address: optionalText(300),
  school: optionalText(100),
  guardians: z.array(guardianSchema).max(2).default([]),
};

/** 选填的数字 id：空字串 / null 视为没有 */
const optionalId = z.preprocess((v) => (v === '' || v === null || v === undefined ? undefined : v), z.coerce.number().int().positive().max(32767).optional());

/** 入队日期不能早于出生日期（两者都是 YYYY-MM-DD 字串，可直接比较） */
function joinAfterBirth(v: { dateOfBirth: string; joinDate: string }, ctx: z.RefinementCtx) {
  if (v.joinDate < v.dateOfBirth) ctx.addIssue({ code: 'custom', path: ['joinDate'], message: 'Join date cannot be before the date of birth.' });
}

export const createUserSchema = z
  .object({
    username: usernameSchema,
    platoonId: optionalId,
    tempPassword: z.string().max(128).optional().transform((v) => v || null),
    sectionId: z.coerce.number({ message: 'Select a section.' }).int().positive('Select a section.'),
    rankId: z.coerce.number({ message: 'Select a rank.' }).int().positive('Select a rank.'),
    ...identity,
    ...profile,
  })
  .superRefine((v, ctx) => {
    const idErr = idNumberError(v.idType, v.idNumber);
    if (idErr) ctx.addIssue({ code: 'custom', path: ['idNumber'], message: idErr });
    if (v.tempPassword && v.tempPassword.length < PASSWORD_MIN) ctx.addIssue({ code: 'custom', path: ['tempPassword'], message: `Use at least ${PASSWORD_MIN} characters.` });
    joinAfterBirth(v, ctx);
  });

export const updateUserSchema = z
  .object({
    username: usernameSchema,
    platoonId: optionalId,
    // 没有 users.view_sensitive 时前端不会送证件栏位
    idType: identity.idType.optional(),
    idNumber: identity.idNumber,
    expectedUpdatedAt: z.string().optional(),
    ...profile,
  })
  .superRefine((v, ctx) => {
    joinAfterBirth(v, ctx);
    if (!v.idType) return;
    const idErr = idNumberError(v.idType, v.idNumber);
    if (idErr) ctx.addIssue({ code: 'custom', path: ['idNumber'], message: idErr });
  });

/** 自己改自己的资料：只有联络资料和监护人 */
export const ownProfileSchema = z.object({
  email: emailSchema,
  phone: phoneSchema,
  address: optionalText(300),
  school: optionalText(100),
  guardians: z.array(guardianSchema).max(2).default([]),
  expectedUpdatedAt: z.string().optional(),
});
export type OwnProfileInput = z.input<typeof ownProfileSchema>;

export const reasonSchema = z.string().trim().min(1, 'Enter a reason.').max(500, 'Use at most 500 characters.').refine(noNul, 'Remove invalid characters.');

export type CreateUserInput = z.input<typeof createUserSchema>;
export type UpdateUserInput = z.input<typeof updateUserSchema>;

/** 把 zod 错误转成 { 栏位: 第一条信息 } */
export function fieldErrorsOf(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.');
    if (!out[key]) out[key] = issue.message;
  }
  return out;
}
