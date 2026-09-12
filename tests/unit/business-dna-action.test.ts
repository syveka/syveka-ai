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

  it("logs a sanitized diagnostic (org id + field names only) when validation fails, instead of silently discarding which field caused it", async () => {
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
    expect(logged.fieldErrors).toContain("supportedLocales");
  });

  it("never logs field values, only field names, on a validation failure", async () => {
    const secretLookingValue = "sUp3r$ecret-display-name-value";
    const result = await updateBusinessDnaAction(
      {},
      formData({ displayName: secretLookingValue, supportedLocales: ["not-a-locale"] }),
    );

    expect(result).toEqual({ error: "invalid_input" });
    const loggedText = consoleErrorSpy.mock.calls[0]![0] as string;
    expect(loggedText).not.toContain(secretLookingValue);
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
