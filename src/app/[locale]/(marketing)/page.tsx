import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { Button } from "@/components/ui/button";

export default async function LandingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("marketing");

  return (
    <section className="container flex flex-col items-center gap-6 py-24 text-center">
      <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl">{t("heroTitle")}</h1>
      <p className="max-w-xl text-lg text-muted-foreground">{t("heroSubtitle")}</p>
      <div className="flex gap-3">
        <Button size="lg" asChild>
          <Link href="/register">{t("startFree")}</Link>
        </Button>
        <Button size="lg" variant="outline" asChild>
          <Link href="/pricing">{t("pricing")}</Link>
        </Button>
      </div>
    </section>
  );
}
