"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/routing";
import { cn } from "@/lib/utils";
import type { Permission } from "@/server/auth/permissions";
import { visibleNavItems } from "./nav-items";

export function AppSidebar({
  role: _role,
  permissions,
}: {
  role: string;
  permissions: Permission[];
}) {
  const t = useTranslations("nav");
  const pathname = usePathname();

  return (
    <aside className="hidden w-56 shrink-0 border-e bg-card md:block">
      <div className="flex h-14 items-center border-b px-4 font-semibold">Syveka AI</div>
      <nav className="space-y-1 p-2">
        {visibleNavItems(permissions).map((item) => {
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
