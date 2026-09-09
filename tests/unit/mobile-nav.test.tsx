// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";

vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  usePathname: () => "/dashboard",
}));

const messages = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"),
);

/**
 * AppSidebar (src/components/layout/app-sidebar.tsx) is `hidden md:block` --
 * every route it lists was completely unreachable below the md breakpoint,
 * with no replacement anywhere in the layout (a real pilot-blocking gap for
 * SME mobile usage, not just a cosmetic one). MobileNav is the minimal fix:
 * same permission-filtered destination list as the desktop sidebar (shared
 * via nav-items.ts), reachable through a menu button in the topbar instead.
 */
describe("MobileNav", () => {
  afterEach(cleanup);

  it("reveals every permission-visible destination when opened, and hides gated ones", async () => {
    const { MobileNav } = await import("../../src/components/layout/mobile-nav");
    const { permissionsFor } = await import("../../src/server/auth/permissions");

    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MobileNav permissions={permissionsFor("MEMBER")} />
      </NextIntlClientProvider>,
    );

    const trigger = screen.getByRole("button", { name: "menu" });
    expect(trigger).toBeTruthy();

    // Radix's DropdownMenu.Trigger opens on pointerdown, not a bare click --
    // jsdom's fireEvent.click alone never fires it.
    fireEvent.pointerDown(trigger, { button: 0, pointerId: 1 });
    fireEvent.click(trigger);

    // Radix's DropdownMenu.Item exposes each entry as role="menuitem" (the
    // ARIA menu widget pattern), not "link", even though it's an <a> under
    // the hood via asChild.
    // A MEMBER has crm:read (see src/server/auth/permissions.ts) -- reachable.
    expect(await screen.findByRole("menuitem", { name: "Contacts" })).toBeTruthy();
    // A MEMBER has analytics:view-own, not analytics:view (the permission
    // AppSidebar/NAV gates this route on) -- must stay hidden here too, or
    // the two navs would grant different access to the same role.
    expect(screen.queryByRole("menuitem", { name: "Analytics" })).toBeNull();
  });

  it("is only rendered for mobile viewports (md:hidden), never a second nav on desktop", async () => {
    const { MobileNav } = await import("../../src/components/layout/mobile-nav");
    const { permissionsFor } = await import("../../src/server/auth/permissions");

    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <MobileNav permissions={permissionsFor("OWNER")} />
      </NextIntlClientProvider>,
    );

    expect(screen.getByRole("button", { name: "menu" }).className).toContain("md:hidden");
  });
});
