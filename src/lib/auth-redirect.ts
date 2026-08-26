import { APP_LOCALES, DEFAULT_LOCALE, type AppLocale } from "@/i18n/locales";

const INTERNAL_ORIGIN = "https://internal.invalid";

export function normalizeLocale(value: FormDataEntryValue | string | null): AppLocale {
  return APP_LOCALES.includes(value as AppLocale) ? (value as AppLocale) : DEFAULT_LOCALE;
}

export function localizedPath(locale: AppLocale, path: `/${string}`): string {
  return `/${locale}${path}`;
}

export function safeInternalNext(value: string | null, fallback = "/onboarding"): string {
  if (!value?.startsWith("/") || value.startsWith("//") || value.includes("\\")) return fallback;

  try {
    const decoded = decodeURIComponent(value);
    if (decoded.startsWith("//") || decoded.includes("\\")) return fallback;
    const parsed = new URL(value, INTERNAL_ORIGIN);
    if (parsed.origin !== INTERNAL_ORIGIN || parsed.username || parsed.password) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}

export function localeFromPath(path: string): AppLocale {
  const segment = path.split("/")[1];
  return normalizeLocale(segment ?? null);
}
