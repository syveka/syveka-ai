"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { setCampaignAutopilotAction } from "@/actions/creator-studio";
import { Button } from "@/components/ui/button";
import type { SocialPlatform } from "@prisma/client";

/** Phase 10: autopilot is opt-in and always ships with explicit, visible rules — never a silent toggle. */
export function AutopilotToggle({
  campaignId,
  enabled,
  targetPlatforms,
}: {
  campaignId: string;
  enabled: boolean;
  targetPlatforms: SocialPlatform[];
}) {
  const t = useTranslations("creatorStudio.campaigns.autopilot");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function toggle(next: boolean) {
    setError(null);
    startTransition(async () => {
      const res = await setCampaignAutopilotAction(campaignId, {
        enabled: next,
        rules: next
          ? {
              maxPostsPerWeek: 3,
              allowedPlatforms: targetPlatforms.length > 0 ? targetPlatforms : ["INSTAGRAM"],
              allowedTemplateCategories: [],
              allowedHoursStart: 8,
              allowedHoursEnd: 20,
              allowedLanguages: ["EN"],
            }
          : undefined,
      });
      if (res.error) setError(res.error);
      router.refresh();
    });
  }

  return (
    <div className="space-y-2 rounded-md border p-4">
      <div className="flex items-center justify-between">
        <div>
          <p className="font-medium">{t("title")}</p>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <Button
          variant={enabled ? "outline" : "default"}
          disabled={pending}
          onClick={() => toggle(!enabled)}
        >
          {enabled ? t("disable") : t("enable")}
        </Button>
      </div>
      {enabled ? <p className="text-xs text-muted-foreground">{t("defaultRules")}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
