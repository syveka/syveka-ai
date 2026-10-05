// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider, createTranslator } from "next-intl";

/**
 * Renders the real Settings pages (Profile, Organization, Members, Audit log,
 * Billing) with the real EN/FI/AR message files. Mocked, and only these:
 * - session / permission guards (fixed OWNER context),
 * - the data layer (tenantDb, unscopedPrisma, billing entitlements/usage),
 * - server-action modules (never executed here),
 * - React's useActionState, so success/error states can be driven directly.
 * This is component-level coverage, not authenticated full-app coverage.
 */
const LOCALES = ["en", "fi", "ar"] as const;
type Locale = (typeof LOCALES)[number];

const load = (l: Locale) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8"));
const MESSAGES = { en: load("en"), fi: load("fi"), ar: load("ar") } as Record<
  Locale,
  Record<string, Record<string, unknown>>
>;

const state = vi.hoisted(() => ({
  locale: "en" as "en" | "fi" | "ar",
  actionState: {} as { error?: string; message?: string },
  plan: "STARTER" as string,
}));

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof React>();
  return { ...actual, useActionState: () => [state.actionState, () => {}, false] };
});

vi.mock("next-intl/server", async () => {
  const { createTranslator: create } = await import("next-intl");
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  const msgs = (l: string) =>
    JSON.parse(
      nodeFs.readFileSync(nodePath.resolve(__dirname, `../../messages/${l}.json`), "utf8"),
    );
  return {
    getLocale: vi.fn(async () => state.locale),
    getTranslations: vi.fn(async (namespace?: string) =>
      create({ locale: state.locale, messages: msgs(state.locale), namespace } as never),
    ),
  };
});

const CTX = {
  orgId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  role: "OWNER" as const,
  locale: "fi",
};
vi.mock("@/server/auth/session", () => ({ getTenantContext: vi.fn(async () => CTX) }));
vi.mock("@/server/auth/guard", () => ({ requirePermission: vi.fn(async () => CTX) }));

vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(() => ({
    auditLog: { findMany: vi.fn(async () => []) },
    organizationMember: {
      findMany: vi.fn(async () => [
        { id: "m1", userId: "22222222-2222-4222-8222-222222222222", role: "OWNER" },
        { id: "m2", userId: "44444444-4444-4444-8444-444444444444", role: "MANAGER" },
      ]),
      count: vi.fn(async () => 2),
    },
    invitation: {
      findMany: vi.fn(async () => [{ id: "i1", email: "pending@example.test", role: "VIEWER" }]),
    },
    contact: { count: vi.fn(async () => 1234) },
    document: { aggregate: vi.fn(async () => ({ _sum: { sizeBytes: 5 * 1_048_576 } })) },
  })),
  unscopedPrisma: {
    user: {
      findUnique: vi.fn(async () => ({ timezone: "Europe/Helsinki" })),
      findUniqueOrThrow: vi.fn(async () => ({
        fullName: "Olli Omistaja",
        email: "owner@example.test",
        locale: "FI",
        timezone: "Europe/Helsinki",
      })),
      findMany: vi.fn(async () => [
        {
          id: "22222222-2222-4222-8222-222222222222",
          email: "owner@example.test",
          fullName: "Olli Omistaja",
        },
        {
          id: "44444444-4444-4444-8444-444444444444",
          email: "manager@example.test",
          fullName: "Maija Mäkinen",
        },
      ]),
    },
    organization: {
      findUniqueOrThrow: vi.fn(async () => ({
        name: "Syveka Settings QA",
        businessId: null,
        vatId: null,
        settings: {},
        slug: "syveka-settings-qa",
      })),
    },
  },
}));

vi.mock("@/server/services/billing/entitlements", () => ({
  getEntitlements: vi.fn(async () => ({
    plan: state.plan,
    status: "ACTIVE",
    aiMessagesPerOrgMonth: 1000,
    voiceMinutesMonth: 100,
    maxContacts: 5000,
    kbStorageMb: 1024,
    maxSeats: 3,
  })),
  getMonthUsage: vi.fn(async () => 1500),
}));

vi.mock("@/actions/settings", () => ({
  updateProfileAction: vi.fn(),
  updateOrganizationAction: vi.fn(),
}));
vi.mock("@/actions/members", () => ({
  inviteMemberAction: vi.fn(),
  changeRoleAction: vi.fn(),
  removeMemberAction: { bind: () => vi.fn() },
}));
vi.mock("@/actions/billing", () => ({
  openPortalAction: vi.fn(),
  startCheckoutAction: { bind: () => vi.fn() },
}));

import ProfilePage from "@/app/[locale]/(app)/settings/profile/page";
import OrganizationSettingsPage from "@/app/[locale]/(app)/settings/organization/page";
import MembersPage from "@/app/[locale]/(app)/settings/members/page";
import AuditLogPage from "@/app/[locale]/(app)/settings/audit-log/page";
import BillingPage from "@/app/[locale]/(app)/settings/billing/page";

async function renderPage(locale: Locale, page: () => Promise<React.ReactElement>) {
  state.locale = locale;
  const el = await page();
  return render(
    <NextIntlClientProvider locale={locale} messages={MESSAGES[locale]} timeZone="UTC">
      {el}
    </NextIntlClientProvider>,
  );
}

const PAGES = {
  profile: () => ProfilePage(),
  organization: () => OrganizationSettingsPage(),
  members: () => MembersPage(),
  auditLog: () => AuditLogPage({ searchParams: Promise.resolve({}) }),
  billing: () => BillingPage({ searchParams: Promise.resolve({}) }),
};

/**
 * Every English UI string that a page could render. Used to prove FI/AR pages
 * leak no English copy (product names, codes and user data are allowed).
 */
function englishStrings(): string[] {
  const out: string[] = [];
  const walk = (v: unknown) => {
    if (typeof v === "string") out.push(v);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  const en = MESSAGES.en;
  for (const ns of [
    "roles",
    "settingsProfile",
    "settingsOrganization",
    "settingsMembers",
    "settingsAuditLog",
    "billingPage",
  ]) {
    walk(en[ns]);
  }
  return out
    .filter((s) => !s.includes("{")) // parameterised strings are checked via their rendered form
    .filter((s) => !s.includes("@")) // example email addresses are not copy
    .filter((s) => s.length > 3);
}

beforeEach(() => {
  state.actionState = {};
  state.plan = "STARTER";
});
afterEach(cleanup);

describe.each(LOCALES)("Settings pages render real %s translations", (locale) => {
  const m = MESSAGES[locale] as Record<string, Record<string, unknown>>;
  const s = (ns: string, key: string) => (m[ns] as Record<string, unknown>)[key] as string;

  it("Profile: title, labelled fields, localized saved status", async () => {
    state.actionState = { message: "saved" };
    await renderPage(locale, PAGES.profile);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      s("settingsProfile", "title"),
    );
    for (const key of ["email", "name", "language", "timezone"]) {
      expect(screen.getByLabelText(s("settingsProfile", key))).toBeTruthy();
    }
    expect(screen.getByRole("status").textContent).toBe(s("settingsProfile", "saved"));
    expect(document.body.textContent).not.toContain("✓");
  });

  it("Organization: title, workspace slug, labelled AI instructions with description", async () => {
    await renderPage(locale, PAGES.organization);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      s("settingsOrganization", "title"),
    );
    expect(document.body.textContent).toContain("syveka-settings-qa");
    const textarea = screen.getByLabelText(s("settingsOrganization", "aiInstructionsTitle"));
    expect(textarea.tagName).toBe("TEXTAREA");
    expect(textarea.getAttribute("placeholder")).toBe(
      s("settingsOrganization", "aiInstructionsPlaceholder"),
    );
    const help = document.getElementById(textarea.getAttribute("aria-describedby")!);
    expect(help?.textContent).toBe(s("settingsOrganization", "aiInstructionsHelp"));
    for (const key of ["companyName", "businessId", "vatId"]) {
      expect(screen.getByLabelText(s("settingsOrganization", key))).toBeTruthy();
    }
  });

  it("Members: translated role labels, canonical role values, accessible names", async () => {
    await renderPage(locale, PAGES.members);
    const roles = m.roles as Record<string, string>;
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      s("settingsMembers", "title"),
    );

    const inviteRole = screen.getByLabelText(s("settingsMembers", "roleLabel"));
    const options = within(inviteRole).getAllByRole("option") as HTMLOptionElement[];
    expect(options.map((o) => o.value)).toEqual(["ADMIN", "MANAGER", "MEMBER", "VIEWER"]);
    expect(options.map((o) => o.textContent)).toEqual(
      ["ADMIN", "MANAGER", "MEMBER", "VIEWER"].map((r) => roles[r]),
    );
    expect(screen.getByLabelText(s("settingsMembers", "emailLabel")).getAttribute("type")).toBe(
      "email",
    );

    // Owner row shows a translated badge, never the raw OWNER code.
    expect(screen.getByText(roles.OWNER!)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/\bOWNER\b|\bMANAGER\b|\bVIEWER\b/);

    // Other member's controls carry the member's name in their accessible names.
    const t = createTranslator({ locale, messages: m, namespace: "settingsMembers" } as never) as (
      k: string,
      v?: Record<string, string>,
    ) => string;
    const changeRole = screen.getByLabelText(t("changeRoleLabel", { name: "Maija Mäkinen" }));
    expect((changeRole as HTMLSelectElement).value).toBe("MANAGER");
    const remove = screen.getByRole("button", {
      name: t("removeLabel", { name: "Maija Mäkinen" }),
    });
    expect(remove.textContent).toBe(s("settingsMembers", "remove"));

    expect(document.body.textContent).toContain(
      `${s("settingsMembers", "pending")} · ${roles.VIEWER}`,
    );
  });

  it.each(["invalid_input", "already_member", "plan_limit", "invite_failed"])(
    "Members: invite error %s renders its localized message as an alert",
    async (code) => {
      state.actionState = { error: code };
      await renderPage(locale, PAGES.members);
      const errors = (m.settingsMembers as Record<string, Record<string, string>>).errors!;
      expect(screen.getByRole("alert").textContent).toBe(errors[code]);
    },
  );

  it("Members: an unknown error string never reaches the UI", async () => {
    state.actionState = { error: "Seat limit reached (3) — internal detail" };
    await renderPage(locale, PAGES.members);
    const errors = (m.settingsMembers as Record<string, Record<string, string>>).errors!;
    expect(screen.getByRole("alert").textContent).toBe(errors.invite_failed);
    expect(document.body.textContent).not.toContain("internal detail");
  });

  it("Audit log: title, labelled filter, empty state and timezone note", async () => {
    await renderPage(locale, PAGES.auditLog);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      s("settingsAuditLog", "title"),
    );
    const filter = screen.getByLabelText(s("settingsAuditLog", "filterLabel"));
    expect(filter.getAttribute("type")).toBe("search");
    expect(document.body.textContent).toContain(s("settingsAuditLog", "empty"));
    expect(document.body.textContent).toContain("Europe/Helsinki");
  });

  it("Billing: product names, localized features and unchanged numbers", async () => {
    await renderPage(locale, PAGES.billing);
    const text = document.body.textContent ?? "";
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(s("billingPage", "title"));
    // Product names are untranslated; raw enum codes are never shown.
    expect(text).toContain("Starter");
    expect(text).toContain("Pro");
    expect(text).not.toMatch(/\bSTARTER\b|\bPRO\b/);
    // Prices and limits are the same numbers in every locale (Latin digits in Arabic too).
    expect(text).toMatch(/29\s€/);
    expect(text).toMatch(/79\s€/);
    for (const n of [/1[\s,.  ]?000/, /5[\s,.  ]?000/, /100\b/, /500\b/, /25\b/]) {
      expect(text).toMatch(n);
    }
    expect(text).not.toMatch(/[٠-٩]/);
    const features = m.billingPage!.features as Record<string, string>;
    // No plan card advertises a public API until one exists.
    expect(text).not.toContain(features.apiWebhooks);
  });
});

describe("no English copy leaks into Finnish or Arabic Settings pages", () => {
  const english = englishStrings();

  it.each(["fi", "ar"] as const)("%s", async (locale) => {
    const seen: string[] = [];
    for (const [name, page] of Object.entries(PAGES)) {
      state.actionState = { error: "plan_limit", message: "saved" };
      const { container, unmount } = await renderPage(locale, page);
      const attrs = Array.from(container.querySelectorAll("[placeholder],[aria-label],[title]"))
        .flatMap((el) => [
          el.getAttribute("placeholder"),
          el.getAttribute("aria-label"),
          el.getAttribute("title"),
        ])
        .join(" ");
      const text = `${container.textContent} ${attrs}`;
      for (const s of english) {
        if (text.includes(s)) seen.push(`${name}: ${s}`);
      }
      for (const leftover of ["AI msg/user", "voice assistant", "workflows", "Invite", "Saved"]) {
        if (text.includes(leftover)) seen.push(`${name}: ${leftover}`);
      }
      unmount();
    }
    expect(seen).toEqual([]);
  });
});
