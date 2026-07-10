import { setRequestLocale } from "next-intl/server";
import { Link } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const PLANS = [
  { name: "Free", price: "0 €", seats: "2", ai: "50", voice: "—", highlight: false },
  {
    name: "Starter",
    price: "29 €",
    seats: "10",
    ai: "1 000 / user",
    voice: "100 min",
    highlight: false,
  },
  {
    name: "Pro",
    price: "79 €",
    seats: "50",
    ai: "5 000 / user",
    voice: "500 min",
    highlight: true,
  },
] as const;

export default async function PricingPage({ params }: { params: Promise<{ locale: string }> }) {
  const { locale } = await params;
  setRequestLocale(locale);
  const fi = locale === "fi";

  return (
    <section className="container py-16">
      <h1 className="text-center text-4xl font-bold">{fi ? "Hinnoittelu" : "Pricing"}</h1>
      <p className="mt-2 text-center text-muted-foreground">
        {fi
          ? "Hinnat / käyttäjä / kk + ALV. 14 päivän ilmainen Pro-kokeilu."
          : "Per user / month + VAT. 14-day free Pro trial."}
      </p>
      <div className="mx-auto mt-10 grid max-w-4xl gap-6 md:grid-cols-3">
        {PLANS.map((p) => (
          <Card key={p.name} className={cn(p.highlight && "border-primary shadow-md")}>
            <CardHeader>
              <CardTitle className="flex items-baseline justify-between">
                {p.name}
                <span className="text-2xl">{p.price}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                <li>
                  · {p.seats} {fi ? "käyttäjää" : "seats"}
                </li>
                <li>
                  · {p.ai} {fi ? "AI-viestiä/kk" : "AI messages/mo"}
                </li>
                <li>
                  · {fi ? "Puheavustaja" : "Voice AI"}: {p.voice}
                </li>
              </ul>
              <Button className="w-full" variant={p.highlight ? "default" : "outline"} asChild>
                <Link href="/register">{fi ? "Aloita" : "Get started"}</Link>
              </Button>
            </CardContent>
          </Card>
        ))}
      </div>
      <p className="mt-8 text-center text-sm text-muted-foreground">
        Enterprise:{" "}
        <a className="underline" href="mailto:sales@syveka.ai">
          sales@syveka.ai
        </a>
      </p>
    </section>
  );
}
