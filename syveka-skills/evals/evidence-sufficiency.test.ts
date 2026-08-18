import { describe, expect, it } from "vitest";
import { evaluateSufficiency } from "../core/evidence/index.js";

describe("evidence sufficiency", () => {
  it("a claim with zero evidence items is insufficient", () => {
    const result = evaluateSufficiency({ claim: "it works", items: [] });
    expect(result.sufficient).toBe(false);
  });

  it("a claim backed only by a screenshot or log is insufficient (weak evidence alone)", () => {
    const result = evaluateSufficiency({
      claim: "it works",
      items: [
        { type: "screenshot", description: "looks right", data: "", timestamp: "t" },
        { type: "log", description: "no errors printed", data: "", timestamp: "t" },
      ],
    });
    expect(result.sufficient).toBe(false);
  });

  it("a claim backed by a real test run is sufficient", () => {
    const result = evaluateSufficiency({
      claim: "it works",
      items: [
        {
          type: "test",
          description: "regression suite passes",
          data: "12 passing",
          timestamp: "t",
        },
      ],
    });
    expect(result.sufficient).toBe(true);
  });

  it("mixing weak and strong evidence is still sufficient (strong evidence is what matters, not purity)", () => {
    const result = evaluateSufficiency({
      claim: "it works",
      items: [
        { type: "log", description: "context", data: "", timestamp: "t" },
        { type: "diff", description: "the actual change", data: "+1 -1", timestamp: "t" },
      ],
    });
    expect(result.sufficient).toBe(true);
  });
});
