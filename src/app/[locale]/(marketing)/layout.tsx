import { Link } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { useTranslations } from "next-intl";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <MarketingNav />
      <main className="flex-1">{children}</main>
      <footer className="border-t py-8 text-center text-sm text-muted-foreground">
        © {new Date().getFullYear()} Syveka AI · <Link href="/legal/privacy">Privacy</Link> ·{" "}
        <Link href="/legal/terms">Terms</Link>
      </footer>
    </div>
  );
}

function MarketingNav() {
  const t = useTranslations("auth");
  return (
    <header className="sticky top-0 z-40 border-b bg-background/80 backdrop-blur">
      <div className="container flex h-14 items-center justify-between">
        <Link href="/" className="font-semibold">
          Syveka AI
        </Link>
        <nav className="flex items-center gap-2">
          <Button variant="ghost" asChild>
            <Link href="/login">{t("login")}</Link>
          </Button>
          <Button asChild>
            <Link href="/register">{t("register")}</Link>
          </Button>
        </nav>
      </div>
    </header>
  );
}
