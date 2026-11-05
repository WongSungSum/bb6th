'use client';

import { useMemo, useState, useTransition } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronLeft } from '@fortawesome/free-solid-svg-icons';
import { createUserAction, updateUserAction } from '@/app/actions/users';
import { ErrorBanner, Field, Segmented, Select, SubmitLabel } from '@/app/components/ui';
import { pickGuardians } from '@/app/components/guardian-errors';
import type { OrgOptions } from '@/lib/server/users/service';
import { createUserSchema, fieldErrorsOf, updateUserSchema } from '@/lib/validation/users';

type Guardian = { name: string; relationship: string; phone: string; email: string };
const emptyGuardian: Guardian = { name: '', relationship: '', phone: '', email: '' };

export type UserFormInitial = {
  id?: string;
  username: string; email: string; idType: string; idNumber: string; fullName: string; gender: string;
  dateOfBirth: string; joinDate: string; phone: string; address: string; school: string;
  sectionId: string; rankId: string; platoonId: string; guardians: Guardian[]; updatedAt?: string;
  sectionName?: string | null; rankName?: string | null;
};

const ID_TYPES = [
  { value: 'mykad', label: 'MyKad / MyKid' },
  { value: 'passport', label: 'Passport' },
  { value: 'other', label: 'Other' },
  { value: 'none', label: 'None (stateless)' },
];
const RELATIONSHIPS = [
  { value: 'father', label: 'Father' },
  { value: 'mother', label: 'Mother' },
  { value: 'guardian', label: 'Guardian' },
  { value: 'other', label: 'Other' },
];

/** MyKad 号码（YYMMDD-PB-###G）推出生日期；不是 MyKad 或日期不合理就回 null */
function myKadBirthDate(idType: string, idNumber: string): string | null {
  if (idType !== 'mykad') return null;
  const d = idNumber.replace(/[\s-]/g, '');
  if (!/^\d{12}$/.test(d)) return null;
  const yy = Number(d.slice(0, 2)), mm = Number(d.slice(2, 4)), dd = Number(d.slice(4, 6));
  const nowYY = new Date().getFullYear() % 100;
  const year = (yy <= nowYY ? 2000 : 1900) + yy;
  const date = new Date(Date.UTC(year, mm - 1, dd));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd) return null;
  return date.toISOString().slice(0, 10);
}

export default function UserForm({ mode, org, initial, canEditId, canChangePlatoon = false }: { mode: 'create' | 'edit'; org: OrgOptions; initial: UserFormInitial; canEditId: boolean; canChangePlatoon?: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [v, setV] = useState(initial);
  const [guardians, setGuardians] = useState<Guardian[]>(initial.guardians.length ? initial.guardians : [{ ...emptyGuardian }]);
  const [tempPassword, setTempPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  // 改了哪个格子就清掉那个格子的旧错误
  const clearErr = (k: string) => setErrors((e) => {
    if (!e[k]) return e;
    const n = { ...e };
    delete n[k];
    return n;
  });
  const set = (k: keyof UserFormInitial) => (val: string) => {
    clearErr(k);
    setV((p) => ({ ...p, [k]: val }));
  };
  // MyKad 前 6 位是出生日期：生日还空着就自动填上；填了但对不上就提示
  const setIdNumber = (val: string) => {
    clearErr('idNumber');
    const dob = myKadBirthDate(v.idType, val);
    if (dob && !v.dateOfBirth) clearErr('dateOfBirth');
    setV((p) => ({ ...p, idNumber: val, dateOfBirth: dob && !p.dateOfBirth ? dob : p.dateOfBirth }));
  };
  const icDob = myKadBirthDate(v.idType, v.idNumber);
  const dobHint = icDob && v.dateOfBirth && icDob !== v.dateOfBirth ? `Does not match the IC number (${icDob}).` : undefined;

  const officerSectionId = org.sections.find((s) => s.isOfficer)?.id;
  const isOfficer = String(officerSectionId) === v.sectionId;
  // 组别有 Platoon 时一定要选
  const platoonOptions = org.platoons.filter((p) => String(p.sectionId) === v.sectionId).map((p) => ({ value: String(p.id), label: p.name }));
  const rankOptions = useMemo(
    () => org.ranks.filter((r) => String(r.sectionId) === v.sectionId && !r.isCaptain).map((r) => ({ value: String(r.id), label: r.name })),
    [org.ranks, v.sectionId],
  );

  const setGuardian = (i: number, k: keyof Guardian) => (val: string) =>
    setGuardians((list) => list.map((g, j) => (j === i ? { ...g, [k]: val } : g)));

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    // 只送出有填写的监护人；Officer 不需要监护人
    const { filled, remap } = pickGuardians(isOfficer ? [] : guardians);
    const base = {
      username: v.username, email: v.email, fullName: v.fullName, gender: v.gender,
      dateOfBirth: v.dateOfBirth, joinDate: v.joinDate, phone: v.phone, address: v.address, school: v.school,
      guardians: filled,
      // 编辑时只有军官能换 Platoon；其他人不送，保持原样
      ...(mode === 'create' || canChangePlatoon ? { platoonId: v.platoonId } : {}),
      ...(canEditId ? { idType: v.idType, idNumber: v.idType === 'none' ? '' : v.idNumber } : {}),
    };
    const payload =
      mode === 'create'
        ? { ...base, idType: canEditId ? v.idType : 'none', sectionId: v.sectionId, rankId: v.rankId, tempPassword }
        : { ...base, expectedUpdatedAt: v.updatedAt };
    const check = (mode === 'create' ? createUserSchema : updateUserSchema).safeParse(payload);
    const extra: Record<string, string> = platoonOptions.length && !v.platoonId && (mode === 'create' || canChangePlatoon) ? { platoonId: 'Select a platoon.' } : {};
    if (!check.success || Object.keys(extra).length) {
      setErrors({ ...(check.success ? {} : remap(fieldErrorsOf(check.error))), ...extra });
      setBanner('Please fix the highlighted fields.');
      return;
    }
    setErrors({});
    setBanner(null);
    start(async () => {
      const res = mode === 'create'
        ? await createUserAction(payload as never)
        : await updateUserAction(initial.id!, payload as never);
      if (res.ok) router.push(`/users/${res.data.id}`);
      else {
        setErrors(remap(res.fieldErrors ?? {}));
        setBanner(res.message);
      }
    });
  };

  const back = mode === 'edit' ? `/users/${initial.id}` : '/users';
  const err = (k: string) => errors[k];

  return (
    <form onSubmit={submit} noValidate className="max-w-3xl mx-auto">
      <Link href={back} className="back-link"><FontAwesomeIcon icon={faChevronLeft} /> Back</Link>
      <h1 className="text-xl md:text-2xl font-bold tracking-tight mt-2 mb-6">{mode === 'create' ? 'Add member' : `Edit ${initial.fullName}`}</h1>
      <ErrorBanner message={banner} />

      <section className="card mb-4">
        <h2 className="card-heading">Account</h2>
        <div className="md:grid md:grid-cols-2 gap-x-4">
          <Field label="Username" name="username" value={v.username} onChange={set('username')} error={err('username')} required maxLength={30} autoComplete="off" />
          <Field label="Email" name="email" type="email" value={v.email} onChange={set('email')} error={err('email')} required hint="May be shared with a family member." maxLength={254} />
          {mode === 'create' && (
            <Field
              label="Temporary password"
              name="tempPassword"
              type="password"
              value={tempPassword}
              onChange={setTempPassword}
              error={err('tempPassword')}
              autoComplete="new-password"
              hint="Leave empty to create an account that cannot sign in yet. The member must change it on first login."
            />
          )}
        </div>
      </section>

      <section className="card mb-4">
        <h2 className="card-heading">Identity</h2>
        {canEditId ? (
          <div className="md:grid md:grid-cols-2 gap-x-4">
            <Select label="ID type" name="idType" value={v.idType} onChange={set('idType')} options={ID_TYPES} error={err('idType')} required />
            {v.idType !== 'none' && (
              <Field label="ID number" name="idNumber" value={v.idNumber} onChange={setIdNumber} error={err('idNumber')} required maxLength={30} hint={v.idType === 'mykad' ? '12 digits, dashes allowed.' : undefined} />
            )}
          </div>
        ) : (
          <Field label="ID number" name="idNumber" value={v.idNumber || 'Not recorded'} onChange={() => {}} locked hint="Hidden - you do not have permission to view or change the ID." />
        )}
      </section>

      <section className="card mb-4">
        <h2 className="card-heading">Personal</h2>
        <div className="md:grid md:grid-cols-2 gap-x-4">
          <Field label="Full name" name="fullName" value={v.fullName} onChange={set('fullName')} error={err('fullName')} required maxLength={100} />
          <Segmented legend="Gender" name="gender" value={v.gender} onChange={set('gender')} options={[{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }]} error={err('gender')} />
          <Field label="Date of birth" name="dateOfBirth" type="date" value={v.dateOfBirth} onChange={set('dateOfBirth')} error={err('dateOfBirth')} hint={dobHint} required />
          <Field label="Join date" name="joinDate" type="date" value={v.joinDate} onChange={set('joinDate')} error={err('joinDate')} required />
          <Field label="Phone" name="phone" type="tel" value={v.phone} onChange={set('phone')} error={err('phone')} maxLength={20} />
          <Field label="School" name="school" value={v.school} onChange={set('school')} error={err('school')} maxLength={100} />
          <div className="md:col-span-2">
            <Field label="Address" name="address" textarea value={v.address} onChange={set('address')} error={err('address')} maxLength={300} />
          </div>
        </div>
      </section>

      <section className="card mb-4">
        <h2 className="card-heading">Organisation</h2>
        {mode === 'create' ? (
          <div className="md:grid md:grid-cols-2 gap-x-4">
            <Select
              label="Section" name="sectionId" value={v.sectionId} required error={err('sectionId')}
              onChange={(val) => setV((p) => ({ ...p, sectionId: val, rankId: '', platoonId: '' }))}
              options={org.sections.map((s) => ({ value: String(s.id), label: s.name }))}
            />
            <Select
              label="Rank" name="rankId" value={v.rankId} onChange={set('rankId')} options={rankOptions} required error={err('rankId')}
              disabled={!v.sectionId} hint={!v.sectionId ? 'Choose a section first' : undefined}
            />
            {platoonOptions.length > 0 && (
              <Select label="Platoon" name="platoonId" value={v.platoonId} onChange={set('platoonId')} options={platoonOptions} required error={err('platoonId')} />
            )}
          </div>
        ) : (
          <>
          <p className="text-sm text-fg-2">
            {initial.sectionName} · {initial.rankName}
            <span className="block text-xs text-muted mt-1">Ranks are changed on the Promotions page.</span>
          </p>
          {platoonOptions.length > 0 && (
            <div className="mt-4 md:w-1/2">
              {canChangePlatoon ? (
                <Select label="Platoon" name="platoonId" value={v.platoonId} onChange={set('platoonId')} options={platoonOptions} required error={err('platoonId')} hint="Moving a member clears their leader role." />
              ) : (
                <Field label="Platoon" name="platoonId" value={platoonOptions.find((p) => p.value === v.platoonId)?.label ?? 'Not assigned'} onChange={() => {}} locked hint="Only officers can change platoons." />
              )}
            </div>
          )}
          </>
        )}
      </section>

      {!isOfficer && v.sectionId && (mode === 'create' || canEditId) && (
        <section className="card mb-4">
          <h2 className="card-heading">Guardians</h2>
          {guardians.map((g, i) => (
            <div key={i} className={i > 0 ? 'border-t border-line pt-4' : ''}>
              <div className="flex justify-between mb-3">
                <p className="text-sm font-medium">Guardian {i + 1}</p>
                {i > 0 && <button type="button" className="text-sm text-red-400" onClick={() => setGuardians((l) => l.slice(0, 1))}>Remove</button>}
              </div>
              <div className="md:grid md:grid-cols-2 gap-x-4">
                <Field label="Name" name={`g${i}name`} value={g.name} onChange={setGuardian(i, 'name')} error={err(`guardians.${i}.name`)} maxLength={100} />
                <Select label="Relationship" name={`g${i}rel`} value={g.relationship} onChange={setGuardian(i, 'relationship')} options={RELATIONSHIPS} error={err(`guardians.${i}.relationship`)} />
                <Field label="Phone" name={`g${i}phone`} type="tel" value={g.phone} onChange={setGuardian(i, 'phone')} error={err(`guardians.${i}.phone`)} maxLength={20} />
                <Field label="Email" name={`g${i}email`} type="email" value={g.email} onChange={setGuardian(i, 'email')} error={err(`guardians.${i}.email`)} maxLength={254} />
              </div>
            </div>
          ))}
          {guardians.length < 2 && (
            <button type="button" className="text-sm text-violet-400" onClick={() => setGuardians((l) => [...l, { ...emptyGuardian }])}>+ Add second guardian</button>
          )}
        </section>
      )}

      <div className="sticky bottom-20 md:static -mx-4 px-4 md:mx-0 md:px-0 py-3 bg-background/90 backdrop-blur border-t border-line md:border-0 flex gap-2 justify-end">
        <Link href={back} className="btn-secondary">Cancel</Link>
        <button type="submit" disabled={pending} className="btn-primary max-md:flex-1">
          <SubmitLabel pending={pending} idle="Save" busy="Saving..." />
        </button>
      </div>
    </form>
  );
}
