"use client";

import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/routing";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/creator-studio", key: "overview" },
  { href: "/creator-studio/characters", key: "characters" },
  { href: "/creator-studio/create", key: "create" },
  { href: "/creator-studio/campaigns", key: "campaigns" },
  { href: "/creator-studio/approvals", key: "approvals" },
  { href: "/creator-studio/calendar", key: "calendar" },
  { href: "/creator-studio/library", key: "library" },
  { href: "/creator-studio/social-accounts", key: "socialAccounts" },
  { href: "/creator-studio/analytics", key: "analytics" },
];

export function CreatorStudioNav() {
  const t = useTranslations("creatorStudio.nav");
  const pathname = usePathname();

  return (
    <nav className="-mx-1 flex gap-1 overflow-x-auto border-b pb-px" aria-label={t("overview")}>
      {TABS.map((tab) => {
        const active =
          tab.href === "/creator-studio" ? pathname === tab.href : pathname.startsWith(tab.href);
        return (
          <Link
            key={tab.href}
            href={tab.href}
            className={cn(
              "shrink-0 whitespace-nowrap rounded-t-md border-b-2 px-3 py-2 text-sm transition-colors",
              active
                ? "border-primary font-medium text-primary"
                : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {t(tab.key)}
          </Link>
        );
      })}
    </nav>
  );
}
