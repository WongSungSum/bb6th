import { beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';
import { db } from '@/lib/db/client';
import { auditLogs, guardians, rankHistory, sessions, users } from '@/lib/db/schema';
import { login } from '@/lib/server/auth/login';
import { createSession, type CurrentUser } from '@/lib/server/auth/session';
import { appointFirstCaptain, getCaptain } from '@/lib/server/captain';
import { allowedActions, changeRank, createUser, getUserDetail, listUsers, resetPassword, setStatus, updateUser } from '@/lib/server/users/service';
import { createUserSchema, updateUserSchema } from '@/lib/validation/users';
import { actor, baseInput, err, guardian, isoDate, makeUser, meta, newIc, PW, rankId, reasonId, RUN, uname } from './helpers';

let cap: CurrentUser, officer: CurrentUser, viewer: CurrentUser, boy: CurrentUser;
let jr: { id: number; sectionId: number };

beforeAll(async () => {
  [cap, officer, viewer, boy] = await Promise.all([actor('dev.captain'), actor('dev.officer'), actor('dev.viewer'), actor('dev.boy')]);
  jr = await rankId('Junior', 'Member');
});

const valid = async (over = {}) => ({ ...(await baseInput()), ...over });
const schemaErr = async (over: Record<string, unknown>, schema: typeof createUserSchema = createUserSchema) => {
  const r = schema.safeParse(await valid(over));
  return r.success ? null : r.error.issues.map((i) => i.path.join('.'));
};
const auditFor = (id: string, action?: string) =>
  db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'users'), eq(auditLogs.entityId, id), action ? eq(auditLogs.action, action) : undefined)).orderBy(desc(auditLogs.createdAt));
const row = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0];

// ───────────────────────── A. validation ─────────────────────────
describe('A validation', () => {
  it('FN-VAL-001 username 2 chars rejected', async () => {
    const e = await err(async () => createUser(cap, await valid({ username: 'ab' }), meta));
    expect(e?.code).toBe('VALIDATION');
    expect(e?.fieldErrors?.username).toBeTruthy();
  });
  it('FN-VAL-002 username 3 and 30 chars accepted', async () => {
    expect(await schemaErr({ username: 'abc' })).toBeNull();
    expect(await schemaErr({ username: 'a'.repeat(30) })).toBeNull();
  });
  it('FN-VAL-003 username 31 chars rejected', async () => {
    expect(await schemaErr({ username: 'a'.repeat(31) })).toContain('username');
  });
  it('FN-VAL-004 username lowercased and trimmed', async () => {
    const u = uname('Upper');
    const { id } = await makeUser(cap, { username: `  ${u.toUpperCase()}  ` });
    expect((await row(id)).username).toBe(u.toLowerCase());
  });
  it('FN-VAL-005 space / unicode / @ rejected', async () => {
    for (const username of ['a b c', '用户名123', 'a@bcd', 'a/bcd', "a'bcd"]) expect(await schemaErr({ username }), username).toContain('username');
  });
  it('FN-VAL-006 12-digit username rejected', async () => {
    expect(await schemaErr({ username: '800101135001' })).toContain('username');
  });
  it('FN-VAL-007 dashed 12-digit username rejected', async () => {
    expect(await schemaErr({ username: '8001-0113-5001' })).toContain('username');
  });
  it('FN-VAL-008 duplicate username case-insensitive', async () => {
    const { input } = await makeUser(cap);
    const e = await err(async () => createUser(cap, { ...(await valid()), username: input.username.toUpperCase() }, meta));
    expect(e?.code).toBe('VALIDATION');
    expect(e?.fieldErrors?.username).toMatch(/already taken/);
  });
  it('FN-VAL-009 email empty / invalid rejected', async () => {
    for (const email of ['', 'a@', 'a b@x.com', 'plain']) expect(await schemaErr({ email }), email).toContain('email');
  });
  it('FN-VAL-010 duplicate email allowed', async () => {
    const a = await makeUser(cap, { email: `dup.${RUN}@example.test` });
    const b = await makeUser(cap, { email: `dup.${RUN}@example.test` });
    expect(a.id).not.toBe(b.id);
  });
  it('FN-VAL-011 MyKad 11/13 digits and letters rejected', async () => {
    for (const idNumber of ['12345678901', '1234567890123', 'abcdefghijkl', '']) {
      expect(await schemaErr({ idType: 'mykad', idNumber }), idNumber).toContain('idNumber');
    }
  });
  it('FN-VAL-012 MyKad with dashes accepted, stored normalised, searchable by digits', async () => {
    const ic = newIc();
    const dashed = `${ic.slice(0, 6)}-${ic.slice(6, 8)}-${ic.slice(8)}`;
    const { id, input } = await makeUser(cap, { idType: 'mykad', idNumber: dashed });
    const d = await getUserDetail(cap, id, meta);
    expect(d.idNumber).toBe(ic);
    const found = await listUsers({ q: ic }, { canSearchIc: true });
    expect(found.rows.map((r) => r.id)).toContain(id);
    expect(input.username).toBeTruthy();
  });
  it('FN-VAL-013 passport/other length rules', async () => {
    expect(await schemaErr({ idType: 'passport', idNumber: 'A12' })).toContain('idNumber');
    expect(await schemaErr({ idType: 'passport', idNumber: 'A123' })).toBeNull();
    expect(await schemaErr({ idType: 'other', idNumber: 'A'.repeat(20) })).toBeNull();
    expect(await schemaErr({ idType: 'other', idNumber: 'A'.repeat(21) })).toContain('idNumber');
    expect(await schemaErr({ idType: 'passport', idNumber: 'A12!45' })).toContain('idNumber');
  });
  it('FN-VAL-014 idType none ignores number, stores null', async () => {
    const { id } = await makeUser(cap, { idType: 'none', idNumber: 'junk' });
    const r = await row(id);
    expect(r.idNumberEnc).toBeNull();
    expect(r.idNumberHash).toBeNull();
  });
  it('FN-VAL-015 duplicate IC rejected', async () => {
    const ic = newIc();
    await makeUser(cap, { idType: 'mykad', idNumber: ic });
    const e = await err(async () => createUser(cap, await valid({ idType: 'mykad', idNumber: ic }), meta));
    expect(e?.fieldErrors?.idNumber).toMatch(/already registered/);
  });
  it('FN-VAL-016 actor without view_sensitive cannot set ID', async () => {
    const e = await err(async () => createUser(officer, await valid({ idType: 'mykad', idNumber: newIc() }), meta));
    expect(e?.code).toBe('VALIDATION');
    expect(e?.fieldErrors?.idNumber).toBeTruthy();
  });
  it('FN-VAL-017 officer creates idType none member', async () => {
    const r = await createUser(officer, await valid(), meta);
    expect(r?.id).toBeTruthy();
  });
  it('FN-VAL-018 future DOB / join date rejected', async () => {
    expect(await schemaErr({ dateOfBirth: isoDate(2) })).toContain('dateOfBirth');
    expect(await schemaErr({ joinDate: isoDate(2) })).toContain('joinDate');
  });
  it('FN-VAL-019 impossible calendar date gives field error not server error', async () => {
    for (const dateOfBirth of ['2020-02-30', '2020-13-01', '2020-00-10']) {
      const e = await err(async () => createUser(cap, await valid({ dateOfBirth }), meta));
      expect(e?.code, `${dateOfBirth}: ${e?.message}`).toBe('VALIDATION');
      expect(e?.fieldErrors?.dateOfBirth, dateOfBirth).toBeTruthy();
    }
  });
  it('FN-VAL-020 empty dates rejected', async () => {
    const errs = await schemaErr({ dateOfBirth: '', joinDate: '' });
    expect(errs).toEqual(expect.arrayContaining(['dateOfBirth', 'joinDate']));
  });
  it('FN-VAL-021 phone rules', async () => {
    expect(await schemaErr({ phone: '1234567' })).toContain('phone');
    expect(await schemaErr({ phone: '12345678' })).toBeNull();
    expect(await schemaErr({ phone: '+60 12-345 6789' })).toBeNull();
    expect(await schemaErr({ phone: '1'.repeat(15) })).toBeNull();
    expect(await schemaErr({ phone: '1'.repeat(16) })).toContain('phone');
    expect(await schemaErr({ phone: 'abcdefghij' })).toContain('phone');
    expect(await schemaErr({ phone: '' })).toBeNull();
  });
  it('FN-VAL-022 full name rules', async () => {
    expect(await schemaErr({ fullName: '' })).toContain('fullName');
    expect(await schemaErr({ fullName: '   ' })).toContain('fullName');
    expect(await schemaErr({ fullName: 'a'.repeat(100) })).toBeNull();
    expect(await schemaErr({ fullName: 'a'.repeat(101) })).toContain('fullName');
    expect(await schemaErr({ fullName: '陈大文' })).toBeNull();
  });
  it('FN-VAL-023 address/school length', async () => {
    expect(await schemaErr({ address: 'a'.repeat(300), school: 'b'.repeat(100) })).toBeNull();
    expect(await schemaErr({ address: 'a'.repeat(301) })).toContain('address');
    expect(await schemaErr({ school: 'b'.repeat(101) })).toContain('school');
  });
  it('FN-VAL-024 temp password rules', async () => {
    for (const tempPassword of ['short', 'password1234', 'x'.repeat(129)]) {
      const e = await err(async () => createUser(cap, await valid({ tempPassword }), meta));
      expect(e?.fieldErrors?.tempPassword, tempPassword).toBeTruthy();
    }
    const username = uname('pw');
    const e = await err(async () => createUser(cap, await valid({ username, tempPassword: username }), meta));
    expect(e?.fieldErrors?.tempPassword).toBeTruthy();
  });
  it('FN-VAL-025 temp password sets hash + must_change; none leaves login disabled', async () => {
    const a = await makeUser(cap, { tempPassword: PW });
    const b = await makeUser(cap);
    const ra = await row(a.id), rb = await row(b.id);
    expect(ra.passwordHash).toBeTruthy();
    expect(ra.mustChangePassword).toBe(true);
    expect(rb.passwordHash).toBeNull();
    expect(rb.mustChangePassword).toBe(false);
  });
  it('FN-VAL-026 invalid gender / missing org rejected', async () => {
    expect(await schemaErr({ gender: 'x' })).toContain('gender');
    expect(await schemaErr({ sectionId: '' as never })).toContain('sectionId');
    expect(await schemaErr({ rankId: 0 })).toContain('rankId');
  });
});

// ───────────────────────── B. org / guardians ─────────────────────────
describe('B section-rank and guardians', () => {
  it('FN-ORG-001 rank of another section rejected', async () => {
    const sgt = await rankId('Senior', 'Sergeant');
    const e = await err(async () => createUser(cap, await valid({ sectionId: jr.sectionId, rankId: sgt.id }), meta));
    expect(e?.fieldErrors?.rankId).toBeTruthy();
  });
  it('FN-ORG-002 Captain rank not assignable on create', async () => {
    const c = await rankId('Officer', 'Captain');
    const e = await err(async () => createUser(cap, await valid({ sectionId: c.sectionId, rankId: c.id }), meta));
    expect(e?.fieldErrors?.rankId).toBeTruthy();
  });
  it('FN-ORG-003 nonexistent ids rejected', async () => {
    const e = await err(async () => createUser(cap, await valid({ rankId: 99999 }), meta));
    expect(e?.code).toBe('VALIDATION');
    const e2 = await err(async () => createUser(cap, await valid({ sectionId: 99999 }), meta));
    expect(e2?.code).toBe('VALIDATION');
  });
  it('FN-ORG-004 valid pairs per section', async () => {
    for (const [s, r] of [['Officer', 'Helper'], ['Senior', 'Recruit'], ['Junior', 'Member'], ['Pre-Junior', 'Member']]) {
      const x = await rankId(s, r);
      const res = await createUser(cap, await valid({ sectionId: x.sectionId, rankId: x.id }), meta);
      expect(res?.id, s).toBeTruthy();
    }
  });
  it('FN-ORG-005 officer: guardians dropped', async () => {
    const o = await rankId('Officer', 'Helper');
    const { id } = await makeUser(cap, { sectionId: o.sectionId, rankId: o.id, guardians: [guardian()] as never });
    expect(await db.select().from(guardians).where(eq(guardians.userId, id))).toHaveLength(0);
  });
  it('FN-ORG-006 guardian count rules', async () => {
    const a = await makeUser(cap);
    expect(await db.select().from(guardians).where(eq(guardians.userId, a.id))).toHaveLength(0);
    const b = await makeUser(cap, { guardians: [guardian(), guardian({ relationship: 'mother' })] as never });
    expect(await db.select().from(guardians).where(eq(guardians.userId, b.id))).toHaveLength(2);
    expect(await schemaErr({ guardians: [guardian(), guardian(), guardian()] })).toContain('guardians');
  });
  it('FN-ORG-007 guardian field rules', async () => {
    expect(await schemaErr({ guardians: [guardian({ name: '' })] })).toContain('guardians.0.name');
    expect(await schemaErr({ guardians: [guardian({ relationship: '' })] })).toContain('guardians.0.relationship');
    expect(await schemaErr({ guardians: [guardian({ phone: '' })] })).toContain('guardians.0.phone');
    expect(await schemaErr({ guardians: [guardian({ email: 'bad' })] })).toContain('guardians.0.email');
    expect(await schemaErr({ guardians: [guardian({ email: '' })] })).toBeNull();
  });
  it('FN-ORG-008 slots 1 and 2', async () => {
    const b = await makeUser(cap, { guardians: [guardian({ name: 'G1' }), guardian({ name: 'G2' })] as never });
    const g = await db.select().from(guardians).where(eq(guardians.userId, b.id)).orderBy(guardians.slot);
    expect(g.map((x) => [x.slot, x.name])).toEqual([[1, 'G1'], [2, 'G2']]);
  });
  it('FN-ORG-009 captain edit replaces guardians; removed content in audit before', async () => {
    const b = await makeUser(cap, { guardians: [guardian({ name: 'Old1' }), guardian({ name: 'Old2' })] as never });
    const upd = { ...b.input, guardians: [guardian({ name: 'New1' })] } as never;
    await updateUser(cap, b.id, upd, meta);
    const g = await db.select().from(guardians).where(eq(guardians.userId, b.id));
    expect(g.map((x) => x.name)).toEqual(['New1']);
    const [a] = await auditFor(b.id, 'USER_UPDATED');
    expect(JSON.stringify(a.before)).toContain('Old2');
  });
  it('FN-ORG-010 officer edit leaves guardians and ID untouched', async () => {
    const ic = newIc();
    const b = await makeUser(cap, { idType: 'mykad', idNumber: ic, guardians: [guardian({ name: 'Keep' })] as never });
    const before = await row(b.id);
    await updateUser(officer, b.id, { ...b.input, fullName: 'QA FN Renamed', idType: undefined, idNumber: undefined, guardians: [] } as never, meta);
    const after = await row(b.id);
    expect(after.fullName).toBe('QA FN Renamed');
    expect(after.idNumberHash).toBe(before.idNumberHash);
    expect(after.idNumberEnc).toBe(before.idNumberEnc);
    expect((await db.select().from(guardians).where(eq(guardians.userId, b.id))).map((x) => x.name)).toEqual(['Keep']);
  });
});

// ───────────────────────── C. IC ─────────────────────────
describe('C IC encryption and masking', () => {
  it('FN-IC-001 stored encrypted', async () => {
    const ic = newIc();
    const { id } = await makeUser(cap, { idType: 'mykad', idNumber: ic });
    const r = await row(id);
    expect(r.idNumberEnc).toBeTruthy();
    expect(r.idNumberEnc).not.toContain(ic);
    expect(JSON.stringify(r)).not.toContain(ic);
    expect(r.idNumberHash).toBeTruthy();
  });
  it('FN-IC-002 officer sees masked', async () => {
    const ic = newIc();
    const { id } = await makeUser(cap, { idType: 'mykad', idNumber: ic });
    const d = await getUserDetail(officer, id, meta);
    expect(d.idNumber).toBe(`******-**-${ic.slice(-4)}`);
    expect(d.idNumberVisible).toBe(false);
    expect(JSON.stringify(d)).not.toContain(ic);
  });
  it('FN-IC-003 captain sees full + VIEW_SENSITIVE audit', async () => {
    const ic = newIc();
    const { id } = await makeUser(cap, { idType: 'mykad', idNumber: ic });
    const d = await getUserDetail(cap, id, meta);
    expect(d.idNumber).toBe(ic);
    expect(await auditFor(id, 'VIEW_SENSITIVE')).toHaveLength(1);
  });
  it('FN-IC-004 officer view writes no VIEW_SENSITIVE', async () => {
    const { id } = await makeUser(cap, { idType: 'mykad', idNumber: newIc() });
    await getUserDetail(officer, id, meta);
    expect(await auditFor(id, 'VIEW_SENSITIVE')).toHaveLength(0);
  });
  it('FN-IC-005 guardian contact masked without view_sensitive', async () => {
    const { id } = await makeUser(cap, { guardians: [guardian({ phone: '0129998888', email: 'secret.g@example.test' })] as never });
    const m = await getUserDetail(officer, id, meta);
    expect(JSON.stringify(m.guardians)).not.toContain('0129998888');
    expect(JSON.stringify(m.guardians)).not.toContain('secret.g');
    const c = await getUserDetail(cap, id, meta);
    expect(c.guardians[0].phone).toBe('0129998888');
  });
  it('FN-IC-006 USER_CREATED audit has masked IC only', async () => {
    const ic = newIc();
    const { id } = await makeUser(cap, { idType: 'mykad', idNumber: ic, tempPassword: PW });
    const [a] = await auditFor(id, 'USER_CREATED');
    const json = JSON.stringify(a);
    expect(json).not.toContain(ic);
    expect(json).not.toContain('argon2');
    expect(json).not.toContain(PW);
    expect(json).toContain(ic.slice(-4));
  });
  it('FN-IC-007 no audit row of the lifecycle leaks IC / hash', async () => {
    const ic = newIc();
    const { id, input } = await makeUser(cap, { idType: 'mykad', idNumber: ic, tempPassword: PW });
    await getUserDetail(cap, id, meta);
    await updateUser(cap, id, { ...input, idType: 'mykad', idNumber: ic, fullName: 'QA FN Leak Check' } as never, meta);
    await resetPassword(cap, id, { reason: 'leak check' }, meta);
    const rows = await db.select().from(auditLogs).where(eq(auditLogs.entityId, id));
    const r = await row(id);
    for (const a of rows) {
      const j = JSON.stringify(a);
      expect(j, a.action).not.toContain(ic);
      expect(j, a.action).not.toContain('argon2');
      expect(j, a.action).not.toContain(r.idNumberHash!);
    }
  });
  it('FN-IC-008 captain changing IC updates enc+hash; audit masked', async () => {
    const { id, input } = await makeUser(cap, { idType: 'mykad', idNumber: newIc() });
    const before = await row(id);
    const ic2 = newIc();
    await updateUser(cap, id, { ...input, idType: 'mykad', idNumber: ic2 } as never, meta);
    const after = await row(id);
    expect(after.idNumberHash).not.toBe(before.idNumberHash);
    expect((await getUserDetail(cap, id, meta)).idNumber).toBe(ic2);
    const [a] = await auditFor(id, 'USER_UPDATED');
    expect(JSON.stringify(a)).not.toContain(ic2);
  });
  it('FN-IC-009 edit to existing IC rejected', async () => {
    const ic = newIc();
    await makeUser(cap, { idType: 'mykad', idNumber: ic });
    const b = await makeUser(cap, { idType: 'mykad', idNumber: newIc() });
    const e = await err(() => updateUser(cap, b.id, { ...b.input, idType: 'mykad', idNumber: ic } as never, meta));
    expect(e?.fieldErrors?.idNumber).toMatch(/already registered/);
  });
  it('FN-IC-010 passport masked to last 4', async () => {
    const { id } = await makeUser(cap, { idType: 'passport', idNumber: `A${RUN}`.toUpperCase() + '1234' });
    const d = await getUserDetail(officer, id, meta);
    expect(d.idNumber).toMatch(/^\*+1234$/);
  });
});

// ───────────────────────── D. edit ─────────────────────────
describe('D edit and target protection', () => {
  it('FN-EDIT-001 happy edit audited', async () => {
    const { id, input } = await makeUser(cap);
    const before = await row(id);
    await new Promise((r) => setTimeout(r, 15));
    await updateUser(cap, id, { ...input, fullName: 'QA FN Edited', phone: '0123456789' } as never, meta);
    const after = await row(id);
    expect(after.fullName).toBe('QA FN Edited');
    expect(after.updatedAt.getTime()).toBeGreaterThan(before.updatedAt.getTime());
    const [a] = await auditFor(id, 'USER_UPDATED');
    expect((a.before as Record<string, unknown>).fullName).toBe(before.fullName);
    expect((a.after as Record<string, unknown>).fullName).toBe('QA FN Edited');
    expect(a.actorId).toBe(cap.id);
  });
  it('FN-EDIT-002 stale expectedUpdatedAt conflicts', async () => {
    const { id, input } = await makeUser(cap);
    const ts = (await row(id)).updatedAt.toISOString();
    await updateUser(cap, id, { ...input, fullName: 'QA FN One', expectedUpdatedAt: ts } as never, meta);
    const e = await err(() => updateUser(cap, id, { ...input, fullName: 'QA FN Two', expectedUpdatedAt: ts } as never, meta));
    expect(e?.code).toBe('CONFLICT');
    expect((await row(id)).fullName).toBe('QA FN One');
  });
  it('FN-EDIT-003 duplicate username on edit', async () => {
    const a = await makeUser(cap);
    const b = await makeUser(cap);
    const e = await err(() => updateUser(cap, b.id, { ...b.input, username: a.input.username.toUpperCase() } as never, meta));
    expect(e?.fieldErrors?.username).toMatch(/already taken/);
  });
  it('FN-EDIT-004 officer cannot edit captain', async () => {
    const d = await getUserDetail(cap, cap.id, meta);
    const e2 = await err(() =>
      updateUser(officer, cap.id, { username: d.username, email: d.email, fullName: d.fullName, gender: d.gender, dateOfBirth: d.dateOfBirth, joinDate: d.joinDate, guardians: [] } as never, meta));
    expect(e2?.code).toBe('FORBIDDEN');
  });
  it('FN-EDIT-005 unknown/invalid ids -> NOT_FOUND', async () => {
    for (const id of ['abc', "' OR 1=1--", '00000000-0000-0000-0000-000000000000', '']) {
      const e = await err(() => getUserDetail(cap, id, meta));
      expect(e?.code, id).toBe('NOT_FOUND');
      const e2 = await err(() => setStatus(cap, id, { status: 'inactive', reasonId: 1 }, meta));
      expect(e2?.code, id).toBe('NOT_FOUND');
    }
  });
  it('FN-EDIT-006 superadmin hidden', async () => {
    const [sa] = await db.select({ id: users.id }).from(users).where(eq(users.accountType, 'superadmin'));
    expect(sa).toBeTruthy();
    expect((await err(() => getUserDetail(cap, sa.id, meta)))?.code).toBe('NOT_FOUND');
    expect((await err(() => setStatus(cap, sa.id, { status: 'inactive', reasonId: 1 }, meta)))?.code).toBe('NOT_FOUND');
    expect((await err(() => resetPassword(cap, sa.id, { reason: 'x' }, meta)))?.code).toBe('NOT_FOUND');
    expect((await err(() => changeRank(cap, sa.id, { sectionId: jr.sectionId, rankId: jr.id, reason: 'x' }, meta)))?.code).toBe('NOT_FOUND');
  });
  it('FN-EDIT-007 edit cannot change rank/section', async () => {
    const { id, input } = await makeUser(cap);
    const sgt = await rankId('Senior', 'Sergeant');
    await updateUser(cap, id, { ...input, rankId: sgt.id, sectionId: sgt.sectionId, status: 'inactive' } as never, meta);
    const r = await row(id);
    expect(r.rankId).toBe(jr.id);
    expect(r.status).toBe('active');
  });
  it('FN-EDIT-008 concurrent double submit: one wins', async () => {
    const { id, input } = await makeUser(cap);
    const ts = (await row(id)).updatedAt.toISOString();
    const results = await Promise.all([
      err(() => updateUser(cap, id, { ...input, fullName: 'QA FN A', expectedUpdatedAt: ts } as never, meta)),
      err(() => updateUser(cap, id, { ...input, fullName: 'QA FN B', expectedUpdatedAt: ts } as never, meta)),
    ]);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(results.find((r) => r)?.code).toBe('CONFLICT');
  });
  it('FN-EDIT-009 viewer cannot edit member with more permissions', async () => {
    const o = await getUserDetail(cap, officer.id, meta);
    const e = await err(() =>
      updateUser(viewer, officer.id, { username: o.username, email: o.email, fullName: o.fullName, gender: o.gender, dateOfBirth: o.dateOfBirth, joinDate: o.joinDate, guardians: [] } as never, meta));
    expect(e?.code).toBe('FORBIDDEN');
  });
});

// ───────────────────────── E. status ─────────────────────────
describe('E status', () => {
  it('FN-STAT-001 reason required', async () => {
    const { id } = await makeUser(cap);
    const e = await err(() => setStatus(cap, id, { status: 'inactive' }, meta));
    expect(e?.fieldErrors?.reasonId).toBeTruthy();
  });
  it('FN-STAT-002 invalid reason id', async () => {
    const { id } = await makeUser(cap);
    expect((await err(() => setStatus(cap, id, { status: 'inactive', reasonId: 99999 }, meta)))?.code).toBe('VALIDATION');
  });
  it('FN-STAT-003 Other needs note', async () => {
    const { id } = await makeUser(cap);
    const other = await reasonId('Other');
    expect((await err(() => setStatus(cap, id, { status: 'inactive', reasonId: other }, meta)))?.fieldErrors?.note).toBeTruthy();
    expect((await err(() => setStatus(cap, id, { status: 'inactive', reasonId: other, note: '   ' }, meta)))?.fieldErrors?.note).toBeTruthy();
    expect(await err(() => setStatus(cap, id, { status: 'inactive', reasonId: other, note: 'moved abroad' }, meta))).toBeNull();
    expect((await row(id)).inactiveNote).toBe('moved abroad');
  });
  it('FN-STAT-004 deactivate revokes sessions + audit reason', async () => {
    const { id } = await makeUser(cap, { tempPassword: PW });
    await db.transaction((tx) => createSession(tx, id, meta));
    const left = await reasonId('Left company');
    await setStatus(cap, id, { status: 'inactive', reasonId: left }, meta);
    const r = await row(id);
    expect(r.status).toBe('inactive');
    expect(r.inactiveReasonId).toBe(left);
    const active = await db.select().from(sessions).where(and(eq(sessions.userId, id), sql`${sessions.revokedAt} IS NULL`));
    expect(active).toHaveLength(0);
    const [a] = await auditFor(id, 'USER_DEACTIVATED');
    expect(a.reason).toMatch(/Left company/);
  });
  it('FN-STAT-005 deactivated user cannot log in', async () => {
    const { id, input } = await makeUser(cap, { tempPassword: PW });
    expect((await login(input.username, PW, { ...meta, ip: `qa-${RUN}-a` })).ok).toBe(true);
    await setStatus(cap, id, { status: 'inactive', reasonId: await reasonId('Left company') }, meta);
    expect((await login(input.username, PW, { ...meta, ip: `qa-${RUN}-b` })).ok).toBe(false);
  });
  it('FN-STAT-006 captain cannot be deactivated', async () => {
    const left = await reasonId('Left company');
    expect((await err(() => setStatus(officer, cap.id, { status: 'inactive', reasonId: left }, meta)))?.code).toBe('FORBIDDEN');
    expect((await err(() => setStatus(cap, cap.id, { status: 'inactive', reasonId: left }, meta)))?.code).toBe('FORBIDDEN');
    expect((await row(cap.id)).status).toBe('active');
  });
  it('FN-STAT-007 self deactivate rejected', async () => {
    const left = await reasonId('Left company');
    expect((await err(() => setStatus(officer, officer.id, { status: 'inactive', reasonId: left }, meta)))?.code).toBe('FORBIDDEN');
    expect((await row(officer.id)).status).toBe('active');
  });
  it('FN-STAT-008 reactivate clears reason', async () => {
    const { id } = await makeUser(cap);
    await setStatus(cap, id, { status: 'inactive', reasonId: await reasonId('Transferred') }, meta);
    await setStatus(cap, id, { status: 'active', reason: 'came back' }, meta);
    const r = await row(id);
    expect(r.status).toBe('active');
    expect(r.inactiveReasonId).toBeNull();
    expect(r.inactiveNote).toBeNull();
    const [a] = await auditFor(id, 'USER_REACTIVATED');
    expect(a.reason).toBe('came back');
  });
  it('FN-STAT-009 reactivate active -> CONFLICT, no audit', async () => {
    const { id } = await makeUser(cap);
    expect((await err(() => setStatus(cap, id, { status: 'active' }, meta)))?.code).toBe('CONFLICT');
    expect(await auditFor(id, 'USER_REACTIVATED')).toHaveLength(0);
  });
  it('FN-STAT-010 600-char note no crash', async () => {
    const { id } = await makeUser(cap);
    const other = await reasonId('Other');
    const e = await err(() => setStatus(cap, id, { status: 'inactive', reasonId: other, note: 'n'.repeat(600) }, meta));
    expect(e === null || e.code === 'VALIDATION').toBe(true);
  });
});

// ───────────────────────── F. rank ─────────────────────────
describe('F rank change', () => {
  it('FN-RANK-001 reason rules', async () => {
    const { id } = await makeUser(cap);
    const sr = await rankId('Junior', 'Leading Boy');
    for (const reason of ['', '   ', 'x'.repeat(501)]) {
      expect((await err(() => changeRank(cap, id, { sectionId: sr.sectionId, rankId: sr.id, reason }, meta)))?.fieldErrors?.reason, reason.length + '').toBeTruthy();
    }
  });
  it('FN-RANK-002 same rank rejected', async () => {
    const { id } = await makeUser(cap);
    expect((await err(() => changeRank(cap, id, { sectionId: jr.sectionId, rankId: jr.id, reason: 'same' }, meta)))?.fieldErrors?.rankId).toBeTruthy();
  });
  it('FN-RANK-003 happy path rows', async () => {
    const { id } = await makeUser(cap);
    const to = await rankId('Junior', 'Leading Boy');
    await changeRank(cap, id, { sectionId: to.sectionId, rankId: to.id, reason: 'Promoted for QA' }, meta);
    expect((await row(id)).rankId).toBe(to.id);
    const h = await db.select().from(rankHistory).where(eq(rankHistory.userId, id)).orderBy(desc(rankHistory.changedAt));
    expect(h).toHaveLength(2);
    expect(h[0]).toMatchObject({ fromRankId: jr.id, toRankId: to.id, reason: 'Promoted for QA', changedBy: cap.id });
    const [a] = await auditFor(id, 'RANK_CHANGED');
    expect(a.changeSetId).toBe(h[0].changeSetId);
    expect(a.reason).toBe('Promoted for QA');
    expect((a.before as Record<string, unknown>).rankId).toBe(jr.id);
    expect((a.after as Record<string, unknown>).rankId).toBe(to.id);
  });
  it('FN-RANK-004 cross-section change', async () => {
    const { id } = await makeUser(cap);
    const to = await rankId('Senior', 'Recruit');
    await changeRank(cap, id, { sectionId: to.sectionId, rankId: to.id, reason: 'Moved up' }, meta);
    expect((await row(id)).sectionId).toBe(to.sectionId);
    const [h] = await db.select().from(rankHistory).where(eq(rankHistory.userId, id)).orderBy(desc(rankHistory.changedAt));
    expect(h.fromSectionId).toBe(jr.sectionId);
    expect(h.toSectionId).toBe(to.sectionId);
  });
  it('FN-RANK-005 rank not in section rejected', async () => {
    const { id } = await makeUser(cap);
    const sgt = await rankId('Senior', 'Sergeant');
    expect((await err(() => changeRank(cap, id, { sectionId: jr.sectionId, rankId: sgt.id, reason: 'x' }, meta)))?.fieldErrors?.rankId).toBeTruthy();
  });
  it('FN-RANK-006 cannot assign Captain rank', async () => {
    const { id } = await makeUser(cap);
    const c = await rankId('Officer', 'Captain');
    const e = await err(() => changeRank(cap, id, { sectionId: c.sectionId, rankId: c.id, reason: 'x' }, meta));
    expect(e?.code).toBe('VALIDATION');
    expect((await row(id)).rankId).toBe(jr.id);
  });
  it('FN-RANK-007 cannot change captain rank', async () => {
    const lt = await rankId('Officer', 'Lieutenant');
    const e = await err(() => changeRank(cap, cap.id, { sectionId: lt.sectionId, rankId: lt.id, reason: 'x' }, meta));
    expect(e?.code).toBe('FORBIDDEN');
    expect((await actor('dev.captain')).isCaptain).toBe(true);
  });
  it('FN-RANK-008 cannot change own rank', async () => {
    const h = await rankId('Officer', 'Helper');
    expect((await err(() => changeRank(officer, officer.id, { sectionId: h.sectionId, rankId: h.id, reason: 'x' }, meta)))?.code).toBe('FORBIDDEN');
  });
  it('FN-RANK-009 non numeric ids', async () => {
    const { id } = await makeUser(cap);
    for (const [s, r] of [[NaN, NaN], [1.5, 2.5], ['a', 'b']] as const) {
      const e = await err(() => changeRank(cap, id, { sectionId: s as never, rankId: r as never, reason: 'x' }, meta));
      expect(e?.code, `${s}/${r}`).toBe('VALIDATION');
    }
  });
  it('FN-RANK-010 failed change leaves no rows', async () => {
    const { id } = await makeUser(cap);
    const sgt = await rankId('Senior', 'Sergeant');
    await err(() => changeRank(cap, id, { sectionId: jr.sectionId, rankId: sgt.id, reason: 'bad' }, meta));
    expect(await db.select().from(rankHistory).where(eq(rankHistory.userId, id))).toHaveLength(1);
    expect(await auditFor(id, 'RANK_CHANGED')).toHaveLength(0);
  });
  it('FN-RANK-011 initial rank history + audit share change set', async () => {
    const { id } = await makeUser(cap);
    const [h] = await db.select().from(rankHistory).where(eq(rankHistory.userId, id));
    const [a] = await auditFor(id, 'USER_CREATED');
    expect(h.reason).toBe('Initial rank');
    expect(h.fromRankId).toBeNull();
    expect(h.changeSetId).toBe(a.changeSetId);
  });
});

// ───────────────────────── G. password reset ─────────────────────────
describe('G reset password', () => {
  it('FN-PWD-001 reason required', async () => {
    const { id } = await makeUser(cap);
    expect((await err(() => resetPassword(cap, id, { reason: '' }, meta)))?.fieldErrors?.reason).toBeTruthy();
    expect((await err(() => resetPassword(cap, id, { reason: '  ' }, meta)))?.fieldErrors?.reason).toBeTruthy();
  });
  it('FN-PWD-002 generated pw works, must_change true', async () => {
    const { id, input } = await makeUser(cap);
    const { tempPassword } = await resetPassword(cap, id, { reason: 'forgot' }, meta);
    expect(tempPassword.length).toBeGreaterThanOrEqual(10);
    expect((await row(id)).mustChangePassword).toBe(true);
    const r = await login(input.username, tempPassword, { ...meta, ip: `qa-${RUN}-c` });
    expect(r.ok && r.mustChangePassword).toBe(true);
  });
  it('FN-PWD-003 weak supplied password rejected', async () => {
    const { id, input } = await makeUser(cap);
    expect((await err(() => resetPassword(cap, id, { password: 'short', reason: 'x' }, meta)))?.fieldErrors?.password).toBeTruthy();
    expect((await err(() => resetPassword(cap, id, { password: input.username, reason: 'x' }, meta)))?.fieldErrors?.password).toBeTruthy();
  });
  it('FN-PWD-004 revokes sessions, clears lockout', async () => {
    const { id } = await makeUser(cap, { tempPassword: PW });
    await db.transaction((tx) => createSession(tx, id, meta));
    await db.update(users).set({ failedLoginCount: 4, lockedUntil: new Date(Date.now() + 9e5) }).where(eq(users.id, id));
    await resetPassword(cap, id, { reason: 'unlock' }, meta);
    const r = await row(id);
    expect(r.failedLoginCount).toBe(0);
    expect(r.lockedUntil).toBeNull();
    expect(await db.select().from(sessions).where(and(eq(sessions.userId, id), sql`${sessions.revokedAt} IS NULL`))).toHaveLength(0);
  });
  it('FN-PWD-005 audit has no password', async () => {
    const { id } = await makeUser(cap);
    const { tempPassword } = await resetPassword(cap, id, { password: PW, reason: 'because' }, meta);
    const [a] = await auditFor(id, 'PASSWORD_RESET');
    expect(a.reason).toBe('because');
    const j = JSON.stringify(a);
    expect(j).not.toContain(tempPassword);
    expect(j).not.toContain('argon2');
  });
  it('FN-PWD-006 password-less member can sign in after reset', async () => {
    const { id, input } = await makeUser(cap);
    expect((await login(input.username, PW, { ...meta, ip: `qa-${RUN}-d` })).ok).toBe(false);
    await resetPassword(cap, id, { password: PW, reason: 'first password' }, meta);
    expect((await login(input.username, PW, { ...meta, ip: `qa-${RUN}-e` })).ok).toBe(true);
  });
  it('FN-PWD-007 officer cannot reset captain; self reset rejected', async () => {
    expect((await err(() => resetPassword(officer, cap.id, { reason: 'x' }, meta)))?.code).toBe('FORBIDDEN');
    expect((await err(() => resetPassword(cap, cap.id, { reason: 'x' }, meta)))?.code).toBe('FORBIDDEN');
  });
  it('FN-PWD-008 viewer cannot reset member with more perms', async () => {
    expect((await err(() => resetPassword(viewer, officer.id, { reason: 'x' }, meta)))?.code).toBe('FORBIDDEN');
  });
});

// ───────────────────────── H. list ─────────────────────────
describe('H list / search / filter / paging', () => {
  it('FN-LIST-001 default active only, no superadmin', async () => {
    const r = await listUsers({});
    expect(r.rows.every((x) => x.status === 'active')).toBe(true);
    const all = await listUsers({ status: 'all', page: 1 });
    const [sa] = await db.select({ id: users.id }).from(users).where(eq(users.accountType, 'superadmin'));
    expect(all.rows.map((x) => x.id)).not.toContain(sa.id);
  });
  it('FN-LIST-002 name search case-insensitive partial', async () => {
    const { id } = await makeUser(cap, { fullName: `QA FN Zyxw${RUN}` });
    const r = await listUsers({ q: `ZYXW${RUN}`.toUpperCase() });
    expect(r.rows.map((x) => x.id)).toContain(id);
  });
  it('FN-LIST-003 username search', async () => {
    const { id, input } = await makeUser(cap);
    expect((await listUsers({ q: input.username.slice(3).toUpperCase() })).rows.map((x) => x.id)).toContain(id);
  });
  it('FN-LIST-004 IC search exact only', async () => {
    const ic = newIc();
    const { id } = await makeUser(cap, { idType: 'mykad', idNumber: ic });
    expect((await listUsers({ q: `${ic.slice(0, 6)}-${ic.slice(6, 8)}-${ic.slice(8)}` }, { canSearchIc: true })).rows.map((x) => x.id)).toContain(id);
    expect((await listUsers({ q: ic.slice(0, 11) })).rows.map((x) => x.id)).not.toContain(id);
    expect((await listUsers({ q: ic.slice(0, 11) })).total).toBe(0);
  });
  it('FN-LIST-005 wildcards literal', async () => {
    const pct = await makeUser(cap, { fullName: `QA FN 100%${RUN}` });
    const und = await makeUser(cap, { fullName: `QA FN a_b${RUN}` });
    const p = await listUsers({ q: '%' });
    expect(p.rows.every((r) => (r.fullName + r.username).includes('%'))).toBe(true);
    // 测试资料越来越多，用本次 RUN 缩小范围再确认（% 仍要照字面比对）
    expect((await listUsers({ q: `0%${RUN}` })).rows.map((r) => r.id)).toContain(pct.id);
    const u = await listUsers({ q: '_' });
    expect(u.rows.every((r) => (r.fullName + r.username).includes('_'))).toBe(true);
    expect((await listUsers({ q: `a_b${RUN}` })).rows.map((r) => r.id)).toContain(und.id);
  });
  it('FN-LIST-006 section / rank filter', async () => {
    const { id } = await makeUser(cap, { fullName: `QA FN U6 ${RUN}` });
    const bySec = await listUsers({ section: jr.sectionId, q: `QA FN U6 ${RUN}` });
    expect(bySec.rows.every((r) => r.sectionId === jr.sectionId)).toBe(true);
    expect(bySec.rows.map((r) => r.id)).toContain(id);
    const byRank = await listUsers({ rank: jr.id, q: `QA FN U6 ${RUN}` });
    expect(byRank.rows.every((r) => r.rankId === jr.id)).toBe(true);
    const other = await rankId('Senior', 'Recruit');
    expect((await listUsers({ section: other.sectionId, rank: jr.id })).total).toBe(0);
  });
  it('FN-LIST-007 status filter', async () => {
    const { id } = await makeUser(cap, { fullName: `QA FN U7 ${RUN}` });
    await setStatus(cap, id, { status: 'inactive', reasonId: await reasonId('Left company') }, meta);
    const q = `QA FN U7 ${RUN}`;
    expect((await listUsers({ q, status: 'active' })).rows.map((r) => r.id)).not.toContain(id);
    expect((await listUsers({ q, status: 'inactive' })).rows.map((r) => r.id)).toContain(id);
    expect((await listUsers({ q, status: 'all' })).rows.map((r) => r.id)).toContain(id);
  });
  it('FN-LIST-008 paging', async () => {
    const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(users).where(like(users.username, 'qa.fn.pg.%'));
    for (let i = n; i < 21; i++) {
      await createUser(cap, await baseInput({ username: `qa.fn.pg.${String(i).padStart(2, '0')}`, fullName: `QA FN Pg ${String(i).padStart(2, '0')}` }), meta);
    }
    const p1 = await listUsers({ q: 'QA FN Pg', page: 1 });
    const p2 = await listUsers({ q: 'QA FN Pg', page: 2 });
    expect(p1.pageSize).toBe(20);
    expect(p1.rows).toHaveLength(20);
    expect(p1.total).toBeGreaterThanOrEqual(21);
    expect(p2.rows.length).toBe(p1.total - 20);
    const ids1 = new Set(p1.rows.map((r) => r.id));
    expect(p2.rows.some((r) => ids1.has(r.id))).toBe(false);
    const names = p1.rows.map((r) => r.fullName);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b, 'en')));
  });
  it('FN-LIST-009 odd page values', async () => {
    for (const page of [0, -3, NaN, 99999, 1.5]) {
      const r = await listUsers({ page });
      expect(Number.isInteger(r.page) && r.page >= 1, `page=${page} -> ${r.page}`).toBe(true);
    }
    const far = await listUsers({ page: 5000 });
    expect(far.rows).toHaveLength(0);
    expect(far.total).toBeGreaterThan(0);
  });
  it('FN-LIST-010 hostile search strings', async () => {
    for (const q of ['x'.repeat(500), "'; DROP TABLE users;--", '😀', '\\', '%_\\%']) {
      expect(await err(() => listUsers({ q })), q.slice(0, 10)).toBeNull();
    }
  });
  it('FN-LIST-011 no sensitive fields in rows', async () => {
    const r = await listUsers({});
    const keys = Object.keys(r.rows[0]).join(',');
    expect(keys).not.toMatch(/idNumber|passwordHash|enc|email/i);
  });
});

// ───────────────────────── I. authz ─────────────────────────
describe('I authorization helpers', () => {
  it('FN-AUTHZ-001 officer on member: edit only', async () => {
    const { id } = await makeUser(cap);
    expect(await allowedActions(officer, { id, isCaptain: false, status: 'active' })).toEqual({ edit: true, access: false, status: false, resetPassword: false });
  });
  it('FN-AUTHZ-002 captain actions', async () => {
    const { id } = await makeUser(cap);
    expect(await allowedActions(cap, { id, isCaptain: false, status: 'active' })).toEqual({ edit: true, access: true, status: true, resetPassword: true });
    const self = await allowedActions(cap, { id: cap.id, isCaptain: true, status: 'active' });
    expect(self.access).toBe(false);
    expect(self.status).toBe(false);
  });
  it('FN-AUTHZ-003 viewer/boy none', async () => {
    const { id } = await makeUser(cap);
    const none = { edit: false, access: false, status: false, resetPassword: false };
    expect(await allowedActions(viewer, { id, isCaptain: false, status: 'active' })).toEqual(none);
    expect(await allowedActions(boy, { id, isCaptain: false, status: 'active' })).toEqual(none);
  });
  it('FN-AUTHZ-004 appointFirstCaptain forbidden for non-superadmin', async () => {
    const { id } = await makeUser(cap);
    expect((await err(() => appointFirstCaptain(officer, id, meta)))?.code).toBe('FORBIDDEN');
    expect((await err(() => appointFirstCaptain(cap, id, meta)))?.code).toBe('FORBIDDEN');
  });
  it('FN-AUTHZ-005 exactly one active captain', async () => {
    const c = await getCaptain();
    expect(c?.id).toBe(cap.id);
    expect((await row(cap.id)).status).toBe('active');
    const n = await db.execute(sql`select count(*)::int as n from users u join ranks r on r.id=u.rank_id where r.system_key='captain'`);
    expect((n.rows[0] as { n: number }).n).toBe(1);
  });
});

void inArray; void updateUserSchema;
