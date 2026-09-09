"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { schedulePostAction } from "@/actions/creator-studio";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type SocialAccount = { id: string; platform: string; displayName: string };

export function SchedulePostForm({
  postId,
  socialAccounts,
}: {
  postId: string;
  socialAccounts: SocialAccount[];
}) {
  const t = useTranslations("creatorStudio.calendar");
  const router = useRouter();
  const [scheduledFor, setScheduledFor] = useState("");
  const [socialAccountId, setSocialAccountId] = useState(socialAccounts[0]?.id ?? "");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (socialAccounts.length === 0) {
    return <p className="text-xs text-muted-foreground">{t("noSocialAccounts")}</p>;
  }

  return (
    <div className="flex flex-wrap items-end gap-2">
      <div>
        <label className="mb-1 block text-xs font-medium">{t("scheduledForLabel")}</label>
        <Input
          type="datetime-local"
          value={scheduledFor}
          onChange={(e) => setScheduledFor(e.target.value)}
        />
      </div>
      <div>
        <label className="mb-1 block text-xs font-medium">{t("socialAccountLabel")}</label>
        <select
          className="h-9 rounded-md border bg-background px-3 text-sm"
          value={socialAccountId}
          onChange={(e) => setSocialAccountId(e.target.value)}
        >
          {socialAccounts.map((a) => (
            <option key={a.id} value={a.id}>
              {a.platform} — {a.displayName}
            </option>
          ))}
        </select>
      </div>
      <Button
        size="sm"
        disabled={pending || !scheduledFor}
        onClick={() =>
          startTransition(async () => {
            setError(null);
            const res = await schedulePostAction(postId, {
              scheduledFor: new Date(scheduledFor).toISOString(),
              socialAccountId,
            });
            if (res.error) setError(res.error);
            router.refresh();
          })
        }
      >
        {pending ? t("scheduling") : t("scheduleCta")}
      </Button>
      {error ? <p className="w-full text-sm text-destructive">{error}</p> : null}
    </div>
  );
}
