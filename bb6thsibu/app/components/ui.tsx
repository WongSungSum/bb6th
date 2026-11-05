'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import {
  faEye, faEyeSlash, faChevronDown, faTriangleExclamation, faLock, faStar, faSpinner,
} from '@fortawesome/free-solid-svg-icons';
import type { IconDefinition } from '@fortawesome/fontawesome-svg-core';
import { motion, AnimatePresence } from 'framer-motion';

// ─── 表单栏位（浮动标签） ─────────────────────────────

type FieldProps = {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  error?: string;
  hint?: string;
  required?: boolean;
  type?: 'text' | 'email' | 'tel' | 'date' | 'password';
  textarea?: boolean;
  disabled?: boolean;
  autoComplete?: string;
  maxLength?: number;
  onPage?: boolean;
  locked?: boolean;
};

export function Field({ label, name, value, onChange, error, hint, required, type = 'text', textarea, disabled, autoComplete, maxLength, onPage, locked }: FieldProps) {
  const id = useId();
  const [show, setShow] = useState(false);
  const isPassword = type === 'password';
  const common = {
    id,
    name,
    value,
    placeholder: ' ',
    disabled: disabled || locked,
    maxLength,
    autoComplete,
    'aria-invalid': error ? true : undefined,
    'aria-describedby': error ? `${id}-err` : undefined,
    className: `form-input floating-input ${type === 'date' ? 'is-filled' : ''} ${isPassword ? 'pr-12' : ''} ${textarea ? 'min-h-24 resize-y' : ''}`,
    onChange: (e: { target: { value: string } }) => onChange(e.target.value),
  };
  return (
    <div className={`floating-group ${onPage ? 'on-page' : ''} ${locked ? 'opacity-70' : ''}`}>
      {textarea ? (
        <textarea rows={3} {...common} />
      ) : (
        <input type={isPassword && show ? 'text' : type} {...common} />
      )}
      <label htmlFor={id} className="floating-label">
        {label} {required && <span className="text-violet-400">*</span>}
      </label>
      {isPassword && (
        <button
          type="button"
          onClick={() => setShow(!show)}
          aria-label={show ? 'Hide password' : 'Show password'}
          aria-pressed={show}
          className="absolute right-2 top-1.5 h-9 w-9 rounded-lg text-muted hover:text-fg hover:bg-subtle-2"
        >
          <FontAwesomeIcon icon={show ? faEyeSlash : faEye} />
        </button>
      )}
      {locked && <FontAwesomeIcon icon={faLock} className="absolute right-4 top-4 text-muted" />}
      {error ? (
        <p id={`${id}-err`} role="alert" className="mt-1.5 text-xs text-red-400">{error}</p>
      ) : hint ? (
        <p className="mt-1.5 text-xs text-muted">{hint}</p>
      ) : null}
    </div>
  );
}

type SelectProps = {
  label: string;
  name: string;
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string; group?: string }[];
  placeholder?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  onPage?: boolean;
};

export function Select({ label, name, value, onChange, options, placeholder = 'Select...', error, hint, required, disabled, onPage }: SelectProps) {
  const id = useId();
  const groups = [...new Set(options.map((o) => o.group).filter(Boolean))] as string[];
  const render = (list: typeof options) => list.map((o) => <option key={o.value} value={o.value}>{o.label}</option>);
  return (
    <div className={`floating-group ${onPage ? 'on-page' : ''}`}>
      <select
        id={id}
        name={name}
        value={value}
        disabled={disabled}
        aria-invalid={error ? true : undefined}
        onChange={(e) => onChange(e.target.value)}
        className="form-input floating-input is-filled appearance-none pr-10"
      >
        <option value="">{placeholder}</option>
        {groups.length
          ? groups.map((g) => <optgroup key={g} label={g}>{render(options.filter((o) => o.group === g))}</optgroup>)
          : render(options)}
      </select>
      <label htmlFor={id} className="floating-label">
        {label} {required && <span className="text-violet-400">*</span>}
      </label>
      <FontAwesomeIcon icon={faChevronDown} className="absolute right-4 top-4 text-muted pointer-events-none" />
      {error ? <p role="alert" className="mt-1.5 text-xs text-red-400">{error}</p> : hint ? <p className="mt-1.5 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}

export function Segmented({ legend, name, value, onChange, options, error }: { legend: string; name: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; error?: string }) {
  return (
    <fieldset className="mb-5">
      <legend className="text-xs text-muted mb-2">{legend} <span className="text-violet-400">*</span></legend>
      <div className="flex gap-2">
        {options.map((o) => (
          <label key={o.value} className={`flex-1 min-h-11 rounded-xl border text-sm flex items-center justify-center cursor-pointer ${value === o.value ? 'bg-violet-500/20 border-violet-400 text-fg' : 'border-line text-fg-2'}`}>
            <input type="radio" className="sr-only" name={name} value={o.value} checked={value === o.value} onChange={() => onChange(o.value)} />
            {o.label}
          </label>
        ))}
      </div>
      {error && <p role="alert" className="mt-1.5 text-xs text-red-400">{error}</p>}
    </fieldset>
  );
}

// ─── 提示与状态 ───────────────────────────────────────

export function ErrorBanner({ message }: { message?: string | null }) {
  const ref = useRef<HTMLDivElement>(null);
  // 表单出错时把焦点移到第一个有错的格子（没有就移到这个提示），手机也会自动卷过去
  useEffect(() => {
    if (!message || !ref.current) return;
    const first = ref.current.closest('form')?.querySelector<HTMLElement>('[aria-invalid="true"]');
    (first ?? ref.current).focus();
  }, [message]);
  if (!message) return null;
  return (
    <div ref={ref} tabIndex={-1} role="alert" className="mb-4 flex gap-3 rounded-xl border border-red-500/30 bg-red-500/10 text-red-300 text-sm px-4 py-3 outline-none">
      <FontAwesomeIcon icon={faTriangleExclamation} className="mt-0.5" />
      <span>{message}</span>
    </div>
  );
}

export function SubmitLabel({ pending, idle, busy }: { pending: boolean; idle: string; busy: string }) {
  return pending ? (
    <>
      <FontAwesomeIcon icon={faSpinner} spin /> {busy}
    </>
  ) : (
    <>{idle}</>
  );
}

const SECTION_COLORS: Record<string, string> = {
  Officer: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  Senior: 'bg-indigo-500/15 text-indigo-300 border-indigo-500/30',
  Junior: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  'Pre-Junior': 'bg-teal-500/15 text-teal-300 border-teal-500/30',
};
const badgeBase = 'inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium border';

export function SectionBadge({ name }: { name: string | null }) {
  if (!name) return null;
  return <span className={`${badgeBase} ${SECTION_COLORS[name] ?? 'bg-subtle text-fg border-line'}`}>{name}</span>;
}
export function RankBadge({ name, captain }: { name: string | null; captain?: boolean }) {
  if (!name) return null;
  return captain ? (
    <span className={`${badgeBase} bg-gradient-to-r from-violet-500 to-indigo-500 text-white border-transparent`}>
      <FontAwesomeIcon icon={faStar} /> {name}
    </span>
  ) : (
    <span className={`${badgeBase} bg-subtle text-fg border-line`}>{name}</span>
  );
}
export function StatusBadge({ status }: { status: string }) {
  return status === 'active' ? (
    <span className={`${badgeBase} bg-emerald-500/15 text-emerald-300 border-emerald-500/30`}>Active</span>
  ) : (
    <span className={`${badgeBase} bg-slate-500/15 text-fg-2 border-slate-500/30`}>Inactive</span>
  );
}
export function FlagBadge({ children }: { children: ReactNode }) {
  return <span className={`${badgeBase} bg-amber-500/15 text-amber-300 border-amber-500/30`}>{children}</span>;
}

export function StateCard({ icon, title, text, action }: { icon: IconDefinition; title: string; text?: string; action?: ReactNode }) {
  return (
    <div className="card flex flex-col items-center text-center py-12 px-6 gap-3">
      <div className="h-14 w-14 rounded-full bg-subtle text-muted text-xl grid place-items-center">
        <FontAwesomeIcon icon={icon} />
      </div>
      <p className="font-semibold">{title}</p>
      {text && <p className="text-sm text-muted max-w-sm">{text}</p>}
      {action}
    </div>
  );
}

// ─── 对话框 ───────────────────────────────────────────

export function Dialog({
  open, onClose, title, body, danger, pending, children, footer,
}: {
  open: boolean; onClose: () => void; title: string; body?: ReactNode; danger?: boolean; pending?: boolean; children?: ReactNode; footer: ReactNode;
}) {
  const titleId = useId();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !pending && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, pending, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <motion.div className="fixed inset-0 z-[10000] bg-black/60 backdrop-blur-sm" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} onClick={() => !pending && onClose()}>
          <motion.div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.96 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 350, damping: 28 }}
            className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[calc(100%-2rem)] max-w-md bg-surface border border-line rounded-xl shadow-2xl p-5 md:p-6 max-h-[90dvh] overflow-y-auto"
          >
            <h2 id={titleId} className={`text-lg font-semibold ${danger ? 'text-red-300' : ''}`}>{title}</h2>
            {body && <div className="text-sm text-fg-2 mt-1 mb-4">{body}</div>}
            {children}
            <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 mt-6">{footer}</div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
