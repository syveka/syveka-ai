// Simulate the deployed server runtime (Vercel functions run in UTC). Without
// this, a developer machine in Helsinki would mask the defect: the old code
// formatted in the runtime's zone.
process.env.TZ = "UTC";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createTranslator } from "next-intl";

/**
 * Renders the real Settings → Audit log server component. Only permissions,
 * the request locale and the data layer are mocked; translations are the real
 * message files. The observed defect: an org.create written at ~23:28
 * Helsinki (20:28:05 UTC) rendered as 20:28:05 because the page formatted in
 * the server runtime's zone (UTC) instead of the viewer's zone.
 */
const mocks = vi.hoisted(() => ({
  locale: "fi",
  viewerTimezone: "Europe/Helsinki" as string | null,
  logs: [] as Array<Record<string, unknown>>,
}));

const MESSAGES = Object.fromEntries(
  ["en", "fi", "ar"].map((l) => [
    l,
    JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8")),
  ]),
);

vi.mock("@/server/auth/guard", () => ({
  requirePermission: vi.fn(async () => ({
    orgId: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    role: "OWNER",
    locale: "fi",
  })),
}));
vi.mock("next-intl/server", () => ({
  getLocale: vi.fn(async () => mocks.locale),
  getTranslations: vi.fn(async (namespace?: string) =>
    createTranslator({
      locale: mocks.locale,
      messages: MESSAGES[mocks.locale],
      namespace,
    } as never),
  ),
}));
vi.mock("@/server/db/tenant", () => ({
  tenantDb: vi.fn(() => ({ auditLog: { findMany: vi.fn(async () => mocks.logs) } })),
  unscopedPrisma: {
    user: {
      findUnique: vi.fn(async () =>
        mocks.viewerTimezone === undefined ? null : { timezone: mocks.viewerTimezone },
      ),
      findMany: vi.fn(async () => [
        { id: "22222222-2222-4222-8222-222222222222", email: "owner@example.test" },
      ]),
    },
  },
}));

import AuditLogPage from "@/app/[locale]/(app)/settings/audit-log/page";

const toLatinDigits = (s: string) => s.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660));

async function render() {
  const el = await AuditLogPage({ searchParams: Promise.resolve({}) });
  return renderToStaticMarkup(el);
}

describe("Settings → Audit log timestamps", () => {
  it("runs with a UTC runtime zone, like the deployed server", () => {
    expect(new Intl.DateTimeFormat().resolvedOptions().timeZone).toMatch(/^(UTC|Etc\/UTC)$/);
  });

  beforeEach(() => {
    mocks.locale = "fi";
    mocks.viewerTimezone = "Europe/Helsinki";
    mocks.logs = [
      {
        id: "log-1",
        action: "org.create",
        createdAt: new Date("2026-09-27T20:28:05.000Z"),
        actorId: "22222222-2222-4222-8222-222222222222",
        actorType: "USER",
        resourceType: "organization",
        resourceId: "33333333-3333-4333-8333-333333333333",
        ip: null,
        before: null,
        after: null,
      },
    ];
  });

  it("shows the observed event at 23.28.05 Helsinki time (not 20.28.05 UTC) in Finnish", async () => {
    const html = await render();
    expect(html).toContain("23.28.05");
    expect(html).not.toContain("20.28.05");
    // Machine-readable instant is preserved exactly as stored.
    expect(html).toContain('dateTime="2026-09-27T20:28:05.000Z"');
    // The canonical audit action code is never translated.
    expect(html).toContain("org.create");
  });

  it("uses the same Helsinki wall-clock time in English and Arabic", async () => {
    mocks.locale = "en";
    expect(await render()).toMatch(/11:28:05\s?PM/);
    mocks.locale = "ar";
    expect(toLatinDigits(await render())).toContain("11:28:05");
  });

  it("follows the viewer's own profile zone when it differs", async () => {
    mocks.viewerTimezone = "Europe/London";
    expect(await render()).toContain("21.28.05");
  });

  it("falls back to Europe/Helsinki for a missing or invalid stored zone", async () => {
    mocks.viewerTimezone = "Not/AZone";
    expect(await render()).toContain("23.28.05");
    mocks.viewerTimezone = null;
    expect(await render()).toContain("23.28.05");
  });

  it("rolls the date over in the viewer's zone", async () => {
    mocks.logs[0]!.createdAt = new Date("2026-09-27T21:30:00.000Z");
    const html = await render();
    expect(html).toContain("28.9.2026");
  });
});
