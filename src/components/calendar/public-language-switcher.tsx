"use client";

import { useLocale, useTranslations } from "next-intl";
import { useSearchParams } from "next/navigation";
import { Languages } from "lucide-react";
import { Link, usePathname } from "@/i18n/routing";
import { APP_LOCALES, type AppLocale } from "@/i18n/locales";
import { cn } from "@/lib/utils";

/** Each language is named in itself, so a guest finds their own whatever the page shows. */
const LANGUAGE_NAMES: Record<AppLocale, string> = {
  fi: "Suomi",
  en: "English",
  ar: "العربية",
};

/**
 * Visible FI/EN/AR switch for guest-facing booking pages. Shared booking links
 * carry no locale (Finnish by default), so a guest needs an obvious way to
 * change it. Each link keeps the current path and query. On the booking page
 * the chosen locale is sent with the booking, so it also sets the language of
 * the guest's emails.
 */
export function PublicLanguageSwitcher() {
  const t = useTranslations("booking");
  const current = useLocale();
  const pathname = usePathname();
  const query = useSearchParams()?.toString() ?? "";
  const href = query ? `${pathname}?${query}` : pathname;

  return (
    <nav aria-label={t("languageLabel")} className="flex justify-end">
      <ul className="flex flex-wrap items-center gap-1 rounded-md border bg-background p-1 text-sm">
        <li aria-hidden="true" className="px-1 text-muted-foreground">
          <Languages className="size-4" />
        </li>
        {APP_LOCALES.map((locale) => {
          const active = locale === current;
          return (
            <li key={locale}>
              <Link
                href={href}
                locale={locale}
                lang={locale}
                hrefLang={locale}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "inline-flex min-h-8 items-center rounded px-2.5 py-1 hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active && "bg-primary font-medium text-primary-foreground hover:bg-primary",
                )}
              >
                {LANGUAGE_NAMES[locale]}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
