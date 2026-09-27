import type { Permission } from "@/server/auth/permissions";

export type SettingsNavItem = {
  href: string;
  key: string;
  /** Mirrors the page's own `requirePermission(...)`; the page still enforces it. */
  permission?: Permission;
};

/**
 * Settings destinations that are finished and usable today. API keys is
 * deliberately absent: keys can be created, but no endpoint accepts them yet,
 * so linking it would advertise a feature that does not work.
 */
export const SETTINGS_NAV: SettingsNavItem[] = [
  { href: "/settings/profile", key: "profile" },
  { href: "/settings/organization", key: "organization", permission: "org:update" },
  { href: "/settings/members", key: "members", permission: "members:invite" },
  { href: "/settings/business-dna", key: "businessDna", permission: "business-dna:read" },
  { href: "/settings/integrations", key: "integrations", permission: "integrations:manage" },
  { href: "/settings/billing", key: "billing", permission: "billing:view" },
  { href: "/settings/audit-log", key: "auditLog", permission: "audit:view" },
];

export function visibleSettingsNavItems(permissions: Permission[]): SettingsNavItem[] {
  const allowed = new Set(permissions);
  return SETTINGS_NAV.filter((item) => !item.permission || allowed.has(item.permission));
}

/** Exact page or one of its sub-pages — never a sibling that merely shares a prefix. */
export function isActiveSettingsHref(pathname: string, href: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
