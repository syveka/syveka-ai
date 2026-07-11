import { describe, expect, it } from "vitest";
import { PLAN_LIMITS } from "@/server/services/billing/plans";

describe("plan matrix (§14.1)", () => {
  it("limits grow monotonically FREE → STARTER → PRO", () => {
    const order = ["FREE", "STARTER", "PRO"] as const;
    const keys = [
      "maxSeats",
      "aiMessagesPerUserMonth",
      "voiceMinutesMonth",
      "kbStorageMb",
      "activeWorkflows",
      "maxContacts",
    ] as const;
    for (const key of keys) {
      for (let i = 1; i < order.length; i++) {
        expect(PLAN_LIMITS[order[i]!][key]).toBeGreaterThanOrEqual(PLAN_LIMITS[order[i - 1]!][key]);
      }
    }
  });

  it("FREE has no voice and no API", () => {
    expect(PLAN_LIMITS.FREE.voiceAssistants).toBe(0);
    expect(PLAN_LIMITS.FREE.apiAccess).toBe(false);
  });

  it("API access starts at PRO (§14.1)", () => {
    expect(PLAN_LIMITS.STARTER.apiAccess).toBe(false);
    expect(PLAN_LIMITS.PRO.apiAccess).toBe(true);
  });
});
