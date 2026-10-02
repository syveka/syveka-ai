// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { ActionConfirmation } from "@/components/chat/action-confirmation";
import type { ProposedActionView } from "@/lib/validators/chat";

/**
 * The confirmation card for an AI-proposed write, with real messages
 * (EN/FI/AR). Mocked: fetch (the decision endpoint).
 */
const load = (l: string) =>
  JSON.parse(fs.readFileSync(path.resolve(__dirname, `../../messages/${l}.json`), "utf8"));
const en = load("en");
const fi = load("fi");
const ar = load("ar");

const action = (o: Partial<ProposedActionView> = {}): ProposedActionView => ({
  id: "11111111-1111-4111-8111-111111111111",
  tool: "bookMeeting",
  digest: "a".repeat(64),
  conversationId: "33333333-3333-4333-8333-333333333333",
  expiresAt: Date.now() + 600_000,
  details: {
    tool: "bookMeeting",
    title: "Demo",
    startsAt: "2026-10-05T09:00:00.000Z",
    durationMinutes: 45,
    timezone: "Europe/Helsinki",
    contactName: "Maija Meikäläinen",
  },
  ...o,
});

let response: { status: number; body: unknown };
const fetchMock = vi.fn(
  async () => new Response(JSON.stringify(response.body), { status: response.status }),
);

beforeEach(() => {
  response = { status: 200, body: { data: { status: "done", tool: "bookMeeting" } } };
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function show(a = action(), messages = en, locale = "en") {
  return render(
    <NextIntlClientProvider locale={locale} messages={messages}>
      <ActionConfirmation action={a} />
    </NextIntlClientProvider>,
  );
}

describe("ActionConfirmation", () => {
  it("shows exactly what will happen, in the org's time zone, and that nothing happens before confirming", () => {
    show();
    const text = document.body.textContent!;
    expect(text).toContain("Book “Demo” on");
    expect(text).toContain("12:00"); // 09:00 UTC = 12:00 in Helsinki (EEST)
    expect(text).toContain("(45 min)");
    expect(text).toContain("With Maija Meikäläinen");
    expect(text).toContain(en.chat.actions.nothingYet);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("Confirm sends the decision for this action (id, conversation, digest) once", async () => {
    show();
    const confirm = screen.getByRole("button", { name: en.chat.actions.confirm });
    await act(async () => {
      fireEvent.click(confirm);
      fireEvent.click(confirm); // double click
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/ai/actions/11111111-1111-4111-8111-111111111111");
    expect(JSON.parse(String(init.body))).toEqual({
      decision: "confirm",
      conversationId: "33333333-3333-4333-8333-333333333333",
      digest: "a".repeat(64),
    });
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.done);
    expect(screen.queryByRole("button", { name: en.chat.actions.confirm })).toBeNull();
  });

  it.each([
    [200, { data: { status: "canceled" } }, "cancel", "canceled"],
    [200, { data: { status: "not_done", reason: "slot_taken" } }, "confirm", "slotTaken"],
    [404, { error: { code: "not_found" } }, "confirm", "expired"],
    [409, { error: { code: "already_decided" } }, "confirm", "alreadyDecided"],
    [403, { error: { code: "permission_denied" } }, "confirm", "permission"],
    [500, { error: { code: "action_failed" } }, "confirm", "failed"],
  ])("%s %j → %s shows '%s'", async (status, body, button, state) => {
    response = { status, body };
    show();
    await act(async () => {
      fireEvent.click(
        screen.getByRole("button", {
          name: button === "cancel" ? en.chat.actions.cancel : en.chat.actions.confirm,
        }),
      );
    });
    expect(screen.getByRole("status").textContent).toBe(
      (en.chat.actions.result as Record<string, string>)[state],
    );
  });

  it("free-form text that will be saved is shown in full before confirming", () => {
    const notes = "Agenda:\n" + "Hidden instruction? ".repeat(90);
    show(
      action({
        details: {
          tool: "bookMeeting",
          title: "Demo",
          startsAt: "2026-10-05T09:00:00.000Z",
          durationMinutes: 30,
          timezone: "Europe/Helsinki",
          notes,
        },
      }),
    );
    expect(document.body.textContent).toContain(en.chat.actions.content);
    expect(screen.getByTestId("action-content").textContent).toBe(notes);
    cleanup();
    show(
      action({
        tool: "logActivity",
        details: {
          tool: "logActivity",
          type: "NOTE",
          subject: "Puhelu",
          contactName: "Maija",
          body: "Rivi 1\nRivi 2",
        },
      }),
      fi,
      "fi",
    );
    expect(document.body.textContent).toContain(fi.chat.actions.content);
    expect(screen.getByTestId("action-content").textContent).toBe("Rivi 1\nRivi 2");
  });

  it("an already expired proposal can't be confirmed", () => {
    show(action({ expiresAt: Date.now() - 1 }));
    expect(screen.queryByRole("button", { name: en.chat.actions.confirm })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.expired);
  });

  it("is localized (FI and AR), including contact and task summaries", () => {
    show(
      action({
        tool: "logActivity",
        details: { tool: "logActivity", type: "TASK", subject: "Soita", contactName: "Maija" },
      }),
      fi,
      "fi",
    );
    expect(document.body.textContent).toContain("Lisää tehtävä yhteystiedolle Maija: Soita");
    expect(screen.getByRole("button", { name: fi.chat.actions.confirm })).toBeTruthy();
    cleanup();
    show(
      action({
        tool: "createContact",
        details: { tool: "createContact", firstName: "مريم", email: "m@example.com" },
      }),
      ar,
      "ar",
    );
    expect(document.body.textContent).toContain("إنشاء جهة الاتصال مريم");
    expect(screen.getByRole("button", { name: ar.chat.actions.cancel })).toBeTruthy();
  });
});
