// components/PageContainer.tsx
export default function PageContainer({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-4 py-6 md:px-8 md:py-10">
      {children}
    </div>
  );
}