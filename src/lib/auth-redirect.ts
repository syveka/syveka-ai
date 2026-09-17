import { APP_LOCALES, DEFAULT_LOCALE, type AppLocale } from "@/i18n/locales";

const INTERNAL_ORIGIN = "https://internal.invalid";

export function normalizeLocale(value: FormDataEntryValue | string | null): AppLocale {
  return APP_LOCALES.includes(value as AppLocale) ? (value as AppLocale) : DEFAULT_LOCALE;
}

export function localizedPath(locale: AppLocale, path: `/${string}`): string {
  return `/${locale}${path}`;
}

/**
 * `fallback` fires for every caller of /api/auth/callback (signup
 * verification, magic link, and password recovery alike) whenever `next`
 * is missing or fails the open-redirect checks below -- not just for one
 * specific flow. It must therefore be a destination that's *correct*
 * regardless of which flow actually landed here, not an assumption about
 * any one of them. `/dashboard` is that destination: (app)/layout.tsx's
 * own `if (!ctx) redirect("/onboarding")` guard already sends an org-less
 * account onward from there, so nothing is lost for a genuine new
 * signup -- but an existing account (e.g. one recovering its password
 * after `next` was dropped somewhere upstream, such as a mismatched
 * Supabase Auth redirect-URL allowlist) lands on its own dashboard
 * instead of being misrouted into "Create your organization". Previously
 * defaulted to "/onboarding" directly, which had exactly the inverse
 * problem for every non-signup flow.
 */
export function safeInternalNext(value: string | null, fallback = "/dashboard"): string {
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
