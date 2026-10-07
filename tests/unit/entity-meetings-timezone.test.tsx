import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTranslator } from "next-intl";
import messages from "../../messages/en.json";

/**
 * The meetings list on contact/company/deal pages is a server component.
 * It formatted times in the runtime zone -- UTC on Vercel -- so the staging
 * booking for 09:00 Europe/Helsinki (06:00Z) printed as 06:00. It now uses
 * the viewer's profile timezone, like the calendar grid and the audit log.
 */

const mocks = vi.hoisted(() => ({
  getEntityEvents: vi.fn(),
  findUser: vi.fn(),
}));

vi.mock("next-intl/server", () => ({
  getLocale: async () => "en",
  getTranslations: async (namespace: string) =>
    createTranslator({ locale: "en", messages, namespace: namespace as "calendar" }),
}));
vi.mock("@/server/services/calendar", () => ({ getEntityEvents: mocks.getEntityEvents }));
vi.mock("@/server/db/tenant", () => ({ unscopedPrisma: { user: { findUnique: mocks.findUser } } }));
vi.mock("@/i18n/routing", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const { EntityMeetings } = await import("@/components/calendar/entity-meetings");

const ctx = { orgId: "org-a", userId: "user-1", role: "OWNER" } as never;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getEntityEvents.mockResolvedValue({
    upcoming: [
      {
        id: "evt-1",
        title: "Intro call — Guest",
        startsAt: new Date("2026-10-07T06:00:00.000Z"),
        endsAt: new Date("2026-10-07T06:30:00.000Z"),
        status: "SCHEDULED",
        source: "BOOKING",
        isOccurrence: false,
      },
    ],
    past: [],
  });
});

async function render() {
  return renderToStaticMarkup(await EntityMeetings({ ctx, contactId: "c-1" }));
}

describe("CRM meetings list times", () => {
  it("a Helsinki viewer sees the booking at 9:00, not the UTC 6:00", async () => {
    mocks.findUser.mockResolvedValue({ timezone: "Europe/Helsinki" });
    const html = await render();
    expect(html).toContain("9:00");
    expect(html).not.toContain("6:00");
  });

  it("a UTC viewer sees 6:00", async () => {
    mocks.findUser.mockResolvedValue({ timezone: "UTC" });
    expect(await render()).toContain("6:00");
  });

  it("a missing or invalid profile zone falls back to the app default (Helsinki)", async () => {
    mocks.findUser.mockResolvedValue({ timezone: "Not/AZone" });
    expect(await render()).toContain("9:00");
    mocks.findUser.mockResolvedValue(null);
    expect(await render()).toContain("9:00");
  });
});
