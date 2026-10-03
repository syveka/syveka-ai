// @vitest-environment jsdom
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// The browser SDK that @sentry/nextjs runs on the client (same version, a
// dependency of it). Vitest resolves @sentry/nextjs to its server build, so
// the browser pipeline is exercised through this package directly.
import * as Sentry from "@sentry/browser";
import { sentryOptions } from "@/lib/observability/options";
import {
  ARABIC_CHAT,
  ARABIC_NAME,
  CHAT_TEXT,
  EMAIL,
  expectClean,
  NAME,
  ORG_ID,
  SENSITIVE_MESSAGE,
} from "../mocks/observability-sensitive";

/**
 * The real browser SDK with the app's options in jsdom, through an
 * in-memory transport. The app's own requests go to a stubbed fetch; the
 * SDK sends nothing over the network.
 */
const DSN = "https://publickey@o1.ingest.de.sentry.io/2";

type Envelope = [Record<string, unknown>, Array<[{ type: string }, unknown]>];
const sent: Envelope[] = [];
const appFetch = vi.fn(async () => new Response("{}", { status: 500 }));

beforeAll(() => {
  vi.stubGlobal("fetch", appFetch);
  window.history.replaceState({}, "", "/en/dashboard");
  Sentry.init({
    ...(sentryOptions(DSN) as Sentry.BrowserOptions),
    transport: () => ({
      send: async (envelope: unknown) => {
        sent.push(envelope as Envelope);
        return { statusCode: 200 };
      },
      flush: async () => true,
    }),
  });
});
afterAll(async () => {
  await Sentry.close();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  sent.length = 0;
});

const events = () =>
  sent.flatMap(([, entries]) =>
    entries.filter(([h]) => h.type === "event").map(([, p]) => p as Record<string, unknown>),
  );

describe("real browser SDK, in-memory transport", () => {
  it("UI, console, fetch and navigation activity with content: only templates and status reach the event", async () => {
    const button = document.createElement("button");
    button.setAttribute("aria-label", NAME);
    button.textContent = ARABIC_NAME;
    document.body.appendChild(button);
    button.click();
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.value = CHAT_TEXT;
    input.dispatchEvent(new KeyboardEvent("keypress", { bubbles: true }));
    console.log(`draft: ${ARABIC_CHAT}`);

    await fetch(`/api/v1/inbox/${ORG_ID}?q=${encodeURIComponent(CHAT_TEXT)}`, {
      method: "POST",
      body: JSON.stringify({ text: ARABIC_CHAT, email: EMAIL }),
    });
    window.history.pushState({}, "", `/ar/crm/contacts/${ORG_ID}?name=${encodeURIComponent(NAME)}`);

    Sentry.captureException(new Error(SENSITIVE_MESSAGE));
    await Sentry.flush(2000);

    const [event] = events();
    expect(event).toBeDefined();
    expectClean(sent);
    expect((event!.exception as { values: Array<{ value: string }> }).values[0]!.value).toBe(
      "Error message withheld",
    );
    const crumbs = event!.breadcrumbs as Array<{ category: string; data: unknown }>;
    expect(crumbs.map((c) => c.category)).toEqual(["fetch", "navigation"]);
    expect(crumbs[0]!.data).toEqual({
      method: "POST",
      url: "/api/v1/inbox/[threadId]",
      status_code: 500,
    });
    expect(crumbs[1]!.data).toEqual({
      from: "/[locale]/dashboard",
      to: "/[locale]/crm/contacts/[contactId]",
    });
    // The page URL the SDK attaches is reduced to its route template.
    expect(event!.request).toEqual({
      url: "http://localhost:3000/[locale]/crm/contacts/[contactId]",
    });
    expect(event!.user).toBeUndefined();
  });

  it("an uncaught error from window.onerror is captured and scrubbed", async () => {
    // What the browser calls for an uncaught error (the hook the SDK installs).
    const error = new TypeError(`Cannot read properties of undefined (reading '${NAME}')`);
    window.onerror?.(
      `Uncaught TypeError: ${NAME}`,
      `http://localhost:3000/en/crm/contacts/${ORG_ID}`,
      1,
      1,
      error,
    );
    await Sentry.flush(2000);
    const [event] = events();
    expect(event).toBeDefined();
    expect(
      (event!.exception as { values: Array<{ type: string; value: string }> }).values[0],
    ).toMatchObject({ type: "TypeError", value: "Cannot read a property of undefined or null" });
    expectClean(sent);
  });

  it("only error events are sent: no sessions, transactions, replays or client reports", async () => {
    Sentry.captureException(new Error("only this"));
    await Sentry.flush(2000);
    const types = sent.flatMap(([, entries]) => entries.map(([h]) => h.type));
    expect(types).toEqual(["event"]);
    // The app's fetch was used only by the test itself, never by the SDK.
    expect(appFetch).toHaveBeenCalledTimes(1);
  });
});
