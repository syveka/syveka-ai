// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";

// ChatThread's action cards can link to settings; next-intl's navigation
// needs the Next.js runtime, so tests render it as a plain link.
vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ChatThread } from "@/components/chat/chat-thread";

/** The chips showing which tools a reply used: localized names, never internal identifiers. */
const load = (l: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8"));

const TOOLS = [
  "searchKnowledgeBase",
  "searchContacts",
  "createContact",
  "logActivity",
  "getCalendarAvailability",
  "bookMeeting",
  "proposeBusinessDnaUpdate",
];

function show(tools: string[], locale = "en") {
  render(
    <NextIntlClientProvider locale={locale} messages={load(locale)}>
      <ChatThread messages={[{ id: "m1", role: "assistant", content: "Done.", tools }]} />
    </NextIntlClientProvider>,
  );
}

// jsdom has no scrollIntoView (the thread scrolls to its newest message).
Element.prototype.scrollIntoView = vi.fn();

afterEach(cleanup);

describe("chat tool chips", () => {
  it.each(["en", "fi", "ar"])("show every known tool by its localized name (%s)", (locale) => {
    const labels = load(locale).chat.toolLabels as Record<string, string>;
    show(TOOLS, locale);

    for (const tool of TOOLS) {
      expect(labels[tool], `${locale} label for ${tool}`).toBeTruthy();
      expect(screen.getAllByText(labels[tool]!).length).toBeGreaterThan(0);
      expect(screen.queryByText(tool)).toBeNull();
    }
  });

  it.each(["en", "fi", "ar"])(
    "shows the Business DNA chip without the tool icon, other chips keep it (%s)",
    (locale) => {
      const labels = load(locale).chat.toolLabels as Record<string, string>;
      show(["proposeBusinessDnaUpdate", "searchContacts"], locale);

      const dnaChip = screen.getByText(labels.proposeBusinessDnaUpdate!);
      expect(dnaChip.querySelector("svg")).toBeNull();
      expect(screen.getByText(labels.searchContacts!).querySelector("svg")).not.toBeNull();
    },
  );

  it("falls back to the name for a tool without a label", () => {
    show(["someFutureTool"]);
    expect(screen.getByText("someFutureTool")).toBeTruthy();
  });
});
