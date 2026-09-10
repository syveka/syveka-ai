"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { confirmConsentAction } from "@/actions/creator-studio";
import { Button } from "@/components/ui/button";

export function ConsentButton({ profileId }: { profileId: string }) {
  const t = useTranslations("creatorStudio.characters");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{t("consentText")}</p>
      <Button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await confirmConsentAction(profileId);
            if (res.error) setError(res.error);
            router.refresh();
          })
        }
      >
        {pending ? t("confirming") : t("confirmConsentCta")}
      </Button>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
