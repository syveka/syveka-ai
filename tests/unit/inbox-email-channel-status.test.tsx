// Simulate the deployed server runtime (UTC).
process.env.TZ = "UTC";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * Observed: Inbox said "Email connected" while the Dashboard said "Email
 * channel: Verification required". Inbox read only "credentials present";
 * the Dashboard also required a real received inbound email. Both now read
 * the same status (getEmailChannelStatus) and the Inbox wording never implies
 * verified end-to-end capability, nor that sending works.
 */
const state = vi.hoisted(() => ({
  locale: "en" as "en" | "fi" | "ar",
  role: "OWNER",
  adapter: { provider: "RESEND", isConfigured: () => true } as {
    provider: string;
    isConfigured: () => boolean;
  },
  inbound: null as { id: string } | null,
  threads: [] as Array<Record<string, unknown>>,
}));
const load = (l: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8"));
const MESSAGES = { en: load("en"), fi: load("fi"), ar: load("ar") };

vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  return {
    getLocale: vi.fn(async () => state.locale),
    getTranslations: vi.fn(async (namespace?: string) =>
      createTranslator({
        locale: state.locale,
        messages: MESSAGES[state.locale],
        namespace,
      } as never),
    ),
  };
});
vi.mock("@/server/auth/guard", () => ({
  requirePermission: vi.fn(async () => ({
    orgId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    role: state.role,
  })),
}));
vi.mock("@/server/channels/email", () => ({
  getEmailChannelAdapter: vi.fn(() => state.adapter),
}));
vi.mock("@/server/business-dna/context", () => ({
  getBusinessDnaContext: vi.fn(async () => null),
}));
vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(() => ({
    inboxThread: { findFirst: vi.fn(async () => state.inbound) },
    bookingType: { count: vi.fn(async () => 0) },
    voiceAssistant: { findFirst: vi.fn(async () => null) },
    voiceCall: { findFirst: vi.fn(async () => null) },
  })),
  unscopedPrisma: {
    user: { findUnique: vi.fn(async () => ({ timezone: "Europe/Helsinki" })) },
  },
}));
vi.mock("@/server/services/inbox", () => ({
  listThreads: vi.fn(async () => ({ data: state.threads })),
}));
vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import InboxPage from "@/app/[locale]/(app)/inbox/page";
import { getOrgSetupReadiness } from "@/server/services/setup-readiness";

const ctx = {
  orgId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  email: "owner@example.test",
  role: "OWNER",
  locale: "en",
} as const;

/** Awaits nested async server components (renderToStaticMarkup cannot). */
async function resolveAsync(node: React.ReactNode): Promise<React.ReactNode> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!React.isValidElement(node)) return node;
  const el = node as React.ReactElement<{ children?: React.ReactNode }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    const render = el.type as (props: unknown) => Promise<React.ReactNode>;
    return resolveAsync(await render(el.props));
  }
  if (el.props && "children" in el.props) {
    return React.cloneElement(el, undefined, await resolveAsync(el.props.children));
  }
  return el;
}

async function renderInbox(locale: "en" | "fi" | "ar" = "en") {
  state.locale = locale;
  const page = await InboxPage({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(<>{await resolveAsync(page)}</>);
}
const dashboardEmailState = async () =>
  (await getOrgSetupReadiness(ctx as never)).find((i) => i.key === "emailChannel")?.state;

beforeEach(() => {
  state.locale = "en";
  state.role = "OWNER";
  state.adapter = { provider: "RESEND", isConfigured: () => true };
  state.inbound = null;
  state.threads = [];
});

describe("Inbox email channel status matches the Dashboard readiness", () => {
  it.each(["en", "fi", "ar"] as const)(
    "credentials without any received email are 'not verified yet', never 'connected' (%s)",
    async (locale) => {
      const html = await renderInbox(locale);
      expect(html).toContain(MESSAGES[locale].inbox.channelStatus.configuredUnverified);
      expect(html).toContain(MESSAGES[locale].inbox.empty);
      expect(html).not.toContain("Email connected");
      expect(await dashboardEmailState()).toBe("verification_required");
    },
  );

  it("says inbound email received only after a real inbound email, matching Dashboard 'ready'", async () => {
    state.inbound = { id: "thread-1" };
    const html = await renderInbox("en");
    expect(html).toContain("Inbound email received: at least one real email has arrived");
    expect(html).not.toMatch(/send/i);
    expect(await dashboardEmailState()).toBe("ready");
  });

  it("reports missing credentials as not configured on both", async () => {
    state.adapter = { provider: "RESEND", isConfigured: () => false };
    expect(await renderInbox("fi")).toContain(MESSAGES.fi.inbox.channelStatus.notConfigured);
    expect(await dashboardEmailState()).toBe("not_configured");
  });

  it("names the simulated test provider in the Inbox; the Dashboard counts it as not configured", async () => {
    state.adapter = { provider: "MOCK", isConfigured: () => true };
    expect(await renderInbox("en")).toContain(MESSAGES.en.inbox.channelStatus.mock);
    expect(await dashboardEmailState()).toBe("not_configured");
  });

  it("shows thread times in the viewer's zone (Helsinki), not UTC", async () => {
    state.threads = [
      {
        id: "t1",
        subject: "Hello",
        status: "OPEN",
        channel: "EMAIL",
        readAt: null,
        contact: null,
        assignedTo: null,
        lastMessageAt: new Date("2026-11-01T10:15:00.000Z"),
      },
    ];
    const html = await renderInbox("fi");
    expect(html).toContain("12.15");
    expect(html).not.toContain("10.15");
  });
});
