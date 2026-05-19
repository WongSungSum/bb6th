'use client';
import { usePathname } from 'next/navigation';
import Ribbon from "./Ribbon";
import React from 'react'
import PageContainer from "./PageContainer";

interface LayoutWrapperProps {
  children: React.ReactNode;
  userName?: string | null; // This tells TypeScript what the prop is
}

// Destructure userName here in the arguments!
export default function LayoutWrapper({ children, userName }: LayoutWrapperProps) {
  const pathname = usePathname();
  const noRibbonRoutes = ['/login', '/register'];
  const showRibbon = !noRibbonRoutes.includes(pathname);

  return (
    <>
      {/* Now userName is defined and can be passed to Ribbon */}
      {showRibbon && <Ribbon userName={userName} />}
      <PageContainer>
        {children}
      </PageContainer>
    </>
  );
}