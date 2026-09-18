import { describe, expect, it } from "vitest";
import { visibleNavItems } from "@/components/layout/nav-items";
import { permissionsFor } from "@/server/auth/permissions";

/**
 * Creator Studio has no self-service activation path yet (its feature flag
 * is only ever turned on by an engineer running scripts/enable-creator-
 * studio-for-org.ts) -- exposing it in the nav for every org that has the
 * "creator:read" permission invites a confused click into a dead-end page.
 * This proves visibleNavItems hides it by default and only reveals it once
 * the org's flag is explicitly enabled, without disturbing any other
 * permission-gated destination.
 */
describe("visibleNavItems feature-flag gating", () => {
  it("hides Creator Studio when no feature flags are enabled, even for a role with creator:read", () => {
    const items = visibleNavItems(permissionsFor("OWNER"));
    expect(items.some((item) => item.key === "creatorStudio")).toBe(false);
  });

  it("hides Creator Studio when an unrelated feature flag is enabled", () => {
    const items = visibleNavItems(permissionsFor("OWNER"), new Set(["some_other_flag"]));
    expect(items.some((item) => item.key === "creatorStudio")).toBe(false);
  });

  it("reveals Creator Studio once creator_studio_v1 is enabled for the org", () => {
    const items = visibleNavItems(permissionsFor("OWNER"), new Set(["creator_studio_v1"]));
    expect(items.some((item) => item.key === "creatorStudio")).toBe(true);
  });

  it("reveals Creator Studio for every role once the flag is enabled, since every role holds creator:read", () => {
    for (const role of ["OWNER", "ADMIN", "MANAGER", "MEMBER", "VIEWER"] as const) {
      const items = visibleNavItems(permissionsFor(role), new Set(["creator_studio_v1"]));
      expect(items.some((item) => item.key === "creatorStudio")).toBe(true);
    }
  });

  it("does not affect any other nav destination's permission gating", () => {
    const withoutFlags = visibleNavItems(permissionsFor("MEMBER"));
    const withFlags = visibleNavItems(permissionsFor("MEMBER"), new Set(["creator_studio_v1"]));
    const nonCreatorKeys = (items: typeof withoutFlags) =>
      items.filter((item) => item.key !== "creatorStudio").map((item) => item.key);
    expect(nonCreatorKeys(withFlags)).toEqual(nonCreatorKeys(withoutFlags));
  });
});
