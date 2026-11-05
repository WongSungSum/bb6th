import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import LayoutWrapper from "@/app/components/LayoutWrapper";
import { getCurrentUser } from "@/lib/server/auth/session";
import { getPermissionsFor } from "@/lib/server/authz";
import { pendingRequestCount } from "@/lib/server/access/service";
import type { NavAccess } from "@/app/components/Ribbon";
import { themeScript } from "@/lib/theme";
const geistSans = Geist({
    variable: "--font-geist-sans",
    subsets: ["latin"],
    });

const geistMono = Geist_Mono({
    variable: "--font-geist-mono",
    subsets: ["latin"],
});

export const metadata: Metadata = {
    title: "BB 6th Sibu",
    description: "The Boys' Brigade 6th Sibu Company Management System",
};

export default async function RootLayout({
    children,
}: Readonly<{
    children: React.ReactNode;
}>) {
    // 只用于导航显示；真正的权限检查在每个页面和 action 里
    const user = await getCurrentUser();
    let nav: NavAccess = { users: false, promote: false, maintenance: false, permissions: false, platoons: false, orgAdmin: false, isCaptain: false, pending: 0 };
    if (user) {
        const perms = await getPermissionsFor(user);
        nav = {
            users: perms.has('users.view'),
            promote: perms.has('users.change_rank'),
            permissions: user.isCaptain || user.isSuperadmin || perms.has('permissions.manage'),
            platoons: perms.has('platoons.manage'),
            maintenance: user.isCaptain || user.isSuperadmin || perms.has('permissions.manage') || perms.has('platoons.manage'),
            orgAdmin: user.isCaptain || user.isSuperadmin,
            isCaptain: user.isCaptain,
            pending: await pendingRequestCount(user),
        };
    }
return (
    <html
    lang="en"
    className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    suppressHydrationWarning
    >
        <head>
            <script dangerouslySetInnerHTML={{ __html: themeScript }} />
        </head>
        <body className="min-h-full flex flex-col">
            <LayoutWrapper userName={user?.fullName} nav={nav}>
            {children}
            </LayoutWrapper>
        </body>
    </html>
);
}
