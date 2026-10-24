import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

/**
 * GHSA-mrhx-c7xc-m3w5: Zod collects one issue per failing array element, so
 * a huge invalid array can exhaust memory. Zod 4.6.6 fixed it only for
 * bounded arrays: a size check that comes before any other check now rejects
 * an oversized array before a single element is parsed. These tests pin that
 * behaviour on the installed Zod, including the cases it doesn't cover, so a
 * bound placed where it doesn't protect is caught here rather than assumed.
 */

const ITEMS = 100_000;

/** An element schema that counts how often it runs, and always fails. */
function countingElement() {
  const seen = vi.fn(() => false);
  return { seen, schema: z.string().refine(seen) };
}

describe("Zod array bounds (GHSA-mrhx-c7xc-m3w5)", () => {
  it("runs a Zod release with the fix (>= 4.6.6)", () => {
    const version = (z as { core?: { version?: { major: number; minor: number; patch: number } } })
      .core?.version;
    expect(version).toBeDefined();
    const { major, minor, patch } = version!;
    expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(4_006_006);
  });

  it("rejects an oversized array by its leading .max() without parsing any element", () => {
    const { seen, schema } = countingElement();
    const result = z.array(schema).max(10).safeParse(Array(ITEMS).fill("x"));
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]).toMatchObject({ code: "too_big", maximum: 10, path: [] });
    expect(seen).not.toHaveBeenCalled();
  });

  it("also gates when .min() comes first, and inside an object field", () => {
    const { seen, schema } = countingElement();
    const result = z
      .object({ scopes: z.array(schema).min(1).max(8) })
      .strict()
      .safeParse({ scopes: Array(ITEMS).fill(1) });
    expect(result.success).toBe(false);
    expect(result.error?.issues).toHaveLength(1);
    expect(result.error?.issues[0]).toMatchObject({ code: "too_big", path: ["scopes"] });
    expect(seen).not.toHaveBeenCalled();
  });

  it("still parses every element of an array within its bound", () => {
    const { seen, schema } = countingElement();
    const result = z.array(schema).max(10).safeParse(Array(10).fill("x"));
    expect(result.error?.issues).toHaveLength(10);
    expect(seen).toHaveBeenCalledTimes(10);
  });

  it("does not gate when another check comes before the bound", () => {
    const { seen, schema } = countingElement();
    const result = z
      .array(schema)
      .refine(() => true)
      .max(10)
      .safeParse(Array(1_000).fill("x"));
    expect(result.success).toBe(false);
    expect(seen).toHaveBeenCalledTimes(1_000);
  });

  it("does not limit an unbounded array: one issue per failing element", () => {
    const result = z.array(z.string()).safeParse(Array(ITEMS).fill(1));
    expect(result.error?.issues).toHaveLength(ITEMS);
  });
});
