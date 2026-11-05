'use client';

import { useState } from 'react';
import Link from 'next/link';
import { AnimatePresence, motion } from 'framer-motion';
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome';
import { faChevronDown, faChevronRight, faScrewdriverWrench } from '@fortawesome/free-solid-svg-icons';
import { maintenanceItems } from '@/app/maintenance/menu';

/** 手机版：点 Maintenance 往下滑出一排子页面，再点一次收起 */
export default function MaintenanceRow({ orgAdmin, isCaptain, pending, row, permissions, platoons }: { orgAdmin: boolean; isCaptain: boolean; pending: number; row: string; permissions: boolean; platoons: boolean }) {
  const [open, setOpen] = useState(false);
  const items = maintenanceItems({ orgAdmin, isCaptain, pending, permissions, platoons });
  // 手机上只有 Confirmations；没有可用项目就不显示
  if (!items.some((i) => !i.desktopOnly)) return null;
  return (
    <div>
      <button type="button" className={row} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-controls="maintenance-sub">
        <FontAwesomeIcon icon={faScrewdriverWrench} className="text-violet-300 w-5" />
        <span className="flex-1">Maintenance</span>
        {pending > 0 && <span className="rounded-full bg-amber-500 text-black text-xs font-bold px-2 py-0.5">{pending} to confirm</span>}
        <FontAwesomeIcon icon={faChevronDown} className={`text-muted transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            id="maintenance-sub"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.25, ease: 'easeOut' }}
            className="overflow-hidden"
          >
            <div className="mt-2 ml-4 pl-3 border-l border-violet-400/30 space-y-2">
              {items.map((it, i) => (
                <motion.div key={it.href} initial={{ x: -12, opacity: 0 }} animate={{ x: 0, opacity: 1 }} transition={{ delay: 0.04 * i }} className={it.desktopOnly ? 'hidden md:block' : ''}>
                  <Link href={it.href} className="card p-3 md:p-3 flex items-center gap-3 min-h-12 hover:bg-subtle">
                    <FontAwesomeIcon icon={it.icon} className="text-violet-300 w-4" />
                    <span className="flex-1 text-sm">{it.title}</span>
                    {!!it.badge && <span className="rounded-full bg-amber-500 text-black text-xs font-bold px-2 py-0.5">{it.badge}</span>}
                    <FontAwesomeIcon icon={faChevronRight} className="text-muted text-xs" />
                  </Link>
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
