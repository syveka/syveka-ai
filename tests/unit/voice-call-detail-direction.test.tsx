import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ voiceCallFindFirst: vi.fn() }));

vi.mock("next/navigation", () => ({ notFound: vi.fn() }));
vi.mock("next-intl/server", () => ({ getTranslations: async () => (key: string) => key }));
vi.mock("@/server/auth/guard", () => ({
  requirePermission: vi.fn(async () => ({ orgId: "org-1", userId: "user-1" })),
}));
vi.mock("@/server/db/tenant", () => ({
  tenantDb: () => ({ voiceCall: { findFirst: mocks.voiceCallFindFirst } }),
}));
vi.mock("@/i18n/routing", () => ({
  Link: ({ children }: { children: React.ReactNode }) => <a>{children}</a>,
}));

import CallDetailPage from "@/app/[locale]/(app)/voice/calls/[callId]/page";

const SUMMARY = "سأل المتصل عن موعد يوم الخميس الساعة 14:30.";
const FOLLOW_UP = "تأكيد الموعد مع المتصل.";

beforeEach(() => {
  mocks.voiceCallFindFirst.mockResolvedValue({
    id: "call-1",
    callerNumber: "+358401234567",
    assistant: { name: "Assistant" },
    summary: SUMMARY,
    actionsTaken: [FOLLOW_UP],
    transcript: [],
    recordingUrl: null,
    durationSeconds: 90,
    sentiment: "neutral",
    costCents: 0,
    startedAt: new Date("2026-11-05T10:00:00Z"),
    status: "COMPLETED",
  });
});

describe("call detail page", () => {
  it("lets the browser set direction from the text of a summary and its follow-ups", async () => {
    const page = await CallDetailPage({ params: Promise.resolve({ callId: "call-1" }) });
    const html = renderToStaticMarkup(page);
    expect(html).toContain(`<p dir="auto">${SUMMARY}</p>`);
    expect(html).toContain(`<span dir="auto">${FOLLOW_UP}</span>`);
  });
});
