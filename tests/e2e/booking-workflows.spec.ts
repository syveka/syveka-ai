import { randomBytes } from "node:crypto";
import { test, expect, type APIRequestContext } from "@playwright/test";
import { Client } from "pg";
import {
  BOOKING_TYPE_NAME,
  BOOKING_TYPE_SLUG,
  FIXTURE_MARKER,
  FIXTURE_ORGS,
  TRIGGER_PAYLOAD_KEYS,
  activitySubject,
  pickJourneySlots,
  subAddress,
  workflowName,
  type BookingTrigger,
  type FixtureOrgKey,
} from "../../scripts/e2e-booking-workflow-fixture-config";

/**
 * Opt-in staging journey: a real public booking, rescheduled and canceled
 * through the guest's own manage token, drives the real booking.created,
 * booking.rescheduled and booking.canceled workflows (queue → run-workflow
 * job → CRM step) on the stable staging host. Each run is checked in the
 * database: the stored trigger payload (exact keys, contactId, booking
 * metadata, no guest notes), the run's CRM note on the right contact, and
 * that organization B's workflows never touch organization A's booking or
 * contact, and the reverse.
 *
 * Needs the fixture from scripts/ensure-e2e-booking-workflow-fixtures.ts
 * (`prepare` before, `cleanup` after), E2E_BOOKING_WORKFLOWS=1,
 * E2E_DIRECT_URL (staging only) and E2E_USER_EMAIL, whose `+` sub-addresses
 * receive every guest and owner email. Workflow steps are CRM notes only, so
 * the journey sends no workflow email, SMS or AI request; the booking itself
 * sends its normal confirmation/reschedule/cancellation emails to that test
 * mailbox.
 *
 * Must run against the stable host (NEXT_PUBLIC_APP_URL): queued jobs call
 * that host, so a Preview URL would run the workflows on a different build.
 */

const ENABLED = process.env.E2E_BOOKING_WORKFLOWS === "1";
const RUN_TIMEOUT_MS = 120_000;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`booking workflow journey requires ${name}`);
  return value;
}

type RunRow = {
  id: string;
  organization_id: string;
  workflow_name: string;
  status: string;
  trigger_data: Record<string, unknown>;
  error: string | null;
};

async function withDb<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: requireEnv("E2E_DIRECT_URL") });
  await db.connect();
  try {
    return await fn(db);
  } finally {
    await db.end();
  }
}

async function fixtureOrgIds(): Promise<Record<FixtureOrgKey, string>> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ id: string; slug: string; marker: string | null }>(
      "select id, slug, settings->>'e2eFixture' as marker from public.organizations where slug = any($1::text[])",
      [FIXTURE_ORGS.map((o) => o.slug)],
    );
    const ids = {} as Record<FixtureOrgKey, string>;
    for (const org of FIXTURE_ORGS) {
      const row = rows.find((r) => r.slug === org.slug);
      if (!row || row.marker !== FIXTURE_MARKER) {
        throw new Error(`fixture organization ${org.key} is missing; run the fixture script first`);
      }
      ids[org.key] = row.id;
    }
    return ids;
  });
}

async function runsFor(orgId: string): Promise<RunRow[]> {
  return withDb(async (db) => {
    const { rows } = await db.query<RunRow>(
      `select r.id, r.organization_id, w.name as workflow_name, r.status, r.trigger_data, r.error
       from public.workflow_runs r join public.workflows w on w.id = r.workflow_id
       where r.organization_id = $1 order by r.started_at`,
      [orgId],
    );
    return rows;
  });
}

/** Polls until the workflow for `trigger` has finished a run for `bookingId`. */
async function waitForRun(
  orgId: string,
  trigger: BookingTrigger,
  bookingId: string,
): Promise<RunRow> {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  for (;;) {
    const run = (await runsFor(orgId)).find(
      (r) => r.workflow_name === workflowName(trigger) && r.trigger_data.bookingId === bookingId,
    );
    if (run && run.status !== "RUNNING") return run;
    if (Date.now() > deadline) {
      throw new Error(
        `no finished ${trigger} run within ${RUN_TIMEOUT_MS / 1000}s ` +
          `(found: ${run ? run.status : "none"}). Check the queue (QStash) configuration of the stable host.`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
  }
}

async function contactFor(orgId: string, email: string): Promise<string> {
  return withDb(async (db) => {
    const { rows } = await db.query<{ id: string }>(
      "select id from public.contacts where organization_id = $1 and lower(email) = lower($2) and deleted_at is null",
      [orgId, email],
    );
    expect(rows, "exactly one contact for the guest").toHaveLength(1);
    return rows[0]!.id;
  });
}

async function activitiesFor(orgId: string, subject: string) {
  return withDb(async (db) => {
    const { rows } = await db.query<{
      organization_id: string;
      contact_id: string;
      body: string | null;
    }>(
      "select organization_id, contact_id, body from public.activities where organization_id = $1 and subject = $2",
      [orgId, subject],
    );
    return rows;
  });
}

async function slotsFor(request: APIRequestContext, orgSlug: string) {
  const from = new Date(Date.now() + 2 * 86_400_000);
  const to = new Date(Date.now() + 9 * 86_400_000);
  const res = await request.get(
    `/api/v1/booking/${orgSlug}/${BOOKING_TYPE_SLUG}/slots?from=${from.toISOString()}&to=${to.toISOString()}`,
  );
  expect(res.status(), "slots").toBe(200);
  return pickJourneySlots(((await res.json()) as { slots: string[] }).slots);
}

async function book(
  request: APIRequestContext,
  orgSlug: string,
  input: { startsAt: string; name: string; email: string; notes: string },
): Promise<{ bookingId: string; manageToken: string }> {
  const res = await request.post(`/api/v1/booking/${orgSlug}/${BOOKING_TYPE_SLUG}`, {
    data: { ...input, timezone: "UTC", consent: true, locale: "en", website: "" },
  });
  expect(res.status(), "booking").toBe(200);
  return (await res.json()) as { bookingId: string; manageToken: string };
}

function expectPayload(run: RunRow, trigger: BookingTrigger, expected: Record<string, unknown>) {
  expect(run.status, `${trigger} run status (error: ${run.error ?? "none"})`).toBe("SUCCEEDED");
  expect(Object.keys(run.trigger_data).sort()).toEqual([...TRIGGER_PAYLOAD_KEYS[trigger]]);
  expect(run.trigger_data).toEqual(expected);
}

test.use({ trace: "off", screenshot: "off", video: "off" });

test.describe("booking → workflow journey on the stable staging host (opt-in)", () => {
  test.describe.configure({ mode: "serial" });
  test.use({ storageState: { cookies: [], origins: [] } });

  test.beforeEach(() => {
    test.skip(!ENABLED, "Opt-in: set E2E_BOOKING_WORKFLOWS=1 with the fixture prepared.");
    test.skip(test.info().project.name !== "desktop", "Runs once (desktop): it books real slots.");
  });

  test("create, reschedule and cancel run each workflow once, on the right contact, in one org only", async ({
    request,
  }) => {
    test.setTimeout(8 * 60_000);
    const e2eEmail = requireEnv("E2E_USER_EMAIL");
    const tag = randomBytes(4).toString("hex");
    const secretNote = `E2E-PRIVATE-NOTE-${tag}`;
    const orgIds = await fixtureOrgIds();
    const [orgA, orgB] = FIXTURE_ORGS;
    const guestA = {
      name: `E2E Guest A ${tag}`,
      email: subAddress(e2eEmail, `booking-guest-a-${tag}`),
    };
    const guestB = {
      name: `E2E Guest B ${tag}`,
      email: subAddress(e2eEmail, `booking-guest-b-${tag}`),
    };

    // Create one booking in each organization.
    const slotsA = await slotsFor(request, orgA.slug);
    const slotsB = await slotsFor(request, orgB.slug);
    const bookedA = await book(request, orgA.slug, {
      startsAt: slotsA.first,
      ...guestA,
      notes: secretNote,
    });
    const bookedB = await book(request, orgB.slug, {
      startsAt: slotsB.first,
      ...guestB,
      notes: secretNote,
    });

    const createdA = await waitForRun(orgIds.a, "booking.created", bookedA.bookingId);
    const createdB = await waitForRun(orgIds.b, "booking.created", bookedB.bookingId);
    const contactA = await contactFor(orgIds.a, guestA.email);
    const contactB = await contactFor(orgIds.b, guestB.email);
    expectPayload(createdA, "booking.created", {
      bookingId: bookedA.bookingId,
      contactId: contactA,
      bookingType: BOOKING_TYPE_NAME,
      guestName: guestA.name,
      guestEmail: guestA.email,
      startsAt: slotsA.first,
    });
    expectPayload(createdB, "booking.created", {
      bookingId: bookedB.bookingId,
      contactId: contactB,
      bookingType: BOOKING_TYPE_NAME,
      guestName: guestB.name,
      guestEmail: guestB.email,
      startsAt: slotsB.first,
    });

    // Reschedule A through its manage token: a new booking id, same contact.
    const rescheduled = await request.post(`/api/v1/booking/manage/${bookedA.manageToken}`, {
      data: { startsAt: slotsA.later, timezone: "UTC" },
    });
    expect(rescheduled.status(), "reschedule").toBe(200);
    const movedA = (await rescheduled.json()) as { bookingId: string; manageToken: string };
    expect(movedA.bookingId).not.toBe(bookedA.bookingId);
    const rescheduledA = await waitForRun(orgIds.a, "booking.rescheduled", movedA.bookingId);
    expectPayload(rescheduledA, "booking.rescheduled", {
      bookingId: movedA.bookingId,
      previousBookingId: bookedA.bookingId,
      contactId: contactA,
      bookingType: BOOKING_TYPE_NAME,
      guestName: guestA.name,
      guestEmail: guestA.email,
      startsAt: slotsA.later,
      previousStartsAt: slotsA.first,
    });

    // Cancel the moved booking with a reason.
    const reason = `E2E cancel ${tag}`;
    const canceled = await request.delete(`/api/v1/booking/manage/${movedA.manageToken}`, {
      data: { reason },
    });
    expect(canceled.status(), "cancel").toBe(200);
    const canceledA = await waitForRun(orgIds.a, "booking.canceled", movedA.bookingId);
    expectPayload(canceledA, "booking.canceled", {
      bookingId: movedA.bookingId,
      contactId: contactA,
      bookingType: BOOKING_TYPE_NAME,
      guestName: guestA.name,
      guestEmail: guestA.email,
      startsAt: slotsA.later,
      reason,
    });

    // Each run's CRM note sits on its own org's guest contact.
    const expectedNotes: Array<[string, string, BookingTrigger, string]> = [
      [orgIds.a, contactA, "booking.created", bookedA.bookingId],
      [orgIds.a, contactA, "booking.rescheduled", movedA.bookingId],
      [orgIds.a, contactA, "booking.canceled", movedA.bookingId],
      [orgIds.b, contactB, "booking.created", bookedB.bookingId],
    ];
    for (const [orgId, contactId, trigger, bookingId] of expectedNotes) {
      const notes = await activitiesFor(orgId, activitySubject(trigger, bookingId));
      expect(notes, `${trigger} note for ${bookingId}`).toEqual([
        expect.objectContaining({ organization_id: orgId, contact_id: contactId }),
      ]);
      expect(notes[0]!.body).toContain(`type=${BOOKING_TYPE_NAME}`);
    }

    // Tenant isolation and no duplicate runs: A has exactly its three runs,
    // B exactly its one, and neither org ever ran on the other's booking.
    const runsA = await runsFor(orgIds.a);
    const runsB = await runsFor(orgIds.b);
    expect(runsA.map((r) => r.workflow_name).sort()).toEqual(
      ["booking.canceled", "booking.created", "booking.rescheduled"].map((t) =>
        workflowName(t as BookingTrigger),
      ),
    );
    expect(runsB.map((r) => r.workflow_name)).toEqual([workflowName("booking.created")]);
    const bookingIdsB = runsB.map((r) => r.trigger_data.bookingId);
    for (const id of [bookedA.bookingId, movedA.bookingId]) expect(bookingIdsB).not.toContain(id);
    expect(runsA.map((r) => r.trigger_data.bookingId)).not.toContain(bookedB.bookingId);
    expect(runsB.map((r) => r.trigger_data.contactId)).not.toContain(contactA);
    expect(
      (await activitiesFor(orgIds.b, activitySubject("booking.created", bookedA.bookingId))).length,
    ).toBe(0);

    // The guest's free-form notes never reach a workflow payload or a CRM note.
    const everything = JSON.stringify([...runsA, ...runsB]);
    expect(everything).not.toContain(secretNote);
    for (const [orgId, , trigger, bookingId] of expectedNotes) {
      for (const note of await activitiesFor(orgId, activitySubject(trigger, bookingId))) {
        expect(note.body ?? "").not.toContain(secretNote);
      }
    }
  });
});
