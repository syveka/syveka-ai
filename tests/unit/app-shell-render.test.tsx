// @vitest-environment jsdom
import React from "react";
import { afterEach, describe, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import fs from "node:fs";
import path from "node:path";

vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  usePathname: () => "/settings/business-dna",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  routing: { locales: ["fi", "en", "ar"], defaultLocale: "fi" },
}));

const messages = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"),
);

/**
 * Every authenticated page (including /settings/business-dna, the page
 * involved in the staging crash report) renders inside this same
 * AppSidebar + Topbar shell via the (app) layout. Ruling these out was part
 * of the crash investigation; kept as permanent coverage since neither had
 * any render test before.
 */
describe("(app) layout shell renders for a brand-new-org OWNER", () => {
  afterEach(cleanup);

  it("AppSidebar mounts without throwing", async () => {
    const { AppSidebar } = await import("../../src/components/layout/app-sidebar");
    const { permissionsFor } = await import("../../src/server/auth/permissions");
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <AppSidebar role="OWNER" permissions={permissionsFor("OWNER")} />
      </NextIntlClientProvider>,
    );
  });

  it("Topbar mounts without throwing", async () => {
    vi.mock("@/lib/supabase/client", () => ({
      createClient: () => ({
        channel: () => ({ on: () => ({ subscribe: () => ({}) }) }),
        removeChannel: () => {},
      }),
    }));
    vi.mock("next-themes", () => ({
      useTheme: () => ({ resolvedTheme: "light", setTheme: vi.fn() }),
    }));
    const { Topbar } = await import("../../src/components/layout/topbar");
    render(
      <NextIntlClientProvider locale="en" messages={messages}>
        <Topbar
          userId="00000000-0000-0000-0000-000000000000"
          orgName="Fruppi Toys"
          initialUnread={0}
        />
      </NextIntlClientProvider>,
    );
  });
});
