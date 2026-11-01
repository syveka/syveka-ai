import React from "react";
import fs from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * "New assistant" on a plan without voice assistants explains the plan
 * restriction with the product plan name (never the raw enum value), and a
 * plan that includes assistants but has used them all says so instead of
 * claiming the plan lacks Voice AI.
 */
const state = vi.hoisted(() => ({
  locale: "en" as "en" | "fi" | "ar",
  ent: { plan: "FREE", voiceAssistants: 0 },
  count: 0,
}));
const load = (l: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8"));
const MESSAGES = { en: load("en"), fi: load("fi"), ar: load("ar") };

vi.mock("next-intl/server", async () => {
  const { createTranslator } = await import("next-intl");
  return {
    getTranslations: vi.fn(async (namespace?: string) =>
      createTranslator({
        locale: state.locale,
        messages: MESSAGES[state.locale],
        namespace,
      } as never),
    ),
  };
});
vi.mock("next/navigation", () => ({ notFound: vi.fn() }));
vi.mock("@/server/auth/guard", () => ({
  requirePermission: vi.fn(async () => ({ orgId: "org-1", userId: "u1", role: "OWNER" })),
}));
vi.mock("@/server/services/billing/entitlements", () => ({
  getEntitlements: vi.fn(async () => state.ent),
}));
vi.mock("@/server/db/tenant", () => ({
  tenantDb: () => ({ voiceAssistant: { count: async () => state.count } }),
}));
vi.mock("@/components/voice/assistant-form", () => ({ AssistantForm: () => <form>form</form> }));
vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href}>{children}</a>
  ),
}));

import AssistantPage from "@/app/[locale]/(app)/voice/[assistantId]/page";

async function render() {
  const page = await AssistantPage({ params: Promise.resolve({ assistantId: "new" }) });
  return renderToStaticMarkup(<>{page}</>);
}

beforeEach(() => {
  state.locale = "en";
  state.ent = { plan: "FREE", voiceAssistants: 0 };
  state.count = 0;
});

describe("new voice assistant plan block", () => {
  it.each(["en", "fi", "ar"] as const)(
    "FREE: plan restriction with the product name, linking to billing (%s)",
    async (locale) => {
      state.locale = locale;
      const html = await render();
      expect(html).toContain(MESSAGES[locale].voice.entitlementBlocked.title);
      expect(html).toContain("Free");
      expect(html).not.toContain("FREE");
      expect(html).toContain('href="/settings/billing"');
      expect(html).not.toContain("<form>");
    },
  );

  it("STARTER at its limit: says the limit is reached, not that the plan lacks Voice AI", async () => {
    state.ent = { plan: "STARTER", voiceAssistants: 1 };
    state.count = 1;
    const html = await render();
    expect(html).toContain("Voice assistant limit reached");
    expect(html).toContain("The Starter plan includes 1 voice assistant");
    expect(html).not.toContain(MESSAGES.en.voice.entitlementBlocked.title);
  });

  it("STARTER below its limit: shows the form", async () => {
    state.ent = { plan: "STARTER", voiceAssistants: 1 };
    expect(await render()).toContain("<form>");
  });
});
