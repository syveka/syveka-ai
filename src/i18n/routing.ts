import { defineRouting } from "next-intl/routing";
import { createNavigation } from "next-intl/navigation";
import { APP_LOCALES, DEFAULT_LOCALE } from "@/i18n/locales";

export const routing = defineRouting({
  locales: APP_LOCALES,
  defaultLocale: DEFAULT_LOCALE,
  localePrefix: "as-needed", // Finnish (default) has no /fi prefix
});

export type { AppLocale } from "@/i18n/locales";

export const RTL_LOCALES: ReadonlySet<string> = new Set(["ar"]);

export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
