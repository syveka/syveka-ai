import { describe, expect, it } from "vitest";
import {
  effectiveProbability,
  expectedRevenueCents,
  isOpenDeal,
  stageColumnTotals,
  summarizeOpenPipeline,
  weightedValueCents,
} from "@/lib/crm/deal-forecast";

/**
 * The single forecast contract shared by deal detail, the deals board and
 * the dashboard. Synthetic fixtures only.
 */
const CONTACTED = { probability: 25, isWon: false, isLost: false };
const PROPOSAL = { probability: 50, isWon: false, isLost: false };
const WON = { probability: 100, isWon: true, isLost: false };
const LOST = { probability: 0, isWon: false, isLost: true };

describe("effective probability", () => {
  it("uses the explicit deal override over the stage default (50% vs stage 25%)", () => {
    expect(effectiveProbability({ probability: 50 }, CONTACTED)).toBe(50);
    expect(weightedValueCents({ valueCents: 100_000, probability: 50 }, CONTACTED)).toBe(50_000);
  });

  it("honours an explicit 0% override instead of falling back to the stage", () => {
    expect(effectiveProbability({ probability: 0 }, CONTACTED)).toBe(0);
    expect(weightedValueCents({ valueCents: 100_000, probability: 0 }, CONTACTED)).toBe(0);
  });

  it("falls back to the stage default when no override is stored", () => {
    expect(effectiveProbability({ probability: null }, CONTACTED)).toBe(25);
    expect(weightedValueCents({ valueCents: 100_000, probability: null }, CONTACTED)).toBe(25_000);
  });

  it("pins won to 100% and lost to 0% regardless of override", () => {
    expect(effectiveProbability({ probability: 50 }, WON)).toBe(100);
    expect(effectiveProbability({ probability: 50 }, LOST)).toBe(0);
  });

  it("rounds weighted cents per deal", () => {
    expect(expectedRevenueCents(333, 33)).toBe(110);
  });
});

describe("open pipeline summary", () => {
  const open = (valueCents: number, probability: number | null) => ({
    valueCents,
    probability,
    closedAt: null,
  });
  const closedAt = new Date("2026-10-01T00:00:00Z");

  it("sums distinct open deals with their own probabilities and excludes closed deals", () => {
    const summary = summarizeOpenPipeline([
      { deal: open(100_000, 50), stage: CONTACTED }, // 50_000
      { deal: open(40_000, null), stage: CONTACTED }, // 10_000
      { deal: open(30_000, 0), stage: CONTACTED }, // 0
      { deal: open(20_000, null), stage: PROPOSAL }, // 10_000
      { deal: { valueCents: 900_000, probability: null, closedAt }, stage: WON },
      { deal: { valueCents: 70_000, probability: 10, closedAt }, stage: LOST },
    ]);
    expect(summary).toEqual({
      openCount: 4,
      openValueCents: 190_000,
      forecastValueCents: 70_000,
    });
  });

  it("moving a deal open -> won/lost removes it from the open forecast", () => {
    const before = summarizeOpenPipeline([
      { deal: open(100_000, 50), stage: CONTACTED },
      { deal: open(20_000, null), stage: PROPOSAL },
    ]);
    const afterWon = summarizeOpenPipeline([
      { deal: { valueCents: 100_000, probability: 50, closedAt }, stage: WON },
      { deal: open(20_000, null), stage: PROPOSAL },
    ]);
    const afterLost = summarizeOpenPipeline([
      { deal: { valueCents: 100_000, probability: 50, closedAt }, stage: LOST },
      { deal: open(20_000, null), stage: PROPOSAL },
    ]);
    expect(before.forecastValueCents).toBe(60_000);
    expect(afterWon).toEqual({ openCount: 1, openValueCents: 20_000, forecastValueCents: 10_000 });
    expect(afterLost).toEqual(afterWon);
  });

  it("treats a closedAt timestamp as closed even in an open stage", () => {
    expect(isOpenDeal({ closedAt }, CONTACTED)).toBe(false);
    expect(isOpenDeal({ closedAt: null }, WON)).toBe(false);
    expect(isOpenDeal({ closedAt: null }, CONTACTED)).toBe(true);
  });
});

describe("board column totals", () => {
  it("Won header total equals the sum of its (closed) cards and has no weighted value", () => {
    expect(
      stageColumnTotals(WON, [
        { valueCents: 100_000, probability: 50, isClosed: true },
        { valueCents: 25_000, probability: null, isClosed: true },
      ]),
    ).toEqual({ totalValueCents: 125_000, weightedValueCents: null });
  });

  it("open column header equals its cards under the shared contract", () => {
    expect(
      stageColumnTotals(CONTACTED, [
        { valueCents: 100_000, probability: 50, isClosed: false },
        { valueCents: 40_000, probability: null, isClosed: false },
        { valueCents: 30_000, probability: 0, isClosed: false },
      ]),
    ).toEqual({ totalValueCents: 170_000, weightedValueCents: 60_000 });
  });
});
