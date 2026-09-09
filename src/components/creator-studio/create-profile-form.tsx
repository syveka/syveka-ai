"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/i18n/routing";
import { createCreatorProfileAction } from "@/actions/creator-studio";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function CreateProfileForm() {
  const t = useTranslations("creatorStudio.characters");
  const router = useRouter();
  const [displayName, setDisplayName] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setError(null);
        startTransition(async () => {
          const res = await createCreatorProfileAction({ displayName });
          if (res.error) {
            setError(res.error);
            return;
          }
          setDisplayName("");
          if (res.id) router.push(`/creator-studio/characters/${res.id}`);
          router.refresh();
        });
      }}
      className="flex flex-wrap items-end gap-2"
    >
      <div className="min-w-48 flex-1">
        <label htmlFor="displayName" className="mb-1 block text-sm font-medium">
          {t("nameLabel")}
        </label>
        <Input
          id="displayName"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder={t("namePlaceholder")}
          required
          maxLength={120}
        />
      </div>
      <Button type="submit" disabled={pending || displayName.trim().length === 0}>
        {pending ? t("creating") : t("createCta")}
      </Button>
      {error ? <p className="w-full text-sm text-destructive">{error}</p> : null}
    </form>
  );
}
