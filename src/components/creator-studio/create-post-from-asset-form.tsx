"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { createCreatorPostAction } from "@/actions/creator-studio";
import { Button } from "@/components/ui/button";

const PLATFORMS = ["INSTAGRAM", "FACEBOOK", "TIKTOK", "YOUTUBE"] as const;

export function CreatePostFromAssetForm({ assetId }: { assetId: string }) {
  const t = useTranslations("creatorStudio.library");
  const router = useRouter();
  const [platform, setPlatform] = useState<(typeof PLATFORMS)[number]>("INSTAGRAM");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  if (done) return <p className="text-xs text-success">{t("addedToCampaign")}</p>;

  return (
    <div className="flex items-center gap-1">
      <select
        className="h-8 rounded-md border bg-background px-2 text-xs"
        value={platform}
        onChange={(e) => setPlatform(e.target.value as (typeof PLATFORMS)[number])}
      >
        {PLATFORMS.map((p) => (
          <option key={p} value={p}>
            {p}
          </option>
        ))}
      </select>
      <Button
        size="sm"
        variant="outline"
        disabled={pending}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await createCreatorPostAction({ assetIds: [assetId], platform });
            if (res.error) setError(res.error);
            else setDone(true);
            router.refresh();
          })
        }
      >
        {pending ? t("adding") : t("createPostCta")}
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </div>
  );
}
