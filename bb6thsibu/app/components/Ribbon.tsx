'use client'
import { useEffect, useState, useRef } from 'react'
import { motion, AnimatePresence, useScroll, useMotionValueEvent } from 'framer-motion'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faHome, faUser, faCog, faCalendarCheck, faLineChart, faNavicon, faSignOutAlt, faUserCircle } from '@fortawesome/free-solid-svg-icons'
import { usePathname, useRouter } from 'next/navigation'
import { SITE_CONFIG } from '@/lib/constants'
import { signOut } from 'next-auth/react'
interface RibbonProps {
    platform?: 'web' | 'apk';
    userName?: string | null;
}

// 1. 数据定义：加上 path 属性，对应你的路由
const faMenus = [
    { name: 'Static', icon: faLineChart, path: '/statics' },
    { name: 'Award', icon: faUser, path: '/awards' },
    { name: 'Home', icon: faHome, path: '/dashboard' },
    { name: 'Attendance', icon: faCalendarCheck, path: '/attendance' },
    { name: 'Setting', icon: faCog, path: '/settings' },
]

// 2. MobileView 需要接收 onNavigate 函数
const MobileView = ({ active, onNavigate }: { active: number, onNavigate: (index: number, path: string) => void }) => {
    return (
        <nav className="fixed bottom-0 inset-x-0 h-16 bg-transparent z-[9999] px-6 mb-2">
            <ul className="flex relative h-full w-full items-center">
                {faMenus.map((menu, i) => {
                    const isSelected = active === i;
                    return (
                        <li key={i} className="flex-1 relative h-full">
                            <button
                                // 这里调用传进来的跳转逻辑
                                onClick={() => onNavigate(i, menu.path)}
                                className="flex flex-col items-center justify-center w-full h-full outline-none"
                            >
                                {isSelected && (
                                    <motion.div
                                        layoutId="fa_active_circle"
                                        layout
                                        className="absolute h-14 w-14 rounded-full -top-6 flex flex-col items-center justify-center z-10
                                                   bg-gradient-to-b from-[#8b5cf6] to-[#6366f1] 
                                                   border-[4px] border-[#0a0f1e] 
                                                   shadow-[0_10px_30px_rgba(99,102,241,0.6)]"
                                        transition={{ type: 'spring', stiffness: 400, damping: 25 }}
                                    >
                                        <FontAwesomeIcon icon={menu.icon} className="text-white text-lg" />
                                        <motion.span 
                                            initial={{ opacity: 0, scale: 0.5 }}
                                            animate={{ opacity: 1, scale: 1 }}
                                            className="text-[8px] text-white/90 font-bold mt-0.5"
                                        >
                                            {menu.name}
                                        </motion.span>
                                    </motion.div>
                                )}
                                <div className={`transition-all duration-300 ${
                                    isSelected ? 'opacity-0 -translate-y-6' : 'opacity-100 translate-y-0'
                                }`}>
                                    <FontAwesomeIcon icon={menu.icon} className="text-xl text-white/30" />
                                </div>
                            </button>
                        </li>
                    );
                })}
            </ul>
        </nav>
    );
}
// Find your WebView definition and replace it with this:
const WebView = ({ pathname, userName , onNavigate}: { pathname: string; userName?: string | null; onNavigate: (path: string) => void;}) => {
    const [isOpen, setIsOpen] = useState(false);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // 点击外部区域自动关闭菜单
    useEffect(() => {
        const handleClickOutside = (event: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
                setIsOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, []);

    const getLinkStyle = (path: string) => {
        const isActive = pathname === path;
        return `px-4 py-1.5 text-sm rounded-full transition-all duration-300 ${
            isActive 
                ? "bg-gradient-to-r from-violet-500 to-indigo-500 text-white shadow-[0_0_15px_rgba(139,92,246,0.5)]" 
                : "text-slate-300 hover:text-white hover:bg-white/10"
        }`;
    };

    return (
        <nav className="sticky top-0 w-full h-16 bg-[#0a0f1e]/80 backdrop-blur-md border-b border-white/5 text-white flex items-center px-8 z-50">
            <div className="text-lg font-bold tracking-tight bg-clip-text text-transparent bg-gradient-to-r from-white to-slate-400">
                {SITE_CONFIG.name}
            </div>

            <div className="ml-auto flex items-center gap-4">
                <div className="hidden md:block text-sm text-slate-400">
                    Welcome Back, <span className="text-violet-400 font-bold">{userName || 'User'}</span>
                </div>
                
                <a href="/dashboard" className={getLinkStyle('/dashboard')}>Dashboard</a>
                <a href="/maintenance" className={getLinkStyle('/maintenance')}>Maintenance</a>

                <div className="h-6 w-[1px] bg-white/10 mx-2" />

                {/* Dropdown Container */}
                <div className="relative" ref={dropdownRef}>
                    <button 
                        onClick={() => setIsOpen(!isOpen)}
                        className={`p-2 rounded-full transition-all ${isOpen ? 'bg-white/20 text-white' : 'text-slate-400 hover:bg-white/10 hover:text-white'}`}
                    >
                        <FontAwesomeIcon icon={faNavicon} />
                    </button>

                    {/* Dropdown Menu */}
                    <AnimatePresence>
                        {isOpen && (
                            <motion.div
                                initial={{ opacity: 0, y: 10, scale: 0.95 }}
                                animate={{ opacity: 1, y: 0, scale: 1 }}
                                exit={{ opacity: 0, y: 10, scale: 0.95 }}
                                className="absolute right-0 mt-3 w-48 bg-[#161b2c] border border-white/10 rounded-xl shadow-2xl overflow-hidden py-1 z-[60]"
                            >
                                <ul className="flex flex-col list-none p-0 m-0">
                                    <li className="px-4 py-3 border-b border-white/5 md:hidden">
                                        <p className="text-xs text-slate-500 mb-1">Signed in as</p>
                                        <p className="text-sm font-bold truncate">{userName}</p>
                                    </li>
                                    
                                    <li>
                                        <button className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5 hover:text-white transition-colors">
                                            <FontAwesomeIcon icon={faUserCircle} className="w-4" />
                                            Profile
                                        </button>
                                    </li>

                                    <div className="mx-2 my-1 border-b border-white/10" />
                                    <li>
                                        <button 
                                            onClick ={() => onNavigate('/users')}
                                            className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-300 hover:bg-white/5 hover:text-white transition-colors">
                                            <FontAwesomeIcon icon={faUserCircle} className="w-4" />
                                            Users
                                        </button>
                                    </li>
                                    <div className="mx-2 my-1 border-b border-white/10" />
                                    <li>
                                        <button 
                                            onClick={() => signOut({ callbackUrl: '/login' })}
                                            className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-400 hover:bg-red-500/10 transition-colors"
                                        >
                                            <FontAwesomeIcon icon={faSignOutAlt} className="w-4" />
                                            Logout
                                        </button>
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

export default function Ribbon({ platform, userName }: RibbonProps) {
    const [isMobileApp, setIsMobileApp] = useState<boolean | null>(null)
    const [active, setActive] = useState(2) // 默认 Home
    const [isVisible, setIsVisible] = useState(true)
    const pathname = usePathname();
    const router = useRouter();
    const touchStart = useRef<number | null>(null)
    const { scrollY } = useScroll()
    const handleNavigation = (index: number, path: string) => {
        setActive(index);
        router.push(path); 
    };
    const routeTo = (path: string) =>{
        router.push(path);
    };

    // 根据 URL 自动对齐图标位置
    useEffect(() => {
        const pathToIndex: Record<string, number> = {
            '/statics': 0,
            '/awards': 1,
            '/dashboard': 2,
            '/attendance': 3,
            '/settings': 4
        }
        if (pathToIndex[pathname] !== undefined) {
            setActive(pathToIndex[pathname])
        }
    }, [pathname])

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
                    <MobileView active={active} onNavigate={handleNavigation} />
                </motion.div>
            )}
            {!isMobileApp && <WebView pathname={pathname} userName={userName} onNavigate={routeTo} />}
        </AnimatePresence>
    )
}