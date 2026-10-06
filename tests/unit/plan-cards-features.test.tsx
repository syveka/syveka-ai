// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

/**
 * The in-app plan cards derive their numbers from the plan catalog. AI
 * messages are one pool for the whole organization, and no card advertises
 * a public API that doesn't exist yet.
 */
vi.mock("@/actions/billing", () => ({
  startCheckoutAction: { bind: () => async () => {} },
}));

import { PlanCards } from "@/components/billing/plan-cards";

const messages = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"),
);

afterEach(cleanup);

function cardLines(): string[][] {
  const { container } = render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <PlanCards currentPlan="FREE" />
    </NextIntlClientProvider>,
  );
  return Array.from(container.querySelectorAll("ul")).map((ul) =>
    Array.from(ul.querySelectorAll("li")).map((li) => li.textContent ?? ""),
  );
}

describe("PlanCards feature lines", () => {
  it("shows pooled AI messages and only features that exist", () => {
    const [starter, pro] = cardLines();
    expect(starter).toEqual([
      "· 1,000 AI messages/mo, shared by your team",
      "· 1 voice assistant · 100 min",
      "· 1 GB knowledge base",
      "· 5 workflows",
      "· 5,000 contacts",
    ]);
    expect(pro).toEqual([
      "· 5,000 AI messages/mo, shared by your team",
      "· 3 voice assistants · 500 min",
      "· 10 GB knowledge base",
      "· 25 workflows",
      "· 2 years of audit log history",
    ]);
  });
});
