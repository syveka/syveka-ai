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

import { updateBusinessDnaAction, type BusinessDnaActionState } from "@/actions/business-dna";

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
   * The action now picks fields explicitly rather than spreading `raw` (see
   * the fix below), so ANY key the schema doesn't expect -- not just
   * React's specific $ACTION_* fields -- is silently ignored instead of
   * ever reaching businessDnaSchema. .strict() itself is unchanged and
   * still active; it simply never sees a field the form didn't actually
   * intend to submit.
   */
  it("ignores an arbitrary unexpected field instead of failing .strict() on it", async () => {
    const fd = formData({ displayName: "Acme Oy" });
    fd.set("someFutureFrameworkOrBrowserField", "boom");

    const result = await updateBusinessDnaAction({}, fd);

    expect(result).toEqual({ message: "saved" });
    expect(mocks.upsertBusinessDNA).toHaveBeenCalledTimes(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  /**
   * Root cause, proven live (staging run 34697153294, 2026-09-12): the
   * business_dna_update_invalid_input diagnostic from PR #139 named the
   * exact rejected keys as
   * ["$ACTION_REF_2", "$ACTION_2:0", "$ACTION_2:1", "$ACTION_KEY"] --
   * React's own Server Action progressive-enhancement fallback fields,
   * landing inside the FormData this action receives on the form's second
   * submission (the restore-original-value save). The old code spread the
   * entire `Object.fromEntries(formData)` into businessDnaSchema, so these
   * incidental framework fields tripped the schema's .strict() mass-
   * assignment guard exactly as it's supposed to for genuinely unexpected
   * keys -- the fix is for the action to never forward them in the first
   * place, not to loosen .strict(). This is the exact save -> restore
   * sequence tests/e2e/business-dna.spec.ts:64 exercises against the real
   * app; reproduces it here as a unit test so it can't regress silently.
   */
  it("ignores React's own $ACTION_* progressive-enhancement fields instead of failing .strict() on them (the exact save -> restore incident)", async () => {
    const saveTemp = formData({ displayName: "E2E-temp-1789218181759" });
    const firstResult = await updateBusinessDnaAction({}, saveTemp);
    expect(firstResult).toEqual({ message: "saved" });

    const restoreOriginal = formData({ displayName: "" });
    restoreOriginal.set("$ACTION_REF_2", "");
    restoreOriginal.set("$ACTION_2:0", "");
    restoreOriginal.set("$ACTION_2:1", "");
    restoreOriginal.set("$ACTION_KEY", "");

    const secondResult = await updateBusinessDnaAction(
      firstResult as BusinessDnaActionState,
      restoreOriginal,
    );

    expect(secondResult).toEqual({ message: "saved" });
    expect(mocks.upsertBusinessDNA).toHaveBeenCalledTimes(2);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
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
