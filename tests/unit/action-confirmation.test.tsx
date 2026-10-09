// @vitest-environment jsdom
import React from "react";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import { ActionConfirmation } from "@/components/chat/action-confirmation";
import type { ProposedActionView } from "@/lib/validators/chat";

// The card links to Business DNA settings; next-intl's navigation needs the
// Next.js runtime, so tests render it as a plain link.
vi.mock("@/i18n/routing", () => ({
  Link: ({ href, children, ...rest }: React.PropsWithChildren<{ href: string }>) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}));

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
    // An error while the tool ran may come after its write: never "failed".
    [500, { error: { code: "action_failed" } }, "confirm", "unknown"],
    [503, { error: { code: "service_unavailable" } }, "confirm", "failed"],
    [500, { notJson: true }, "confirm", "unknown"],
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

  it("no answer to Confirm (network loss) shows an unknown outcome, never 'failed'", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.chat.actions.confirm }));
    });
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.unknown);
    expect(screen.queryByRole("button", { name: en.chat.actions.confirm })).toBeNull();
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

describe("ActionConfirmation — Business DNA changes", () => {
  const dnaAction = (): ProposedActionView =>
    action({
      tool: "proposeBusinessDnaUpdate",
      details: {
        tool: "proposeBusinessDnaUpdate",
        missingAfter: ["targetCustomer"],
        changes: [
          {
            field: "industry",
            kind: "modified",
            before: { type: "text", value: "Car repair" },
            after: { type: "text", value: "Car and van repair" },
          },
          {
            field: "supportedLocales",
            kind: "added",
            before: null,
            after: { type: "list", items: ["FI", "EN", "AR"] },
          },
          {
            field: "openingHours",
            kind: "modified",
            before: {
              type: "hours",
              days: [{ day: "monday", closed: false, open: "08:00", close: "17:00" }],
            },
            after: { type: "hours", days: [{ day: "monday", closed: true }] },
          },
          {
            field: "description",
            kind: "removed",
            before: { type: "text", value: "أصحاب السيارات في هلسنكي" },
            after: null,
          },
        ],
      },
    });

  it("shows every change with its field, kind, and values before and after, before confirming", () => {
    show(dnaAction());
    const changes = screen.getByTestId("business-dna-changes");

    expect(screen.getByText("Update Business DNA (4 changes)")).toBeTruthy();
    expect(changes.textContent).toContain(en.businessDna.fields.industry);
    expect(changes.textContent).toContain("Car repair");
    expect(changes.textContent).toContain("Car and van repair");
    expect(changes.textContent).toContain(en.businessDna.sections.openingHours);
    expect(changes.textContent).toContain(`${en.businessDna.weekdays.monday}: 08:00–17:00`);
    expect(changes.textContent).toContain(
      `${en.businessDna.weekdays.monday}: ${en.businessDna.closed}`,
    );
    for (const kind of ["added", "modified", "removed"]) {
      expect(changes.textContent).toContain(en.chat.actions.businessDna.kind[kind]);
    }
    expect(screen.getByText(en.chat.actions.nothingYet)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
  });

  it("after confirming, says it's done and links to the Business DNA page", async () => {
    response = {
      status: 200,
      body: { data: { status: "done", tool: "proposeBusinessDnaUpdate" } },
    };
    show(dnaAction());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.chat.actions.confirm }));
    });

    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.done);
    const link = screen.getByRole("link", { name: en.chat.actions.businessDna.review });
    expect(link.getAttribute("href")).toBe("/settings/business-dna");
  });

  it("a change made elsewhere in the meantime is reported as not applied, with no retry", async () => {
    response = {
      status: 200,
      body: { data: { status: "not_done", reason: "stale", tool: "proposeBusinessDnaUpdate" } },
    };
    show(dnaAction());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.chat.actions.confirm }));
    });

    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.stale);
    expect(screen.queryByRole("button", { name: en.chat.actions.confirm })).toBeNull();
  });

  it("a reopened conversation shows a stale change as such", () => {
    show({ ...dnaAction(), restored: "stale" } as ProposedActionView);
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.stale);
  });

  it.each([
    ["fi", fi],
    ["ar", ar],
  ])("is localized (%s), with the user's text direction kept per value", (locale, messages) => {
    show(dnaAction(), messages, locale);
    const changes = screen.getByTestId("business-dna-changes");

    expect(changes.textContent).toContain(messages.businessDna.fields.industry);
    expect(changes.textContent).toContain(messages.businessDna.weekdays.monday);
    expect(changes.textContent).toContain(messages.chat.actions.businessDna.kind.removed);
    const arabic = screen.getByText("أصحاب السيارات في هلسنكي");
    expect(arabic.getAttribute("dir")).toBe("auto");
  });
});
