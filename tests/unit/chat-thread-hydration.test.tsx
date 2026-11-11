// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { createRoot, hydrateRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextIntlClientProvider } from "next-intl";
import messages from "../../messages/en.json";

vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

import { ChatThread } from "@/components/chat/chat-thread";
import { useSpeechPlayback } from "@/hooks/use-speech-playback";
import type { UiMessage } from "@/hooks/use-chat";

/**
 * A reopened conversation (/[locale]/chat/[conversationId]) is rendered on
 * the server (Vercel: Node, no speech synthesis, runtime zone UTC) and
 * hydrated in the user's browser (speech synthesis available, a local zone
 * such as Europe/Helsinki). Anything the thread renders from either during
 * that first render differs between the two and fails hydration: React's
 * production build reports it as error #418 (Sentry SYVEKA-STAGING-3, on
 * this route, staging, last seen 2026-11-04 from Helsinki).
 *
 * This renders on the "server" without the browser's capabilities and in
 * one zone, hydrates with them in another, and requires zero hydration
 * errors -- then that the browser-only parts still appear after hydration.
 */

const RealDateTimeFormat = Intl.DateTimeFormat;

/** The process's own zone, as used by any formatter that names none. */
function runtimeTimeZone(zone: string) {
  const Patched = function (
    locales?: string | string[],
    options?: Intl.DateTimeFormatOptions,
  ): Intl.DateTimeFormat {
    return new RealDateTimeFormat(locales, { ...options, timeZone: options?.timeZone ?? zone });
  } as unknown as typeof Intl.DateTimeFormat;
  Object.assign(Patched, { supportedLocalesOf: RealDateTimeFormat.supportedLocalesOf });
  vi.stubGlobal("Intl", Object.create(Intl, { DateTimeFormat: { value: Patched } }));
}

function withSpeechSynthesis() {
  const synthesis = {
    speak: vi.fn(),
    cancel: vi.fn(),
    getVoices: () => [],
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    speaking: false,
    pending: false,
  };
  Object.defineProperty(window, "speechSynthesis", { value: synthesis, configurable: true });
  Object.defineProperty(window, "SpeechSynthesisUtterance", {
    value: class {},
    configurable: true,
  });
}

function withoutSpeechSynthesis() {
  delete (window as { speechSynthesis?: unknown }).speechSynthesis;
  delete (window as { SpeechSynthesisUtterance?: unknown }).SpeechSynthesisUtterance;
}

const DUE_AT = "2026-11-12T22:30:00.000Z";

const reply: UiMessage = {
  id: "11111111-1111-4111-8111-111111111111",
  role: "assistant",
  content: "Here is a summary of your week.",
};

const taskProposal: UiMessage = {
  id: "22222222-2222-4222-8222-222222222222",
  role: "assistant",
  content: "When you confirm, I'll save this task.",
  actions: [
    {
      id: "33333333-3333-4333-8333-333333333333",
      tool: "logActivity",
      digest: "d".repeat(64),
      conversationId: "conv-1",
      expiresAt: Date.now() + 600_000,
      details: {
        tool: "logActivity",
        type: "TASK",
        subject: "Call back",
        contactName: "Example Contact",
        dueAt: DUE_AT,
      },
    },
  ],
};

/** What the thread reports as settled (the chat hook's settleAction in the app). */
const settled = vi.fn();

function Thread({ thread }: { thread: UiMessage[] }) {
  const playback = useSpeechPlayback();
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <ChatThread messages={thread} playback={playback} onActionSettled={settled} />
    </NextIntlClientProvider>
  );
}

type Runtime = {
  zone: string;
  speech: boolean;
  /** This runtime's clock (Date.now), when the test fixes it. */
  now?: number;
};

function runtimeClock(now: number | undefined) {
  if (now !== undefined) vi.spyOn(Date, "now").mockReturnValue(now);
}

async function hydrationErrors(
  thread: UiMessage[],
  server: Runtime,
  browser: Runtime,
): Promise<{ errors: unknown[]; container: HTMLElement; html: string }> {
  runtimeTimeZone(server.zone);
  runtimeClock(server.now);
  if (server.speech) withSpeechSynthesis();
  else withoutSpeechSynthesis();
  const html = renderToString(<Thread thread={thread} />);
  vi.unstubAllGlobals();

  runtimeTimeZone(browser.zone);
  runtimeClock(browser.now);
  if (browser.speech) withSpeechSynthesis();
  else withoutSpeechSynthesis();
  const container = document.createElement("div");
  container.innerHTML = html;
  document.body.appendChild(container);
  const errors: unknown[] = [];
  vi.spyOn(console, "error").mockImplementation(() => {});
  await act(async () => {
    hydrateRoot(container, <Thread thread={thread} />, {
      onRecoverableError: (error) => errors.push(error),
    });
  });
  return { errors, container, html };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  settled.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  withoutSpeechSynthesis();
  document.body.innerHTML = "";
});

describe("reopened conversation hydration", () => {
  it("a reply hydrates without a mismatch when only the browser can read it aloud", async () => {
    const { errors } = await hydrationErrors(
      [reply],
      { zone: "UTC", speech: false },
      { zone: "UTC", speech: true },
    );
    expect(errors).toEqual([]);
  });

  it("after hydration, the reply offers read-aloud where the browser supports it", async () => {
    const { container } = await hydrationErrors(
      [reply],
      { zone: "UTC", speech: false },
      { zone: "UTC", speech: true },
    );
    await act(async () => {});
    expect(
      container.querySelector(`button[aria-label="${messages.chat.voice.listenLabel}"]`),
    ).not.toBeNull();
  });

  it("no read-aloud control where the browser has no speech synthesis", async () => {
    const { container, errors } = await hydrationErrors(
      [reply],
      { zone: "UTC", speech: false },
      { zone: "UTC", speech: false },
    );
    await act(async () => {});
    expect(errors).toEqual([]);
    expect(container.querySelector(`button[aria-label="${messages.chat.voice.listenLabel}"]`)).toBe(
      null,
    );
  });

  it.each([
    ["UTC", "Europe/Helsinki"],
    ["UTC", "America/New_York"],
    ["UTC", "UTC"],
  ])(
    "a task card with a due time: server zone %s, browser zone %s hydrates without a mismatch",
    async (serverZone, browserZone) => {
      const { errors } = await hydrationErrors(
        [taskProposal],
        { zone: serverZone, speech: false },
        { zone: browserZone, speech: false },
      );
      expect(errors).toEqual([]);
    },
  );

  it("after hydration, the due time is shown in the browser's own zone", async () => {
    const { container } = await hydrationErrors(
      [taskProposal],
      { zone: "UTC", speech: false },
      { zone: "Europe/Helsinki", speech: false },
    );
    await act(async () => {});
    const inHelsinki = new RealDateTimeFormat("en", {
      timeZone: "Europe/Helsinki",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(DUE_AT));
    const inUtc = new RealDateTimeFormat("en", {
      timeZone: "UTC",
      weekday: "short",
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(DUE_AT));
    expect(container.textContent).toContain(inHelsinki);
    expect(container.textContent).not.toContain(inUtc);
  });
});

/**
 * The page sends an action without a recorded outcome only while it is still
 * open at the server's clock. The browser's clock can disagree by the time
 * it hydrates: the action expired in between, or the device clock runs
 * ahead. The hydration pass must still render what the server rendered
 * (open), and only afterwards show what the browser's clock says.
 */
describe("reopened conversation hydration: an action's expiry and the two clocks", () => {
  const SERVER_NOW = Date.parse("2026-11-10T12:00:00.000Z");
  const SOON = SERVER_NOW + 5_000;
  const LATER = SERVER_NOW + 600_000;
  const UTC = { zone: "UTC", speech: false };
  const text = messages.chat.actions;

  const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

  const task = (expiresAt: number): UiMessage => ({
    ...taskProposal,
    actions: [{ ...taskProposal.actions![0]!, expiresAt }],
  });

  /** A Business DNA proposal about the opening hours: a later one replaces an earlier one. */
  const hoursProposal = (id: string, expiresAt: number): UiMessage => ({
    id: `message-${id}`,
    role: "assistant",
    content: "When you confirm, I'll update your Business DNA.",
    actions: [
      {
        id,
        tool: "proposeBusinessDnaUpdate",
        digest: id[0]!.repeat(64),
        conversationId: "conv-1",
        expiresAt,
        details: {
          tool: "proposeBusinessDnaUpdate",
          missingAfter: [],
          changes: [
            {
              field: "openingHours",
              kind: "modified",
              before: { type: "text", value: "old hours" },
              after: { type: "text", value: `new hours ${id[0]}` },
            },
          ],
        },
      },
    ],
  });

  const cards = (container: HTMLElement) =>
    [...container.querySelectorAll(`section[aria-label="${text.title}"]`)] as HTMLElement[];
  const statusOf = (card: HTMLElement) => card.querySelector('[role="status"]')?.textContent;
  const confirmable = (card: HTMLElement) =>
    [...card.querySelectorAll("button")].some((b) => b.textContent === text.confirm);

  it.each([
    { why: "it expired between the server render and hydration", browserNow: SOON + 1_000 },
    {
      why: "the device clock runs an hour ahead of the server",
      browserNow: SERVER_NOW + 3_600_000,
    },
  ])(
    "an action the server rendered as open hydrates without a mismatch when $why, then shows as expired",
    async ({ browserNow }) => {
      const { errors, container, html } = await hydrationErrors(
        [task(SOON)],
        { ...UTC, now: SERVER_NOW },
        { ...UTC, now: browserNow },
      );
      expect(html).toContain(text.nothingYet);
      expect(errors).toEqual([]);
      await act(async () => {});
      const [card] = cards(container);
      expect(statusOf(card!)).toBe(text.result.expired);
      expect(confirmable(card!)).toBe(false);
      expect(card!.querySelectorAll("button")).toHaveLength(0);
      // Like a card that mounts already expired: nothing is reported.
      expect(settled).not.toHaveBeenCalled();
    },
  );

  it("an action still open at hydration stays pending, with its buttons", async () => {
    const { errors, container } = await hydrationErrors(
      [task(SOON)],
      { ...UTC, now: SERVER_NOW },
      { ...UTC, now: SOON - 1_000 },
    );
    expect(errors).toEqual([]);
    await act(async () => {});
    const [card] = cards(container);
    expect(statusOf(card!)).toBe(text.nothingYet);
    expect(confirmable(card!)).toBe(true);
    expect(settled).not.toHaveBeenCalled();
  });

  it("an action with a recorded outcome shows it on both sides, whatever the clocks say", async () => {
    const restored: UiMessage = {
      ...taskProposal,
      actions: [{ ...taskProposal.actions![0]!, expiresAt: SOON, restored: "done" }],
    };
    const { errors, container } = await hydrationErrors(
      [restored],
      { ...UTC, now: SERVER_NOW },
      { ...UTC, now: SERVER_NOW + 3_600_000 },
    );
    expect(errors).toEqual([]);
    await act(async () => {});
    const [card] = cards(container);
    expect(statusOf(card!)).toBe(text.result.done);
    expect(confirmable(card!)).toBe(false);
  });

  it("mounted in the browser (no server HTML), an already expired action is expired at once", async () => {
    vi.spyOn(Date, "now").mockReturnValue(SOON + 1_000);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    await act(async () => {
      root.render(<Thread thread={[task(SOON)]} />);
    });
    const [card] = cards(container);
    expect(statusOf(card!)).toBe(text.result.expired);
    expect(confirmable(card!)).toBe(false);
    expect(settled).not.toHaveBeenCalled();
    await act(async () => {
      root.unmount();
    });
  });

  it("a replaced proposal and its replacement, both still open: same on both sides, and after hydration", async () => {
    const { errors, container, html } = await hydrationErrors(
      [hoursProposal(A, LATER), hoursProposal(B, LATER)],
      { ...UTC, now: SERVER_NOW },
      { ...UTC, now: SERVER_NOW + 1_000 },
    );
    expect(html).toContain(text.result.superseded);
    expect(errors).toEqual([]);
    await act(async () => {});
    const [a, b] = cards(container);
    expect(statusOf(a!)).toBe(text.result.superseded);
    expect(confirmable(a!)).toBe(false);
    expect(statusOf(b!)).toBe(text.nothingYet);
    expect(confirmable(b!)).toBe(true);
    // The replacement is reported once, as on a mount in the browser.
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith(A);
  });

  it("the replacement expired by hydration: no mismatch, then the earlier proposal is offered again", async () => {
    const { errors, container, html } = await hydrationErrors(
      [hoursProposal(A, LATER), hoursProposal(B, SOON)],
      { ...UTC, now: SERVER_NOW },
      { ...UTC, now: SOON + 1_000 },
    );
    expect(html).toContain(text.result.superseded);
    expect(errors).toEqual([]);
    await act(async () => {});
    const [a, b] = cards(container);
    expect(statusOf(a!)).toBe(text.nothingYet);
    expect(confirmable(a!)).toBe(true);
    expect(statusOf(b!)).toBe(text.result.expired);
    expect(confirmable(b!)).toBe(false);
    expect(settled).not.toHaveBeenCalled();
  });

  it("the replaced proposal expired by hydration: no mismatch, then it is expired and the replacement stays open", async () => {
    const { errors, container, html } = await hydrationErrors(
      [hoursProposal(A, SOON), hoursProposal(B, LATER)],
      { ...UTC, now: SERVER_NOW },
      { ...UTC, now: SOON + 1_000 },
    );
    expect(html).toContain(text.result.superseded);
    expect(errors).toEqual([]);
    await act(async () => {});
    const [a, b] = cards(container);
    expect(statusOf(a!)).toBe(text.result.expired);
    expect(confirmable(a!)).toBe(false);
    expect(statusOf(b!)).toBe(text.nothingYet);
    expect(confirmable(b!)).toBe(true);
    expect(settled).not.toHaveBeenCalled();
  });
});
