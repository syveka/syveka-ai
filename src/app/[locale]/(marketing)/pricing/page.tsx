import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Plan names are product names and stay untranslated; every other string comes
// from the "marketing" message namespace.
const PLANS = [
  {
    name: "Free",
    priceEur: 0,
    seats: 2,
    aiMessages: 50,
    perUser: false,
    voiceMinutes: null,
    highlight: false,
  },
  {
    name: "Starter",
    priceEur: 29,
    seats: 10,
    aiMessages: 1000,
    perUser: true,
    voiceMinutes: 100,
    highlight: false,
  },
  {
    name: "Pro",
    priceEur: 79,
    seats: 50,
    aiMessages: 5000,
    perUser: true,
    voiceMinutes: 500,
    highlight: true,
  },
] as const;

export default async function PricingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const t = await getTranslations("marketing");
  // Latin digits in every locale so prices and limits read the same in AR.
  const numberFormat = new Intl.NumberFormat(locale === "ar" ? "ar-u-nu-latn" : locale);
  const priceFormat = new Intl.NumberFormat(locale === "ar" ? "ar-u-nu-latn" : locale, {
    style: "currency",
    currency: "EUR",
    maximumFractionDigits: 0,
  });

  return (
    <section className="container py-16">
      <h1 className="text-center text-4xl font-bold">{t("pricingTitle")}</h1>
      <p className="mt-2 text-center text-muted-foreground">{t("pricingSubtitle")}</p>
      <div className="mx-auto mt-10 grid max-w-4xl gap-6 md:grid-cols-3">
        {PLANS.map((p) => (
          <Card key={p.name} className={cn(p.highlight && "border-primary shadow-md")}>
            <CardHeader>
              <CardTitle className="flex items-baseline justify-between">
                {p.name}
                <span className="text-2xl">{priceFormat.format(p.priceEur)}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                <li>· {t("planSeats", { count: numberFormat.format(p.seats) })}</li>
                <li>
                  ·{" "}
                  {t(p.perUser ? "planAiMessagesPerUser" : "planAiMessages", {
                    count: numberFormat.format(p.aiMessages),
                  })}
                </li>
                <li>
                  ·{" "}
                  {p.voiceMinutes === null
                    ? t("planVoiceNone")
                    : t("planVoiceMinutes", { minutes: numberFormat.format(p.voiceMinutes) })}
                </li>
              </ul>
              <Button className="w-full" variant={p.highlight ? "default" : "outline"} asChild>
                <Link href="/register">{t("getStarted")}</Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="mt-8 text-center text-sm text-muted-foreground">
        {t("enterprise")}{" "}
        <a className="underline" href="mailto:sales@syveka.ai">
          sales@syveka.ai
        </a>
      </p>
    </section>
  );
}
