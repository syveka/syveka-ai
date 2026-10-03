import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as Sentry from "@sentry/nextjs";
import { sentryOptions } from "@/lib/observability/options";
import { onRequestError } from "@/instrumentation";
import {
  APP_ORIGIN,
  CUSTOMER_HOST,
  IDENTIFIER_SHAPED,
  ARABIC_CHAT,
  ARABIC_NAME,
  CHAT_TEXT,
  CRM_DETAIL,
  EMAIL,
  expectClean,
  INVITE_TOKEN,
  JWT,
  NAME,
  ORG_ID,
  SENSITIVE_MESSAGE,
} from "../mocks/observability-sensitive";

/**
 * The real server SDK with the app's options, end to end, through an
 * in-memory transport: envelopes are captured exactly as they would be
 * sent, but nothing leaves the process (fetch is asserted unused). Proves
 * the event and the envelope headers are clean after every SDK integration
 * has added its data.
 */
const DSN = "https://publickey@o1.ingest.de.sentry.io/2";

type Envelope = [Record<string, unknown>, Array<[{ type: string }, unknown]>];
const sent: Envelope[] = [];
const fetchSpy = vi.fn();

beforeAll(() => {
  vi.stubEnv("NEXT_RUNTIME", "nodejs");
  vi.stubEnv("SENTRY_DSN", DSN);
  vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_ORIGIN);
  vi.stubGlobal("fetch", fetchSpy);
  Sentry.init({
    ...sentryOptions(DSN, "test-release"),
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
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});
beforeEach(() => {
  sent.length = 0;
});

const items = (type: string) =>
  sent.flatMap(([, entries]) => entries.filter(([h]) => h.type === type).map(([, p]) => p));
const events = () => items("event") as Array<Record<string, unknown>>;

describe("real server SDK, in-memory transport", () => {
  it("a server request error: fixed message, route template, no headers, cookies or identity", async () => {
    await onRequestError(
      new Error(SENSITIVE_MESSAGE),
      {
        path: `/ar/crm/contacts/${ORG_ID}?q=${encodeURIComponent(ARABIC_CHAT)}`,
        method: "POST",
        headers: {
          cookie: `sb-access-token=${JWT}`,
          authorization: `Bearer ${JWT}`,
          "x-org-id": ORG_ID,
          referer: `https://${CUSTOMER_HOST}/en/invite/${INVITE_TOKEN}`,
          host: CUSTOMER_HOST,
          "x-forwarded-host": CUSTOMER_HOST,
        },
      },
      {
        routerKind: "App Router",
        routePath: "/[locale]/(app)/crm/contacts/[contactId]",
        routeType: "render",
        renderSource: "react-server-components",
        revalidateReason: undefined,
      },
    );
    await Sentry.flush(2000);

    expect(sent.length).toBeGreaterThan(0);
    // Envelope headers and every item, serialized as they'd be sent.
    expectClean(sent);
    const [event] = events();
    const exception = (event!.exception as { values: Array<{ type: string; value: string }> })
      .values[0]!;
    expect(exception).toMatchObject({ type: "Error", value: "Error message withheld" });
    expect(event!.user).toBeUndefined();
    expect(event!.extra).toBeUndefined();
    expect(event!.server_name).toBeUndefined();
    expect(event!.request).toEqual({ method: "POST" });
    expect(event!.transaction).toBe("POST /[locale]/crm/contacts/[contactId]");
    expect((event!.contexts as Record<string, unknown>).nextjs).toEqual({
      request_path: "/[locale]/crm/contacts/[contactId]",
      router_path: "/[locale]/crm/contacts/[contactId]",
      router_kind: "App Router",
      route_type: "render",
    });
    // Envelope header: no user, org or request data.
    for (const [header] of sent) {
      expect(JSON.stringify(header)).not.toMatch(/user|segment|transaction/);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("scope data set by any code (user, tags, extras, contexts) never leaves", async () => {
    Sentry.withScope((scope) => {
      scope.setUser({ id: ORG_ID, email: EMAIL, username: NAME });
      scope.setTag("orgId", ORG_ID);
      scope.setTag("contact", NAME);
      scope.setExtra("conversation", CHAT_TEXT);
      scope.setContext("crm", { deal: CRM_DETAIL, contact: ARABIC_NAME });
      scope.setFingerprint([NAME]);
      Sentry.captureException(new Error(`Deal ${CRM_DETAIL} for ${ARABIC_NAME}`));
    });
    await Sentry.flush(2000);
    expect(events()).toHaveLength(1);
    expectClean(sent);
  });

  it("console output and breadcrumbs with content never reach an event", async () => {
    console.log(`user said: ${CHAT_TEXT} ${ARABIC_CHAT}`);
    Sentry.addBreadcrumb({ category: "ui.input", message: CHAT_TEXT });
    Sentry.addBreadcrumb({ category: "log", message: ARABIC_CHAT, data: { name: NAME } });
    Sentry.addBreadcrumb({
      category: "http",
      data: {
        method: "GET",
        url: `https://api.example.com/v1/people/${encodeURIComponent(NAME)}?email=${EMAIL}`,
        status_code: 500,
      },
    });
    Sentry.addBreadcrumb({
      category: "http",
      data: {
        method: "POST",
        url: `https://${CUSTOMER_HOST}/en/inbox/${ORG_ID}`,
        status_code: 404,
      },
    });
    Sentry.captureException(new Error("boom"));
    await Sentry.flush(2000);

    const [event] = events();
    expect(event!.breadcrumbs).toEqual([
      // Untrusted origins (third party, customer subdomain): no URL at all.
      expect.objectContaining({ category: "http", data: { method: "GET", status_code: 500 } }),
      expect.objectContaining({ category: "http", data: { method: "POST", status_code: 404 } }),
    ]);
    expectClean(sent);
  });

  it("a real stack frame named like sensitive text: the name never leaves", async () => {
    // A function whose (real, runtime) name is sensitive text shaped like an identifier.
    const named = {
      [IDENTIFIER_SHAPED]: () => {
        throw new Error("boom");
      },
    }[IDENTIFIER_SHAPED]!;
    let error: Error | undefined;
    try {
      named();
    } catch (e) {
      error = e as Error;
    }
    expect(error!.stack).toContain(IDENTIFIER_SHAPED); // the SDK sees it in the stack
    Sentry.captureException(error);
    await Sentry.flush(2000);

    const [event] = events();
    const frames = (event!.exception as { values: Array<{ stacktrace: { frames: object[] } }> })
      .values[0]!.stacktrace.frames;
    expect(frames.length).toBeGreaterThan(0);
    for (const frame of frames) {
      expect(frame).not.toHaveProperty("function");
      expect(frame).not.toHaveProperty("module");
    }
    expectClean(sent);
  });

  it("no tracing: spans aren't recorded and nothing but error events is sent", async () => {
    await Sentry.startSpan({ name: `GET /api/v1/orgs/${ORG_ID}` }, async (span) => {
      expect(span.isRecording()).toBe(false);
    });
    Sentry.captureException(new Error("only this"));
    await Sentry.flush(2000);

    expect(items("transaction")).toEqual([]);
    expect(items("span")).toEqual([]);
    expect(items("session")).toEqual([]);
    expect(items("replay_event")).toEqual([]);
    expect(items("log")).toEqual([]);
    expect(events()).toHaveLength(1);
    expect(Sentry.getIsolationScope().getUser()).toEqual({});
  });
});
