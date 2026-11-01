import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Opening these pages must never call a paid AI provider: the dashboard's
 * insights are rule-based text from CRM counts, and CRM lists, boards and
 * analytics are plain data. AI runs only from explicit user actions (chat,
 * the deal "AI insights" form, drafts, the scheduling assistant, workflows).
 * Browser acceptance checks rely on this to stay non-billable.
 *
 * A static check: none of these modules imports an AI provider client or the
 * model router, directly.
 */
const root = path.resolve(__dirname, "../../src");
const PAGE_LOAD_MODULES = [
  "server/services/dashboard.ts",
  "components/dashboard/crm-dashboard.tsx",
  "app/[locale]/(app)/dashboard/page.tsx",
  "server/services/analytics.ts",
  "components/analytics/charts.tsx",
  "server/services/contacts.ts",
  "server/services/companies.ts",
  "components/crm/deal-board.tsx",
  "app/[locale]/(app)/crm/deals/page.tsx",
];
const AI_IMPORTS = [
  /from "@\/server\/integrations\/anthropic"/,
  /from "@\/server\/integrations\/openai"/,
  /from "@\/server\/ai\/router"/,
  /from "@anthropic-ai\/sdk"/,
  /from "openai"/,
];

describe("pages that load without any AI provider call", () => {
  it.each(PAGE_LOAD_MODULES)("%s imports no AI provider or model router", (file) => {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    for (const pattern of AI_IMPORTS) expect(source, String(pattern)).not.toMatch(pattern);
  });
});
