/**
 * Shared definition of the staging booking → workflow E2E fixture, used by
 * scripts/ensure-e2e-booking-workflow-fixtures.ts (which provisions it) and
 * tests/e2e/booking-workflows.spec.ts (which drives and checks it). Pure: no
 * I/O, no `@/` aliases (standalone scripts in this repo avoid them), so both
 * sides and the unit tests read exactly the same values.
 *
 * Two organizations, A and B, each with:
 * - a dedicated owner account (a `+booking-owner-<org>` sub-address of the
 *   staging E2E mailbox, so every notification lands in that test inbox);
 * - an always-open UTC availability schedule and one public booking type;
 * - one active workflow per booking trigger, whose only step is an internal
 *   CRM note on the trigger's contact (no email, SMS or AI provider call);
 * - an ACTIVE_WORKFLOWS entitlement grant, because the FREE plan runs none.
 *
 * Every row the fixture owns is found by these fixed identifiers, so
 * re-running it updates in place instead of adding duplicates.
 */

export const FIXTURE_MARKER = "booking-workflows";
export const FIXTURE_OWNER_APP_METADATA = "booking-workflow-owner";
export const FIXTURE_GRANT_REASON = "Staging E2E booking-workflow fixture (test-only)";
export const FIXTURE_GRANT_AMOUNT = 5;
export const BOOKING_TYPE_SLUG = "e2e-intro";
export const BOOKING_TYPE_NAME = "E2E Intro";
export const SCHEDULE_NAME = "E2E always open (UTC)";

export const FIXTURE_ORGS = [
  { key: "a", slug: "syveka-e2e-booking-a", name: "Syveka E2E Booking A" },
  { key: "b", slug: "syveka-e2e-booking-b", name: "Syveka E2E Booking B" },
] as const;

export type FixtureOrgKey = (typeof FIXTURE_ORGS)[number]["key"];

export const BOOKING_TRIGGERS = [
  "booking.created",
  "booking.rescheduled",
  "booking.canceled",
] as const;
export type BookingTrigger = (typeof BOOKING_TRIGGERS)[number];

export function workflowName(trigger: BookingTrigger): string {
  return `E2E ${trigger}`;
}

/** The subject the fixture's CRM step writes, so a run's effect can be found exactly. */
export function activitySubject(trigger: BookingTrigger, bookingId: string): string {
  return `E2E ${trigger} ${bookingId}`;
}

/**
 * One internal, deterministic step: a CRM note on `trigger.contactId`. Its
 * body echoes the booking metadata the trigger carried, which the spec
 * compares with the stored trigger payload.
 */
export function workflowSteps(trigger: BookingTrigger): unknown[] {
  return [
    {
      id: "note",
      type: "crm.create_activity",
      contactIdVar: "trigger.contactId",
      activityType: "NOTE",
      subject: `E2E ${trigger} {{trigger.bookingId}}`,
      body: "type={{trigger.bookingType}};starts={{trigger.startsAt}};previous={{trigger.previousStartsAt}};reason={{trigger.reason}}",
    },
  ];
}

export function subAddress(email: string, tag: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) {
    throw new Error("E2E_USER_EMAIL is not a valid email address");
  }
  return `${email.slice(0, at)}+${tag}@${email.slice(at + 1)}`;
}

export function ownerEmail(e2eEmail: string, org: FixtureOrgKey): string {
  return subAddress(e2eEmail, `booking-owner-${org}`);
}

/** Seven all-day UTC rules: any future slot inside the booking window is open. */
export const ALWAYS_OPEN_RULES = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({
  weekday,
  startMinute: 0,
  endMinute: 24 * 60,
}));

/**
 * Two slots for one journey: the first offered slot, and a reschedule target
 * at least a day later, so the two can never overlap.
 */
export function pickJourneySlots(slots: string[]): { first: string; later: string } {
  const sorted = [...slots].sort();
  const first = sorted[0];
  if (!first) throw new Error("no bookable slots offered");
  const later = sorted.find((s) => Date.parse(s) >= Date.parse(first) + 24 * 3_600_000);
  if (!later) throw new Error("no reschedule slot at least a day after the first");
  return { first, later };
}

/** Exact trigger payload keys per trigger, as emitted by src/server/services/booking.ts. */
export const TRIGGER_PAYLOAD_KEYS: Record<BookingTrigger, readonly string[]> = {
  "booking.created": [
    "bookingId",
    "bookingType",
    "contactId",
    "guestEmail",
    "guestName",
    "startsAt",
  ],
  "booking.rescheduled": [
    "bookingId",
    "bookingType",
    "contactId",
    "guestEmail",
    "guestName",
    "previousBookingId",
    "previousStartsAt",
    "startsAt",
  ],
  "booking.canceled": [
    "bookingId",
    "bookingType",
    "contactId",
    "guestEmail",
    "guestName",
    "reason",
    "startsAt",
  ],
};
