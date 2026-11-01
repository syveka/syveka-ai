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
    // Decided before, outcome not recorded (yet): never shown as a success.
    [409, { error: { code: "already_decided" } }, "confirm", "unknown"],
    [403, { error: { code: "permission_denied" } }, "confirm", "permission"],
    // An error while the tool ran may come after its write: never "failed".
    [500, { error: { code: "action_failed" } }, "confirm", "unknown"],
    // Refused by the plan before any write: nothing was done.
    [402, { error: { code: "plan_limit" } }, "confirm", "planLimit"],
    [503, { error: { code: "service_unavailable" } }, "confirm", "failed"],
    // No usable answer: the action may have run; a repeat is safe (see below).
    [500, { notJson: true }, "confirm", "noAnswer"],
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

  it("no answer to Confirm (network loss) says so and never claims it failed", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    show();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.chat.actions.confirm }));
    });
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.noAnswer);
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
    // The value's block takes its direction from the text itself, so an
    // Arabic paragraph is laid out right-to-left inside a Finnish or English
    // interface (and the other way round), whole lines included.
    const arabic = screen.getByText("أصحاب السيارات في هلسنكي");
    expect(arabic.tagName).toBe("DIV");
    expect(arabic.getAttribute("dir")).toBe("auto");
    const english = screen.getByText("Car and van repair");
    expect(english.getAttribute("dir")).toBe("auto");
    for (const item of ["FI", "EN", "AR"]) {
      expect(screen.getByText(item).getAttribute("dir")).toBe("auto");
    }
  });
});

describe("ActionConfirmation — a request that got no usable answer can be sent again", () => {
  const dnaAction = (): ProposedActionView =>
    action({
      tool: "proposeBusinessDnaUpdate",
      details: {
        tool: "proposeBusinessDnaUpdate",
        missingAfter: [],
        changes: [
          {
            field: "industry",
            kind: "added",
            before: null,
            after: { type: "text", value: "Car repair" },
          },
        ],
      },
    });
  const confirm = () =>
    act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.chat.actions.confirm }));
    });
  const tryAgain = () =>
    act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.chat.actions.tryAgain }));
    });

  it("the limit couldn't be checked (503): Try again sends the same decision and shows the result", async () => {
    response = { status: 503, body: { error: { code: "service_unavailable" } } };
    show(dnaAction());
    await confirm();
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.failed);
    expect(document.activeElement).toBe(
      screen.getByRole("region", { name: en.chat.actions.title }),
    );

    response = {
      status: 200,
      body: { data: { status: "done", tool: "proposeBusinessDnaUpdate" } },
    };
    await tryAgain();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const bodies = fetchMock.mock.calls.map((c) =>
      JSON.parse(String((c as unknown as [string, RequestInit])[1].body)),
    );
    expect(bodies[1]).toEqual(bodies[0]);
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.done);
    expect(screen.queryByRole("button", { name: en.chat.actions.tryAgain })).toBeNull();
    expect(screen.getByRole("link", { name: en.chat.actions.businessDna.review })).toBeTruthy();
  });

  it("rate limited (429): says so and offers to try again", async () => {
    response = { status: 429, body: { error: { code: "rate_limited" } } };
    show(dnaAction());
    await confirm();
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.rateLimited);
    expect(screen.getByRole("button", { name: en.chat.actions.tryAgain })).toBeTruthy();
  });

  it("no answer, then a repeat refused as already decided: the first decision's recorded outcome is shown", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    show(dnaAction());
    await confirm();
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.noAnswer);

    response = { status: 409, body: { error: { code: "already_decided", outcome: "done" } } };
    await tryAgain();

    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.done);
    expect(screen.getByRole("link", { name: en.chat.actions.businessDna.review })).toBeTruthy();
  });

  it("a repeat refused as already decided without a recorded outcome reads as unknown, not as a success", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    show(dnaAction());
    await confirm();
    response = { status: 409, body: { error: { code: "already_decided" } } };
    await tryAgain();
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.unknown);
    expect(screen.queryByRole("button", { name: en.chat.actions.tryAgain })).toBeNull();
  });

  it.each([
    [402, { error: { code: "plan_limit" } }, "planLimit"],
    [403, { error: { code: "permission_denied" } }, "permission"],
    [404, { error: { code: "not_found" } }, "expired"],
    [409, { error: { code: "mismatch" } }, "failed"],
    [500, { error: { code: "action_failed" } }, "unknown"],
  ])(
    "%s %j: a refusal that decided or can't change (%s) offers no retry",
    async (status, body, state) => {
      response = { status, body };
      show(dnaAction());
      await confirm();
      expect(screen.getByRole("status").textContent).toBe(
        (en.chat.actions.result as Record<string, string>)[state],
      );
      expect(screen.queryByRole("button", { name: en.chat.actions.tryAgain })).toBeNull();
    },
  );

  it("Cancel that got no answer can be sent again as Cancel", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new TypeError("Failed to fetch"));
    show(dnaAction());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.chat.actions.cancel }));
    });
    response = { status: 200, body: { data: { status: "canceled" } } };
    await tryAgain();
    const bodies = fetchMock.mock.calls.map((c) =>
      JSON.parse(String((c as unknown as [string, RequestInit])[1].body)),
    );
    expect(bodies.map((b) => b.decision)).toEqual(["cancel", "cancel"]);
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.canceled);
  });

  it("is localized (FI and AR)", async () => {
    response = { status: 429, body: { error: { code: "rate_limited" } } };
    show(dnaAction(), fi, "fi");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: fi.chat.actions.confirm }));
    });
    expect(screen.getByRole("status").textContent).toBe(fi.chat.actions.result.rateLimited);
    expect(screen.getByRole("button", { name: fi.chat.actions.tryAgain })).toBeTruthy();
    cleanup();
    show(dnaAction(), ar, "ar");
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: ar.chat.actions.confirm }));
    });
    expect(screen.getByRole("status").textContent).toBe(ar.chat.actions.result.rateLimited);
    expect(screen.getByRole("button", { name: ar.chat.actions.tryAgain })).toBeTruthy();
  });

  it.each([
    [{ status: 403, body: { error: { code: "permission_denied" } } }, "failed"],
    [{ status: 402, body: { error: { code: "plan_limit" } } }, "failed"],
    [{ status: 409, body: { error: { code: "mismatch" } } }, "failed"],
    [{ status: 500, body: { error: { code: "action_failed" } } }, "unknown"],
    [{ status: 404, body: { error: { code: "not_found" } } }, "unavailable"],
  ])(
    "%j settles the card (it can't be sent again), with outcome %s, so a held redirect goes on",
    async (reply, outcome) => {
      response = reply;
      const onSettled = vi.fn();
      render(
        <NextIntlClientProvider locale="en" messages={en}>
          <ActionConfirmation action={dnaAction()} onSettled={onSettled} />
        </NextIntlClientProvider>,
      );
      await confirm();
      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledWith(dnaAction().id, outcome);
    },
  );

  it.each([
    [{ status: 503, body: { error: { code: "service_unavailable" } } }],
    [{ status: 429, body: { error: { code: "rate_limited" } } }],
    [{ status: 500, body: { notJson: true } }],
  ])("%j can be sent again, so the card is not settled yet", async (reply) => {
    response = reply;
    const onSettled = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ActionConfirmation action={dnaAction()} onSettled={onSettled} />
      </NextIntlClientProvider>,
    );
    await confirm();
    expect(onSettled).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: en.chat.actions.tryAgain })).toBeTruthy();
    response = { status: 200, body: { data: { status: "done" } } };
    await tryAgain();
    expect(onSettled).toHaveBeenCalledWith(dnaAction().id, "done");
  });
});

describe("ActionConfirmation — a proposal replaced by a newer one", () => {
  const hoursAndLanguages = (): ProposedActionView =>
    action({
      tool: "proposeBusinessDnaUpdate",
      details: {
        tool: "proposeBusinessDnaUpdate",
        missingAfter: [],
        changes: [
          {
            field: "openingHours",
            kind: "modified",
            before: null,
            after: {
              type: "hours",
              days: [{ day: "monday", closed: false, open: "08:00", close: "17:00" }],
            },
          },
          {
            field: "supportedLocales",
            kind: "added",
            before: null,
            after: { type: "list", items: ["FI", "EN"] },
          },
        ],
      },
    });
  const replaced = { notCarriedOver: [] };

  it("is shown as replaced, can't be decided, and releases the view at once", () => {
    const onSettled = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ActionConfirmation action={action()} superseded={replaced} onSettled={onSettled} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.superseded);
    expect(screen.queryByRole("button", { name: en.chat.actions.confirm })).toBeNull();
    expect(onSettled).toHaveBeenCalledWith(action().id, "superseded");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("a card already decided is not changed by a later proposal", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ActionConfirmation action={{ ...action(), restored: "done" }} superseded={replaced} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.done);
  });

  it("is offered again once the newer proposal is withdrawn, if still unexpired; announced, not focused", () => {
    const onSettled = vi.fn();
    const view = render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ActionConfirmation action={hoursAndLanguages()} onSettled={onSettled} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("button", { name: en.chat.actions.confirm })).toBeTruthy();
    view.rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <ActionConfirmation
          action={hoursAndLanguages()}
          superseded={replaced}
          onSettled={onSettled}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.superseded);
    expect(screen.queryByRole("button", { name: en.chat.actions.confirm })).toBeNull();
    expect(onSettled).toHaveBeenCalledTimes(1);
    view.rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <ActionConfirmation action={hoursAndLanguages()} onSettled={onSettled} />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.nothingYet);
    expect(screen.getByRole("button", { name: en.chat.actions.confirm })).toBeTruthy();
    expect(document.activeElement).toBe(document.body);
    expect(fetchMock).not.toHaveBeenCalled();
    // Replaced again later: reported again, so a held redirect is released again.
    view.rerender(
      <NextIntlClientProvider locale="en" messages={en}>
        <ActionConfirmation
          action={hoursAndLanguages()}
          superseded={replaced}
          onSettled={onSettled}
        />
      </NextIntlClientProvider>,
    );
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it("a proposal that expired while replaced is expired, not confirmable, when the newer one is withdrawn", () => {
    const expiresAt = Date.now() + 1_000;
    const a = { ...hoursAndLanguages(), expiresAt };
    const view = render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ActionConfirmation action={a} superseded={replaced} />
      </NextIntlClientProvider>,
    );
    vi.useFakeTimers();
    vi.setSystemTime(expiresAt + 1);
    try {
      view.rerender(
        <NextIntlClientProvider locale="en" messages={en}>
          <ActionConfirmation action={a} />
        </NextIntlClientProvider>,
      );
    } finally {
      vi.useRealTimers();
    }
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.expired);
    expect(screen.queryByRole("button", { name: en.chat.actions.confirm })).toBeNull();
  });

  it.each([
    ["en", en, "The newer request doesn't include Supported languages."],
    ["fi", fi, "Uudempi pyyntö ei sisällä kohtaa Tuetut kielet."],
    ["ar", ar, "الطلب الأحدث لا يشمل اللغات المدعومة."],
  ])("names the fields the newer request doesn't carry over (%s)", (locale, messages, expected) => {
    render(
      <NextIntlClientProvider locale={locale} messages={messages}>
        <ActionConfirmation
          action={hoursAndLanguages()}
          superseded={{ notCarriedOver: ["supportedLocales"] }}
        />
      </NextIntlClientProvider>,
    );
    const status = screen.getByRole("status").textContent ?? "";
    expect(status.startsWith(messages.chat.actions.result.superseded)).toBe(true);
    expect(status).toContain(expected);
    expect(screen.queryByRole("button", { name: messages.chat.actions.confirm })).toBeNull();
  });

  it.each([
    [{ status: 429, body: { error: { code: "rate_limited" } } }],
    [{ status: 503, body: { error: { code: "service_unavailable" } } }],
    [{ status: 500, body: { notJson: true } }],
  ])(
    "%j: a card awaiting a repeat is replaced by a correction too; its repeat is withheld, then offered again",
    async (reply) => {
      response = reply;
      const onSettled = vi.fn();
      const view = render(
        <NextIntlClientProvider locale="en" messages={en}>
          <ActionConfirmation action={hoursAndLanguages()} onSettled={onSettled} />
        </NextIntlClientProvider>,
      );
      await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: en.chat.actions.confirm }));
      });
      expect(screen.getByRole("button", { name: en.chat.actions.tryAgain })).toBeTruthy();
      expect(onSettled).not.toHaveBeenCalled();

      view.rerender(
        <NextIntlClientProvider locale="en" messages={en}>
          <ActionConfirmation
            action={hoursAndLanguages()}
            superseded={{ notCarriedOver: ["supportedLocales"] }}
            onSettled={onSettled}
          />
        </NextIntlClientProvider>,
      );
      expect(screen.getByRole("status").textContent).toBe(
        `${en.chat.actions.result.superseded} The newer request doesn't include Supported languages. Ask Syveka again to change that too.`,
      );
      expect(screen.queryByRole("button", { name: en.chat.actions.tryAgain })).toBeNull();
      expect(screen.queryByRole("button", { name: en.chat.actions.confirm })).toBeNull();
      expect(onSettled).toHaveBeenCalledTimes(1);
      expect(onSettled).toHaveBeenCalledWith(hoursAndLanguages().id, "superseded");
      expect(fetchMock).toHaveBeenCalledTimes(1);

      // The correction is withdrawn: the repeat is offered again, and sends
      // the same decision (refused with the first one's outcome if it ran).
      view.rerender(
        <NextIntlClientProvider locale="en" messages={en}>
          <ActionConfirmation action={hoursAndLanguages()} onSettled={onSettled} />
        </NextIntlClientProvider>,
      );
      const again = screen.getByRole("button", { name: en.chat.actions.tryAgain });
      expect(again).toBeTruthy();
      response = { status: 409, body: { error: { code: "already_decided", outcome: "done" } } };
      await act(async () => {
        fireEvent.click(again);
      });
      expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.done);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    },
  );

  it("lists several fields in the interface language", () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ActionConfirmation
          action={hoursAndLanguages()}
          superseded={{ notCarriedOver: ["supportedLocales", "openingHours"] }}
        />
      </NextIntlClientProvider>,
    );
    expect(screen.getByRole("status").textContent).toContain(
      "doesn't include Supported languages and Opening hours.",
    );
  });
});

describe("ActionConfirmation — while a repeat is in flight", () => {
  it("keeps the retry button in place (disabled, busy) instead of showing Confirm/Cancel again", async () => {
    let release!: (r: Response) => void;
    response = { status: 503, body: { error: { code: "service_unavailable" } } };
    show(action());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.chat.actions.confirm }));
    });
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (release = r)));

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.chat.actions.tryAgain }));
    });

    // Never `disabled` (browsers blur a control that becomes disabled, dropping
    // keyboard focus to the page); the one-request guard ignores a second click.
    const busy = screen.getByRole("button", { name: en.chat.actions.tryAgain });
    expect(busy.hasAttribute("disabled")).toBe(false);
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    await act(async () => {
      fireEvent.click(busy);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("button", { name: en.chat.actions.confirm })).toBeNull();
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.retrying);
    await act(async () => {
      release(new Response(JSON.stringify({ data: { status: "done" } }), { status: 200 }));
    });
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.done);
  });

  it("a refusal issued before any decision (signed out) can be sent again and settles nothing", async () => {
    response = { status: 401, body: { error: { code: "unauthenticated" } } };
    const onSettled = vi.fn();
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <ActionConfirmation action={action()} onSettled={onSettled} />
      </NextIntlClientProvider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.chat.actions.confirm }));
    });
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.failed);
    expect(screen.getByRole("button", { name: en.chat.actions.tryAgain })).toBeTruthy();
    expect(onSettled).not.toHaveBeenCalled();
  });

  it("a recorded outcome the card doesn't know reads as unknown, never as a success or a stuck card", async () => {
    response = { status: 409, body: { error: { code: "already_decided", outcome: "applied" } } };
    show(action());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.chat.actions.confirm }));
    });
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.unknown);
    expect(screen.queryByRole("button", { name: en.chat.actions.tryAgain })).toBeNull();
  });

  it("Confirm and Cancel are never disabled while a request is in flight (focus stays on the card)", async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (release = r)));
    show(action());
    const confirm = screen.getByRole("button", { name: en.chat.actions.confirm });
    confirm.focus();
    await act(async () => {
      fireEvent.click(confirm);
    });
    expect(confirm.hasAttribute("disabled")).toBe(false);
    expect(confirm.getAttribute("aria-disabled")).toBe("true");
    expect(confirm.getAttribute("aria-busy")).toBe("true");
    expect(confirm.textContent).toContain(en.chat.actions.confirm);
    expect(document.activeElement).toBe(confirm);
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.confirming);
    await act(async () => {
      fireEvent.click(confirm);
      fireEvent.click(screen.getByRole("button", { name: en.chat.actions.cancel }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      release(new Response(JSON.stringify({ data: { status: "done" } }), { status: 200 }));
    });
    expect(document.activeElement).toBe(
      screen.getByRole("region", { name: en.chat.actions.title }),
    );
  });

  it("Confirm then Cancel clicked in a row: only the first decision is sent", async () => {
    let release!: (r: Response) => void;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (release = r)));
    show(action());
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: en.chat.actions.confirm }));
      fireEvent.click(screen.getByRole("button", { name: en.chat.actions.cancel }));
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).decision).toBe("confirm");
    await act(async () => {
      release(new Response(JSON.stringify({ data: { status: "done" } }), { status: 200 }));
    });
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.result.done);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("the live region exists while pending too, so a replacement is announced, not inserted", () => {
    show(action());
    expect(screen.getByRole("status").textContent).toBe(en.chat.actions.nothingYet);
    expect(screen.getByRole("status").getAttribute("aria-live")).toBe("polite");
  });
});
