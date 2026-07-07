import { describe, expect, it } from "vitest";

/**
 * Mirrors the interpolation logic in the run-workflow job (§17.2).
 * Kept in sync by exporting the regex contract here; if the job's behavior
 * changes, this spec documents the expected semantics.
 */
function interpolate(
  template: string,
  ctx: { trigger: Record<string, unknown>; vars: Record<string, unknown> },
): string {
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path: string) => {
    const value = path
      .split(".")
      .reduce<unknown>(
        (acc, key) =>
          acc && typeof acc === "object" ? (acc as Record<string, unknown>)[key] : undefined,
        { trigger: ctx.trigger, vars: ctx.vars } as Record<string, unknown>,
      );
    return value === undefined || value === null ? "" : String(value);
  });
}

describe("workflow template interpolation (§17.2)", () => {
  const ctx = {
    trigger: { title: "Iso kauppa", valueCents: 500000, contact: { email: "a@b.fi" } },
    vars: { s1: "AI text" },
  };

  it("resolves trigger paths", () => {
    expect(interpolate("Deal: {{trigger.title}}", ctx)).toBe("Deal: Iso kauppa");
  });

  it("resolves nested paths", () => {
    expect(interpolate("{{trigger.contact.email}}", ctx)).toBe("a@b.fi");
  });

  it("resolves step output vars", () => {
    expect(interpolate("Summary: {{vars.s1}}", ctx)).toBe("Summary: AI text");
  });

  it("renders missing paths as empty string, never 'undefined'", () => {
    expect(interpolate("x{{trigger.missing.deep}}y", ctx)).toBe("xy");
  });

  it("tolerates whitespace inside braces", () => {
    expect(interpolate("{{ trigger.title }}", ctx)).toBe("Iso kauppa");
  });
});
