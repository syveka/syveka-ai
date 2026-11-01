"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useLocale, useTranslations } from "next-intl";
import { CalendarClock } from "lucide-react";
import { Link, RTL_LOCALES } from "@/i18n/routing";
import { moveDealAction } from "@/actions/deals";
import { formatCents, formatDate, cn } from "@/lib/utils";
import { effectiveProbability, stageColumnTotals } from "@/lib/crm/deal-forecast";

export type BoardDeal = {
  id: string;
  title: string;
  valueCents: number;
  currency: string;
  /**
   * The deal's own stored probability (null = use the stage default). The
   * effective probability is derived from the column the card is in, so an
   * optimistic move re-weights the card under the target stage.
   */
  probabilityOverride: number | null;
  expectedCloseAt: string | null;
  isClosed: boolean;
  contactName: string | null;
  companyName: string | null;
  ownerName: string | null;
};

export type BoardStage = {
  id: string;
  name: string;
  probability: number;
  isWon: boolean;
  isLost: boolean;
  deals: BoardDeal[];
};

function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

/**
 * Kanban with native HTML drag & drop + optimistic move and rollback (§9, §21).
 * Cards accept drops too, so a deal can be inserted at a specific position.
 */
export function DealBoard({
  stages: initial,
  canWrite,
}: {
  stages: BoardStage[];
  canWrite: boolean;
}) {
  const t = useTranslations("crm");
  const locale = useLocale();
  const [stages, setStages] = useState(initial);
  // The board keeps a local copy for optimistic drag-and-drop, but the server
  // stays the source of truth: when the page is revalidated (a deal created,
  // edited or moved elsewhere) the new stages replace the copy. Without this a
  // newly created deal stayed invisible until a manual reload.
  const [serverStages, setServerStages] = useState(initial);
  if (initial !== serverStages) {
    setServerStages(initial);
    setStages(initial);
  }
  // A failed move falls back to the latest server data, not to the board as
  // it was at the drop: a refresh may have arrived meanwhile (a new deal, another
  // move), and the drop-time snapshot would hide it again.
  const latestServerStages = useRef(serverStages);
  useEffect(() => {
    latestServerStages.current = serverStages;
  }, [serverStages]);
  const [dragged, setDragged] = useState<{ dealId: string; fromStageId: string } | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const now = Date.now();
  // Columns always flow left to right (the board is dir="ltr"), but each
  // column's text follows the page direction so Arabic dates and totals
  // read correctly instead of being reordered by the LTR context.
  const columnDir = RTL_LOCALES.has(locale) ? "rtl" : "ltr";

  const onDrop = (toStageId: string, index?: number) => {
    const current = dragged;
    setDragged(null);
    setDropTarget(null);
    if (!current || !canWrite) return;
    const { dealId, fromStageId } = current;

    // optimistic move with rollback (§21)
    const prev = stages;
    let position = 0;
    const next = (() => {
      const fromStage = prev.find((s) => s.id === fromStageId);
      const deal = fromStage?.deals.find((d) => d.id === dealId);
      if (!deal) return prev;
      const removed = prev.map((s) =>
        s.id === fromStageId ? { ...s, deals: s.deals.filter((d) => d.id !== dealId) } : s,
      );
      return removed.map((s) => {
        if (s.id !== toStageId) return s;
        const at = Math.min(index ?? s.deals.length, s.deals.length);
        position = at;
        const target = prev.find((ts) => ts.id === toStageId);
        const moved: BoardDeal = {
          ...deal,
          isClosed: Boolean(target && (target.isWon || target.isLost)),
        };
        return { ...s, deals: [...s.deals.slice(0, at), moved, ...s.deals.slice(at)] };
      });
    })();
    if (next === prev && fromStageId === toStageId) return;
    setStages(next);

    startTransition(async () => {
      try {
        await moveDealAction({ dealId, stageId: toStageId, position });
      } catch {
        setStages(latestServerStages.current); // rollback to the server's view
      }
    });
  };

  return (
    // The board is the only horizontal scroller on the page; overscroll is
    // contained so a swipe past its end doesn't move the page or navigate.
    <div className="flex gap-3 overflow-x-auto overscroll-x-contain pb-4" dir="ltr">
      {stages.map((stage) => {
        const { totalValueCents: totalCents, weightedValueCents: weightedCents } =
          stageColumnTotals(
            stage,
            stage.deals.map((d) => ({ ...d, probability: d.probabilityOverride })),
          );
        return (
          <div
            key={stage.id}
            dir={columnDir}
            onDragOver={(e) => {
              e.preventDefault();
              setDropTarget(stage.id);
            }}
            onDragLeave={() => setDropTarget((cur) => (cur === stage.id ? null : cur))}
            onDrop={() => onDrop(stage.id)}
            className={cn(
              "flex w-72 shrink-0 flex-col rounded-lg border bg-muted/40",
              stage.isWon && "border-success/40",
              stage.isLost && "border-destructive/30",
              dropTarget === stage.id && dragged && "ring-2 ring-ring",
            )}
          >
            <div className="border-b px-3 py-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{stage.name}</span>
                <span className="text-xs text-muted-foreground">{stage.deals.length}</span>
              </div>
              <p className="mt-0.5 text-xs text-muted-foreground">
                {formatCents(totalCents, locale)}
                {weightedCents !== null ? (
                  <>
                    {" "}
                    · {t("weighted")} {formatCents(weightedCents, locale)}
                  </>
                ) : null}
              </p>
            </div>
            <div className="min-h-16 flex-1 space-y-2 p-2">
              {stage.deals.map((deal, index) => {
                const overdue =
                  !deal.isClosed &&
                  deal.expectedCloseAt !== null &&
                  new Date(deal.expectedCloseAt).getTime() < now;
                return (
                  <div
                    key={deal.id}
                    draggable={canWrite}
                    onDragStart={() => setDragged({ dealId: deal.id, fromStageId: stage.id })}
                    onDragEnd={() => {
                      setDragged(null);
                      setDropTarget(null);
                    }}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.stopPropagation();
                      onDrop(stage.id, index);
                    }}
                    className={cn(
                      "rounded-md border bg-card p-3 shadow-sm",
                      canWrite && "cursor-grab active:cursor-grabbing",
                      dragged?.dealId === deal.id && "opacity-50",
                    )}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <Link
                        href={`/crm/deals/${deal.id}`}
                        className="text-sm font-medium hover:underline"
                      >
                        {deal.title}
                      </Link>
                      {deal.ownerName ? (
                        <span
                          title={deal.ownerName}
                          className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground"
                        >
                          {initials(deal.ownerName)}
                        </span>
                      ) : null}
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">
                      {formatCents(deal.valueCents, locale, deal.currency)} ·{" "}
                      {effectiveProbability({ probability: deal.probabilityOverride }, stage)}%
                    </p>
                    {deal.contactName || deal.companyName ? (
                      <p className="mt-0.5 truncate text-xs text-muted-foreground">
                        {[deal.contactName, deal.companyName].filter(Boolean).join(" · ")}
                      </p>
                    ) : null}
                    {deal.expectedCloseAt ? (
                      <p
                        className={cn(
                          "mt-1 flex items-center gap-1 text-xs",
                          overdue ? "text-destructive" : "text-muted-foreground",
                        )}
                      >
                        <CalendarClock className="size-3" />
                        {formatDate(deal.expectedCloseAt, locale, { dateStyle: "medium" })}
                      </p>
                    ) : null}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}
