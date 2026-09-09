"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { createCampaignAction } from "@/actions/creator-studio";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function CreateCampaignForm() {
  const t = useTranslations("creatorStudio.campaigns");
  const router = useRouter();
  const [name, setName] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const res = await createCampaignAction({ name, approvalMode: "APPROVAL" });
          if (res.error) {
            setError(res.error);
            return;
          }
          setName("");
          router.refresh();
        });
      }}
      className="flex flex-wrap items-end gap-2"
    >
      <div className="min-w-48 flex-1">
        <label htmlFor="campaignName" className="mb-1 block text-sm font-medium">
          {t("nameLabel")}
        </label>
        <Input
          id="campaignName"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t("namePlaceholder")}
          required
          maxLength={200}
        />
      </div>
      <Button type="submit" disabled={pending || name.trim().length === 0}>
        {pending ? t("creating") : t("createCta")}
      </Button>
      {error ? <p className="w-full text-sm text-destructive">{error}</p> : null}
    </form>
  );
}
