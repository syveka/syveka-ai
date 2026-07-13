/** Minimal chrome for public guest-facing pages (booking links). */
export default function PublicLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-muted/30">
      <main className="mx-auto w-full max-w-2xl flex-1 px-4 py-10">{children}</main>
      <footer className="py-6 text-center text-xs text-muted-foreground">
        Powered by Syveka AI
      </footer>
    </div>
  );
}
