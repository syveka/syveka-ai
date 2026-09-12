import { beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "@/server/auth/session";

const mocks = vi.hoisted(() => ({
  requirePermission: vi.fn(async (): Promise<TenantContext> => ({
    userId: "user-1",
    email: "u@example.com",
    orgId: "org-a",
    role: "MANAGER",
    locale: "en",
  })),
  upsertBusinessDNA: vi.fn(async () => undefined),
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/server/auth/guard", () => ({ requirePermission: mocks.requirePermission }));
vi.mock("@/server/services/business-dna", () => ({
  getBusinessDNA: vi.fn(),
  upsertBusinessDNA: mocks.upsertBusinessDNA,
}));

import { updateBusinessDnaAction } from "@/actions/business-dna";

function formData(fields: Record<string, string | string[]>) {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) {
      for (const item of v) fd.append(k, item);
    } else {
      fd.set(k, v);
    }
  }
  return fd;
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

describe("updateBusinessDnaAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("saves successfully with only a display name set", async () => {
    const result = await updateBusinessDnaAction({}, formData({ displayName: "Acme Oy" }));

    expect(result).toEqual({ message: "saved" });
    expect(mocks.upsertBusinessDNA).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it("logs a sanitized diagnostic (org id + issue code/path) for a per-field validation failure", async () => {
    // supportedLocales entries must be one of BUSINESS_DNA_LOCALES ("FI"/"EN"/"AR");
    // an arbitrary string fails validation without needing malformed JSON.
    const result = await updateBusinessDnaAction(
      {},
      formData({ displayName: "Acme Oy", supportedLocales: ["not-a-locale"] }),
    );

    expect(result).toEqual({ error: "invalid_input" });
    expect(mocks.upsertBusinessDNA).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(consoleErrorSpy.mock.calls[0]![0] as string);
    expect(logged.event).toBe("business_dna_update_invalid_input");
    expect(logged.orgId).toBe("org-a");
    expect(logged.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: ["supportedLocales", 0] })]),
    );
  });

  /**
   * Live incident (staging run 34694851185, 2026-09-12): the business-dna
   * "...original value is restored" E2E test's second save failed with
   * businessDnaSchema rejecting the submission, but the diagnostic added
   * for exactly this purpose logged `fieldErrors: []` -- useless, because a
   * .strict() schema's "unrecognized_keys" issue has an EMPTY path, and
   * zod's flatten() buckets empty-path issues into formErrors, not
   * fieldErrors. This reproduces that exact failure class directly against
   * the real schema (an extra key the form never intentionally sends) and
   * proves the new issues[] shape actually names the rejected key, unlike
   * the old fieldErrors-only shape.
   */
  it("names the offending key(s) for a .strict() unrecognized-key violation (fieldErrors alone would report none)", async () => {
    const fd = formData({ displayName: "Acme Oy" });
    fd.set("extraUnexpectedField", "boom");

    const result = await updateBusinessDnaAction({}, fd);

    expect(result).toEqual({ error: "invalid_input" });
    expect(mocks.upsertBusinessDNA).not.toHaveBeenCalled();
    const logged = JSON.parse(consoleErrorSpy.mock.calls[0]![0] as string);
    expect(logged.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unrecognized_keys",
          path: [],
          keys: ["extraUnexpectedField"],
        }),
      ]),
    );
  });

  it("never logs field values or zod's raw .message text, only codes/paths/key names, on a validation failure", async () => {
    const secretLookingValue = "sUp3r$ecret-display-name-value";
    const result = await updateBusinessDnaAction(
      {},
      formData({ displayName: secretLookingValue, supportedLocales: ["not-a-locale"] }),
    );

    expect(result).toEqual({ error: "invalid_input" });
    const loggedText = consoleErrorSpy.mock.calls[0]![0] as string;
    expect(loggedText).not.toContain(secretLookingValue);
    expect(loggedText).not.toContain("not-a-locale");
  });

  it("returns invalid_input (and does not save) when openingHours is malformed JSON", async () => {
    const result = await updateBusinessDnaAction(
      {},
      formData({ displayName: "Acme Oy", openingHours: "{not valid json" }),
    );

    expect(result).toEqual({ error: "invalid_input" });
    expect(mocks.upsertBusinessDNA).not.toHaveBeenCalled();
  });
});
