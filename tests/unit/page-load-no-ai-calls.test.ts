import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Opening these pages must never call a paid AI provider: the dashboard's
 * insights are rule-based text from CRM counts, and the analytics, CRM list
 * and deals-board modules render plain data. AI runs only from explicit user
 * actions (chat, the per-deal "AI insights" form in services/deals.ts, drafts,
 * the scheduling assistant, workflows, Creator Studio). Browser acceptance
 * checks that only open pages rely on this to stay non-billable.
 *
 * A static check of DIRECT imports in the listed modules (static or dynamic):
 * none may import an AI module, the model router or a paid provider wrapper.
 * It does not follow imports transitively; services/deals.ts is deliberately
 * not listed because its AI feature is reached only through that form action.
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
const AI_MODULE =
  /["'](@\/server\/ai\/[^"']*|@\/server\/integrations\/(anthropic|openai|fal|vapi)|@anthropic-ai\/sdk|openai|@fal-ai\/[^"']*)["']/;

describe("pages that load without any AI provider call", () => {
  it.each(PAGE_LOAD_MODULES)("%s imports no AI module or paid provider", (file) => {
    const source = fs.readFileSync(path.join(root, file), "utf8");
    const imports = [
      ...source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)(["'][^"']+["'])/g),
    ].map((m) => m[1]!);
    expect(imports.filter((specifier) => AI_MODULE.test(specifier))).toEqual([]);
  });

  it("the pattern catches the import the dashboard used to have", () => {
    expect(AI_MODULE.test('"@/server/ai/router"')).toBe(true);
    expect(AI_MODULE.test('"@/server/ai/fallback"')).toBe(true);
    expect(AI_MODULE.test('"@/server/integrations/fal"')).toBe(true);
    expect(AI_MODULE.test('"@/server/integrations/redis"')).toBe(false);
  });
});
