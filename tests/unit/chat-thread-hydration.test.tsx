// @vitest-environment jsdom
import React from "react";
import { act } from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
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

function Thread({ thread }: { thread: UiMessage[] }) {
  const playback = useSpeechPlayback();
  return (
    <NextIntlClientProvider locale="en" messages={messages}>
      <ChatThread messages={thread} playback={playback} />
    </NextIntlClientProvider>
  );
}

async function hydrationErrors(
  thread: UiMessage[],
  server: { zone: string; speech: boolean },
  browser: { zone: string; speech: boolean },
): Promise<{ errors: unknown[]; container: HTMLElement }> {
  runtimeTimeZone(server.zone);
  if (server.speech) withSpeechSynthesis();
  else withoutSpeechSynthesis();
  const html = renderToString(<Thread thread={thread} />);
  vi.unstubAllGlobals();

  runtimeTimeZone(browser.zone);
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
  return { errors, container };
}

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
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
