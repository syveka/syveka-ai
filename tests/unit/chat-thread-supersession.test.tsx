// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));
import { ChatThread } from "@/components/chat/chat-thread";
import type { UiMessage } from "@/hooks/use-chat";
import type { ProposedActionView, RestoredActionState } from "@/lib/validators/chat";

/**
 * The thread and its cards together: a correction (a newer Business DNA
 * proposal about the same field) replaces the earlier card; canceling the
 * correction offers the earlier one again; applying it keeps the earlier
 * one replaced. Real: ChatThread, ActionConfirmation, the supersession
 * helper. Mocked: fetch (the decision endpoint).
 */
const en = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../messages/en.json"), "utf8"));

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const C = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

type Action = ProposedActionView & { restored?: RestoredActionState };

function dna(
  id: string,
  fields: Array<"openingHours" | "supportedLocales" | "industry">,
  o: Partial<Action> = {},
): Action {
  return {
    id,
    tool: "proposeBusinessDnaUpdate",
    digest: id[0]!.repeat(64),
    conversationId: "conv-1",
    expiresAt: Date.now() + 600_000,
    details: {
      tool: "proposeBusinessDnaUpdate",
      missingAfter: [],
      changes: fields.map((field) => ({
        field,
        kind: "modified",
        before: { type: "text", value: `old ${field}` },
        after: { type: "text", value: `new ${field}` },
      })),
    },
    ...o,
  };
}

const message = (id: string, actions: Action[]): UiMessage => ({
  id,
  role: "assistant",
  content: "When you confirm, I'll update your Business DNA.",
  actions,
});

let decision: { status: number; body: unknown };
const settled = vi.fn();

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn();
  settled.mockClear();
  decision = { status: 200, body: { data: { status: "canceled" } } };
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(decision.body), { status: decision.status })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function renderThread(messages: UiMessage[]) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ChatThread messages={messages} onActionSettled={settled} />
    </NextIntlClientProvider>,
  );
}

/** The card for the action id, found through its own message bubble order. */
const cards = () => screen.getAllByRole("region", { name: en.chat.actions.title });
const statusOf = (card: HTMLElement) => within(card).getByRole("status").textContent;
const confirmable = (card: HTMLElement) =>
  within(card).queryByRole("button", { name: en.chat.actions.confirm }) !== null;
const click = async (card: HTMLElement, name: string) =>
  act(async () => {
    fireEvent.click(within(card).getByRole("button", { name }));
  });

describe("a correction in the thread", () => {
  it("replaces the earlier proposal about the same field; the user is told, and the view is released once", () => {
    renderThread([
      message("m1", [dna(A, ["openingHours"])]),
      message("m2", [dna(B, ["openingHours"])]),
    ]);
    const [a, b] = cards();
    expect(statusOf(a!)).toBe(en.chat.actions.result.superseded);
    expect(confirmable(a!)).toBe(false);
    expect(confirmable(b!)).toBe(true);
    expect(settled).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith(A);
  });

  it("the earlier card is replaced the moment the correction arrives in a later reply", () => {
    const view = renderThread([message("m1", [dna(A, ["openingHours"])])]);
    expect(confirmable(cards()[0]!)).toBe(true);
    view.rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <ChatThread
          messages={[
            message("m1", [dna(A, ["openingHours"])]),
            message("m2", [dna(B, ["openingHours"])]),
          ]}
          onActionSettled={settled}
        />
      </NextIntlClientProvider>,
    );
    const [a, b] = cards();
    expect(statusOf(a!)).toBe(en.chat.actions.result.superseded);
    expect(confirmable(b!)).toBe(true);
  });

  it("Cancel the correction: the earlier proposal is offered again, confirmable, nothing sent for it", async () => {
    renderThread([
      message("m1", [dna(A, ["openingHours"])]),
      message("m2", [dna(B, ["openingHours"])]),
    ]);
    const [a, b] = cards();
    await click(b!, en.chat.actions.cancel);
    expect(statusOf(b!)).toBe(en.chat.actions.result.canceled);
    expect(statusOf(a!)).toBe(en.chat.actions.nothingYet);
    expect(confirmable(a!)).toBe(true);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(1);
    expect(settled).toHaveBeenCalledWith(A);
    expect(settled).toHaveBeenCalledWith(B);
    // And it can then be confirmed on its own.
    decision = {
      status: 200,
      body: { data: { status: "done", tool: "proposeBusinessDnaUpdate" } },
    };
    await click(a!, en.chat.actions.confirm);
    expect(statusOf(a!)).toBe(en.chat.actions.result.done);
    expect(vi.mocked(fetch)).toHaveBeenCalledTimes(2);
    expect(String(vi.mocked(fetch).mock.calls[1]![0])).toBe(`/api/v1/ai/actions/${A}`);
  });

  it("Apply the correction: the earlier proposal stays replaced", async () => {
    decision = {
      status: 200,
      body: { data: { status: "done", tool: "proposeBusinessDnaUpdate" } },
    };
    renderThread([
      message("m1", [dna(A, ["openingHours"])]),
      message("m2", [dna(B, ["openingHours"])]),
    ]);
    const [a, b] = cards();
    await click(b!, en.chat.actions.confirm);
    expect(statusOf(b!)).toBe(en.chat.actions.result.done);
    expect(statusOf(a!)).toBe(en.chat.actions.result.superseded);
    expect(confirmable(a!)).toBe(false);
  });

  it("a correction that failed while running (outcome unknown) withdraws nothing for sure: the earlier one is offered again", async () => {
    decision = { status: 500, body: { error: { code: "action_failed" } } };
    renderThread([
      message("m1", [dna(A, ["openingHours"])]),
      message("m2", [dna(B, ["openingHours"])]),
    ]);
    const [a, b] = cards();
    await click(b!, en.chat.actions.confirm);
    expect(statusOf(b!)).toBe(en.chat.actions.result.unknown);
    // The server still refuses A as stale if B's write did land: the view only offers it.
    expect(confirmable(a!)).toBe(true);
  });

  it("proposals about unrelated fields stay independent", () => {
    renderThread([
      message("m1", [dna(A, ["openingHours"])]),
      message("m2", [dna(B, ["supportedLocales"])]),
    ]);
    const [a, b] = cards();
    expect(confirmable(a!)).toBe(true);
    expect(confirmable(b!)).toBe(true);
    expect(settled).not.toHaveBeenCalled();
  });

  it("a partial correction names what it doesn't carry over; canceling it offers the whole earlier proposal again", async () => {
    renderThread([
      message("m1", [dna(A, ["openingHours", "supportedLocales"])]),
      message("m2", [dna(B, ["openingHours"])]),
    ]);
    const [a, b] = cards();
    expect(statusOf(a!)).toBe(
      `${en.chat.actions.result.superseded} The newer request doesn’t include Supported languages. Ask Syveka again to change that too.`,
    );
    expect(confirmable(a!)).toBe(false);
    await click(b!, en.chat.actions.cancel);
    expect(confirmable(a!)).toBe(true);
    expect(statusOf(a!)).toBe(en.chat.actions.nothingYet);
  });

  it("a chain: the newest open correction replaces both earlier ones; withdrawing it falls back to the middle one only", async () => {
    renderThread([
      message("m1", [dna(A, ["openingHours"])]),
      message("m2", [dna(B, ["openingHours"])]),
      message("m3", [dna(C, ["openingHours"])]),
    ]);
    const [a, b, c] = cards();
    expect(confirmable(a!)).toBe(false);
    expect(confirmable(b!)).toBe(false);
    expect(confirmable(c!)).toBe(true);
    await click(c!, en.chat.actions.cancel);
    expect(confirmable(b!)).toBe(true);
    expect(confirmable(a!)).toBe(false);
    expect(statusOf(a!)).toBe(en.chat.actions.result.superseded);
  });
});

describe("a reopened conversation (outcomes restored from the record)", () => {
  it("a canceled correction leaves the earlier, still pending, proposal confirmable", () => {
    renderThread([
      message("m1", [dna(A, ["openingHours"])]),
      message("m2", [dna(B, ["openingHours"], { restored: "canceled" })]),
    ]);
    const [a, b] = cards();
    expect(confirmable(a!)).toBe(true);
    expect(statusOf(b!)).toBe(en.chat.actions.result.canceled);
  });

  it("an applied correction keeps the earlier, still pending, proposal replaced", () => {
    renderThread([
      message("m1", [dna(A, ["openingHours"])]),
      message("m2", [dna(B, ["openingHours"], { restored: "done" })]),
    ]);
    const [a] = cards();
    expect(confirmable(a!)).toBe(false);
    expect(statusOf(a!)).toBe(en.chat.actions.result.superseded);
  });

  it("an earlier proposal with its own recorded outcome is never changed by a later one", () => {
    renderThread([
      message("m1", [dna(A, ["openingHours"], { restored: "done" })]),
      message("m2", [dna(B, ["openingHours"])]),
    ]);
    const [a, b] = cards();
    expect(statusOf(a!)).toBe(en.chat.actions.result.done);
    expect(confirmable(b!)).toBe(true);
  });

  it("an expired earlier proposal can't come back through a canceled correction", async () => {
    renderThread([
      message("m1", [dna(A, ["openingHours"], { expiresAt: Date.now() - 1 })]),
      message("m2", [dna(B, ["openingHours"])]),
    ]);
    const [a, b] = cards();
    expect(statusOf(a!)).toBe(en.chat.actions.result.expired);
    await click(b!, en.chat.actions.cancel);
    expect(statusOf(a!)).toBe(en.chat.actions.result.expired);
    expect(confirmable(a!)).toBe(false);
  });
});
