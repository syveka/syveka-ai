import {
  LayoutDashboard,
  MessageSquare,
  Phone,
  Users,
  Building2,
  Kanban,
  Calendar,
  BarChart3,
  BookOpen,
  Sparkles,
  GitBranch,
  Inbox,
  Bell,
  Settings,
  Dna,
  Wand2,
} from "lucide-react";
import type { Permission } from "@/server/auth/permissions";

export type NavItem = {
  href: string;
  key: string;
  icon: React.ComponentType<{ className?: string }>;
  permission?: Permission;
  /**
   * Org-level feature-flag key (see src/server/services/feature-flags.ts)
   * required to show this destination, in addition to `permission`. Kept as
   * a plain string literal rather than importing the real constant (e.g.
   * CREATOR_STUDIO_FLAG from @/server/services/creator-profiles) because
   * that module is `server-only` and this file is imported by client
   * components (AppSidebar, MobileNav) -- must stay in sync by hand.
   */
  featureFlag?: string;
};

/**
 * Shared between AppSidebar (desktop, >=md) and MobileNav (below md) so the
 * two navigation surfaces can never drift apart -- every destination
 * reachable on desktop must be reachable on mobile too.
 */
export const NAV: NavItem[] = [
  { href: "/dashboard", key: "dashboard", icon: LayoutDashboard },
  { href: "/inbox", key: "inbox", icon: Inbox, permission: "inbox:read" },
  {
    href: "/creator-studio",
    key: "creatorStudio",
    icon: Wand2,
    permission: "creator:read",
    featureFlag: "creator_studio_v1",
  },
  { href: "/chat", key: "chat", icon: MessageSquare, permission: "chat:use" },
  { href: "/voice", key: "voice", icon: Phone, permission: "voice:view-calls" },
  { href: "/crm/contacts", key: "contacts", icon: Users, permission: "crm:read" },
  { href: "/crm/companies", key: "companies", icon: Building2, permission: "crm:read" },
  { href: "/crm/deals", key: "deals", icon: Kanban, permission: "crm:read" },
  { href: "/calendar", key: "calendar", icon: Calendar, permission: "calendar:read" },
  { href: "/analytics", key: "analytics", icon: BarChart3, permission: "analytics:view" },
  { href: "/knowledge", key: "knowledge", icon: BookOpen, permission: "kb:read" },
  { href: "/prompts", key: "prompts", icon: Sparkles, permission: "prompts:read" },
  { href: "/workflows", key: "workflows", icon: GitBranch, permission: "workflows:view" },
  { href: "/notifications", key: "notifications", icon: Bell },
  {
    href: "/settings/business-dna",
    key: "businessDna",
    icon: Dna,
    permission: "business-dna:read",
  },
  { href: "/settings/profile", key: "settings", icon: Settings },
];

export function visibleNavItems(
  permissions: Permission[],
  enabledFeatures: ReadonlySet<string> = new Set(),
): NavItem[] {
  const allowed = new Set(permissions);
  return NAV.filter(
    (item) =>
      (!item.permission || allowed.has(item.permission)) &&
      (!item.featureFlag || enabledFeatures.has(item.featureFlag)),
  );
}
