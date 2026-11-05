'use client';

import { useEffect, useState, useTransition } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { AnimatePresence, motion } from 'framer-motion';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faFilter, faMagnifyingGlass, faSpinner, faXmark } from '@fortawesome/free-solid-svg-icons';
import type { OrgOptions } from '@/lib/server/users/service';
import { Select } from './ui';

type Values = { q: string; section: string; rank: string; platoon: string; status: string };
const STATUS_LABEL: Record<string, string> = { active: 'Active', inactive: 'Inactive', all: 'All statuses' };

/**
 * 名字搜索框：打字时自动搜索（停 300ms 后）。
 * 筛选面板：点「Filters」在搜索框下方滑出全部筛选条件，点「Search」套用并收起。
 * 条件存在网址参数里，所以可以分享、上一页也会保留。
 */
export default function FilterPanel({ org, showStatus = true }: { org: OrgOptions; showStatus?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const current: Values = { q: sp.get('q') ?? '', section: sp.get('section') ?? '', rank: sp.get('rank') ?? '', platoon: sp.get('platoon') ?? '', status: sp.get('status') ?? 'active' };
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<Values>(current);
  const [q, setQ] = useState(current.q);
  const [searching, startSearch] = useTransition();
  // 网址被别处改掉（例如「Clear filters」），搜索框跟着更新；自己推的不算，免得盖掉还在打的字
  const [pushed, setPushed] = useState(current.q);
  const [seenQ, setSeenQ] = useState(current.q);
  if (current.q !== seenQ) {
    setSeenQ(current.q);
    if (current.q !== pushed) setQ(current.q);
  }

  // 打字即搜：只等 100ms 合并连按，换页放在 transition 里，打字不会被卡住；只改 q，其他筛选保留，回到第一页
  useEffect(() => {
    const t = setTimeout(() => {
      const next = q.trim().slice(0, 100);
      if (next === (sp.get('q') ?? '')) return;
      const params = new URLSearchParams(sp.toString());
      params.delete('page');
      if (next) params.set('q', next);
      else params.delete('q');
      setPushed(next);
      startSearch(() => router.replace(params.size ? `${pathname}?${params}` : pathname, { scroll: false }));
    }, 100);
    return () => clearTimeout(t);
  }, [q, sp, pathname, router]);

  // 每次打开都从目前网址的条件开始；再点一次收起
  const toggle = () => {
    if (!open) setV(current);
    setOpen((o) => !o);
  };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const go = (next: Values) => {
    const params = new URLSearchParams();
    if (next.q.trim()) params.set('q', next.q.trim().slice(0, 100));
    if (next.section) params.set('section', next.section);
    if (next.rank) params.set('rank', next.rank);
    if (next.platoon) params.set('platoon', next.platoon);
    if (showStatus && next.status !== 'active') params.set('status', next.status);
    setPushed(next.q.trim().slice(0, 100));
    router.replace(params.size ? `${pathname}?${params}` : pathname);
    setOpen(false);
  };

  const sectionName = org.sections.find((s) => String(s.id) === current.section)?.name;
  const rankName = org.ranks.find((r) => String(r.id) === current.rank)?.name;
  const platoonName = org.platoons.find((p) => String(p.id) === current.platoon)?.name;
  const chips: [keyof Values, string][] = [];
  if (sectionName) chips.push(['section', sectionName]);
  if (rankName) chips.push(['rank', rankName]);
  if (platoonName) chips.push(['platoon', platoonName]);
  if (showStatus && current.status !== 'active') chips.push(['status', STATUS_LABEL[current.status] ?? current.status]);

  const ranks = org.ranks.filter((r) => !v.section || String(r.sectionId) === v.section);
  const platoonOptions = org.platoons.filter((p) => !v.section || String(p.sectionId) === v.section);
  const looksNumeric = /^[\d-\s]{6,}$/.test(q);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative w-full sm:w-80">
          <FontAwesomeIcon icon={searching ? faSpinner : faMagnifyingGlass} spin={searching} className="absolute left-3 top-1/2 -translate-y-1/2 text-muted pointer-events-none" />
          <input
            type="search" className="form-input pl-9" placeholder="Search name, username or IC" aria-label="Search name, username or IC"
            maxLength={100} value={q} onChange={(e) => setQ(e.target.value)}
          />
          {looksNumeric && <p className="text-xs text-muted mt-1">IC search needs the full 12-digit number.</p>}
        </div>
        <button type="button" onClick={toggle} className={`btn-secondary ${open ? 'bg-subtle-2 text-fg' : ''}`} aria-expanded={open} aria-controls="filter-panel">
          <FontAwesomeIcon icon={faFilter} /> Filters
          {chips.length > 0 && <span className="ml-1 rounded-full bg-violet-500 text-white text-xs px-2 py-0.5">{chips.length}</span>}
          <FontAwesomeIcon icon={faChevronDown} className={`text-[10px] transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
        </button>
      </div>

      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id="filter-panel"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <form
              aria-label="Filters"
              className="card mb-4"
              onSubmit={(e) => {
                e.preventDefault();
                go({ ...v, q });
              }}
            >
              <div className={`grid gap-x-4 ${showStatus ? 'md:grid-cols-4' : 'md:grid-cols-3'}`}>
                <Select label="Section" name="section" placeholder="All sections" value={v.section} onChange={(section) => setV((p) => ({ ...p, section, rank: '', platoon: '' }))} options={org.sections.map((s) => ({ value: String(s.id), label: s.name }))} />
                <Select
                  label="Rank" name="rank" placeholder="All ranks" value={v.rank} onChange={(rank) => setV((p) => ({ ...p, rank }))}
                  options={ranks.map((r) => ({ value: String(r.id), label: r.name, group: org.sections.find((s) => s.id === r.sectionId)?.name }))}
                />
                <Select
                  label="Platoon" name="platoon" placeholder="All platoons" value={v.platoon} onChange={(platoon) => setV((p) => ({ ...p, platoon }))}
                  options={platoonOptions.map((p) => ({ value: String(p.id), label: p.name }))} disabled={!platoonOptions.length}
                />
                {showStatus && (
                  <fieldset className="mb-5">
                    <legend className="text-xs text-muted mb-2">Status</legend>
                    <div className="flex gap-2">
                      {Object.entries(STATUS_LABEL).map(([value, label]) => (
                        <label key={value} className={`flex-1 min-h-12 rounded-xl border text-sm flex items-center justify-center cursor-pointer ${v.status === value ? 'bg-violet-500/20 border-violet-400 text-fg' : 'border-line text-fg-2'}`}>
                          <input type="radio" className="sr-only" name="status" value={value} checked={v.status === value} onChange={() => setV((p) => ({ ...p, status: value }))} />
                          {value === 'all' ? 'All' : label}
                        </label>
                      ))}
                    </div>
                  </fieldset>
                )}
              </div>
              <div className="flex gap-2 justify-end">
                <button type="button" className="btn-secondary max-sm:flex-1" onClick={() => setV({ q, section: '', rank: '', platoon: '', status: 'active' })}>Reset</button>
                <button type="submit" className="btn-primary max-sm:flex-1"><FontAwesomeIcon icon={faMagnifyingGlass} /> Search</button>
              </div>
            </form>
          </motion.div>
        )}
      </AnimatePresence>

      {chips.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 mb-4">
          {chips.map(([k, label]) => (
            <span key={k} className="inline-flex items-center gap-1 rounded-full border border-violet-400/40 bg-violet-500/10 text-violet-200 text-sm pl-3 pr-1 min-h-9">
              {label}
              <button
                type="button"
                aria-label={`Remove filter ${label}`}
                className="h-7 w-7 rounded-full hover:bg-subtle-2"
                onClick={() => go({ ...current, q, [k]: k === 'status' ? 'active' : '', ...(k === 'section' ? { rank: '', platoon: '' } : {}) })}
              >
                <FontAwesomeIcon icon={faXmark} />
              </button>
            </span>
          ))}
          {chips.length > 1 && (
            <button type="button" className="text-sm text-violet-300 hover:text-violet-200 px-2 min-h-9" onClick={() => go({ q, section: '', rank: '', platoon: '', status: 'active' })}>
              Clear all
            </button>
          )}
        </div>
      )}
    </>
  );
}
