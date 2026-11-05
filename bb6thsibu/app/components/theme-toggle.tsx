'use client';

import { useSyncExternalStore } from 'react';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faCircleHalfStroke, faMoon, faSun } from '@fortawesome/free-solid-svg-icons';
import { THEME_KEY as KEY } from '@/lib/theme';

type Pref = 'system' | 'light' | 'dark';
const EVENT = 'themechange';

// 两个开关（桌面菜单 + More 页）和其他分页都会同步
function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb);
  window.addEventListener('storage', cb);
  return () => {
    window.removeEventListener(EVENT, cb);
    window.removeEventListener('storage', cb);
  };
}
function readPref(): Pref {
  try { return (localStorage.getItem(KEY) as Pref) || 'system'; } catch { return 'system'; }
}

const OPTIONS: { value: Pref; label: string; icon: typeof faSun }[] = [
  { value: 'system', label: 'System', icon: faCircleHalfStroke },
  { value: 'light', label: 'Light', icon: faSun },
  { value: 'dark', label: 'Dark', icon: faMoon },
];

export default function ThemeToggle({ className = '' }: { className?: string }) {
  const pref = useSyncExternalStore(subscribe, readPref, () => 'system' as Pref);
  const choose = (p: Pref) => {
    try {
      if (p === 'system') localStorage.removeItem(KEY);
      else localStorage.setItem(KEY, p);
    } catch {}
    (window as unknown as { __applyTheme?: () => void }).__applyTheme?.();
    window.dispatchEvent(new Event(EVENT));
  };
  return (
    <div role="radiogroup" aria-label="Theme" className={`flex gap-1 rounded-xl border border-line p-1 ${className}`}>
      {OPTIONS.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={pref === o.value}
          onClick={() => choose(o.value)}
          className={`flex-1 min-h-9 rounded-lg text-xs flex items-center justify-center gap-1.5 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-400/70 ${pref === o.value ? 'bg-violet-500/20 text-fg font-semibold' : 'text-muted hover:bg-subtle hover:text-fg'}`}
        >
          <FontAwesomeIcon icon={o.icon} />
          {o.label}
        </button>
      ))}
    </div>
  );
}
