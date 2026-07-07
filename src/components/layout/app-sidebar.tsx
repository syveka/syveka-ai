"use client";

import { useTranslations } from "next-intl";
import {
  LayoutDashboard, MessageSquare, Phone, Users, Building2, Kanban,
  Calendar, BarChart3, BookOpen, Sparkles, GitBranch, Bell, Settings,
} from "lucide-react";
import { Link, usePathname } from "@/i18n/routing";
import { cn } from "@/lib/utils";
import type { Permission } from "@/server/auth/permissions";

type NavItem = {
  href: string;
  key: string;
  icon: React.ComponentType<{ className?: string }>;
  permission?: Permission;
};

const NAV: NavItem[] = [
  { href: "/dashboard", key: "dashboard", icon: LayoutDashboard },
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
  { href: "/settings/profile", key: "settings", icon: Settings },
];

export function AppSidebar({
  role: _role,
  permissions,
}: {
  role: string;
  permissions: Permission[];
}) {
  const t = useTranslations("nav");
  const pathname = usePathname();
  const allowed = new Set(permissions);

  return (
    <aside className="hidden w-56 shrink-0 border-e bg-card md:block">
      <div className="flex h-14 items-center border-b px-4 font-semibold">Syveka AI</div>
      <nav className="space-y-1 p-2">
        {NAV.filter((item) => !item.permission || allowed.has(item.permission)).map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
                active
                  ? "bg-primary/10 font-medium text-primary"
                  : "text-muted-foreground hover:bg-accent hover:text-foreground",
              )}
            >
              <item.icon className="size-4" />
              {t(item.key)}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
