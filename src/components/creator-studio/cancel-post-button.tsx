"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { cancelScheduledPostAction } from "@/actions/creator-studio";
import { Button } from "@/components/ui/button";

export function CancelPostButton({ postId }: { postId: string }) {
  const t = useTranslations("creatorStudio.calendar");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await cancelScheduledPostAction(postId);
          router.refresh();
        })
      }
    >
      {t("cancelCta")}
    </Button>
  );
}
