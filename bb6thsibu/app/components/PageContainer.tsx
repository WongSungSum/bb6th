// components/PageContainer.tsx
export default function PageContainer({ children }: { children: React.ReactNode }) {
  return (
    <main id="content" tabIndex={-1} className="px-4 py-6 pb-24 md:px-8 md:py-10 outline-none">
      {children}
    </main>
  );
}
