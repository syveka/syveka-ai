"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { requestPostApprovalAction } from "@/actions/creator-studio";
import { Button } from "@/components/ui/button";

export function RequestApprovalButton({ postId }: { postId: string }) {
  const t = useTranslations("creatorStudio.library");
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          await requestPostApprovalAction(postId);
          router.refresh();
        })
      }
    >
      {t("requestApprovalCta")}
    </Button>
  );
}
