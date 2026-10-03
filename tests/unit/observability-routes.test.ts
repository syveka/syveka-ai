import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ROUTE_TEMPLATES } from "@/lib/observability/route-templates";
import { routeTemplate } from "@/lib/observability/routes";
import {
  collectRouteTemplates,
  renderRouteTemplates,
} from "../../scripts/generate-route-templates.mjs";

describe("route templates for error reports", () => {
  it("the generated list matches src/app (run: node scripts/generate-route-templates.mjs)", () => {
    const current = collectRouteTemplates();
    expect(ROUTE_TEMPLATES).toEqual(current);
    const file = fs.readFileSync(
      path.resolve(__dirname, "../../src/lib/observability/route-templates.ts"),
      "utf8",
    );
    expect(file).toBe(renderRouteTemplates(current));
  });

  it.each([
    ["/", "/[locale]"],
    ["/en", "/[locale]"],
    ["/ar/", "/[locale]"],
    ["/fi/pricing", "/[locale]/pricing"],
    ["/voice/calls", "/[locale]/voice/calls"], // static beats [assistantId]
    ["/voice/abc", "/[locale]/voice/[assistantId]"],
    ["/en/legal/privacy", "/[locale]/legal/[doc]"],
    ["/api/v1/creator-studio/posts/p1/schedule", "/api/v1/creator-studio/posts/[id]/schedule"],
    ["/[locale]/(app)/inbox/[threadId]", "/[locale]/inbox/[threadId]"], // Next route path
    ["/[locale]/(app)/inbox/[threadId]/page", "/[locale]/inbox/[threadId]"],
    ["/api/v1/inbox/[threadId]/route", "/api/v1/inbox/[threadId]"],
    ["/de/pricing", undefined], // not a supported locale
    ["/en/en/pricing", undefined],
    ["/api/v1/unknown", undefined],
    ["/en/inbox//", undefined],
    ["relative/path", undefined],
    [undefined, undefined],
  ])("%j -> %j", (raw, expected) => {
    expect(routeTemplate(raw)).toBe(expected);
  });
});
