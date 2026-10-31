// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../messages/en.json";

/**
 * CRM contacts and companies lists. An invalid query string (e.g. a search
 * longer than 200 characters, reachable by pasting into the search box or
 * editing the URL) made the page throw and show the error screen. It now
 * falls back to the default, unfiltered list, and the contacts search box
 * stops at 200 characters.
 *
 * Mocked: permission guard, CRM services (data), server actions, navigation.
 * Real: pages, query schemas, ContactsTable, messages.
 */

const ctx = vi.hoisted(() => ({
  orgId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  role: "OWNER",
}));
const svc = vi.hoisted(() => ({
  listContacts: vi.fn(async (..._args: unknown[]) => {
    void _args;
    return { data: [], nextCursor: undefined };
  }),
  listCompanies: vi.fn(async (..._args: unknown[]) => {
    void _args;
    return { data: [], nextCursor: undefined };
  }),
}));

vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => key),
}));
vi.mock("@/server/auth/guard", () => ({ requirePermission: vi.fn(async () => ctx) }));
vi.mock("@/server/services/contacts", () => ({ listContacts: svc.listContacts }));
vi.mock("@/server/services/companies", () => ({
  listCompanies: svc.listCompanies,
  listCompanyOptions: vi.fn(async () => []),
}));
vi.mock("@/actions/contacts", () => ({
  createContactAction: vi.fn(),
  updateContactAction: vi.fn(),
  deleteContactAction: vi.fn(),
}));
vi.mock("@/actions/companies", () => ({
  createCompanyAction: vi.fn(),
  updateCompanyAction: vi.fn(),
  deleteCompanyAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useSearchParams: () => new URLSearchParams() }));
vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  usePathname: () => "/crm/contacts",
  useRouter: () => ({ push() {}, replace() {}, refresh() {} }),
}));

import ContactsPage from "@/app/[locale]/(app)/crm/contacts/page";
import CompaniesPage from "@/app/[locale]/(app)/crm/companies/page";
import { ContactsTable } from "@/components/crm/contacts-table";

const TOO_LONG = "x".repeat(201);
const DEFAULTS = { archived: "active", limit: 25 };
const searchParams = (q: string) => Promise.resolve({ q });

beforeEach(() => {
  svc.listContacts.mockClear();
  svc.listCompanies.mockClear();
});
afterEach(cleanup);

describe("an invalid list query falls back to the defaults", () => {
  it("contacts: a 201-character search lists unfiltered contacts; a valid one still filters", async () => {
    await expect(ContactsPage({ searchParams: searchParams(TOO_LONG) })).resolves.toBeTruthy();
    expect(svc.listContacts).toHaveBeenLastCalledWith(ctx, DEFAULTS);

    await ContactsPage({ searchParams: searchParams("anna") });
    expect(svc.listContacts).toHaveBeenLastCalledWith(ctx, { ...DEFAULTS, q: "anna" });
  });

  it("companies: a 201-character search lists unfiltered companies; a valid one still filters", async () => {
    await expect(CompaniesPage({ searchParams: searchParams(TOO_LONG) })).resolves.toBeTruthy();
    expect(svc.listCompanies).toHaveBeenLastCalledWith(ctx, DEFAULTS);

    await CompaniesPage({ searchParams: searchParams("acme") });
    expect(svc.listCompanies).toHaveBeenLastCalledWith(ctx, { ...DEFAULTS, q: "acme" });
  });
});

describe("contacts search box", () => {
  it("accepts at most 200 characters (the query limit)", () => {
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="Europe/Helsinki">
        <ContactsTable contacts={[]} canDelete={false} />
      </NextIntlClientProvider>,
    );
    const search = screen.getByPlaceholderText(messages.crm.searchPlaceholder);
    expect(search.getAttribute("maxlength")).toBe("200");
  });
});
