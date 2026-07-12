"use client";

import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Archive, ArchiveRestore, Trash2 } from "lucide-react";
import { useRouter } from "@/i18n/routing";
import { Button } from "@/components/ui/button";

export function EntityActions({
  archived,
  canWrite,
  canDelete,
  archiveAction,
  restoreAction,
  deleteAction,
  afterDeleteHref,
}: {
  archived: boolean;
  canWrite: boolean;
  canDelete: boolean;
  archiveAction?: () => Promise<void>;
  restoreAction?: () => Promise<void>;
  deleteAction: () => Promise<void>;
  afterDeleteHref: string;
}) {
  const t = useTranslations("crm");
  const tc = useTranslations("common");
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [pending, startTransition] = useTransition();

  if (!canWrite && !canDelete) return null;

  if (confirming) {
    return (
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">{t("confirmDelete")}</span>
        <Button
          variant="destructive"
          size="sm"
          disabled={pending}
          onClick={() =>
            startTransition(async () => {
              await deleteAction();
              router.push(afterDeleteHref);
            })
          }
        >
          {pending ? tc("loading") : tc("delete")}
        </Button>
        <Button variant="ghost" size="sm" disabled={pending} onClick={() => setConfirming(false)}>
          {tc("cancel")}
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      {canWrite ? (
        archived && restoreAction ? (
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={pending}
            onClick={() => startTransition(async () => restoreAction())}
          >
            <ArchiveRestore className="size-4" />
            {t("restore")}
          </Button>
        ) : !archived && archiveAction ? (
          <Button
            variant="outline"
            size="sm"
            className="gap-2"
            disabled={pending}
            onClick={() => startTransition(async () => archiveAction())}
          >
            <Archive className="size-4" />
            {t("archive")}
          </Button>
        ) : null
      ) : null}
      {canDelete ? (
        <Button
          variant="ghost"
          size="sm"
          className="gap-2 text-destructive"
          disabled={pending}
          onClick={() => setConfirming(true)}
        >
          <Trash2 className="size-4" />
          {tc("delete")}
        </Button>
      ) : null}
    </div>
  );
}
