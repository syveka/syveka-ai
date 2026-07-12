"use client";

import { useActionState } from "react";
import { useTranslations } from "next-intl";
import { Sparkles } from "lucide-react";
import { generateDealInsightsAction, type DealActionState } from "@/actions/deals";
import { Button } from "@/components/ui/button";

/** "Generate insights" button; the result lands on the timeline via revalidation. */
export function DealInsights({ dealId }: { dealId: string }) {
  const t = useTranslations("crm");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState<DealActionState, FormData>(
    generateDealInsightsAction.bind(null, dealId),
    {},
  );

  return (
    <form action={action} className="space-y-2">
      <Button type="submit" size="sm" variant="outline" disabled={pending} className="gap-2">
        <Sparkles className="size-4" />
        {pending ? t("generatingInsights") : t("generateInsights")}
      </Button>
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {tc("error")}
        </p>
      ) : null}
    </form>
  );
}
