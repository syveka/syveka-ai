import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * patchOrganizationSettings: one UPDATE that changes only the named keys on
 * the row's current settings (no read-then-write), and refuses operator-only
 * keys. setFeatureEnabled goes through it. The behaviour under overlapping
 * writes is proven on a real Postgres in organization-settings.postgres.test.ts.
 */
const db = vi.hoisted(() => ({
  $executeRaw: vi.fn(async (..._a: unknown[]) => {
    void _a;
    return 1;
  }),
  organization: { findUniqueOrThrow: vi.fn(), update: vi.fn(), findUnique: vi.fn() },
}));
vi.mock("@/server/db/tenant", () => ({ unscopedPrisma: db }));

import {
  OPERATOR_ONLY_SETTINGS,
  patchOrganizationSettings,
  updateOrganizationProfile,
  ProtectedSettingError,
} from "@/server/services/organization-settings";
import { setFeatureEnabled } from "@/server/services/feature-flags";

const ORG = "11111111-1111-4111-8111-111111111111";
const sqlOf = (call: unknown[]) => (call[0] as TemplateStringsArray).join("?").replace(/\s+/g, " ");

beforeEach(() => vi.clearAllMocks());

describe("patchOrganizationSettings", () => {
  it("issues one UPDATE merging only the given keys onto the current value", async () => {
    await patchOrganizationSettings(ORG, { set: { aiInstructions: "Be brief" }, remove: ["old"] });
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    const call = db.$executeRaw.mock.calls[0]!;
    expect(sqlOf(call)).toContain(
      "update organizations set settings = (case when jsonb_typeof(settings) = 'object' then settings else '{}'::jsonb end - ?::text[]) || ?::jsonb",
    );
    expect(call.slice(1)).toEqual([["old"], JSON.stringify({ aiInstructions: "Be brief" }), ORG]);
    expect(db.organization.findUniqueOrThrow).not.toHaveBeenCalled();
    expect(db.organization.update).not.toHaveBeenCalled();
  });

  it("refuses operator-only keys in set and remove, writing nothing", async () => {
    expect(OPERATOR_ONLY_SETTINGS).toContain("workflow_steps_internal_only");
    await expect(
      patchOrganizationSettings(ORG, { set: { workflow_steps_internal_only: false } }),
    ).rejects.toBeInstanceOf(ProtectedSettingError);
    await expect(
      patchOrganizationSettings(ORG, { remove: ["workflow_steps_internal_only"] }),
    ).rejects.toBeInstanceOf(ProtectedSettingError);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });

  it("an empty patch is a no-op", async () => {
    expect(await patchOrganizationSettings(ORG, {})).toBe(0);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});

describe("setFeatureEnabled", () => {
  it("changes only its key atomically", async () => {
    await setFeatureEnabled(ORG, "creator_studio_v1", true);
    expect(db.$executeRaw.mock.calls[0]!.slice(1)).toEqual([
      [],
      JSON.stringify({ creator_studio_v1: true }),
      ORG,
    ]);
    expect(db.organization.update).not.toHaveBeenCalled();
  });

  it("can't touch the operator-only restriction", async () => {
    await expect(
      setFeatureEnabled(ORG, "workflow_steps_internal_only", false),
    ).rejects.toBeInstanceOf(ProtectedSettingError);
  });

  it("fails when the organization doesn't exist", async () => {
    db.$executeRaw.mockResolvedValueOnce(0);
    await expect(setFeatureEnabled(ORG, "creator_studio_v1", true)).rejects.toThrow(
      "Organization not found",
    );
  });
});

describe("updateOrganizationProfile", () => {
  it("writes the columns and only its settings keys in one statement", async () => {
    await updateOrganizationProfile(
      ORG,
      { name: "Acme", businessId: null, vatId: "FI123" },
      { set: { aiInstructions: "Be brief" } },
    );
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    const call = db.$executeRaw.mock.calls[0]!;
    expect(sqlOf(call)).toContain("set name = ?, business_id = ?, vat_id = ?, settings = (case");
    expect(call.slice(1)).toEqual([
      "Acme",
      null,
      "FI123",
      [],
      JSON.stringify({ aiInstructions: "Be brief" }),
      ORG,
    ]);
  });

  it("refuses operator-only keys before writing", async () => {
    await expect(
      updateOrganizationProfile(
        ORG,
        { name: "Acme", businessId: null, vatId: null },
        { remove: ["workflow_steps_internal_only"] },
      ),
    ).rejects.toBeInstanceOf(ProtectedSettingError);
    expect(db.$executeRaw).not.toHaveBeenCalled();
  });
});
