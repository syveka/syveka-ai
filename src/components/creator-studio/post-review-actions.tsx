"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { reviewCreatorPostAction } from "@/actions/creator-studio";
import { Button } from "@/components/ui/button";

export function PostReviewActions({ postId }: { postId: string }) {
  const t = useTranslations("creatorStudio.approvals");
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function review(decision: "APPROVE" | "REJECT" | "REQUEST_CHANGES") {
    setError(null);
    startTransition(async () => {
      const res = await reviewCreatorPostAction(postId, { decision });
      if (res.error) setError(res.error);
      router.refresh();
    });
  }

  return (
    <div className="space-y-1">
      <div className="flex gap-2">
        <Button size="sm" disabled={pending} onClick={() => review("APPROVE")}>
          {t("approve")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={pending}
          onClick={() => review("REQUEST_CHANGES")}
        >
          {t("requestChanges")}
        </Button>
        <Button size="sm" variant="outline" disabled={pending} onClick={() => review("REJECT")}>
          {t("reject")}
        </Button>
      </div>
      {error ? <p className="text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
