// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";
import { permissionsFor } from "@/server/auth/permissions";

const pathname = vi.hoisted(() => ({ current: "/settings/members" }));

vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  usePathname: () => pathname.current,
}));

import { SettingsNav } from "@/components/settings/settings-nav";
import { SETTINGS_NAV } from "@/components/settings/settings-nav-items";

const load = (locale: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${locale}.json`), "utf8"));
const MESSAGES = { en: load("en"), fi: load("fi"), ar: load("ar") } as const;

function renderNav(locale: keyof typeof MESSAGES, role: Parameters<typeof permissionsFor>[0]) {
  return render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]}>
      <SettingsNav permissions={permissionsFor(role)} />
    </NextIntlClientProvider>,
  );
}

describe("SettingsNav", () => {
  afterEach(() => {
    cleanup();
    pathname.current = "/settings/members";
  });

  it.each(["en", "fi", "ar"] as const)(
    "renders translated labels and a translated landmark name (%s)",
    (locale) => {
      renderNav(locale, "OWNER");
      const m = MESSAGES[locale].settingsNav;
      const nav = screen.getByRole("navigation", { name: m.label });
      const links = within(nav).getAllByRole("link");
      expect(links.map((l) => l.textContent)).toEqual(SETTINGS_NAV.map((i) => m[i.key]));
    },
  );

  it("marks exactly the current page with aria-current and a non-colour indicator", () => {
    pathname.current = "/settings/billing";
    renderNav("en", "OWNER");
    const current = screen.getAllByRole("link").filter((l) => l.getAttribute("aria-current"));
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveProperty("textContent", "Billing");
    expect(current[0]!.getAttribute("aria-current")).toBe("page");
    expect(current[0]!.className).toMatch(/\bfont-medium\b/);
    expect(current[0]!.className).toMatch(/\bborder-primary\b/);
  });

  it("shows members/viewers only the destinations their role can open", () => {
    renderNav("en", "MEMBER");
    const hrefs = screen.getAllByRole("link").map((l) => l.getAttribute("href"));
    expect(hrefs).toEqual(["/settings/profile", "/settings/business-dna"]);
  });

  it("uses plain, focusable links (native keyboard navigation) with a visible focus ring", () => {
    renderNav("en", "OWNER");
    for (const link of screen.getAllByRole("link")) {
      expect(link.tagName).toBe("A");
      expect(link.getAttribute("href")).toMatch(/^\/settings\//);
      expect(link.getAttribute("tabindex")).toBeNull();
      expect(link.className).toMatch(/focus-visible:ring-2/);
    }
  });

  it("scrolls horizontally on phones, stacks from md up, and uses only RTL-safe classes", () => {
    const { container } = renderNav("ar", "OWNER");
    const list = container.querySelector("ul")!;
    expect(list.className).toMatch(/\boverflow-x-auto\b/);
    expect(list.className).toMatch(/\bmd:flex-col\b/);
    const classes = Array.from(container.querySelectorAll("[class]"))
      .map((el) => el.getAttribute("class"))
      .join(" ");
    expect(classes).toMatch(/\bmd:border-s-2\b/);
    expect(classes).not.toMatch(
      /(^|\s)(md:)?(ml|mr|pl|pr|left|right|border-l|border-r|text-left|text-right)-/,
    );
  });
});

describe("SettingsNav keeps the active tab visible on phones", () => {
  const rect = (left: number, right: number) =>
    ({
      left,
      right,
      top: 0,
      bottom: 40,
      width: right - left,
      height: 40,
      x: left,
      y: 0,
    }) as DOMRect;

  function setup(opts: { scrollable: boolean; tab: [number, number] }) {
    const scrollBy = vi.fn();
    const scrollIntoView = vi.fn();
    const restore = [
      vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockImplementation(function (
        this: HTMLElement,
      ) {
        return this.tagName === "UL" && opts.scrollable ? 900 : 0;
      }),
      vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(function (
        this: HTMLElement,
      ) {
        return this.tagName === "UL" ? 300 : 0;
      }),
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
        this: HTMLElement,
      ) {
        if (this.tagName === "UL") return rect(10, 310);
        if (this.getAttribute("aria-current") === "page") return rect(...opts.tab);
        return rect(0, 0);
      }),
    ];
    Object.defineProperty(HTMLElement.prototype, "scrollBy", {
      value: scrollBy,
      configurable: true,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      value: scrollIntoView,
      configurable: true,
    });
    return { scrollBy, scrollIntoView, restore: () => restore.forEach((r) => r.mockRestore()) };
  }

  afterEach(() => {
    cleanup();
    pathname.current = "/settings/members";
  });

  it("scrolls only the tab row (never scrollIntoView) when the active tab is past the end", () => {
    pathname.current = "/settings/audit-log";
    const s = setup({ scrollable: true, tab: [400, 480] });
    renderNav("en", "OWNER");
    // 480 - 310 + 8 px margin, as a physical delta on the row itself.
    expect(s.scrollBy).toHaveBeenCalledWith({ left: 178 });
    // scrollIntoView would move the keyboard focus-navigation starting point.
    expect(s.scrollIntoView).not.toHaveBeenCalled();
    s.restore();
  });

  it("scrolls the other way when the active tab is before the start (RTL rows)", () => {
    pathname.current = "/settings/audit-log";
    const s = setup({ scrollable: true, tab: [-150, -70] });
    renderNav("ar", "OWNER");
    expect(s.scrollBy).toHaveBeenCalledWith({ left: -168 });
    expect(s.scrollIntoView).not.toHaveBeenCalled();
    s.restore();
  });

  it("does nothing when the active tab is already visible", () => {
    pathname.current = "/settings/profile";
    const s = setup({ scrollable: true, tab: [20, 100] });
    renderNav("en", "OWNER");
    expect(s.scrollBy).not.toHaveBeenCalled();
    s.restore();
  });

  it("does nothing when the row does not scroll (desktop column)", () => {
    pathname.current = "/settings/audit-log";
    const s = setup({ scrollable: false, tab: [400, 480] });
    renderNav("en", "OWNER");
    expect(s.scrollBy).not.toHaveBeenCalled();
    s.restore();
  });
});

describe("settings navigation translations", () => {
  it.each(["fi", "ar"] as const)(
    "%s translates every new label (not left in English)",
    (locale) => {
      const en = MESSAGES.en;
      const other = MESSAGES[locale];
      for (const key of [
        "label",
        "profile",
        "organization",
        "members",
        "integrations",
        "billing",
        "auditLog",
      ]) {
        expect(other.settingsNav[key], `${locale}.settingsNav.${key}`).toBeTruthy();
        expect(other.settingsNav[key]).not.toBe(en.settingsNav[key]);
      }
      expect(other.calendar.connectCalendarLink).toBeTruthy();
      expect(other.calendar.connectCalendarLink).not.toBe(en.calendar.connectCalendarLink);
    },
  );

  it("reuses each locale's existing Business DNA label so both navs agree", () => {
    for (const locale of ["en", "fi", "ar"] as const) {
      expect(MESSAGES[locale].settingsNav.businessDna).toBe(MESSAGES[locale].nav.businessDna);
    }
  });
});
