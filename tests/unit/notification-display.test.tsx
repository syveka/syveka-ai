import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { displayNotification } from "@/lib/notifications/display";

/**
 * Stored notifications are never rewritten; the page shows what the viewer's
 * language can safely replace. Rows below are the shapes staging stores:
 * a workflow.failed row from before PR #384 and a booking row written in the
 * owner's English profile language.
 */
const state = vi.hoisted(() => ({
  locale: "ar" as "en" | "fi" | "ar",
  rows: [] as Array<Record<string, unknown>>,
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
vi.mock("@/server/auth/session", () => ({
  getTenantContext: vi.fn(async () => ({ orgId: "org-1", userId: "u1", role: "OWNER" })),
}));
vi.mock("@/server/services/notifications", () => ({
  listNotifications: vi.fn(async () => state.rows),
}));
vi.mock("@/server/services/viewer-time-zone", () => ({
  getViewerTimeZone: vi.fn(async () => "Europe/Helsinki"),
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

const row = (over: {
  type: string;
  title: string;
  body?: string | null;
  href?: string | null;
}) => ({
  id: String(Math.random()),
  readAt: null,
  createdAt: new Date("2026-11-01T15:20:00.000Z"),
  href: null,
  body: null,
  ...over,
});
const WORKFLOW_FAILED = row({
  type: "workflow.failed",
  title: "Pilot contact workflow test",
  body: "step failed (DriverAdapterError)",
  href: "/workflows/wf-1",
});
const BOOKING = row({
  type: "booking.confirmation",
  title: "New booking: Pilot meeting — Pilot Guest TEST.",
  body: "Monday, November 2, 2026 at 10:00 AM – 11:00 AM (Europe/Helsinki)",
  href: "/calendar",
});

async function render(locale: "en" | "fi" | "ar") {
  state.locale = locale;
  return renderToStaticMarkup(<>{await NotificationsPage()}</>);
}

beforeEach(() => {
  state.rows = [WORKFLOW_FAILED, BOOKING];
});

describe("displayNotification", () => {
  it("maps a workflow failure to the Run history reason code", () => {
    expect(displayNotification(WORKFLOW_FAILED)).toEqual({
      kind: "workflow_failed",
      workflowName: "Pilot contact workflow test",
      failure: "internal",
    });
    expect(
      displayNotification({
        type: "workflow.failed",
        title: "W",
        body: "crm.create_activity: contact not found",
      }),
    ).toMatchObject({ failure: "contact_not_found" });
  });

  it("splits booking titles stored in any of the three languages", () => {
    for (const title of [
      "Booking canceled: Intro — Anna",
      "Varaus peruttu: Intro — Anna",
      "تم إلغاء الحجز: Intro — Anna",
    ]) {
      expect(displayNotification({ type: "booking.cancellation", title, body: null })).toEqual({
        kind: "booking",
        action: "cancellation",
        bookingType: "Intro",
        guest: "Anna",
        body: null,
      });
    }
  });

  it("leaves anything it doesn't recognise exactly as stored", () => {
    const custom = { type: "workflow.notification", title: "Call Anna back.", body: "Today" };
    expect(displayNotification(custom)).toEqual({
      kind: "plain",
      title: custom.title,
      body: "Today",
    });
    // A booking type whose action word doesn't match its title stays plain.
    expect(
      displayNotification({ type: "booking.reminder", title: "New booking: X — Y", body: null }),
    ).toMatchObject({ kind: "plain" });
  });
});

describe("notifications page", () => {
  it("shows a historical workflow failure as the translated safe reason (ar/fi/en)", async () => {
    for (const locale of ["ar", "fi", "en"] as const) {
      const html = await render(locale);
      expect(html).not.toContain("DriverAdapterError");
      expect(html).not.toContain("step failed (");
      expect(html).toContain(MESSAGES[locale].workflows.runFailure.internal);
      expect(html).toContain("<bdi>Pilot contact workflow test</bdi>");
    }
  });

  it("shows a booking stored in English with the viewer's action word and isolated names", async () => {
    const html = await render("ar");
    expect(html).toContain("حجز جديد: <bdi>Pilot meeting</bdi> — <bdi>Pilot Guest TEST.</bdi>");
    expect(html).not.toContain("New booking");
    // The meeting time was formatted when the row was written; it is kept,
    // in its own direction.
    expect(html).toContain(
      '<p dir="auto" class="mt-0.5 text-sm text-muted-foreground">Monday, November 2, 2026',
    );
  });

  it("isolates other stored text by its own direction", async () => {
    state.rows = [
      row({ type: "workflow.notification", title: "Follow up with Pilot Guest TEST.", body: null }),
    ];
    const html = await render("ar");
    expect(html).toContain(
      '<p dir="auto" class="text-sm font-medium">Follow up with Pilot Guest TEST.</p>',
    );
  });
});
