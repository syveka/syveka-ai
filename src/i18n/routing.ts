import { defineRouting } from "next-intl/routing";
import { createNavigation } from "next-intl/navigation";

export const routing = defineRouting({
  locales: ["fi", "en", "ar"],
  defaultLocale: "fi",
  localePrefix: "as-needed", // Finnish (default) has no /fi prefix
});

export type AppLocale = (typeof routing.locales)[number];

export const RTL_LOCALES: ReadonlySet<string> = new Set(["ar"]);

export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
