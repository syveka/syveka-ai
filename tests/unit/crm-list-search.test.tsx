// @vitest-environment jsdom
import React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../messages/en.json";

/**
 * CRM contacts and companies search, as seen on staging: "NoMatch987" still
 * listed contacts and companies, and "Pilot Guest" still listed "Pilot Test
 * Contact".
 *
 * - The search box applied a query only on an Enter keydown, which a phone
 *   keyboard's Search/Go key does not reliably produce, so the query never
 *   reached the URL and the unfiltered list stayed. It now submits as a form,
 *   has a search button, and follows typing after a short pause.
 * - The server matched the whole query against each field, so a first + last
 *   name ("Pilot Guest") matched nothing. Every term must now match a field.
 *
 * The where-clauses the real services build are evaluated against several
 * distinct records, so a filter that lets unrelated records through fails.
 */

const db = vi.hoisted(() => ({
  contactFindMany: vi.fn(async (..._a: unknown[]) => {
    void _a;
    return [];
  }),
  companyFindMany: vi.fn(async (..._a: unknown[]) => {
    void _a;
    return [];
  }),
}));
const nav = vi.hoisted(() => ({
  replace: vi.fn((..._a: unknown[]) => {
    void _a;
  }),
  params: new URLSearchParams(),
}));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: () => ({
    contact: { findMany: db.contactFindMany },
    company: { findMany: db.companyFindMany },
  }),
  unscopedPrisma: {},
}));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn() }));
vi.mock("@/server/services/billing/entitlements", () => ({
  assertWithinLimit: vi.fn(),
  EntitlementError: class extends Error {},
}));
vi.mock("@/server/services/workflow-events", () => ({ emitWorkflowEvent: vi.fn() }));
vi.mock("@/actions/contacts", () => ({ deleteContactAction: vi.fn() }));
vi.mock("@/actions/companies", () => ({ deleteCompanyAction: vi.fn() }));
vi.mock("next/navigation", () => ({ useSearchParams: () => nav.params }));
vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href}>{children}</a>
  ),
  usePathname: () => "/crm/contacts",
  useRouter: () => ({ replace: nav.replace, push() {}, refresh() {} }),
}));

import { listContacts } from "@/server/services/contacts";
import { listCompanies } from "@/server/services/companies";
import { ContactsTable } from "@/components/crm/contacts-table";
import { CompaniesTable } from "@/components/crm/companies-table";
import { SEARCH_DEBOUNCE_MS } from "@/components/crm/list-search";

type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

/** Evaluates the subset of Prisma filters the list services use. */
function matches(where: Where, row: Row): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === "AND") return (cond as Where[]).every((w) => matches(w, row));
    if (key === "OR") return (cond as Where[]).some((w) => matches(w, row));
    const value = row[key];
    if (cond === null) return value === null;
    if (typeof cond === "object") {
      const c = cond as { contains?: string; mode?: string; not?: null };
      if ("not" in c) return value !== null;
      if (c.contains !== undefined) {
        if (typeof value !== "string") return false;
        return c.mode === "insensitive"
          ? value.toLowerCase().includes(c.contains.toLowerCase())
          : value.includes(c.contains);
      }
    }
    return value === cond;
  });
}

const contact = (firstName: string, lastName: string | null, extra: Row = {}): Row => ({
  firstName,
  lastName,
  email: null,
  phone: null,
  status: "LEAD",
  companyId: null,
  deletedAt: null,
  archivedAt: null,
  ...extra,
});
const CONTACTS: Row[] = [
  contact("Pilot Test", "Contact", { email: "pilot.contact@example.com" }),
  contact("Pilot", "Guest", { email: "guest@example.com", phone: "+358401234567" }),
  contact("Anna", "Virtanen", { email: "anna@example.com", status: "CUSTOMER" }),
  contact("Pilot", "Archived", { archivedAt: new Date("2026-10-01") }),
  contact("Pilot", "Deleted", { deletedAt: new Date("2026-10-01") }),
];
const company = (name: string, extra: Row = {}): Row => ({
  name,
  domain: null,
  industry: null,
  deletedAt: null,
  archivedAt: null,
  ...extra,
});
const COMPANIES: Row[] = [
  company("Pilot Test Company", { domain: "pilot.example.test" }),
  company("Acme Oy", { industry: "Retail" }),
  company("Pilot Archived Oy", { archivedAt: new Date("2026-10-01") }),
];

async function contactNames(q: string | undefined, archived: "active" | "archived" | "all") {
  db.contactFindMany.mockClear();
  await listContacts({ orgId: "org-a", userId: "u", role: "OWNER" } as never, {
    q,
    archived,
    limit: 25,
  });
  const where = (db.contactFindMany.mock.calls[0]![0] as { where: Where }).where;
  return CONTACTS.filter((c) => matches(where, c)).map((c) => `${c.firstName} ${c.lastName}`);
}

async function companyNames(q: string | undefined, archived: "active" | "archived" | "all") {
  db.companyFindMany.mockClear();
  await listCompanies({ orgId: "org-a", userId: "u", role: "OWNER" } as never, {
    q,
    archived,
    limit: 25,
  });
  const where = (db.companyFindMany.mock.calls[0]![0] as { where: Where }).where;
  return COMPANIES.filter((c) => matches(where, c)).map((c) => c.name);
}

describe("server-side search on distinct records", () => {
  it("a query that matches nothing returns nothing", async () => {
    expect(await contactNames("NoMatch987", "active")).toEqual([]);
    expect(await companyNames("NoMatch987", "active")).toEqual([]);
  });

  it("first + last name finds that contact and excludes unrelated ones", async () => {
    expect(await contactNames("Pilot Guest", "active")).toEqual(["Pilot Guest"]);
    expect(await contactNames("pilot test", "active")).toEqual(["Pilot Test Contact"]);
  });

  it("matches email and a spaced phone number term by term", async () => {
    expect(await contactNames("anna@example", "active")).toEqual(["Anna Virtanen"]);
    expect(await contactNames("040 1234", "active")).toEqual([]);
    expect(await contactNames("358 401234", "active")).toEqual(["Pilot Guest"]);
  });

  it("composes with the Active / Archived / All filter and never returns deleted rows", async () => {
    expect(await contactNames("Pilot", "active")).toEqual(["Pilot Test Contact", "Pilot Guest"]);
    expect(await contactNames("Pilot", "archived")).toEqual(["Pilot Archived"]);
    expect(await contactNames("Pilot", "all")).toEqual([
      "Pilot Test Contact",
      "Pilot Guest",
      "Pilot Archived",
    ]);
    expect(await companyNames("pilot", "active")).toEqual(["Pilot Test Company"]);
    expect(await companyNames("pilot", "all")).toEqual(["Pilot Test Company", "Pilot Archived Oy"]);
    expect(await companyNames("retail acme", "active")).toEqual(["Acme Oy"]);
  });

  it("an empty or whitespace-only query lists everything active", async () => {
    expect(await contactNames(undefined, "active")).toHaveLength(3);
    expect(await contactNames("   ", "active")).toHaveLength(3);
  });
});

function renderContacts(rows: React.ComponentProps<typeof ContactsTable>["contacts"] = []) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages} timeZone="Europe/Helsinki">
      <ContactsTable contacts={rows} canDelete={false} />
    </NextIntlClientProvider>,
  );
}
const lastUrl = () => String(nav.replace.mock.calls.at(-1)?.[0] ?? "");
const searchBox = () => screen.getByRole("searchbox");

describe("search box (client)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    nav.replace.mockClear();
    nav.params = new URLSearchParams();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("is labelled, has a search button, and stays within the 200-character limit", () => {
    renderContacts();
    expect(searchBox().getAttribute("aria-label")).toBe(messages.crm.searchPlaceholder);
    expect(searchBox().getAttribute("maxlength")).toBe("200");
    expect(searchBox().getAttribute("enterkeyhint")).toBe("search");
    expect(screen.getByRole("button", { name: messages.crm.search })).toBeTruthy();
  });

  it("a keyboard Search/Go (form submit) applies the query without an Enter keydown", () => {
    renderContacts();
    fireEvent.change(searchBox(), { target: { value: "NoMatch987" } });
    fireEvent.submit(searchBox().closest("form")!);
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(lastUrl()).toBe("/crm/contacts?q=NoMatch987");
    // The debounce that was pending does not send it a second time.
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2));
    expect(nav.replace).toHaveBeenCalledTimes(1);
  });

  it("the search button applies the query", () => {
    renderContacts();
    fireEvent.change(searchBox(), { target: { value: "Pilot Guest" } });
    fireEvent.click(screen.getByRole("button", { name: messages.crm.search }));
    expect(lastUrl()).toBe("/crm/contacts?q=Pilot+Guest");
  });

  it("rapid typing applies only the latest text, once", () => {
    renderContacts();
    for (const value of ["P", "Pi", "Pil", "Pilot", "Pilot G"]) {
      fireEvent.change(searchBox(), { target: { value } });
      act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS / 2));
    }
    expect(nav.replace).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(lastUrl()).toBe("/crm/contacts?q=Pilot+G");
  });

  it("keeps the other filters and resets paging when the query changes", () => {
    nav.params = new URLSearchParams("archived=all&status=LEAD&cursor=abc");
    renderContacts();
    fireEvent.change(searchBox(), { target: { value: "anna" } });
    fireEvent.submit(searchBox().closest("form")!);
    const url = new URL(lastUrl(), "https://x.test");
    expect(url.searchParams.get("q")).toBe("anna");
    expect(url.searchParams.get("archived")).toBe("all");
    expect(url.searchParams.get("status")).toBe("LEAD");
    expect(url.searchParams.get("cursor")).toBeNull();
  });

  it("text typed while the previous search is landing is not overwritten", () => {
    const view = renderContacts();
    fireEvent.change(searchBox(), { target: { value: "Pilot" } });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    fireEvent.change(searchBox(), { target: { value: "Pilot Gu" } });
    // The navigation for "Pilot" lands now.
    nav.params = new URLSearchParams("q=Pilot");
    view.rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="Europe/Helsinki">
        <ContactsTable contacts={[]} canDelete={false} />
      </NextIntlClientProvider>,
    );
    expect((searchBox() as HTMLInputElement).value).toBe("Pilot Gu");
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    expect(lastUrl()).toBe("/crm/contacts?q=Pilot+Gu");
  });

  it("follows the URL when it changes elsewhere (back button)", () => {
    nav.params = new URLSearchParams("q=anna");
    const view = renderContacts();
    nav.params = new URLSearchParams("q=pilot");
    view.rerender(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="Europe/Helsinki">
        <ContactsTable contacts={[]} canDelete={false} />
      </NextIntlClientProvider>,
    );
    expect((searchBox() as HTMLInputElement).value).toBe("pilot");
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("a whitespace-only or unchanged query is not sent", () => {
    nav.params = new URLSearchParams("q=anna");
    renderContacts();
    fireEvent.change(searchBox(), { target: { value: "  anna " } });
    fireEvent.submit(searchBox().closest("form")!);
    fireEvent.change(searchBox(), { target: { value: "   " } });
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS));
    // "   " clears the applied "anna": one call, removing q.
    expect(nav.replace).toHaveBeenCalledTimes(1);
    expect(lastUrl()).toBe("/crm/contacts?");
  });

  it("no matches: a clear empty state whose button restores the list", () => {
    nav.params = new URLSearchParams("q=NoMatch987&archived=all");
    renderContacts([]);
    const status = screen.getByRole("status");
    expect(status.textContent).toContain("No contacts match “NoMatch987”.");
    expect(screen.queryByText(messages.crm.noContacts)).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: messages.crm.clearSearch }).at(-1)!);
    expect(lastUrl()).toBe("/crm/contacts?archived=all");
  });

  it("the clear (×) button in the box removes the search", () => {
    nav.params = new URLSearchParams("q=anna");
    renderContacts();
    fireEvent.click(screen.getAllByRole("button", { name: messages.crm.clearSearch })[0]!);
    expect(lastUrl()).toBe("/crm/contacts?");
    expect((searchBox() as HTMLInputElement).value).toBe("");
    expect(document.activeElement).toBe(searchBox());
  });

  it("unmounting with a pending search sends nothing", () => {
    const { unmount } = renderContacts();
    fireEvent.change(searchBox(), { target: { value: "late" } });
    unmount();
    act(() => vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS * 2));
    expect(nav.replace).not.toHaveBeenCalled();
  });

  it("companies: same box, and its own no-match state", () => {
    nav.params = new URLSearchParams("q=NoMatch987");
    render(
      <NextIntlClientProvider locale="en" messages={messages} timeZone="Europe/Helsinki">
        <CompaniesTable companies={[]} canDelete={false} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("status").textContent).toContain("No companies match “NoMatch987”.");
    fireEvent.change(searchBox(), { target: { value: "Pilot" } });
    fireEvent.submit(searchBox().closest("form")!);
    expect(lastUrl()).toBe("/crm/contacts?q=Pilot");
  });
});
