/**
 * 名称清理（组别、军阶、Platoon、角色、成员与监护人姓名共用）：
 * - NFC 正规化，同一个字的不同写法当成同一个名称
 * - 去掉看不见的格式字元（零宽字元、文字方向控制）
 * - 空白合并成一个空格
 * - 不接受控制字元、只有符号、太多叠加记号，以及拉丁字母混用西里尔 / 希腊字母（防假冒，例如用俄文 а 拼 Captain）
 */
export function cleanName(raw: unknown): { name: string } | { error: string } {
  if (typeof raw !== 'string') return { error: 'empty' };
  const name = raw.normalize('NFC').replace(/\p{Cf}/gu, '').replace(/\s+/gu, ' ').trim();
  if (!name) return { error: 'empty' };
  if (/\p{Cc}/u.test(name) || /\p{M}{4,}/u.test(name)) return { error: 'Remove invalid characters.' };
  if (!/[\p{L}\p{N}]/u.test(name)) return { error: 'Use at least one letter or number.' };
  if (/\p{Script=Latin}/u.test(name) && /[\p{Script=Cyrillic}\p{Script=Greek}]/u.test(name)) {
    return { error: 'Do not mix letters from different alphabets.' };
  }
  return { name };
}
