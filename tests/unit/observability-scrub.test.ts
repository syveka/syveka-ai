import { describe, expect, it } from "vitest";
import type { ErrorEvent } from "@sentry/nextjs";
import { parseSentryDsn } from "@/lib/observability/dsn";
import {
  ARABIC_CHAT,
  ARABIC_NAME,
  BOOKING_SLUG,
  CHAT_TEXT,
  CRM_DETAIL,
  EMAIL,
  expectClean,
  INVITE_TOKEN,
  JWT,
  NAME,
  ORG_ID,
  PHONE,
  STRIPE_KEY,
} from "../mocks/observability-sensitive";
import {
  safeErrorDescription,
  safeUrl,
  scrubBreadcrumb,
  scrubEvent,
} from "@/lib/observability/scrub";

/**
 * What may leave the app in an error event. Pure functions; no SDK, no
 * network. None of the synthetic sensitive values may appear in the output.
 */

describe("parseSentryDsn: off unless a valid DSN is configured", () => {
  it.each([
    undefined,
    "",
    "   ",
    "not a url",
    "http://key@o1.ingest.sentry.io/1", // not https
    "https://o1.ingest.sentry.io/1", // no public key
    "https://key:secret@o1.ingest.sentry.io/1", // legacy secret key
    "https://key@o1.ingest.sentry.io/", // no project
    "https://key@o1.ingest.sentry.io/1?x=1",
  ])("%j -> disabled", (raw) => {
    expect(parseSentryDsn(raw)).toBeNull();
  });

  it("a valid DSN yields only its ingest origin for the CSP", () => {
    expect(parseSentryDsn(" https://abc123@o42.ingest.us.sentry.io/7 ")).toEqual({
      dsn: "https://abc123@o42.ingest.us.sentry.io/7",
      ingestOrigin: "https://o42.ingest.us.sentry.io",
    });
  });
});

describe("safeErrorDescription: messages are replaced, never forwarded", () => {
  it.each([
    [`Contact ${NAME} could not be saved`],
    [`${NAME} ${PHONE} ${EMAIL}`],
    [`فشل حفظ جهة الاتصال ${ARABIC_NAME}`],
    [ARABIC_CHAT],
    [CHAT_TEXT],
    [`Deal update failed: ${CRM_DETAIL}`],
    [`Invalid token ${JWT}`],
    [`Stripe rejected key ${STRIPE_KEY}`],
    [`org ${ORG_ID} not found`],
    [`password=hunter2`],
    [""],
  ])("%j -> withheld", (message) => {
    expect(safeErrorDescription(message)).toBe("Error message withheld");
  });

  it.each([
    [
      "Cannot read properties of undefined (reading 'Maria')",
      "Cannot read a property of undefined or null",
    ],
    [`${NAME}.map is not a function`, "A value is not a function"],
    [`Failed to fetch`, "Network request failed"],
    [`connect ECONNREFUSED 10.0.0.1:5432 ${NAME}`, "Network error ECONNREFUSED"],
    [
      `Invalid \`prisma.contact.create()\` invocation:\n{ name: "${NAME}" }`,
      "Database operation failed",
    ],
    [`Unexpected token 'م', "${ARABIC_CHAT}" is not valid JSON`, "Invalid JSON"],
    ["Minified React error #418; visit https://react.dev/errors/418", "React error #418"],
    ["Loading chunk 9927 failed.", "Code chunk failed to load"],
    [`The operation for ${NAME} timed out`, "Operation timed out"],
  ])("a known shape gets a fixed description: %j", (message, expected) => {
    expect(safeErrorDescription(message)).toBe(expected);
    expectClean(safeErrorDescription(message));
  });

  it("non-strings are withheld", () => {
    expect(safeErrorDescription(undefined)).toBe("Error message withheld");
    expect(safeErrorDescription({ toString: () => NAME })).toBe("Error message withheld");
  });
});

describe("safeUrl: app routes as templates, unknown paths omitted", () => {
  it.each([
    [`/en/inbox/${ORG_ID}?q=${CHAT_TEXT}`, "/[locale]/inbox/[threadId]"],
    [`/inbox/${ORG_ID}`, "/[locale]/inbox/[threadId]"], // Finnish: no locale prefix
    [`/ar/crm/contacts/${ORG_ID}#notes`, "/[locale]/crm/contacts/[contactId]"],
    [`/en/invite/${INVITE_TOKEN}`, "/[locale]/invite/[token]"],
    [`/book/${BOOKING_SLUG}/consultation`, "/[locale]/book/[org]/[slug]"],
    [`/api/v1/booking/manage/${INVITE_TOKEN}`, "/api/v1/booking/manage/[token]"],
    ["/api/v1/ai/chat", "/api/v1/ai/chat"],
    [`/en/${encodeURIComponent(ARABIC_NAME)}`, undefined],
    [`/contacts/${encodeURIComponent(EMAIL)}`, undefined],
    [`/en/crm/contacts/${ORG_ID}/${NAME}`, undefined],
    [
      `https://app.syveka.com/en/crm/deals/${ORG_ID}?x=1`,
      "https://app.syveka.com/[locale]/crm/deals/[dealId]",
    ],
    [
      `https://user:pw@api.example.com/v1/people/${encodeURIComponent(NAME)}`,
      "https://api.example.com",
    ],
    [`javascript:alert('${NAME}')`, undefined],
    [NAME, undefined],
  ])("%j -> %j", (raw, expected) => {
    expect(safeUrl(raw)).toBe(expected);
  });
});

describe("scrubBreadcrumb", () => {
  it("drops console, UI and log breadcrumbs entirely", () => {
    for (const category of ["console", "ui.click", "ui.input", "sentry.event", "log", undefined]) {
      expect(scrubBreadcrumb({ category, message: CHAT_TEXT })).toBeNull();
    }
  });

  it("fetch: method, route template and status only; no message or body", () => {
    const out = scrubBreadcrumb({
      type: "http",
      category: "fetch",
      message: CHAT_TEXT,
      data: {
        method: "post",
        url: `/api/v1/inbox/${ORG_ID}?name=${NAME}`,
        status_code: 500,
        request_body: ARABIC_CHAT,
      },
    });
    expect(out).toMatchObject({
      category: "fetch",
      data: { method: "POST", url: "/api/v1/inbox/[threadId]", status_code: 500 },
    });
    expect(out?.message).toBeUndefined();
    expectClean(out);
  });

  it("navigation to unknown paths keeps no path at all", () => {
    expect(
      scrubBreadcrumb({
        category: "navigation",
        data: { from: `/en/crm/contacts/${ORG_ID}`, to: `/en/${NAME}` },
      })?.data,
    ).toEqual({ from: "/[locale]/crm/contacts/[contactId]" });
  });
});

describe("scrubEvent", () => {
  const raw = (): ErrorEvent => ({
    type: undefined,
    event_id: "e1",
    level: "error",
    platform: "javascript",
    message: `Failed for ${NAME}`,
    transaction: `GET /ar/crm/contacts/${ORG_ID}`,
    server_name: "ip-10-0-0-1",
    fingerprint: [NAME],
    user: { id: ORG_ID, email: EMAIL, ip_address: "203.0.113.9" },
    extra: { conversation: CHAT_TEXT, arabic: ARABIC_CHAT },
    tags: { orgId: ORG_ID, runtime: "node", contact: NAME, turbopack: true },
    modules: { next: "15.5.0" },
    contexts: {
      runtime: { name: "node", version: "v22.1.0" },
      os: { name: "Linux", version: "6.1", kernel_version: NAME },
      culture: { timezone: "Europe/Helsinki", locale: "fi-FI" },
      app: { app_name: NAME },
      nextjs: {
        request_path: `/en/inbox/${ORG_ID}?q=${CHAT_TEXT}`,
        router_kind: "App Router",
        router_path: "/[locale]/(app)/inbox/[threadId]",
        route_type: "render",
      },
      state: { state: { type: "crm", value: { contact: EMAIL, deal: CRM_DETAIL } } },
      response: { body: CHAT_TEXT },
    },
    request: {
      method: "POST",
      url: `https://app.syveka.com/api/v1/booking/manage/${INVITE_TOKEN}?email=${EMAIL}`,
      query_string: `email=${EMAIL}`,
      cookies: { "sb-access-token": JWT },
      headers: { authorization: `Bearer ${JWT}`, cookie: `sb=${JWT}` },
      data: { name: NAME, notes: ARABIC_CHAT },
      env: { REMOTE_ADDR: "203.0.113.9" },
    },
    exception: {
      values: [
        {
          type: "Error",
          value: `Contact ${NAME} (${EMAIL}, ${PHONE}) failed: ${ARABIC_CHAT}\n${CRM_DETAIL}`,
          mechanism: { type: "onerror", handled: false, data: { body: CHAT_TEXT } },
          stacktrace: {
            frames: [
              {
                filename: `https://app.syveka.com/_next/static/chunks/app.js?token=${JWT}`,
                function: "submitContact",
                lineno: 10,
                colno: 4,
                in_app: true,
                vars: { message: CHAT_TEXT, apiKey: STRIPE_KEY },
                context_line: `const note = "${CHAT_TEXT}"`,
                pre_context: [ARABIC_CHAT],
                post_context: [CRM_DETAIL],
              },
              {
                // Inline script: the "file" is the page URL itself.
                filename: `https://app.syveka.com/en/crm/contacts/${ORG_ID}?name=${NAME}`,
                function: ARABIC_NAME,
                lineno: 1,
              },
              {
                filename: "/var/task/.next/server/app/[locale]/(app)/crm/page.js",
                function: "Object.<anonymous>",
                module: "app.[locale].(app).crm.page",
                lineno: 2,
              },
            ],
          },
        },
        { type: `Custom ${NAME}`, value: ARABIC_NAME },
      ],
    },
    breadcrumbs: [
      { category: "console", message: CHAT_TEXT },
      { category: "ui.click", message: `button[aria-label="${NAME}"]` },
      { category: "fetch", data: { method: "GET", url: `/api/x/${NAME}?k=${STRIPE_KEY}` } },
    ],
  });

  it("the whole event contains none of the sensitive values", () => {
    expectClean(scrubEvent(raw()));
  });

  it("is idempotent (breadcrumbs are scrubbed when added and again in beforeSend)", () => {
    const once = scrubEvent(raw());
    expect(scrubEvent(once)).toEqual(once);
    const crumb = scrubBreadcrumb({
      category: "http",
      data: { method: "GET", url: `https://api.example.com/v1/${NAME}` },
    })!;
    expect(crumb.data).toEqual({ method: "GET", url: "https://api.example.com" });
    expect(scrubBreadcrumb(crumb)).toEqual(crumb);
  });

  it("keeps only allowlisted fields", () => {
    const out = scrubEvent(raw());
    expect(out.user).toBeUndefined();
    expect(out.extra).toBeUndefined();
    expect(out.server_name).toBeUndefined();
    expect(out.fingerprint).toBeUndefined();
    expect(out.modules).toBeUndefined();
    expect(out.message).toBe("Error message withheld");
    expect(out.tags).toEqual({ runtime: "node", turbopack: true });
    expect(out.transaction).toBe("GET /[locale]/crm/contacts/[contactId]");
    expect(out.request).toEqual({
      method: "POST",
      url: "https://app.syveka.com/api/v1/booking/manage/[token]",
    });
    expect(out.contexts).toEqual({
      runtime: { name: "node", version: "v22.1.0" },
      os: { name: "Linux", version: "6.1" },
      nextjs: {
        request_path: "/[locale]/inbox/[threadId]",
        router_path: "/[locale]/inbox/[threadId]",
        router_kind: "App Router",
        route_type: "render",
      },
    });
    expect(out.breadcrumbs).toEqual([
      expect.objectContaining({ category: "fetch", data: { method: "GET" } }),
    ]);
  });

  it("exceptions: safe type, fixed description, frames without variables, source or page URLs", () => {
    const [first, second] = scrubEvent(raw()).exception!.values!;
    expect(first).toEqual({
      type: "Error",
      value: "Error message withheld",
      mechanism: { type: "onerror", handled: false },
      stacktrace: {
        frames: [
          {
            filename: "https://app.syveka.com/_next/static/chunks/app.js",
            abs_path: undefined,
            module: undefined,
            function: "submitContact",
            lineno: 10,
            colno: 4,
            in_app: true,
          },
          {
            filename: "https://app.syveka.com/[locale]/crm/contacts/[contactId]",
            abs_path: undefined,
            module: undefined,
            function: undefined,
            lineno: 1,
            colno: undefined,
            in_app: undefined,
          },
          {
            filename: "/var/task/.next/server/app/[locale]/(app)/crm/page.js",
            abs_path: undefined,
            module: "app.[locale].(app).crm.page",
            function: "Object.<anonymous>",
            lineno: 2,
            colno: undefined,
            in_app: undefined,
          },
        ],
      },
    });
    expect(second).toMatchObject({ type: "Error", value: "Error message withheld" });
  });
});
