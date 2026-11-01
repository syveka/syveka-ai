import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Superadmin switch for an organization's Creator Studio flag (admin page).
 * Only superadmins, only allow-listed flags, a reason every time, one audit
 * row per real change in that organization's audit log, and no write when
 * nothing changes. Credits are untouched (the flag opens screens only).
 *
 * Mocked: superadmin guard, feature-flag storage, audit, cache revalidation.
 */

const mocks = vi.hoisted(() => ({
  requireSuperadmin: vi.fn(async () => ({ userId: "admin-1" })),
  isFeatureEnabled: vi.fn(async (..._a: unknown[]) => {
    void _a;
    return false;
  }),
  setFeatureEnabled: vi.fn(async (..._a: unknown[]) => {
    void _a;
  }),
  audit: vi.fn(async (..._a: unknown[]) => {
    void _a;
  }),
  revalidatePath: vi.fn(),
}));

vi.mock("@/server/auth/superadmin", () => ({ requireSuperadmin: mocks.requireSuperadmin }));
vi.mock("@/server/services/feature-flags", () => ({
  isFeatureEnabled: mocks.isFeatureEnabled,
  setFeatureEnabled: mocks.setFeatureEnabled,
}));
vi.mock("@/server/services/audit", () => ({ audit: mocks.audit }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/server/services/billing/entitlement-grants", () => ({
  grantEntitlementOverride: vi.fn(),
  revokeEntitlementOverride: vi.fn(),
  InvalidGrantError: class extends Error {},
}));

import {
  InvalidFeatureToggleError,
  setOrganizationFeatureAsSuperadmin,
} from "@/server/services/admin-feature-flags";
import { setOrganizationFeatureAction } from "@/actions/admin-entitlement-grants";
import { AuthError } from "@/server/auth/session";

const ORG = "11111111-1111-4111-8111-111111111111";
const form = (fields: Record<string, string>) => {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isFeatureEnabled.mockResolvedValue(false);
  mocks.requireSuperadmin.mockResolvedValue({ userId: "admin-1" });
});

describe("setOrganizationFeatureAsSuperadmin", () => {
  it("turns Creator Studio on and audits it in that organization", async () => {
    await setOrganizationFeatureAsSuperadmin({
      organizationId: ORG,
      key: "creator_studio_v1",
      enabled: true,
      reason: " Pilot acceptance 2026-11-01 ",
    });
    expect(mocks.setFeatureEnabled).toHaveBeenCalledWith(ORG, "creator_studio_v1", true);
    expect(mocks.audit).toHaveBeenCalledWith(
      { orgId: ORG, userId: "admin-1" },
      expect.objectContaining({
        action: "feature_flag.update",
        resourceId: ORG,
        before: { creator_studio_v1: false },
        after: { creator_studio_v1: true, reason: "Pilot acceptance 2026-11-01" },
      }),
    );
  });

  it("refuses anyone who is not a superadmin, before reading or writing", async () => {
    mocks.requireSuperadmin.mockRejectedValueOnce(new AuthError("FORBIDDEN"));
    await expect(
      setOrganizationFeatureAsSuperadmin({
        organizationId: ORG,
        key: "creator_studio_v1",
        enabled: true,
        reason: "x",
      }),
    ).rejects.toBeInstanceOf(AuthError);
    expect(mocks.isFeatureEnabled).not.toHaveBeenCalled();
    expect(mocks.setFeatureEnabled).not.toHaveBeenCalled();
  });

  it("refuses flags that are not on the allow-list (autopilot included)", async () => {
    await expect(
      setOrganizationFeatureAsSuperadmin({
        organizationId: ORG,
        key: "creator_studio_autopilot",
        enabled: true,
        reason: "x",
      }),
    ).rejects.toBeInstanceOf(InvalidFeatureToggleError);
    expect(mocks.setFeatureEnabled).not.toHaveBeenCalled();
  });

  it("requires a reason", async () => {
    await expect(
      setOrganizationFeatureAsSuperadmin({
        organizationId: ORG,
        key: "creator_studio_v1",
        enabled: true,
        reason: "   ",
      }),
    ).rejects.toBeInstanceOf(InvalidFeatureToggleError);
    expect(mocks.setFeatureEnabled).not.toHaveBeenCalled();
  });

  it("does nothing (no write, no audit) when the flag already has that value", async () => {
    mocks.isFeatureEnabled.mockResolvedValueOnce(true);
    await setOrganizationFeatureAsSuperadmin({
      organizationId: ORG,
      key: "creator_studio_v1",
      enabled: true,
      reason: "again",
    });
    expect(mocks.setFeatureEnabled).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("turning it off is audited too (revocation)", async () => {
    mocks.isFeatureEnabled.mockResolvedValueOnce(true);
    await setOrganizationFeatureAsSuperadmin({
      organizationId: ORG,
      key: "creator_studio_v1",
      enabled: false,
      reason: "Pilot over",
    });
    expect(mocks.setFeatureEnabled).toHaveBeenCalledWith(ORG, "creator_studio_v1", false);
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ after: { creator_studio_v1: false, reason: "Pilot over" } }),
    );
  });
});

describe("setOrganizationFeatureAction", () => {
  it("validates input before calling the service", async () => {
    const bad = [
      { organizationId: "not-a-uuid", key: "creator_studio_v1", enabled: "true", reason: "x" },
      { organizationId: ORG, key: "creator_studio_autopilot", enabled: "true", reason: "x" },
      { organizationId: ORG, key: "creator_studio_v1", enabled: "yes", reason: "x" },
      { organizationId: ORG, key: "creator_studio_v1", enabled: "true", reason: "" },
    ];
    for (const fields of bad) {
      expect(await setOrganizationFeatureAction({}, form(fields))).toEqual({
        error: "invalid_input",
      });
    }
    expect(mocks.setFeatureEnabled).not.toHaveBeenCalled();
  });

  it("maps a non-superadmin to forbidden", async () => {
    mocks.requireSuperadmin.mockRejectedValueOnce(new AuthError("FORBIDDEN"));
    const result = await setOrganizationFeatureAction(
      {},
      form({ organizationId: ORG, key: "creator_studio_v1", enabled: "true", reason: "x" }),
    );
    expect(result).toEqual({ error: "forbidden" });
  });

  it("enables and revalidates the admin page", async () => {
    const result = await setOrganizationFeatureAction(
      {},
      form({ organizationId: ORG, key: "creator_studio_v1", enabled: "true", reason: "Pilot" }),
    );
    expect(result).toEqual({ message: "Feature enabled." });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/admin/organizations/${ORG}`);
  });
});
