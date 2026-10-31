import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type * as BookingService from "@/server/services/booking";

/**
 * Bad manage links at the two public boundaries: the guest page
 * (booking/manage/[token]) and the manage API (GET details, POST reschedule,
 * DELETE cancel). A link that doesn't resolve must show only the generic
 * invalid/expired state: no booking data, no organization lookup, and no
 * notification or reminder side effect.
 *
 * The booking service is mocked to throw. BookingTokenError is the real
 * class, so the page's and the route's `instanceof` checks are the real ones.
 * The missing-token case runs the real service and token resolver against a
 * mocked Prisma that only records calls.
 */

const mocks = vi.hoisted(() => ({
  getBookingByToken: vi.fn(),
  reschedule: vi.fn(),
  cancel: vi.fn(),
  notify: vi.fn(async (..._args: unknown[]) => {
    void _args;
    return { guestEmail: "sent" };
  }),
  reminders: vi.fn(async (..._args: unknown[]) => {
    void _args;
  }),
  orgFindUnique: vi.fn(async (..._args: unknown[]) => {
    void _args;
    return { slug: "synthetic-org-slug" };
  }),
  tokenFindUnique: vi.fn(async (..._args: unknown[]) => {
    void _args;
    return null;
  }),
  transaction: vi.fn(),
  // Renders its props, so a test can see whether booking data reached the page.
  manageBooking: vi.fn(
    (props: Record<string, unknown>) => `MANAGE_BOOKING ${JSON.stringify(props)}`,
  ),
}));

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: {
    organization: { findUnique: mocks.orgFindUnique },
    bookingToken: { findUnique: mocks.tokenFindUnique },
    $transaction: mocks.transaction,
  },
  tenantDb: vi.fn(),
}));
vi.mock("@/server/services/booking", () => ({
  getBookingByToken: mocks.getBookingByToken,
  rescheduleBookingViaToken: mocks.reschedule,
  cancelBookingViaToken: mocks.cancel,
  BookingError: class BookingError extends Error {
    constructor(
      message: string,
      readonly code: string,
    ) {
      super(message);
    }
  },
}));
// Only loaded by the real booking service in the missing-token case.
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/server/services/workflow-events", () => ({
  emitWorkflowEvent: vi.fn(async () => undefined),
}));
// Rate limiting is covered by rate-limit-direct-sites-fail-closed.test.ts; here it always allows.
vi.mock("@/server/security/rate-limit", () => ({ rateLimitRefusal: vi.fn(async () => null) }));
vi.mock("@/server/services/booking-notifications", () => ({
  sendBookingLifecycleNotifications: mocks.notify,
}));
vi.mock("@/server/services/reminders", () => ({ scheduleEventReminders: mocks.reminders }));
vi.mock("next-intl/server", () => ({
  getTranslations: vi.fn(async () => (key: string) => `t(${key})`),
}));
vi.mock("@/components/calendar/manage-booking", () => ({ ManageBooking: mocks.manageBooking }));

import ManageBookingPage from "@/app/[locale]/(public)/booking/manage/[token]/page";
import { DELETE, GET, POST } from "@/app/api/v1/booking/manage/[token]/route";
import { BookingTokenError } from "@/server/services/booking-tokens";

const TOKEN = "synthetic-manage-token-0000000000";
const NEW_START = "2026-11-04T09:00:00.000Z";

const BOOKING = {
  id: "bk-synthetic",
  organizationId: "org-synthetic",
  status: "CONFIRMED",
  startsAt: new Date("2026-11-03T09:00:00.000Z"),
  endsAt: new Date("2026-11-03T10:00:00.000Z"),
  guestName: "Synthetic Guestperson",
  guestEmail: "synthetic.guest@example.test",
  guestTimezone: "Europe/Helsinki",
  bookingType: {
    name: "Synthetic Strategy Session",
    slug: "synthetic-strategy",
    location: "Synthetic Room 42",
    durationMinutes: 60,
    durationOptions: [60],
  },
};

// Every value that would only appear if booking data leaked into the output.
const BOOKING_FIELDS = [
  BOOKING.id,
  BOOKING.organizationId,
  BOOKING.guestName,
  BOOKING.guestEmail,
  BOOKING.bookingType.name,
  BOOKING.bookingType.slug,
  BOOKING.bookingType.location,
  "2026-11-03T09",
  "2026-11-03T10",
  "synthetic-org-slug",
];

const TOKEN_CODES = ["invalid", "expired", "used"] as const;

function expectNoBookingFields(output: string) {
  for (const field of BOOKING_FIELDS) expect(output).not.toContain(field);
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("manage page: a link that doesn't resolve", () => {
  async function render(token = TOKEN) {
    return renderToStaticMarkup(await ManageBookingPage({ params: Promise.resolve({ token }) }));
  }

  it("control: a resolving link renders ManageBooking with the booking and its organization", async () => {
    // Proves the negative cases below can see a leak: on success the fields do appear.
    mocks.getBookingByToken.mockResolvedValue(BOOKING);
    const html = await render();
    expect(html).toContain("MANAGE_BOOKING");
    expect(html).toContain(BOOKING.bookingType.name);
    expect(html).toContain("synthetic-org-slug");
    expect(html).toContain("2026-11-03T09");
    expect(mocks.orgFindUnique).toHaveBeenCalledWith({
      where: { id: BOOKING.organizationId },
      select: { slug: true },
    });
  });

  const cases: Array<[string, () => Error, "manage.expired" | "manage.invalid"]> = [
    [
      "BookingTokenError invalid",
      () => new BookingTokenError("Invalid token", "invalid"),
      "manage.invalid",
    ],
    [
      "BookingTokenError expired",
      () => new BookingTokenError("Token expired", "expired"),
      "manage.expired",
    ],
    [
      "BookingTokenError used",
      () => new BookingTokenError("Token already used", "used"),
      "manage.invalid",
    ],
    // Any other failure (e.g. the database) must look like an invalid link,
    // and its message (here carrying guest data) must never be rendered.
    [
      "a non-token error",
      () => new Error(`lookup failed for ${BOOKING.guestEmail}`),
      "manage.invalid",
    ],
  ];

  it.each(cases)(
    "%s: shows only the generic card, no ManageBooking, no booking data, no organization lookup",
    async (_label, makeError, expectedKey) => {
      void _label;
      mocks.getBookingByToken.mockRejectedValue(makeError());
      const html = await render();

      expect(mocks.getBookingByToken).toHaveBeenCalledWith(TOKEN);
      expect(html).toContain("t(manage.invalidTitle)");
      expect(html).toContain(`t(${expectedKey})`);
      const otherKey = expectedKey === "manage.expired" ? "manage.invalid" : "manage.expired";
      expect(html).not.toContain(`t(${otherKey})`);
      expect(html).not.toContain("MANAGE_BOOKING");
      expect(mocks.manageBooking).not.toHaveBeenCalled();
      expectNoBookingFields(html);
      expect(mocks.orgFindUnique).not.toHaveBeenCalled();
    },
  );
});

describe("manage API: a link that doesn't resolve", () => {
  function request(method: "GET" | "POST" | "DELETE") {
    const body =
      method === "POST"
        ? JSON.stringify({ startsAt: NEW_START })
        : method === "DELETE"
          ? JSON.stringify({ reason: "synthetic reason" })
          : undefined;
    return new Request("http://localhost/api/v1/booking/manage/x", {
      method,
      headers: { "Content-Type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body,
    });
  }

  const routes = {
    GET: { handler: GET, service: mocks.getBookingByToken },
    POST: { handler: POST, service: mocks.reschedule },
    DELETE: { handler: DELETE, service: mocks.cancel },
  } as const;

  function call(method: keyof typeof routes, token = TOKEN) {
    return routes[method].handler(request(method), { params: Promise.resolve({ token }) });
  }

  function expectNoSideEffects() {
    expect(mocks.notify).not.toHaveBeenCalled();
    expect(mocks.reminders).not.toHaveBeenCalled();
  }

  const methodCodePairs = (["GET", "POST", "DELETE"] as const).flatMap((method) =>
    TOKEN_CODES.map((code) => [method, code] as const),
  );

  it.each(methodCodePairs)(
    "%s with a %s token: 404, body exactly { error: code }, no notification or reminder",
    async (method, code) => {
      routes[method].service.mockRejectedValue(new BookingTokenError("synthetic", code));
      const res = await call(method);

      expect(res.status).toBe(404);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: code });
      expectNoBookingFields(text);
      // The token from the URL is what reached the service (no bypass).
      expect(routes[method].service).toHaveBeenCalledWith(
        TOKEN,
        ...(method === "POST" ? [NEW_START] : method === "DELETE" ? ["synthetic reason"] : []),
      );
      expectNoSideEffects();
    },
  );

  it.each(["GET", "POST", "DELETE"] as const)(
    "%s with an unexpected service error: 500 { error: 'failed' }, no message or booking data",
    async (method) => {
      routes[method].service.mockRejectedValue(
        new Error(`db exploded for ${BOOKING.guestEmail} on ${BOOKING.id}`),
      );
      const res = await call(method);

      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: "failed" });
      expect(text).not.toContain("db exploded");
      expectNoBookingFields(text);
      expectNoSideEffects();
    },
  );

  it.each(["GET", "POST", "DELETE"] as const)(
    "%s with an empty token: the real resolver refuses it as invalid before any database query",
    async (method) => {
      // The route passes the param through unchanged; the guard is
      // resolveToken's length check, reached through the real service here.
      const actual = await vi.importActual<typeof BookingService>("@/server/services/booking");
      const realService = {
        GET: actual.getBookingByToken,
        POST: actual.rescheduleBookingViaToken,
        DELETE: actual.cancelBookingViaToken,
      }[method];
      routes[method].service.mockImplementationOnce(realService as never);

      const res = await call(method, "");

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "invalid" });
      expect(routes[method].service).toHaveBeenCalledWith(
        "",
        ...(method === "GET" ? [] : [expect.anything()]),
      );
      expect(mocks.tokenFindUnique).not.toHaveBeenCalled();
      expect(mocks.transaction).not.toHaveBeenCalled();
      expectNoSideEffects();
    },
  );
});
