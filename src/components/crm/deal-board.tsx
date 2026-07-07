"use client";

import { useState, useTransition } from "react";
import { useLocale } from "next-intl";
import { moveDealAction } from "@/actions/deals";
import { formatCents, cn } from "@/lib/utils";

type Deal = { id: string; title: string; valueCents: number; contactName: string | null };
type Stage = { id: string; name: string; isWon: boolean; isLost: boolean; deals: Deal[] };

/**
 * Kanban with native HTML drag & drop + optimistic move (§9, §21).
 * (dnd-kit upgrade is a drop-in swap; native DnD keeps the bundle lean at MVP.)
 */
export function DealBoard({ stages: initial, canWrite }: { stages: Stage[]; canWrite: boolean }) {
  const locale = useLocale();
  const [stages, setStages] = useState(initial);
  const [dragged, setDragged] = useState<{ dealId: string; fromStageId: string } | null>(null);
  const [, startTransition] = useTransition();

  const onDrop = (toStageId: string) => {
    if (!dragged || !canWrite || dragged.fromStageId === toStageId) {
      setDragged(null);
      return;
    }
    const { dealId, fromStageId } = dragged;
    setDragged(null);

    // optimistic move with rollback (§21)
    const prev = stages;
    setStages((cur) => {
      const deal = cur.find((s) => s.id === fromStageId)?.deals.find((d) => d.id === dealId);
      if (!deal) return cur;
      return cur.map((s) => {
        if (s.id === fromStageId) return { ...s, deals: s.deals.filter((d) => d.id !== dealId) };
        if (s.id === toStageId) return { ...s, deals: [deal, ...s.deals] };
        return s;
      });
    });

    startTransition(async () => {
      try {
        await moveDealAction({ dealId, stageId: toStageId });
      } catch {
        setStages(prev); // rollback
      }
    });
  };

  return (
    <div className="flex gap-3 overflow-x-auto pb-4">
      {stages.map((stage) => (
        <div
          key={stage.id}
          onDragOver={(e) => e.preventDefault()}
          onDrop={() => onDrop(stage.id)}
          className={cn(
            "flex w-64 shrink-0 flex-col rounded-lg border bg-muted/40",
            stage.isWon && "border-success/40",
            stage.isLost && "border-destructive/30",
          )}
        >
          <div className="flex items-center justify-between border-b px-3 py-2">
            <span className="text-sm font-medium">{stage.name}</span>
            <span className="text-xs text-muted-foreground">{stage.deals.length}</span>
          </div>
          <div className="flex-1 space-y-2 p-2">
            {stage.deals.map((deal) => (
              <div
                key={deal.id}
                draggable={canWrite}
                onDragStart={() => setDragged({ dealId: deal.id, fromStageId: stage.id })}
                className={cn(
                  "rounded-md border bg-card p-3 shadow-sm",
                  canWrite && "cursor-grab active:cursor-grabbing",
                )}
              >
                <p className="text-sm font-medium">{deal.title}</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  {formatCents(deal.valueCents, locale)}
                  {deal.contactName ? ` · ${deal.contactName}` : ""}
                </p>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
