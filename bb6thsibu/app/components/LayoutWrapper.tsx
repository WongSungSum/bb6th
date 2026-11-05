'use client';
import { usePathname } from 'next/navigation';
import Ribbon, { type NavAccess } from "./Ribbon";
import React from 'react'
import PageContainer from "./PageContainer";

interface LayoutWrapperProps {
  children: React.ReactNode;
  userName?: string | null;
  nav: NavAccess;
}

export default function LayoutWrapper({ children, userName, nav }: LayoutWrapperProps) {
  const pathname = usePathname();
  // 登录、改密码、初始化页面不显示导航
  const noRibbonRoutes = ['/login', '/change-password', '/setup'];
  const showRibbon = !noRibbonRoutes.includes(pathname);

  if (!showRibbon) return <>{children}</>;
  return (
    <>
      <a href="#content" className="skip-link">Skip to content</a>
      <Ribbon userName={userName} nav={nav} />
      <PageContainer>
        {children}
      </PageContainer>
    </>
  );
}
