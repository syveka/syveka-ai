import { describe, expect, it, vi } from "vitest";
import { APP_LOCALES, DEFAULT_LOCALE } from "@/i18n/locales";
import { routing } from "@/i18n/routing";
import { localizedPath } from "@/lib/auth-redirect";
import { OPEN_PATH_PREFIX, REDIRECT_PATH_PREFIX } from "../../scripts/lib/invite-journeys";

// The routing module also builds Next.js navigation helpers, which need the
// Next runtime; the routing definition itself (defineRouting) is real.
vi.mock("next-intl/navigation", () => ({ createNavigation: () => ({}) }));

/**
 * The invitation journeys (tests/e2e/invite-journeys.spec.ts) open pages by
 * one locale-prefix rule and assert server redirects by another. These keep
 * both maps aligned with the app's own rules, so the first staging run's
 * mistake (expecting the Finnish dashboard redirect unprefixed) can't return
 * unnoticed if either rule changes.
 */

describe("invitation journey locale prefixes follow the app's routing contract", () => {
  it("cover exactly the app's locales", () => {
    expect(Object.keys(OPEN_PATH_PREFIX).sort()).toEqual([...APP_LOCALES].sort());
    expect(Object.keys(REDIRECT_PATH_PREFIX).sort()).toEqual([...APP_LOCALES].sort());
  });

  it("pages the test opens: the default locale is unprefixed, the others prefixed (as-needed)", () => {
    expect(routing.localePrefix).toBe("as-needed");
    expect(routing.defaultLocale).toBe(DEFAULT_LOCALE);
    for (const locale of APP_LOCALES) {
      expect(OPEN_PATH_PREFIX[locale]).toBe(locale === DEFAULT_LOCALE ? "" : `/${locale}`);
    }
  });

  it("server redirects and rendered links: every locale prefixed, as localizedPath builds them", () => {
    for (const locale of APP_LOCALES) {
      expect(`${REDIRECT_PATH_PREFIX[locale]}/dashboard`).toBe(localizedPath(locale, "/dashboard"));
      expect(`${REDIRECT_PATH_PREFIX[locale]}/invite/x?error=expired`).toBe(
        `${localizedPath(locale, "/invite/x")}?error=expired`,
      );
    }
    // The default locale is the one place the two rules differ.
    expect(REDIRECT_PATH_PREFIX[DEFAULT_LOCALE]).not.toBe(OPEN_PATH_PREFIX[DEFAULT_LOCALE]);
  });
});
