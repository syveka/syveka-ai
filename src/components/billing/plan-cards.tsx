"use client";

import { useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import type { Plan } from "@/generated/prisma/client/client";
import { startCheckoutAction } from "@/actions/billing";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import { formatCount, PLAN_NAMES } from "./plan-display";
import {
  displayedMonthlyPriceEur,
  PLAN_CARD_EXTRAS,
  PLAN_LIMITS,
  SELF_SERVE_PLANS,
  type SelfServePlan,
} from "@/lib/billing/plan-catalog";

type Limits = {
  aiMessages: number;
  voiceAssistants: number;
  voiceMinutes: number;
  knowledgeBaseGb: number;
  workflows: number;
  contacts?: number;
  apiWebhooks?: boolean;
  auditRetentionYears?: number;
};

/** In-app plan cards, derived from the plan catalog (same source as entitlements). */
const PLANS: Array<{ plan: SelfServePlan; limits: Limits }> = SELF_SERVE_PLANS.map((plan) => {
  const l = PLAN_LIMITS[plan];
  const extras = PLAN_CARD_EXTRAS[plan];
  return {
    plan,
    limits: {
      aiMessages: l.aiMessagesPerOrgMonth,
      voiceAssistants: l.voiceAssistants,
      voiceMinutes: l.voiceMinutesMonth,
      knowledgeBaseGb: l.kbStorageMb / 1_024,
      workflows: l.activeWorkflows,
      contacts: extras.contacts ? l.maxContacts : undefined,
      apiWebhooks: extras.apiWebhooks && l.apiAccess ? true : undefined,
      auditRetentionYears: extras.auditRetention ? l.auditRetentionDays / 365 : undefined,
    },
  };
});

export function PlanCards({ currentPlan }: { currentPlan: Plan }) {
  const t = useTranslations("billingPage");
  const locale = useLocale();
  const n = (value: number) => formatCount(locale, value);
  const featureLines = (l: Limits) =>
    [
      t("features.aiMessages", { count: n(l.aiMessages) }),
      t("features.voice", {
        assistants: l.voiceAssistants,
        assistantsText: n(l.voiceAssistants),
        minutes: n(l.voiceMinutes),
      }),
      t("features.knowledgeBase", { gb: n(l.knowledgeBaseGb) }),
      t("features.workflows", { count: n(l.workflows) }),
      l.contacts !== undefined ? t("features.contacts", { count: n(l.contacts) }) : null,
      l.apiWebhooks ? t("features.apiWebhooks") : null,
      l.auditRetentionYears !== undefined
        ? t("features.auditRetention", {
            years: l.auditRetentionYears,
            yearsText: n(l.auditRetentionYears),
          })
        : null,
    ].filter((line): line is string => line !== null);
  const [interval, setInterval] = useState<"monthly" | "annual">("monthly");

  return (
    <div className="space-y-3">
      {/* Stacked on narrow screens so long labels (e.g. Finnish) get the full row. */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <h2 className="text-lg font-semibold">{t("plans")}</h2>
        <div
          role="group"
          aria-label={t("intervalLabel")}
          className="grid grid-cols-2 gap-1 rounded-md border p-1 text-sm"
        >
          {(["monthly", "annual"] as const).map((i) => (
            <button
              key={i}
              type="button"
              aria-pressed={interval === i}
              onClick={() => setInterval(i)}
              className={cn(
                "min-h-11 rounded px-3 py-1.5 text-center leading-snug focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-9",
                interval === i ? "bg-primary text-primary-foreground" : "text-muted-foreground",
              )}
            >
              {t(`interval.${i}`)}
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        {PLANS.map(({ plan, limits }) => {
          const price = displayedMonthlyPriceEur(plan, interval);
          const isCurrent = plan === currentPlan;
          return (
            <Card key={plan} className={cn(isCurrent && "border-primary")}>
              <CardHeader>
                <CardTitle className="flex items-baseline justify-between">
                  <span>{PLAN_NAMES[plan]}</span>
                  <span className="text-base font-normal text-muted-foreground">
                    {n(price)} €/{t("perUserMonth")}
                  </span>
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <ul className="space-y-1 text-sm text-muted-foreground">
                  {featureLines(limits).map((f) => (
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
