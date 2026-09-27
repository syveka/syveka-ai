"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { Link, usePathname } from "@/i18n/routing";
import { cn } from "@/lib/utils";
import type { Permission } from "@/server/auth/permissions";
import { isActiveSettingsHref, visibleSettingsNavItems } from "./settings-nav-items";

/**
 * Shared Settings navigation. A scrollable tab row on phones, a vertical list
 * from md up. Plain links, so native Tab/Enter keyboard navigation works; the
 * current page is marked with aria-current plus a non-colour-only indicator.
 * Only logical (start/end) spacing, so Arabic RTL mirrors automatically.
 */
export function SettingsNav({ permissions }: { permissions: Permission[] }) {
  const t = useTranslations("settingsNav");
  const pathname = usePathname();
  const items = visibleSettingsNavItems(permissions);
  const listRef = useRef<HTMLUListElement>(null);

  // On phones the tab row scrolls horizontally, and later pages (Billing,
  // Audit log, ...) start off-screen, hiding which page is active. Scroll only
  // the row itself by the active tab's measured overflow. Deliberately not
  // scrollIntoView(): browsers move the keyboard "focus navigation starting
  // point" to that element, so the next Tab would skip the header controls.
  // Physical deltas from getBoundingClientRect work the same in LTR and RTL.
  useEffect(() => {
    const list = listRef.current;
    if (!list || list.scrollWidth <= list.clientWidth) return;
    const active = list.querySelector<HTMLElement>('[aria-current="page"]');
    if (!active) return;
    const row = list.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    const margin = 8;
    if (tab.left < row.left) list.scrollBy({ left: tab.left - row.left - margin });
    else if (tab.right > row.right) list.scrollBy({ left: tab.right - row.right + margin });
  }, [pathname]);

  return (
    <nav aria-label={t("label")} className="md:w-48 md:shrink-0">
      <ul
        ref={listRef}
        className="-mx-1 flex gap-1 overflow-x-auto border-b pb-px md:mx-0 md:flex-col md:overflow-visible md:border-b-0 md:pb-0"
      >
        {items.map((item) => {
          const active = isActiveSettingsHref(pathname, item.href);
          return (
            <li key={item.href} className="shrink-0">
              <Link
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "block whitespace-nowrap rounded-md px-3 py-2 text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                  "border-b-2 md:border-b-0 md:border-s-2",
                  active
                    ? "border-primary bg-primary/10 font-medium text-primary"
                    : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {t(item.key)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
