/**
 * Single calculation contract for deal forecasting, shared by the deal detail
 * page, the deals board (column headers and page header) and the dashboard.
 *
 * - Effective probability: won stage = 100, lost stage = 0; otherwise the
 *   deal's explicit override when one is stored (including an explicit 0),
 *   else the stage default.
 * - Weighted value = round(valueCents × effective probability / 100), in
 *   integer cents, rounded per deal before summing.
 * - Open pipeline / forecast totals include only open deals: not in a won or
 *   lost stage and without `closedAt`. Closed deals never inflate them.
 *
 * Totals sum `valueCents` as stored, exactly like the views did before; no
 * currency conversion happens here.
 */

export type ForecastStage = { probability: number; isWon: boolean; isLost: boolean };
export type ForecastDeal = { valueCents: number; probability: number | null };

export function isClosedStage(stage: { isWon: boolean; isLost: boolean }): boolean {
  return stage.isWon || stage.isLost;
}

/** Effective win probability: won=100, lost=0, else deal override or stage default. */
export function effectiveProbability(
  deal: { probability: number | null },
  stage: ForecastStage,
): number {
  if (stage.isWon) return 100;
  if (stage.isLost) return 0;
  return deal.probability ?? stage.probability;
}

/** Probability-weighted revenue in cents. */
export function expectedRevenueCents(valueCents: number, probability: number): number {
  return Math.round((valueCents * probability) / 100);
}

/** Weighted value of one deal under the effective probability. */
export function weightedValueCents(deal: ForecastDeal, stage: ForecastStage): number {
  return expectedRevenueCents(deal.valueCents, effectiveProbability(deal, stage));
}

/** True when the deal counts towards the open pipeline and forecast. */
export function isOpenDeal(
  deal: { closedAt: Date | string | null },
  stage: { isWon: boolean; isLost: boolean },
): boolean {
  return !isClosedStage(stage) && deal.closedAt === null;
}

/** Open pipeline value and weighted forecast over (deal, stage) pairs. */
export function summarizeOpenPipeline(
  items: Iterable<{
    deal: ForecastDeal & { closedAt: Date | string | null };
    stage: ForecastStage;
  }>,
): { openCount: number; openValueCents: number; forecastValueCents: number } {
  let openCount = 0;
  let openValueCents = 0;
  let forecastValueCents = 0;
  for (const { deal, stage } of items) {
    if (!isOpenDeal(deal, stage)) continue;
    openCount += 1;
    openValueCents += deal.valueCents;
    forecastValueCents += weightedValueCents(deal, stage);
  }
  return { openCount, openValueCents, forecastValueCents };
}

/**
 * Board column header totals. `totalValueCents` is the sum of every card in
 * the column (so a Won column shows its won value); `weightedValueCents` is
 * the forecast of the column's open cards and is null for won/lost columns,
 * which are not part of the forecast.
 */
export function stageColumnTotals(
  stage: ForecastStage,
  deals: (ForecastDeal & { isClosed: boolean })[],
): { totalValueCents: number; weightedValueCents: number | null } {
  const totalValueCents = deals.reduce((sum, d) => sum + d.valueCents, 0);
  if (isClosedStage(stage)) return { totalValueCents, weightedValueCents: null };
  const weighted = deals
    .filter((d) => !d.isClosed)
    .reduce((sum, d) => sum + weightedValueCents(d, stage), 0);
  return { totalValueCents, weightedValueCents: weighted };
}
