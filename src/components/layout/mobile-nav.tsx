"use client";

import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import { Menu } from "lucide-react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/routing";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Permission } from "@/server/auth/permissions";
import { visibleNavItems } from "./nav-items";

/**
 * AppSidebar is `hidden md:block` -- every route it lists (CRM, Voice,
 * Calendar, Analytics, Knowledge Base, Workflows, Business DNA, ...) was
 * completely unreachable below the md breakpoint, with no replacement
 * anywhere in the layout. This is the minimal fix: a menu button in the
 * topbar (md:hidden, so it never doubles up with the sidebar) that reveals
 * the exact same permission-filtered destination list. Not a redesign --
 * same NAV data, same Link targets, same permission gating as the desktop
 * sidebar (shared via nav-items.ts so the two can't drift apart).
 */
export function MobileNav({ permissions }: { permissions: Permission[] }) {
  const t = useTranslations("nav");
  const pathname = usePathname();

  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <Button variant="ghost" size="icon" aria-label="menu" className="md:hidden">
          <Menu className="size-4" />
        </Button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          align="start"
          sideOffset={4}
          className="z-50 w-56 rounded-md border bg-card p-1 shadow-md"
        >
          {visibleNavItems(permissions).map((item) => {
            const active = pathname.startsWith(item.href);
            return (
              <DropdownMenu.Item key={item.href} asChild>
                <Link
                  href={item.href}
                  className={cn(
                    "flex items-center gap-3 rounded-md px-3 py-2 text-sm outline-none transition-colors",
                    active
                      ? "bg-primary/10 font-medium text-primary"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  <item.icon className="size-4" />
                  {t(item.key)}
                </Link>
              </DropdownMenu.Item>
            );
          })}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
