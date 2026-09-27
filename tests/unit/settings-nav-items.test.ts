import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { can, permissionsFor } from "@/server/auth/permissions";
import {
  isActiveSettingsHref,
  SETTINGS_NAV,
  visibleSettingsNavItems,
} from "@/components/settings/settings-nav-items";

const ROLES = ["OWNER", "ADMIN", "MANAGER", "MEMBER", "VIEWER"] as const;
const root = path.join(__dirname, "../..");
const pageSource = (href: string) =>
  fs.readFileSync(path.join(root, "src/app/[locale]/(app)", href, "page.tsx"), "utf8");

describe("settings navigation: destinations", () => {
  it("links only to Settings pages that exist", () => {
    for (const item of SETTINGS_NAV) {
      expect(() => pageSource(item.href), item.href).not.toThrow();
    }
  });

  it("never links the unfinished API keys page", () => {
    expect(SETTINGS_NAV.map((i) => i.href)).not.toContain("/settings/api-keys");
  });

  it("requires exactly the permission each page enforces server-side (no drift)", () => {
    for (const item of SETTINGS_NAV) {
      const guard = pageSource(item.href).match(/requirePermission\("([a-z:-]+)"\)/)?.[1];
      // Profile is open to every signed-in member (getTenantContext, no permission).
      expect(item.permission, item.href).toBe(guard);
    }
  });
});

describe("settings navigation: visibility by role", () => {
  const visible = (role: (typeof ROLES)[number]) =>
    visibleSettingsNavItems(permissionsFor(role)).map((i) => i.key);

  it("shows every destination to owners and admins", () => {
    const all = SETTINGS_NAV.map((i) => i.key);
    expect(visible("OWNER")).toEqual(all);
    expect(visible("ADMIN")).toEqual(all);
  });

  it.each(["MANAGER", "MEMBER", "VIEWER"] as const)(
    "shows %s only what that role can open",
    (role) => {
      const keys = visible(role);
      expect(keys).toContain("profile");
      for (const item of SETTINGS_NAV) {
        const allowed = !item.permission || can(role, item.permission);
        expect(keys.includes(item.key), `${role} ${item.key}`).toBe(allowed);
      }
      // None of these roles administer the organization.
      expect(keys).not.toContain("members");
      expect(keys).not.toContain("billing");
      expect(keys).not.toContain("auditLog");
      expect(keys).not.toContain("integrations");
    },
  );

  it("hides everything permission-gated when given no permissions", () => {
    expect(visibleSettingsNavItems([]).map((i) => i.key)).toEqual(["profile"]);
  });
});

describe("settings navigation: active page", () => {
  it.each([
    ["/settings/members", "/settings/members", true],
    ["/settings/business-dna/services", "/settings/business-dna", true],
    ["/settings/billing", "/settings/members", false],
    // A sibling that merely shares a prefix is not the active page.
    ["/settings/profile-extra", "/settings/profile", false],
  ])("%s active for %s: %s", (pathname, href, expected) => {
    expect(isActiveSettingsHref(pathname, href)).toBe(expected);
  });
});

describe("calendar page: Connect calendar link", () => {
  const calendar = fs.readFileSync(
    path.join(root, "src/app/[locale]/(app)/calendar/page.tsx"),
    "utf8",
  );

  it("links to the existing integrations page only for integrations:manage", () => {
    expect(calendar).toMatch(
      /can\(ctx\.role, "integrations:manage"\) \? \(\s*<Link href="\/settings\/integrations"[\s\S]*?t\("connectCalendarLink"\)/,
    );
    expect(pageSource("/settings/integrations")).toContain(
      'requirePermission("integrations:manage")',
    );
  });

  it("is visible to owners/admins only", () => {
    expect(ROLES.filter((r) => can(r, "integrations:manage"))).toEqual(["OWNER", "ADMIN"]);
  });
});
