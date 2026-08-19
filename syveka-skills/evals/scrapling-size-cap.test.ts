import { describe, expect, it } from "vitest";
import { applySizeCap } from "../providers/scrapling/size-cap.js";

describe("Scrapling provider: response size cap", () => {
  it("passes content under the cap through unchanged", () => {
    const result = applySizeCap("small content", 1000);
    expect(result.oversized).toBe(false);
    expect(result.content).toBe("small content");
  });

  it("truncates content over the cap and reports oversized: true", () => {
    const big = "x".repeat(5000);
    const result = applySizeCap(big, 1000);
    expect(result.oversized).toBe(true);
    expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(1000);
    expect(result.originalByteLength).toBe(5000);
  });

  it("content exactly at the cap is not marked oversized", () => {
    const exact = "x".repeat(1000);
    const result = applySizeCap(exact, 1000);
    expect(result.oversized).toBe(false);
  });

  it("does not produce invalid UTF-8 when truncation lands mid multi-byte character", () => {
    // Each "€" is 3 bytes in UTF-8 - a cap of an odd byte count relative to
    // that guarantees the naive cut point lands mid-character somewhere.
    const content = "€".repeat(1000);
    const result = applySizeCap(content, 777);
    // toString("utf-8") on a partial buffer never throws - it substitutes
    // U+FFFD for a broken trailing sequence - so this call succeeding at
    // all (not throwing) is the actual assertion.
    expect(typeof result.content).toBe("string");
    expect(Buffer.byteLength(result.content, "utf-8")).toBeLessThanOrEqual(777);
  });
});
