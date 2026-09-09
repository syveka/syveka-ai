"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import {
  connectSocialAccountAction,
  disconnectSocialAccountAction,
} from "@/actions/creator-studio";
import { Button } from "@/components/ui/button";

const PLATFORMS = ["INSTAGRAM", "FACEBOOK", "TIKTOK", "YOUTUBE"] as const;

export function ConnectSocialAccountForm() {
  const t = useTranslations("creatorStudio.socialAccounts");
  const router = useRouter();
  const [platform, setPlatform] = useState<(typeof PLATFORMS)[number]>("INSTAGRAM");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <label className="mb-1 block text-sm font-medium">{t("platformLabel")}</label>
        <select
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={platform}
          onChange={(e) => setPlatform(e.target.value as (typeof PLATFORMS)[number])}
        >
          {PLATFORMS.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
      </div>
      <Button
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await connectSocialAccountAction({
              platform,
              authCode: crypto.randomUUID(),
            });
            if (res.error) setError(res.error);
            router.refresh();
          })
        }
      >
        {pending ? t("connecting") : t("connectCta")}
      </Button>
      {error ? <p className="w-full text-sm text-destructive">{error}</p> : null}
      <p className="w-full text-xs text-muted-foreground">{t("mockNotice")}</p>
    </div>
  );
}

export function DisconnectSocialAccountButton({ accountId }: { accountId: string }) {
  const t = useTranslations("creatorStudio.socialAccounts");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await disconnectSocialAccountAction(accountId);
          router.refresh();
        })
      }
    >
      {t("disconnectCta")}
    </Button>
  );
}
