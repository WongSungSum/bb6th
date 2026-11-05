'use client'
import { useEffect, useState, useRef } from 'react'
import { motion, AnimatePresence, useScroll, useMotionValueEvent } from 'framer-motion'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faHome, faUsers, faArrowUpRightDots, faRankingStar, faEllipsis, faSignOutAlt, faKey, faChevronDown, faIdCard } from '@fortawesome/free-solid-svg-icons'
import { usePathname, useRouter } from 'next/navigation'
import Link from 'next/link'
import { SITE_CONFIG } from '@/lib/constants'
import { logoutAction } from '@/app/actions/auth'
import { maintenanceItems } from '@/app/maintenance/menu'
import ThemeToggle from '@/app/components/theme-toggle'
export type NavAccess = { users: boolean; promote: boolean; maintenance: boolean; permissions: boolean; platoons: boolean; orgAdmin: boolean; isCaptain: boolean; pending: number };
interface RibbonProps {
    platform?: 'web' | 'apk';
    userName?: string | null;
    nav: NavAccess;
}

// 手机底部导航：按权限只显示真正能用的页面；其余（维护、个人资料、改密码、登出）放在 More
type MobileItem = { name: string; icon: typeof faHome; path: string; match: string[] };
const mobileMenus = (nav: NavAccess): MobileItem[] => [
    { name: 'Home', icon: faHome, path: '/dashboard', match: ['/dashboard'] },
    ...(nav.users ? [{ name: 'Members', icon: faUsers, path: '/users', match: ['/users'] }] : []),
    { name: 'Platoons', icon: faRankingStar, path: '/platoons', match: ['/platoons'] },
    ...(nav.promote ? [{ name: 'Promote', icon: faArrowUpRightDots, path: '/promotions', match: ['/promotions'] }] : []),
    { name: 'More', icon: faEllipsis, path: '/settings', match: ['/settings', '/maintenance', '/profile'] },
]

const MobileView = ({ items, active, pending, onNavigate }: { items: MobileItem[]; active: number; pending: number; onNavigate: (path: string) => void }) => {
    return (
        <nav aria-label="Main" className="fixed bottom-0 inset-x-0 h-16 bg-transparent z-[9999] px-4 mb-2">
            <ul className="flex relative h-full w-full items-center">
                {items.map((menu, i) => {
                    const isSelected = active === i;
                    return (
                        <li key={menu.path} className="flex-1 relative h-full">
                            <button
                                type="button"
                                onClick={() => onNavigate(menu.path)}
                                aria-label={menu.name}
                                aria-current={isSelected ? 'page' : undefined}
                                className="relative flex flex-col items-center justify-center w-full h-full rounded-xl outline-none focus-visible:ring-2 focus-visible:ring-violet-400"
                            >
                                {isSelected && (
                                    <motion.div
                                        layoutId="fa_active_circle"
                                        layout
                                        className="absolute h-14 w-14 rounded-full -top-6 flex flex-col items-center justify-center z-10
                                                   bg-gradient-to-b from-violet-500 to-indigo-500
                                                   border-[4px] border-background
                                                   shadow-[0_10px_30px_rgba(99,102,241,0.6)]"
                                        transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                                    >
                                        <FontAwesomeIcon icon={menu.icon} className="text-white text-lg" />
                                    </motion.div>
                                )}
                                <div className={`transition-all duration-300 ${
                                    isSelected ? 'opacity-0 -translate-y-6' : 'opacity-100 translate-y-0'
                                }`}>
                                    <FontAwesomeIcon icon={menu.icon} className="text-xl text-muted" />
                                </div>
                                <span className={`text-[11px] mt-0.5 ${isSelected ? 'text-fg font-semibold translate-y-2' : 'text-muted'}`}>{menu.name}</span>
                                {menu.name === 'More' && pending > 0 && (
                                    <span className="absolute top-1 right-[calc(50%-18px)] min-w-4 h-4 px-1 rounded-full bg-amber-500 text-[10px] font-bold text-black grid place-items-center z-20" aria-label={`${pending} waiting for your confirmation`}>{pending}</span>
                                )}
                            </button>
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
}
// 电脑版：点 Maintenance 淡入一个下拉清单，点外面 / Esc / 选了项目就淡出
const MaintenanceMenu = ({ nav, pathname, className }: { nav: NavAccess; pathname: string; className: string }) => {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const items = maintenanceItems({ orgAdmin: nav.orgAdmin, isCaptain: nav.isCaptain, pending: nav.pending, permissions: nav.permissions, platoons: nav.platoons });

    useEffect(() => {
        if (!open) return;
        const onDown = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false); };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey); };
    }, [open]);

    return (
        <div className="relative" ref={ref}>
            <button type="button" onClick={() => setOpen((o) => !o)} aria-haspopup="menu" aria-expanded={open} className={`${className} relative inline-flex items-center gap-2`}>
                Maintenance
                <FontAwesomeIcon icon={faChevronDown} className={`text-[10px] transition-transform duration-200 ${open ? 'rotate-180' : ''}`} />
                {nav.pending > 0 && (
                    <span className="absolute -top-1.5 -right-1.5 min-w-5 h-5 px-1 rounded-full bg-amber-500 text-[11px] font-bold text-black grid place-items-center" aria-label={`${nav.pending} waiting for your confirmation`}>
                        {nav.pending}
                    </span>
                )}
            </button>
            <AnimatePresence>
                {open && (
                    <motion.div
                        role="menu"
                        initial={{ opacity: 0, y: -4 }}
                        animate={{ opacity: 1, y: 0 }}
                        exit={{ opacity: 0, y: -4 }}
                        transition={{ duration: 0.18, ease: 'easeOut' }}
                        className="absolute right-0 mt-3 w-80 bg-surface border border-line rounded-xl shadow-2xl overflow-hidden py-1.5 z-[60]"
                    >
                        {items.map((it) => {
                            const active = pathname === it.href || pathname.startsWith(it.href + '/');
                            return (
                                <Link key={it.href} href={it.href} role="menuitem" onClick={() => setOpen(false)}
                                    className={`flex items-start gap-3 px-4 py-2.5 transition-colors ${active ? 'bg-violet-500/15' : 'hover:bg-subtle'}`}>
                                    <span className="h-8 w-8 shrink-0 rounded-lg bg-violet-500/15 text-violet-300 grid place-items-center text-sm"><FontAwesomeIcon icon={it.icon} /></span>
                                    <span className="flex-1 min-w-0">
                                        <span className="flex items-center gap-2 text-sm font-medium text-fg">
                                            {it.title}
                                            {!!it.badge && <span className="rounded-full bg-amber-500 text-black text-[11px] font-bold px-1.5">{it.badge}</span>}
                                        </span>
                                        <span className="block text-xs text-muted leading-snug">{it.text}</span>
                                    </span>
                                </Link>
                            );
                        })}
                    </motion.div>
                )}
            </AnimatePresence>
        </div>
    );
};

// Find your WebView definition and replace it with this:
const WebView = ({ pathname, userName, nav }: { pathname: string; userName?: string | null; nav: NavAccess }) => {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // 点外面或按 Esc 关闭菜单
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setIsOpen(false); };
        document.addEventListener('mousedown', handleClickOutside);
        document.addEventListener('keydown', onKey);
        return () => { document.removeEventListener('mousedown', handleClickOutside); document.removeEventListener('keydown', onKey); };
    }, []);
    const initials = (userName || 'U').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

    const getLinkStyle = (path: string) => {
        const isActive = pathname === path || pathname.startsWith(path + '/');
        return `px-4 py-1.5 text-sm rounded-full transition-all duration-300 ${
            isActive
                ? "bg-gradient-to-r from-violet-500 to-indigo-500 text-white shadow-[0_0_15px_rgba(139,92,246,0.5)]"
                : "text-fg-2 hover:text-fg hover:bg-subtle-2"
        }`;
    };

    return (
        <nav aria-label="Main" className="sticky top-0 w-full h-16 bg-background/80 backdrop-blur-md border-b border-line-soft text-fg flex items-center px-8 z-50">
            <div className="text-lg font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-fg to-muted">
                {SITE_CONFIG.name}
            </div>

            <div className="ml-auto flex items-center gap-4">
                <div className="hidden md:block text-sm text-muted">
                    Welcome Back, <span className="text-violet-400 font-bold">{userName || 'User'}</span>
                </div>

                <Link href="/dashboard" className={getLinkStyle('/dashboard')}>Dashboard</Link>
                {nav.users && <Link href="/users" className={getLinkStyle('/users')}>Members</Link>}
                {nav.promote && <Link href="/promotions" className={getLinkStyle('/promotions')}>Promotions</Link>}
                <Link href="/platoons" className={getLinkStyle('/platoons')}>Platoons</Link>
                {nav.maintenance && <MaintenanceMenu nav={nav} pathname={pathname} className={getLinkStyle('/maintenance')} />}

                <div className="h-6 w-[1px] bg-subtle-2 mx-2" />

                {/* Dropdown Container */}
                <div className="relative" ref={dropdownRef}>
                    <button
                        type="button"
                        onClick={() => setIsOpen(!isOpen)}
                        aria-label="Account menu"
                        aria-haspopup="menu"
                        aria-expanded={isOpen}
                        className={`h-9 w-9 rounded-full grid place-items-center text-xs font-bold transition-all bg-gradient-to-br from-violet-500 to-indigo-500 text-white ${isOpen ? 'ring-2 ring-violet-400/60' : 'hover:ring-2 hover:ring-violet-400/40'}`}
                    >
                        {initials}
                    </button>

                    {/* Dropdown Menu */}
                    <AnimatePresence>
                        {isOpen && (
                            <motion.div
                                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, y: 10, scale: 0.95 }}
                                className="absolute right-0 mt-3 w-64 bg-surface border border-line rounded-xl shadow-2xl overflow-hidden py-1 z-[60]"
                            >
                                <ul className="flex flex-col list-none p-0 m-0">
                                    <li className="px-4 py-3 border-b border-line-soft md:hidden">
                                        <p className="text-xs text-muted mb-1">Signed in as</p>
                                        <p className="text-sm font-bold truncate">{userName}</p>
                                    </li>

                                    <li>
                                        <Link href="/profile" onClick={() => setIsOpen(false)} className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-fg-2 hover:bg-subtle hover:text-fg transition-colors">
                                            <FontAwesomeIcon icon={faIdCard} className="w-4" />
                                            My profile
                                        </Link>
                                    </li>
                                    <li>
                                        <Link href="/change-password" onClick={() => setIsOpen(false)} className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-fg-2 hover:bg-subtle hover:text-fg transition-colors">
                                            <FontAwesomeIcon icon={faKey} className="w-4" />
                                            Change password
                                        </Link>
                                    </li>
                                    <li className="px-3 py-2"><ThemeToggle /></li>
                                    <div className="mx-2 my-1 border-b border-line" />
                                    <li>
                                        <form action={logoutAction}>
                                            <button
                                                type="submit"
                                                className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/10 transition-colors"
                                            >
                                                <FontAwesomeIcon icon={faSignOutAlt} className="w-4" />
                                                Logout
                                            </button>
                                        </form>
                                    </li>
                                </ul>
                            </motion.div>
                        )}
                    </AnimatePresence>
                </div>
            </div>
        </nav>
    );
};

export default function Ribbon({ platform, userName, nav }: RibbonProps) {
    const [isMobileApp, setIsMobileApp] = useState<boolean | null>(null)
    const [isVisible, setIsVisible] = useState(true)
    const pathname = usePathname();
    const router = useRouter();
    const touchStart = useRef<number | null>(null)
    const { scrollY } = useScroll()
    // 根据 URL 决定亮哪个图标
    const items = mobileMenus(nav)
    const found = items.findIndex((m) => m.match.some((p) => pathname === p || pathname.startsWith(p + '/')))
    const active = found >= 0 ? found : 0
    const handleNavigation = (path: string) => {
        router.push(path);
    };

    // 滚动监听
    useMotionValueEvent(scrollY, "change", (latest) => {
        const previous = scrollY.getPrevious() ?? 0
        if (latest > previous && latest > 30) {
            setIsVisible(false)
        } else if (latest < previous) {
            setIsVisible(true)
        }
    })

    useEffect(() => {
        // Touch 手势监听 (保持原样)
        const handleTouchStart = (e: TouchEvent) => { touchStart.current = e.targetTouches[0].clientY }
        const handleTouchMove = (e: TouchEvent) => {
            if (touchStart.current === null) return
            const touchEnd = e.targetTouches[0].clientY
            const distance = touchStart.current - touchEnd
            if (distance > 40) setIsVisible(false)
            else if (distance < -40) setIsVisible(true)
        }
        const handleTouchEnd = () => { touchStart.current = null }

        const checkPlatform = () => {
            if (platform) {
                setIsMobileApp(platform === 'apk')
                return
            }
            const ua = navigator.userAgent
            const isUAApp = /Android|iPhone|iPad/i.test(ua)
            const isStandalone = window.matchMedia('(display-mode: standalone)').matches
            setIsMobileApp(isUAApp || isStandalone)
        }

        checkPlatform()
        window.addEventListener('touchstart', handleTouchStart)
        window.addEventListener('touchmove', handleTouchMove)
        window.addEventListener('touchend', handleTouchEnd)
        if (!platform) window.addEventListener('resize', checkPlatform)

        return () => {
            window.removeEventListener('touchstart', handleTouchStart)
            window.removeEventListener('touchmove', handleTouchMove)
            window.removeEventListener('touchend', handleTouchEnd)
            if (!platform) window.removeEventListener('resize', checkPlatform)
        }
    }, [platform])

    if (isMobileApp === null) return null

    return (
        <AnimatePresence>
            {isMobileApp && isVisible && (
                <motion.div
                    key="mobile-nav-container"
                    initial={{ y: 100, opacity: 0 }}
                    animate={{ y: 0, opacity: 1 }}
                    exit={{ y: 100, opacity: 0 }}
                    transition={{ type: "spring", stiffness: 300, damping: 32 }}
                    className="fixed bottom-0 inset-x-0 z-[9999]"
                >
                    {/* 传递 handleNavigation */}
                    <MobileView items={items} active={active} pending={nav.pending} onNavigate={handleNavigation} />
                </motion.div>
            )}
            {!isMobileApp && <WebView pathname={pathname} userName={userName} nav={nav} />}
        </AnimatePresence>
    )
}