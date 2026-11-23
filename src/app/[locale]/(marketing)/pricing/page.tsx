import { getTranslations, setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { PLAN_NAMES } from "@/components/billing/plan-display";
import {
  HIGHLIGHTED_PLAN,
  PLAN_LIMITS,
  PLAN_MONTHLY_PRICE_EUR,
  PRICING_PAGE_PLANS,
} from "@/lib/billing/plan-catalog";

// Plan names are product names and stay untranslated; every other string comes
// from the "marketing" message namespace. Prices and limits come from the plan
// catalog, the same source entitlements use. Voice minutes are not listed:
// voice is not part of the current offer.
const PLANS = PRICING_PAGE_PLANS.map((plan) => {
  const limits = PLAN_LIMITS[plan];
  return {
    name: PLAN_NAMES[plan],
    priceEur: PLAN_MONTHLY_PRICE_EUR[plan],
    seats: limits.maxSeats,
    aiMessages: limits.aiMessagesPerOrgMonth,
    highlight: plan === HIGHLIGHTED_PLAN,
  };
});

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
      <div className="mx-auto mt-10 flex max-w-4xl flex-wrap justify-center gap-6">
        {PLANS.map((p) => (
          <Card
            key={p.name}
            className={cn("w-full md:w-72", p.highlight && "border-primary shadow-md")}
          >
            <CardHeader>
              <CardTitle className="flex items-baseline justify-between">
                {p.name}
                <span className="text-2xl">{priceFormat.format(p.priceEur)}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                <li>· {t("planSeats", { count: numberFormat.format(p.seats) })}</li>
                <li>· {t("planAiMessages", { count: numberFormat.format(p.aiMessages) })}</li>
              </ul>
              <Button className="w-full" variant={p.highlight ? "default" : "outline"} asChild>
                <Link href="/register">{t("getStarted")}</Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="mt-8 text-center text-sm text-muted-foreground">
        {t("pricingContact")}{" "}
        <a className="underline" href="mailto:sales@syveka.ai">
          sales@syveka.ai
        </a>
      </p>
    </section>
  );
}
