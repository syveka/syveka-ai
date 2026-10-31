// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
vi.mock("@/i18n/routing", () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn(), push: vi.fn() }),
}));

import { ChatThread } from "@/components/chat/chat-thread";
import { safeChatUrl, withCitationTokens } from "@/components/chat/markdown-message";
import type { UiMessage } from "@/hooks/use-chat";

/**
 * Assistant replies render as safe Markdown with citation chips for the
 * sources the server attached; user text stays plain. Synthetic messages only.
 */
const load = (locale: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${locale}.json`), "utf8"));
const en = load("en");
const fi = load("fi");

const KNOWN = "11111111-1111-4111-8111-111111111111";
const SECOND = "44444444-4444-4444-8444-444444444444";
const UNKNOWN = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(cleanup);

function renderThread(messages: UiMessage[], locale: "en" | "fi" = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={locale === "en" ? en : fi}>
      <ChatThread messages={messages} />
    </NextIntlClientProvider>,
  );
}

const reply = (content: string, extra: Partial<UiMessage> = {}): UiMessage => ({
  id: "a1",
  role: "assistant",
  content,
  ...extra,
});

describe("assistant Markdown", () => {
  it("renders bold, lists, links and code instead of raw markers", () => {
    const { container } = renderThread([
      reply(
        "**Price** is *low*.\n\n- one\n- two\n\n1. first\n\nSee [docs](https://example.com/a) and `npm test`.\n\n```\nconst x = 1;\n```\n\n# Big heading",
      ),
    ]);
    expect(container.textContent).not.toContain("**");
    expect(container.querySelector("strong")?.textContent).toBe("Price");
    expect(container.querySelector("em")?.textContent).toBe("low");
    expect(container.querySelectorAll("ul > li")).toHaveLength(2);
    expect(container.querySelectorAll("ol > li")).toHaveLength(1);
    const link = screen.getByRole("link", { name: "docs" });
    expect(link.getAttribute("href")).toBe("https://example.com/a");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(container.querySelector("p code")?.textContent).toBe("npm test");
    expect(container.querySelector("pre code")?.textContent).toContain("const x = 1;");
    // Headings are mapped down to modest sizes.
    expect(container.querySelector("h1")).toBeNull();
    expect(screen.getByRole("heading", { name: "Big heading" }).tagName).toBe("H3");
  });

  it("never injects raw HTML or unsafe links", () => {
    const { container } = renderThread([
      reply(
        '<script>alert(1)</script>\n\n<img src=x onerror="alert(1)">\n\n[click](javascript:alert(1)) [data](data:text/html;base64,PHNjcmlwdD4=) [rel](/settings) ![pic](https://example.com/p.png)',
      ),
    ]);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("[onerror]")).toBeNull();
    // Raw HTML stays inert text.
    expect(container.textContent).toContain("<script>alert(1)</script>");
    for (const a of container.querySelectorAll("a")) {
      expect(a.getAttribute("href") ?? "").not.toMatch(/^(javascript|data):/i);
    }
    expect(screen.queryByRole("link", { name: "click" })).toBeNull();
    expect(screen.queryByRole("link", { name: "data" })).toBeNull();
    expect(screen.queryByRole("link", { name: "rel" })).toBeNull();
    expect(container.textContent).toContain("click");
  });

  it("only http(s) and mailto URLs survive", () => {
    expect(safeChatUrl("https://example.com")).toBe("https://example.com");
    expect(safeChatUrl("mailto:a@example.com")).toBe("mailto:a@example.com");
    expect(safeChatUrl("javascript:alert(1)")).toBe("");
    expect(safeChatUrl(" JaVaScRiPt:alert(1)")).toBe("");
    expect(safeChatUrl("data:text/html,x")).toBe("");
    expect(safeChatUrl("vbscript:x")).toBe("");
    expect(safeChatUrl("//evil.example.com")).toBe("");
    expect(safeChatUrl("/internal")).toBe("");
  });

  it("partial Markdown while streaming renders without throwing", () => {
    const partials: Array<[string, string]> = [
      ["**Hinta on", "Hinta on"],
      ["- item\n- **bo", "item"],
      ["```\nconst", "const"],
      ["[link](https://exa", "link"],
      ["Text [doc:1111", "Text"],
      ["Text [do", "Text"],
    ];
    for (const [partial, visible] of partials) {
      const { container, unmount } = renderThread([reply(partial, { streaming: true })]);
      expect(container.textContent).toContain(visible);
      expect(container.textContent).not.toMatch(/\[do/);
      unmount();
    }
  });

  it("keeps the user's own text plain", () => {
    const { container } = renderThread([
      { id: "u1", role: "user", content: "**not bold** <b>x</b>" },
    ]);
    expect(container.querySelector("strong")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    expect(container.textContent).toContain("**not bold** <b>x</b>");
  });
});

describe("citations", () => {
  const citations = [
    { documentId: KNOWN, title: "pilot-kb-test" },
    { documentId: SECOND, title: "Hinnasto 2026" },
  ];

  it("a known marker becomes a numbered chip; the source list shows labels", () => {
    const { container } = renderThread([
      reply(`Price is 100 € [doc:${KNOWN}]. Terms [doc:${SECOND.toUpperCase()}].`, { citations }),
    ]);
    expect(container.textContent).not.toMatch(/\[doc:|[0-9a-f]{8}-[0-9a-f]{4}/i);
    const chip = screen.getByRole("link", { name: "Source 1: pilot-kb-test" });
    expect(chip.textContent).toBe("1");
    expect(chip.closest("sup")).not.toBeNull();
    const target = chip.getAttribute("href")!.slice(1);
    expect(document.getElementById(target)?.textContent).toContain("pilot-kb-test");
    expect(screen.getByRole("link", { name: "Source 2: Hinnasto 2026" }).textContent).toBe("2");

    const list = screen.getByRole("region", { name: "Sources" });
    const items = within(list).getAllByRole("listitem");
    expect(items.map((li) => li.textContent)).toEqual(["1.pilot-kb-test", "2.Hinnasto 2026"]);
  });

  it("unknown and malformed markers are stripped, never linked", () => {
    const { container } = renderThread([
      reply(`A [doc:${UNKNOWN}] B [doc:not-a-uuid] C [doc:] D [doc:${KNOWN}]`, {
        citations: [citations[0]!],
      }),
    ]);
    expect(container.textContent).not.toContain("[doc:");
    expect(container.textContent).not.toContain(UNKNOWN);
    expect(container.textContent).not.toContain("not-a-uuid");
    // Only the authorized source is linked, and only within the page.
    const links = [...container.querySelectorAll("a")];
    expect(links).toHaveLength(1);
    expect(links[0]!.getAttribute("href")).toMatch(/^#/);
  });

  it("without attached sources every marker is stripped", () => {
    const { container } = renderThread([reply(`Answer [doc:${KNOWN}].`)]);
    expect(container.textContent).toBe("Answer.");
    expect(screen.queryByRole("region")).toBeNull();
  });

  it("model text can't forge a citation token", () => {
    expect(withCitationTokens("x 1 y", citations)).toBe("x 1 y");
    expect(withCitationTokens(`x [doc:${KNOWN}]`, citations)).toBe("x1");
  });
});

describe("text direction", () => {
  it("an Arabic reply in the Finnish UI gets automatic direction per block", () => {
    const { container } = renderThread(
      [
        { id: "u1", role: "user", content: "ما هو السعر؟" },
        reply("**السعر** هو 100 يورو.\n\n- البند الأول\n- Second item", {
          citations: [{ documentId: KNOWN, title: "قائمة الأسعار" }],
        }),
      ],
      "fi",
    );
    const userBody = screen.getByText("ما هو السعر؟");
    expect(userBody.getAttribute("dir")).toBe("auto");
    const replyBlocks = [...container.querySelectorAll("p, ul, li")].filter(
      (el) => !el.closest("section"), // the source list is checked below
    );
    expect(replyBlocks.length).toBeGreaterThanOrEqual(4);
    for (const el of replyBlocks) {
      expect(el.getAttribute("dir")).toBe("auto");
    }
    expect(screen.getByText("قائمة الأسعار").getAttribute("dir")).toBe("auto");
    expect(screen.getByRole("region", { name: fi.chat.sources })).toBeTruthy();
  });

  it("code stays left-to-right", () => {
    const { container } = renderThread([reply("نص `code` نص\n\n```\nx = 1\n```")]);
    for (const el of container.querySelectorAll("code, pre")) {
      expect(el.getAttribute("dir")).toBe("ltr");
    }
  });
});
