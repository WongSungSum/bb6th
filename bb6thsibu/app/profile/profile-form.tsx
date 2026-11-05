'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleCheck } from '@fortawesome/free-solid-svg-icons';
import { updateProfileAction } from '@/app/actions/users';
import { ErrorBanner, Field, RankBadge, SectionBadge, Select, SubmitLabel } from '@/app/components/ui';
import { pickGuardians } from '@/app/components/guardian-errors';
import type { OwnProfile } from '@/lib/server/users/profile';
import { fieldErrorsOf, ownProfileSchema } from '@/lib/validation/users';

type Guardian = { name: string; relationship: string; phone: string; email: string };
const emptyGuardian: Guardian = { name: '', relationship: '', phone: '', email: '' };
const RELATIONSHIPS = [
  { value: 'father', label: 'Father' },
  { value: 'mother', label: 'Mother' },
  { value: 'guardian', label: 'Guardian' },
  { value: 'other', label: 'Other' },
];

/** 只读的一行资料 */
function Info({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="py-2">
      <p className="text-xs text-muted">{label}</p>
      <p className="text-sm text-fg break-words">{value || <span className="text-muted">Not recorded</span>}</p>
    </div>
  );
}

export default function ProfileForm({ profile }: { profile: OwnProfile }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [v, setV] = useState({ email: profile.email, phone: profile.phone ?? '', address: profile.address ?? '', school: profile.school ?? '' });
  const [guardians, setGuardians] = useState<Guardian[]>(profile.guardians.length ? profile.guardians : [{ ...emptyGuardian }]);
  const [updatedAt, setUpdatedAt] = useState(profile.updatedAt);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const set = (k: keyof typeof v) => (val: string) => { setSaved(false); setV((p) => ({ ...p, [k]: val })); };
  const setGuardian = (i: number, k: keyof Guardian) => (val: string) => {
    setSaved(false);
    setGuardians((list) => list.map((g, j) => (j === i ? { ...g, [k]: val } : g)));
  };
  const err = (k: string) => errors[k];

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const { filled, remap } = pickGuardians(profile.hasGuardians ? guardians : []);
    const payload = {
      ...v,
      guardians: filled,
      expectedUpdatedAt: updatedAt,
    };
    const check = ownProfileSchema.safeParse(payload);
    if (!check.success) {
      setErrors(remap(fieldErrorsOf(check.error)));
      setBanner('Please fix the highlighted fields.');
      return;
    }
    setErrors({});
    setBanner(null);
    start(async () => {
      const res = await updateProfileAction(payload as never);
      if (!res.ok) {
        setErrors(remap(res.fieldErrors ?? {}));
        setBanner(res.message);
        return;
      }
      setUpdatedAt(res.data.updatedAt);
      setSaved(true);
      router.refresh();
    });
  };

  return (
    <form onSubmit={submit} noValidate className="max-w-3xl mx-auto">
      <h1 className="text-xl md:text-2xl font-bold tracking-tight mb-1">My profile</h1>
      <p className="text-sm text-muted mb-5">You can update your contact details here. Ask an officer to change your name, ID or other details.</p>
      <ErrorBanner message={banner} />
      {saved && (
        <p className="card mb-4 text-sm text-emerald-300 flex items-center gap-2" role="status">
          <FontAwesomeIcon icon={faCircleCheck} /> Your profile is saved.
        </p>
      )}

      <section className="card mb-4">
        <h2 className="card-heading">About you</h2>
        <div className="md:grid md:grid-cols-2 gap-x-4">
          <Info label="Full name" value={profile.fullName} />
          <Info label="Username" value={profile.username} />
          <Info label="ID number" value={profile.idType === 'none' ? 'None' : profile.idNumber} />
          <Info label="Gender" value={profile.gender === 'male' ? 'Male' : profile.gender === 'female' ? 'Female' : null} />
          <Info label="Date of birth" value={profile.dateOfBirth} />
          <Info label="Join date" value={profile.joinDate} />
          {profile.accountType === 'member' && (
            <Info label="Section and rank" value={<span className="inline-flex gap-2 flex-wrap"><SectionBadge name={profile.sectionName} /><RankBadge name={profile.rankName} captain={profile.isCaptain} /></span>} />
          )}
          {profile.platoonName && <Info label="Platoon" value={`${profile.platoonName}${profile.platoonRole === 'leader' ? ' (Leader)' : profile.platoonRole === 'assistant' ? ' (Assistant leader)' : ''}`} />}
        </div>
      </section>

      <section className="card mb-4">
        <h2 className="card-heading">Contact</h2>
        <div className="md:grid md:grid-cols-2 gap-x-4">
          <Field label="Email" name="email" type="email" value={v.email} onChange={set('email')} error={err('email')} required maxLength={254} />
          <Field label="Phone" name="phone" type="tel" value={v.phone} onChange={set('phone')} error={err('phone')} maxLength={20} />
          {profile.accountType === 'member' && <Field label="School" name="school" value={v.school} onChange={set('school')} error={err('school')} maxLength={100} />}
          <div className="md:col-span-2">
            <Field label="Address" name="address" textarea value={v.address} onChange={set('address')} error={err('address')} maxLength={300} />
          </div>
        </div>
      </section>

      {profile.hasGuardians && (
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

      <div className="sticky bottom-20 md:static -mx-4 px-4 md:mx-0 md:px-0 py-3 bg-background/90 backdrop-blur border-t border-line md:border-0 flex justify-end">
        <button type="submit" disabled={pending} className="btn-primary max-md:flex-1">
          <SubmitLabel pending={pending} idle="Save" busy="Saving..." />
        </button>
      </div>
    </form>
  );
}
