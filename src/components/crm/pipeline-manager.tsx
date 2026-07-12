"use client";

import { useActionState, useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { Settings2, Trash2 } from "lucide-react";
import {
  createStageAction,
  deleteStageAction,
  updateStageAction,
  type DealActionState,
} from "@/actions/deals";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type ManagedStage = {
  id: string;
  name: string;
  probability: number;
  isWon: boolean;
  isLost: boolean;
  dealCount: number;
};

const selectClass = "h-9 rounded-md border border-input bg-transparent px-3 text-sm";

function stageKind(stage: ManagedStage): "open" | "won" | "lost" {
  if (stage.isWon) return "won";
  if (stage.isLost) return "lost";
  return "open";
}

function StageRow({ stage }: { stage: ManagedStage }) {
  const t = useTranslations("crm");
  const tc = useTranslations("common");
  const [state, action, pending] = useActionState<DealActionState, FormData>(
    updateStageAction.bind(null, stage.id),
    {},
  );
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleting, startDelete] = useTransition();

  return (
    <div className="space-y-1">
      <form action={action} className="flex flex-wrap items-center gap-2">
        <Input name="name" defaultValue={stage.name} required className="w-40 flex-1" />
        <Input
          name="probability"
          type="number"
          min="0"
          max="100"
          defaultValue={stage.probability}
          className="w-20"
          aria-label={t("dealFields.probability")}
        />
        <select
          name="kind"
          defaultValue={stageKind(stage)}
          className={selectClass}
          aria-label={t("stageKind")}
        >
          <option value="open">{t("stageKinds.open")}</option>
          <option value="won">{t("stageKinds.won")}</option>
          <option value="lost">{t("stageKinds.lost")}</option>
        </select>
        <Button type="submit" size="sm" variant="outline" disabled={pending}>
          {pending ? tc("loading") : tc("save")}
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={deleting || stage.dealCount > 0}
          title={stage.dealCount > 0 ? t("stageHasDeals") : undefined}
          onClick={() =>
            startDelete(async () => {
              const result = await deleteStageAction(stage.id);
              setDeleteError(result.error ?? null);
            })
          }
        >
          <Trash2 className="size-4" />
        </Button>
      </form>
      {state.error || deleteError ? (
        <p role="alert" className="text-sm text-destructive">
          {deleteError === "stage_has_deals" || state.error === "stage_has_deals"
            ? t("stageHasDeals")
            : deleteError === "last_open_stage"
              ? t("lastOpenStage")
              : tc("error")}
        </p>
      ) : null}
    </div>
  );
}

export function PipelineManager({ stages }: { stages: ManagedStage[] }) {
  const t = useTranslations("crm");
  const tc = useTranslations("common");
  const [open, setOpen] = useState(false);
  const [state, createAction, creating] = useActionState<DealActionState, FormData>(
    createStageAction,
    {},
  );

  if (!open) {
    return (
      <Button variant="outline" onClick={() => setOpen(true)} className="gap-2">
        <Settings2 className="size-4" />
        {t("editStages")}
      </Button>
    );
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={(e) => e.target === e.currentTarget && setOpen(false)}
      role="dialog"
      aria-modal="true"
    >
      <Card className="max-h-full w-full max-w-lg overflow-y-auto">
        <CardHeader>
          <CardTitle>{t("editStages")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-3">
            {stages.map((stage) => (
              <StageRow key={stage.id} stage={stage} />
            ))}
          </div>

          <form action={createAction} className="flex flex-wrap items-center gap-2 border-t pt-4">
            <Input
              name="name"
              required
              placeholder={t("newStagePlaceholder")}
              className="w-40 flex-1"
            />
            <Input
              name="probability"
              type="number"
              min="0"
              max="100"
              defaultValue={0}
              className="w-20"
              aria-label={t("dealFields.probability")}
            />
            <select
              name="kind"
              defaultValue="open"
              className={selectClass}
              aria-label={t("stageKind")}
            >
              <option value="open">{t("stageKinds.open")}</option>
              <option value="won">{t("stageKinds.won")}</option>
              <option value="lost">{t("stageKinds.lost")}</option>
            </select>
            <Button type="submit" size="sm" disabled={creating}>
              {creating ? tc("loading") : t("addStage")}
            </Button>
          </form>
          {state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {state.error === "invalid_input" ? t("invalidInput") : tc("error")}
            </p>
          ) : null}

          <div className="flex justify-end">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {tc("close")}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
