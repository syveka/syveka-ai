// Simulate the deployed server runtime (Vercel functions run in UTC). Without
// this, a developer machine in Helsinki would mask the defect.
process.env.TZ = "UTC";
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";

import { createTranslator } from "next-intl";
import { DEFAULT_PIPELINE_STAGES } from "@/lib/constants";
import type { CrmDashboard } from "@/server/services/dashboard";

/**
 * Display-time policy: stored instants (UTC) are shown in the viewer's profile
 * timezone, falling back to Europe/Helsinki, with the zone's own DST rules —
 * never the server runtime's zone (UTC) and never a fixed offset.
 *
 * Observed defect: notification/timeline times rendered two hours behind the
 * phone in Finland (UTC instead of EET). Real: the notifications page, the
 * CRM timeline, the dashboard view and the EN/FI/AR messages. Mocked: auth,
 * the data layer (synthetic fixtures) and routing.
 */
const state = vi.hoisted(() => ({
  locale: "fi" as "fi" | "en" | "ar",
  viewerTimezone: "Europe/Helsinki" as string | null,
  notifications: [] as Array<Record<string, unknown>>,
}));

const MESSAGES = Object.fromEntries(
  ["en", "fi", "ar"].map((l) => [
    l,
    JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8")),
  ]),
);

vi.mock("next-intl/server", () => ({
  getLocale: vi.fn(async () => state.locale),
  getTranslations: vi.fn(async (namespace?: string) =>
    createTranslator({
      locale: state.locale,
      messages: MESSAGES[state.locale],
      namespace,
    } as never),
  ),
}));
vi.mock("@/server/auth/session", () => ({
  getTenantContext: vi.fn(async () => ({
    orgId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    role: "OWNER",
  })),
}));
vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(() => ({ pipeline: { findMany: vi.fn(async () => []) } })),
  unscopedPrisma: {
    user: {
      findUnique: vi.fn(async () => ({ timezone: state.viewerTimezone })),
    },
  },
}));
vi.mock("@/server/services/notifications", () => ({
  listNotifications: vi.fn(async () => state.notifications),
}));
vi.mock("@/actions/notifications", () => ({ markReadAction: vi.fn() }));
vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import NotificationsPage from "@/app/[locale]/(app)/notifications/page";
import { ActivityTimeline } from "@/components/crm/activity-timeline";
import { CrmDashboardView } from "@/components/dashboard/crm-dashboard";
import { formatDateTimeInTimeZone } from "@/lib/date-time";
import { getViewerTimeZone } from "@/server/services/viewer-time-zone";

/** Inserted values are wrapped in Unicode isolates; assertions read the visible text. */
const renderToStaticMarkup = (node: Parameters<typeof renderMarkup>[0]) =>
  renderMarkup(node).replace(/[\u2068\u2069]/g, "");

const OBSERVED = new Date("2026-11-01T10:15:00.000Z"); // 12:15 in Helsinki (EET, UTC+2)

beforeEach(() => {
  state.locale = "fi";
  state.viewerTimezone = "Europe/Helsinki";
  state.notifications = [];
});

describe("display time zone policy", () => {
  it("runs with a UTC runtime zone, like the deployed server", () => {
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toMatch(/^(UTC|Etc\/UTC)$/);
  });

  it("follows Helsinki DST at the late-October boundary (no fixed offset)", () => {
    const fmt = (iso: string) =>
      formatDateTimeInTimeZone(iso, "en-GB", "Europe/Helsinki", {
        dateStyle: "short",
        timeStyle: "short",
      });
    // EEST (UTC+3) until 2026-10-25 01:00 UTC, then EET (UTC+2).
    expect(fmt("2026-10-24T21:30:00Z")).toBe("25/10/2026, 00:30");
    expect(fmt("2026-10-25T00:59:00Z")).toBe("25/10/2026, 03:59");
    expect(fmt("2026-10-25T01:00:00Z")).toBe("25/10/2026, 03:00");
    expect(fmt("2026-10-25T21:30:00Z")).toBe("25/10/2026, 23:30");
  });

  it("follows Helsinki DST at the late-March boundary", () => {
    const fmt = (iso: string) =>
      formatDateTimeInTimeZone(iso, "en-GB", "Europe/Helsinki", { timeStyle: "short" });
    // EET (UTC+2) until 2026-03-29 01:00 UTC, then EEST (UTC+3).
    expect(fmt("2026-03-29T00:30:00Z")).toBe("02:30");
    expect(fmt("2026-03-29T01:30:00Z")).toBe("04:30");
  });

  it("resolves the viewer's profile zone, falling back to Europe/Helsinki", async () => {
    state.viewerTimezone = "America/New_York";
    expect(await getViewerTimeZone("viewer-ny")).toBe("America/New_York");
    state.viewerTimezone = "Not/AZone";
    expect(await getViewerTimeZone("viewer-bad")).toBe("Europe/Helsinki");
    state.viewerTimezone = null;
    expect(await getViewerTimeZone("viewer-none")).toBe("Europe/Helsinki");
    state.viewerTimezone = "+03:00";
    expect(await getViewerTimeZone("viewer-offset")).toBe("Europe/Helsinki");
  });
});

describe("Notifications page", () => {
  beforeEach(() => {
    state.notifications = [
      {
        id: "n1",
        type: "workflow.notification",
        title: "Intro call — Ann",
        body: null,
        href: null,
        readAt: null,
        createdAt: OBSERVED,
      },
    ];
  });

  it("shows the observed notification at 12.15 Helsinki time, not 10.15 UTC", async () => {
    const html = renderToStaticMarkup(await NotificationsPage());
    expect(html).toContain("12.15");
    expect(html).not.toContain("10.15");
    expect(html).toContain('dateTime="2026-11-01T10:15:00.000Z"');
  });

  it("uses the same wall-clock time in English and Arabic", async () => {
    state.locale = "en";
    expect(renderToStaticMarkup(await NotificationsPage())).toMatch(/12:15\s?PM/);
    state.locale = "ar";
    const ar = renderToStaticMarkup(await NotificationsPage()).replace(/[٠-٩]/g, (d) =>
      String(d.charCodeAt(0) - 0x0660),
    );
    expect(ar).toContain("12:15");
  });

  it("uses a different profile zone when the viewer set one", async () => {
    state.viewerTimezone = "Europe/London";
    state.locale = "en";
    // getViewerTimeZone is cached per request in production; each render here
    // is its own call with a distinct viewer.
    expect(renderToStaticMarkup(await NotificationsPage())).toMatch(/10:15\s?AM/);
  });
});

describe("CRM timeline", () => {
  const activities = [
    {
      id: "a1",
      type: "STAGE_CHANGE",
      subject: "Uusi liidi → Tarjous",
      body: null,
      metadata: { fromStageId: "s0", toStageId: "s2" },
      createdAt: new Date("2026-10-24T21:30:00.000Z"),
      user: { fullName: "Owner" },
    },
    {
      id: "a2",
      type: "NOTE",
      subject: "Called back",
      body: "Called back",
      metadata: null,
      createdAt: new Date("2026-10-25T21:30:00.000Z"),
      user: null,
    },
  ];
  const stages = DEFAULT_PIPELINE_STAGES.map((s, i) => ({
    id: `s${i}`,
    name: s.name,
    order: s.order,
    isWon: "isWon" in s && s.isWon === true,
    isLost: "isLost" in s && s.isLost === true,
  }));

  it("shows entries either side of the DST change in Helsinki time, with EN stage labels", async () => {
    state.locale = "en";
    const html = renderToStaticMarkup(
      await ActivityTimeline({
        activities,
        stages,
        locale: "en",
        timeZone: "Europe/Helsinki",
      }),
    );
    expect(html).toContain("New lead → Proposal");
    expect(html).not.toContain("Uusi liidi");
    expect(html).toMatch(/Oct 25, 2026, 12:30\s?AM/);
    expect(html).toMatch(/Oct 25, 2026, 11:30\s?PM/);
  });

  it("keeps the Finnish stored text in the Finnish interface", async () => {
    const html = renderToStaticMarkup(
      await ActivityTimeline({ activities, stages, locale: "fi", timeZone: "Europe/Helsinki" }),
    );
    expect(html).toContain("Uusi liidi → Tarjous");
  });
});

function dashboardFixture(pipelineName: string): CrmDashboard {
  return {
    permissions: {
      canReadCalendar: true,
      canUseChat: false,
      canViewBilling: false,
      canWriteCrm: false,
    },
    kpis: {
      totalCustomers: 1,
      activeDeals: 1,
      revenueCents: 0,
      tasksDueToday: 0,
      aiConversations: 0,
      aiMessagesThisMonth: 0,
      customerGrowthPct: null,
    },
    feed: {
      customerActivities: [
        {
          id: "act-1",
          type: "MEETING",
          subject: "Booking: Intro call",
          metadata: { bookingId: "b-1", kind: "booked" },
          at: OBSERVED,
          contactName: "Ann Guest",
          dealTitle: null,
        },
      ],
      aiActivities: [],
      payments: [],
      tasks: [],
    },
    pipeline: {
      name: pipelineName,
      stages: DEFAULT_PIPELINE_STAGES.map((s, i) => ({
        id: `s${i}`,
        name: s.name,
        order: s.order,
        count: 1,
        valueCents: 100_00,
        probability: s.probability,
        isWon: "isWon" in s && s.isWon === true,
        isLost: "isLost" in s && s.isLost === true,
      })),
      openValueCents: 400_00,
      forecastValueCents: 100_00,
    },
    calendar: { meetings: [], tasks: [] },
    insights: {
      activeDeals: 1,
      overdueTasks: 0,
      customerGrowthPct: null,
      aiMessagesThisMonth: 0,
    },
  } as unknown as CrmDashboard;
}

describe("Dashboard", () => {
  const renderDashboard = async (locale: "en" | "fi" | "ar", pipelineName = "Myyntiputki") => {
    state.locale = locale;
    return renderToStaticMarkup(
      await CrmDashboardView({
        dashboard: dashboardFixture(pipelineName),
        locale,
        timeZone: "Europe/Helsinki",
      }),
    );
  };

  /** The pilot acceptance data: €250 open at 10%, €1,000 won, €1,000 lost. */
  const acceptanceDashboard = () => {
    const base = dashboardFixture("Sales pipeline") as unknown as Record<string, unknown> & {
      pipeline: { stages: Array<Record<string, unknown>> };
    };
    const counts: Record<string, [number, number]> = {
      s0: [1, 250_00],
      s4: [1, 1_000_00],
      s5: [1, 1_000_00],
    };
    return {
      ...base,
      permissions: { ...(base.permissions as object), canUseChat: true, canViewBilling: true },
      feed: {
        ...(base.feed as object),
        aiActivities: [
          { id: "c1", title: "New conversation", at: OBSERVED, model: null },
          { id: "c2", title: "Pilot question", at: OBSERVED, model: null },
        ],
        payments: [
          { id: "sub-1", plan: "FREE", status: "ACTIVE", at: OBSERVED, currentPeriodEnd: null },
        ],
      },
      pipeline: {
        ...base.pipeline,
        stages: base.pipeline.stages.map((s) => {
          const [count, valueCents] = counts[s.id as string] ?? [0, 0];
          return { ...s, count, valueCents };
        }),
        openValueCents: 250_00,
        forecastValueCents: 25_00,
      },
    } as unknown as CrmDashboard;
  };
  const renderAcceptance = async (locale: "en" | "fi" | "ar") => {
    state.locale = locale;
    return renderToStaticMarkup(
      await CrmDashboardView({
        dashboard: acceptanceDashboard(),
        locale,
        timeZone: "Europe/Helsinki",
      }),
    );
  };

  it("names the plan and subscription state, never the raw enum values", async () => {
    const en = await renderAcceptance("en");
    expect(en).toContain("Free · Active");
    const ar = await renderAcceptance("ar");
    expect(ar).toContain("Free · نشط");
    for (const html of [en, ar, await renderAcceptance("fi")]) {
      expect(html).not.toContain("FREE");
      expect(html).not.toContain("ACTIVE");
    }
  });

  it("shows the default conversation title in the interface language and others as written", async () => {
    const ar = await renderAcceptance("ar");
    expect(ar).toContain("محادثة جديدة");
    expect(ar).not.toContain("New conversation");
    expect(ar).toContain("Pilot question");
  });

  it("says the stage bars count deals, sizes them by count and draws nothing for an empty stage", async () => {
    for (const locale of ["en", "fi", "ar"] as const) {
      const html = await renderAcceptance(locale);
      expect(html).toContain(MESSAGES[locale].dashboard.stageBarsMetric);
    }
    const en = await renderAcceptance("en");
    expect(en).toContain("1 deal · €250.00");
    expect(en).toContain("0 deals · €0.00");
    // €250 and €1,000 stages each hold one deal: equal bars, by design.
    expect(en.match(/style="width:100%"/g)).toHaveLength(3);
    expect(en.match(/style="width:0%"/g)).toHaveLength(3);
    expect(en).not.toContain("width:4%");
    // Totals and forecast are unchanged.
    expect(en).toContain("€250.00");
    expect(en).toContain("€25.00");
  });

  it("shows the seeded default pipeline name in the interface language", async () => {
    const en = await renderDashboard("en");
    expect(en).toContain("Sales pipeline");
    expect(en).not.toContain("Myyntiputki");
    expect(await renderDashboard("fi")).toContain("Myyntiputki");
    expect(await renderDashboard("ar")).toContain("مسار المبيعات");
  });

  it("keeps a renamed pipeline exactly as entered", async () => {
    expect(await renderDashboard("en", "Enterprise deals")).toContain("Enterprise deals");
  });

  it("labels the rule-based insights honestly: no model name, no 'Generated with'", async () => {
    const en = await renderDashboard("en");
    expect(en).toContain("Calculated from your CRM data. No AI model is used for these.");
    expect(en).not.toContain("Generated with");
    expect(en).not.toContain("AI insights");
    expect(en).not.toMatch(/claude|anthropic/i);
    expect(await renderDashboard("fi")).toContain("Näihin ei käytetä tekoälymallia");
  });

  it("shows feed times in Helsinki time and system booking subjects in the interface language", async () => {
    const fi = await renderDashboard("fi");
    expect(fi).toContain("12.15");
    expect(fi).not.toContain("10.15");
    expect(fi).toContain("Uusi ajanvaraus: Intro call");
    const ar = await renderDashboard("ar");
    expect(ar).toContain("حجز جديد: Intro call");
    expect(await renderDashboard("en")).toContain("New booking: Intro call");
  });
});
