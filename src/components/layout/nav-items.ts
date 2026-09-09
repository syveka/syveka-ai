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
} from "lucide-react";
import type { Permission } from "@/server/auth/permissions";

export type NavItem = {
  href: string;
  key: string;
  icon: React.ComponentType<{ className?: string }>;
  permission?: Permission;
};

/**
 * Shared between AppSidebar (desktop, >=md) and MobileNav (below md) so the
 * two navigation surfaces can never drift apart -- every destination
 * reachable on desktop must be reachable on mobile too.
 */
export const NAV: NavItem[] = [
  { href: "/dashboard", key: "dashboard", icon: LayoutDashboard },
  { href: "/inbox", key: "inbox", icon: Inbox, permission: "inbox:read" },
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

export function visibleNavItems(permissions: Permission[]): NavItem[] {
  const allowed = new Set(permissions);
  return NAV.filter((item) => !item.permission || allowed.has(item.permission));
}
