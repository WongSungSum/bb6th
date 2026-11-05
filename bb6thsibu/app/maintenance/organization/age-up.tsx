'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCakeCandles, faPen } from '@fortawesome/free-solid-svg-icons';
import { setAgeUpAction } from '@/app/actions/org';
import { Dialog, ErrorBanner, Select, SubmitLabel } from '@/app/components/ui';
import type { OrgSection } from '@/lib/server/org/service';

const AGES = Array.from({ length: 22 }, (_, i) => String(i + 4));

/** 某组别的「到龄升组」设定：当年满几岁 → 升到哪个军阶 */
export default function AgeUpSetting({ section, sections }: { section: OrgSection; sections: OrgSection[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [age, setAge] = useState('');
  const [rankId, setRankId] = useState('');
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  // 目标：别的启用中、非系统组别里启用中的军阶
  const options = sections
    .filter((s) => s.id !== section.id && s.isActive && !s.isSystem)
    .flatMap((s) => s.ranks.filter((r) => r.isActive && !r.isSystem).map((r) => ({ value: String(r.id), label: `${s.name} · ${r.name}`, group: s.name })));
  const current = section.ageUp ? options.find((o) => o.value === String(section.ageUp!.rankId))?.label ?? 'an inactive rank' : null;

  const show = () => {
    setAge(section.ageUp ? String(section.ageUp.age) : '');
    setRankId(section.ageUp ? String(section.ageUp.rankId) : '');
    setError(null);
    setFieldErrors({});
    setOpen(true);
  };
  const save = () =>
    start(async () => {
      const res = await setAgeUpAction(section.id, { age: age || null, rankId: age ? rankId || null : null });
      if (!res.ok) {
        setError(res.message);
        setFieldErrors(res.fieldErrors ?? {});
        return;
      }
      setOpen(false);
      router.refresh();
    });

  return (
    <>
      <div className="mt-3 flex items-center gap-2 text-sm">
        <FontAwesomeIcon icon={faCakeCandles} className="text-muted" />
        <span className="flex-1 text-fg-2">
          {section.ageUp ? <>Moves up when turning <b className="text-fg">{section.ageUp.age}</b> this year → <b className="text-fg">{current}</b></> : <span className="text-muted">Does not move up by age</span>}
        </span>
        <button className="h-8 w-8 rounded-lg text-muted hover:bg-subtle-2 hover:text-fg" aria-label={`Edit age rule for ${section.name}`} onClick={show}>
          <FontAwesomeIcon icon={faPen} />
        </button>
      </div>

      <Dialog
        open={open} onClose={() => !busy && setOpen(false)} pending={busy} title={`${section.name}: move up by age`}
        body="Members who turn this age during the year are listed on the Promotions page. An officer confirms before anyone moves."
        footer={<>
          <button className="btn-secondary" disabled={busy} onClick={() => setOpen(false)}>Cancel</button>
          <button className="btn-primary" disabled={busy} onClick={save}><SubmitLabel pending={busy} idle="Save" busy="Saving..." /></button>
        </>}
      >
        <ErrorBanner message={error} />
        <Select label="Turning this age in the year" name="age" placeholder="Off (do not move up)" value={age} onChange={setAge} options={AGES.map((a) => ({ value: a, label: `${a} years old` }))} error={fieldErrors.age} />
        {age && <Select label="Moves up to" name="rankId" value={rankId} onChange={setRankId} options={options} required error={fieldErrors.rankId} />}
      </Dialog>
    </>
  );
}
