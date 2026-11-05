import { NextResponse, type NextRequest } from 'next/server'

// 注意：这里只做「有没有 cookie」的页面跳转（用户体验），不是安全检查。
// 真正的登录与权限检查在每个页面和 Server Action 里（lib/server/auth/session.ts、lib/server/authz）。
const COOKIE = process.env.NODE_ENV === 'production' ? '__Host-bb6_session' : 'bb6_session'
const PUBLIC_PATHS = ['/login']

export default function proxy(req: NextRequest) {
  const hasSession = req.cookies.has(COOKIE)
  const isPublic = PUBLIC_PATHS.some((p) => req.nextUrl.pathname.startsWith(p))

  if (!hasSession && !isPublic) {
    return NextResponse.redirect(new URL('/login', req.url))
  }
  const res = NextResponse.next()
  // 已登录页面不允许被缓存（共用手机时避免泄露别人的资料）
  if (hasSession) res.headers.set('Cache-Control', 'no-store')
  return res
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|manifest.json|images/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
