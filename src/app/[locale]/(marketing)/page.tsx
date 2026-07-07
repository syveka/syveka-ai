import { setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { Button } from "@/components/ui/button";

export default async function LandingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);

  return (
    <section className="container flex flex-col items-center gap-6 py-24 text-center">
      <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl">
        {locale === "fi"
          ? "Tekoälyavustaja, joka tuntee yrityksesi"
          : locale === "ar"
            ? "مساعد ذكي يعرف شركتك"
            : "The AI assistant that knows your business"}
      </h1>
      <p className="max-w-xl text-lg text-muted-foreground">
        {locale === "fi"
          ? "Chat, puheavustaja, CRM ja automaatiot — yhdessä alustassa suomalaisille pk-yrityksille."
          : "Chat, voice assistant, CRM and automations — one platform built for Finnish SMBs."}
      </p>
      <div className="flex gap-3">
        <Button size="lg" asChild>
          <Link href="/register">{locale === "fi" ? "Aloita ilmaiseksi" : "Start free"}</Link>
        </Button>
        <Button size="lg" variant="outline" asChild>
          <Link href="/pricing">{locale === "fi" ? "Hinnoittelu" : "Pricing"}</Link>
        </Button>
      </div>
    </section>
  );
}
