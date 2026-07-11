"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { Plan } from "@prisma/client";
import { startCheckoutAction } from "@/actions/billing";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";

const PLANS: Array<{ plan: Plan; monthly: number; features: string[] }> = [
  {
    plan: "STARTER",
    monthly: 29,
    features: [
      "1000 AI msg/user",
      "1 voice assistant · 100 min",
      "1 GB KB",
      "5 workflows",
      "5000 contacts",
    ],
  },
  {
    plan: "PRO",
    monthly: 79,
    features: [
      "5000 AI msg/user",
      "3 voice assistants · 500 min",
      "10 GB KB",
      "25 workflows",
      "API + webhooks",
      "2y audit log",
    ],
  },
];

export function PlanCards({ currentPlan }: { currentPlan: Plan }) {
  const t = useTranslations("billingPage");
  const [interval, setInterval] = useState<"monthly" | "annual">("monthly");

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <h2 className="flex-1 text-lg font-semibold">{t("plans")}</h2>
        <div className="flex rounded-md border p-0.5 text-sm">
          {(["monthly", "annual"] as const).map((i) => (
            <button
              key={i}
              onClick={() => setInterval(i)}
              className={cn(
                "rounded px-3 py-1",
                interval === i ? "bg-primary text-primary-foreground" : "text-muted-foreground",
              )}
            >
              {t(`interval.${i}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {PLANS.map(({ plan, monthly, features }) => {
          const price = interval === "annual" ? Math.round((monthly * 10) / 12) : monthly;
          const isCurrent = plan === currentPlan;
          return (
            <Card key={plan} className={cn(isCurrent && "border-primary")}>
              <CardHeader>
                <CardTitle className="flex items-baseline justify-between">
                  <span>{plan}</span>
                  <span className="text-base font-normal text-muted-foreground">
                    {price} €/{t("perUserMonth")}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {features.map((f) => (
                    <li key={f}>· {f}</li>
                  ))}
                </ul>
                <form action={startCheckoutAction.bind(null, plan, interval)}>
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={isCurrent}
                    variant={isCurrent ? "outline" : "default"}
                  >
                    {isCurrent ? t("current") : t("choosePlan")}
                  </Button>
                </form>
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
