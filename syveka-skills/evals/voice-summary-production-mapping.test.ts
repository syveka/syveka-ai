import { describe, expect, it } from "vitest";
import {
  buildSkillInputFromNormalizedCall,
  mapProductionLocaleToSkillLanguage,
  mapSkillOutputToProductionAnalysis,
} from "../providers/voice-summary/production-mapping.js";
import {
  callSummaryInputSchema,
  type CallSummaryOutput,
} from "../providers/voice-summary/schema.js";

/**
 * Unit tests for the pure production<->Skill mapping helpers
 * (providers/voice-summary/production-mapping.ts). These helpers are NOT
 * connected to src/app/api/v1/jobs/post-call/route.ts - see
 * docs/skills/voice-call-summary.md "Production integration adapter".
 */

describe("mapProductionLocaleToSkillLanguage", () => {
  it("EN -> en, FI -> fi", () => {
    expect(mapProductionLocaleToSkillLanguage("EN")).toBe("en");
    expect(mapProductionLocaleToSkillLanguage("FI")).toBe("fi");
  });

  it(
    "AR -> unknown (NOT en) - deliberately does not repeat production's own " +
      "current AR-collapses-to-English behavior",
    () => {
      expect(mapProductionLocaleToSkillLanguage("AR")).toBe("unknown");
    },
  );
});

describe("buildSkillInputFromNormalizedCall", () => {
  it("produces a schema-valid CallSummaryInput from normalized production fields", () => {
    const fields = buildSkillInputFromNormalizedCall({
      transcriptText: "Caller asked about billing.",
      callId: "call-map-1",
      locale: "FI",
      durationSeconds: 90,
    });
    expect(callSummaryInputSchema.safeParse(fields).success).toBe(true);
    expect(fields.language).toBe("fi");
    expect(fields.metadata).toEqual({ durationSeconds: 90 });
  });

  it("omits metadata entirely when no durationSeconds is available", () => {
    const fields = buildSkillInputFromNormalizedCall({
      transcriptText: "Short call.",
      callId: "call-map-2",
      locale: "EN",
    });
    expect(fields.metadata).toBeUndefined();
    expect(callSummaryInputSchema.safeParse(fields).success).toBe(true);
  });
});

describe("mapSkillOutputToProductionAnalysis", () => {
  const BASE_OUTPUT: CallSummaryOutput = {
    summary: "Caller asked about their invoice.",
    callerIntent: "Invoice inquiry",
    keyFacts: ["Invoice not received"],
    actionItems: ["Email invoice copy"],
    followUpRequired: true,
    urgency: "medium",
    language: "en",
    confidence: "high",
  };

  it("maps summary directly and actionItems into followUps", () => {
    const result = mapSkillOutputToProductionAnalysis(BASE_OUTPUT);
    expect(result.fields.summary).toBe(BASE_OUTPUT.summary);
    expect(result.fields.followUps).toEqual(["Email invoice copy"]);
  });

  it("sentiment is always null - never fabricated from urgency or any other field", () => {
    const result = mapSkillOutputToProductionAnalysis(BASE_OUTPUT);
    expect(result.fields.sentiment).toBeNull();
    expect(result.warnings.some((w) => w.toLowerCase().includes("sentiment"))).toBe(true);
  });

  it("truncates actionItems beyond production's 5-item followUps limit, with an explicit warning (never a silent drop)", () => {
    const output: CallSummaryOutput = {
      ...BASE_OUTPUT,
      actionItems: ["a1", "a2", "a3", "a4", "a5", "a6", "a7"],
    };
    const result = mapSkillOutputToProductionAnalysis(output);
    expect(result.fields.followUps).toHaveLength(5);
    expect(result.fields.followUps).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    expect(result.warnings.some((w) => w.includes("truncated"))).toBe(true);
  });

  it("flags unmapped 'uncertain' items with a warning rather than silently discarding them", () => {
    const output: CallSummaryOutput = { ...BASE_OUTPUT, uncertain: ["caller's account number"] };
    const result = mapSkillOutputToProductionAnalysis(output);
    expect(result.warnings.some((w) => w.includes("uncertain"))).toBe(true);
  });

  it("is pure: identical input always produces an identical result", () => {
    const a = mapSkillOutputToProductionAnalysis(BASE_OUTPUT);
    const b = mapSkillOutputToProductionAnalysis(BASE_OUTPUT);
    expect(a).toEqual(b);
  });
});
