/**
 * Staging-only fixtures for the opt-in booking → workflow E2E spec
 * (tests/e2e/booking-workflows.spec.ts). See
 * scripts/e2e-booking-workflow-fixture-config.ts for what the fixture is.
 *
 * Usage: ensure-e2e-booking-workflow-fixtures.ts prepare|cleanup
 *
 * - `prepare` creates or updates, in place, the two fixture owners, the two
 *   fixture organizations and their schedule, booking type, workflows and
 *   workflow entitlement grant, then removes any booking data a previous run
 *   left behind. Re-running it never adds duplicates.
 * - `cleanup` removes only the booking data the journey creates inside the
 *   two fixture organizations (workflow runs, CRM activities, bookings,
 *   calendar events, contacts, notifications), keeping the fixture itself.
 *
 * Fails closed: an organization with a fixture slug is only touched when it
 * carries the fixture marker and its owner is the fixture account, and an
 * owner account is only used when it carries the fixture app_metadata.
 * Otherwise nothing is changed. Owner accounts are created with a random
 * password that is never stored or printed, and email pre-confirmed, so no
 * email is sent. Never logs an email, user id, password or token.
 */
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import {
  ALWAYS_OPEN_RULES,
  BOOKING_TRIGGERS,
  BOOKING_TYPE_NAME,
  BOOKING_TYPE_SLUG,
  FIXTURE_GRANT_AMOUNT,
  FIXTURE_GRANT_REASON,
  FIXTURE_MARKER,
  FIXTURE_ORGS,
  FIXTURE_OWNER_APP_METADATA,
  SCHEDULE_NAME,
  ownerEmail,
  workflowName,
  workflowSteps,
} from "./e2e-booking-workflow-fixture-config";

const LOG_PREFIX = "ensure-e2e-booking-workflow-fixtures";

function fail(message: string): never {
  throw new Error(`${LOG_PREFIX}: ${message}`);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`missing required env var ${name}`);
  return value;
}

type Db = Client;

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** The fixture owner's id, creating the account on first use. */
async function ensureOwner(db: Db, admin: SupabaseClient, email: string): Promise<string> {
  const { rows } = await db.query<{ id: string; fixture: string | null }>(
    "select id, raw_app_meta_data->>'e2e_fixture' as fixture from auth.users where lower(email) = lower($1)",
    [email],
  );
  if (rows.length > 1) fail("ambiguous fixture owner lookup");
  let userId = rows[0]?.id;
  if (userId && rows[0]!.fixture !== FIXTURE_OWNER_APP_METADATA) {
    fail("an account with a fixture owner address exists without the fixture marker; refusing");
  }
  if (!userId) {
    const created = await admin.auth.admin.createUser({
      email,
      password: randomBytes(24).toString("base64url"),
      email_confirm: true,
      app_metadata: { e2e_fixture: FIXTURE_OWNER_APP_METADATA },
      user_metadata: { full_name: "E2E Booking Owner" },
    });
    if (created.error || !created.data.user) fail("failed to create a fixture owner account");
    userId = created.data.user.id;
    console.log(`${LOG_PREFIX}: created a fixture owner account.`);
  }
  // public.users is filled by the handle_new_user() trigger on auth.users.
  for (let attempt = 0; attempt < 20; attempt++) {
    const synced = await db.query("select 1 from public.users where id = $1", [userId]);
    if (synced.rowCount) return userId;
    await sleep(500);
  }
  fail("fixture owner never appeared in public.users");
}

/** The fixture organization's id, creating it on first use; refuses a non-fixture org. */
async function ensureOrg(
  db: Db,
  org: (typeof FIXTURE_ORGS)[number],
  ownerId: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string; marker: string | null; deleted: boolean }>(
    "select id, settings->>'e2eFixture' as marker, deleted_at is not null as deleted from public.organizations where slug = $1",
    [org.slug],
  );
  const existing = rows[0];
  if (existing) {
    if (existing.marker !== FIXTURE_MARKER || existing.deleted) {
      fail("an organization with a fixture slug is not a live fixture organization; refusing");
    }
    const owner = await db.query(
      "select 1 from public.organization_members where organization_id = $1 and user_id = $2 and role = 'OWNER'",
      [existing.id, ownerId],
    );
    if (!owner.rowCount) fail("a fixture organization is not owned by its fixture owner; refusing");
    return existing.id;
  }

  await db.query("begin");
  try {
    const created = await db.query<{ id: string }>(
      `insert into public.organizations (name, slug, "defaultLocale", settings, updated_at)
       values ($1, $2, 'EN', $3::jsonb, now()) returning id`,
      [org.name, org.slug, JSON.stringify({ e2eFixture: FIXTURE_MARKER })],
    );
    const orgId = created.rows[0]!.id;
    await db.query(
      `insert into public.organization_members (organization_id, user_id, role)
       values ($1, $2, 'OWNER')`,
      [orgId, ownerId],
    );
    await db.query(
      `insert into public.subscriptions (organization_id, plan, status, seats, updated_at)
       values ($1, 'FREE', 'ACTIVE', 1, now())`,
      [orgId],
    );
    await db.query("commit");
    console.log(`${LOG_PREFIX}: created fixture organization ${org.key.toUpperCase()}.`);
    return orgId;
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

async function ensureScheduleAndBookingType(db: Db, orgId: string, ownerId: string): Promise<void> {
  await db.query("begin");
  try {
    const found = await db.query<{ id: string }>(
      "select id from public.availability_schedules where organization_id = $1 and user_id = $2 and name = $3",
      [orgId, ownerId, SCHEDULE_NAME],
    );
    let scheduleId = found.rows[0]?.id;
    if (!scheduleId) {
      const created = await db.query<{ id: string }>(
        `insert into public.availability_schedules (organization_id, user_id, name, timezone, is_default, updated_at)
         values ($1, $2, $3, 'UTC', true, now()) returning id`,
        [orgId, ownerId, SCHEDULE_NAME],
      );
      scheduleId = created.rows[0]!.id;
    } else {
      await db.query(
        "update public.availability_schedules set timezone = 'UTC', is_default = true, updated_at = now() where id = $1",
        [scheduleId],
      );
    }
    await db.query("delete from public.availability_rules where schedule_id = $1", [scheduleId]);
    await db.query("delete from public.availability_overrides where schedule_id = $1", [
      scheduleId,
    ]);
    for (const rule of ALWAYS_OPEN_RULES) {
      await db.query(
        "insert into public.availability_rules (schedule_id, weekday, start_minute, end_minute) values ($1, $2, $3, $4)",
        [scheduleId, rule.weekday, rule.startMinute, rule.endMinute],
      );
    }

    // Upsert on the (organization_id, slug) unique key: same row every run.
    await db.query(
      `insert into public.booking_types
         (organization_id, owner_id, schedule_id, slug, name, duration_minutes, duration_options,
          location_type, buffer_before_minutes, buffer_after_minutes, min_notice_minutes,
          max_window_days, requires_consent, is_active, deleted_at, updated_at)
       values ($1, $2, $3, $4, $5, 30, '{30}', 'VIDEO', 0, 0, 60, 30, true, true, null, now())
       on conflict (organization_id, slug) do update set
         owner_id = excluded.owner_id, schedule_id = excluded.schedule_id, name = excluded.name,
         duration_minutes = 30, duration_options = '{30}', buffer_before_minutes = 0,
         buffer_after_minutes = 0, min_notice_minutes = 60, max_window_days = 30,
         requires_consent = true, is_active = true, deleted_at = null, updated_at = now()`,
      [orgId, ownerId, scheduleId, BOOKING_TYPE_SLUG, BOOKING_TYPE_NAME],
    );
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

async function ensureWorkflows(db: Db, orgId: string, ownerId: string): Promise<void> {
  for (const trigger of BOOKING_TRIGGERS) {
    const name = workflowName(trigger);
    const triggerJson = JSON.stringify({ type: trigger });
    const stepsJson = JSON.stringify(workflowSteps(trigger));
    const found = await db.query<{ id: string }>(
      "select id from public.workflows where organization_id = $1 and name = $2 order by created_at",
      [orgId, name],
    );
    if (found.rows.length > 1)
      fail("duplicate fixture workflows; refusing to guess which is current");
    if (found.rows[0]) {
      await db.query(
        `update public.workflows set trigger = $2::jsonb, steps = $3::jsonb, is_active = true, updated_at = now()
         where id = $1`,
        [found.rows[0].id, triggerJson, stepsJson],
      );
    } else {
      await db.query(
        `insert into public.workflows (organization_id, created_by_id, name, trigger, steps, is_active, updated_at)
         values ($1, $2, $3, $4::jsonb, $5::jsonb, true, now())`,
        [orgId, ownerId, name, triggerJson, stepsJson],
      );
    }
  }
}

async function ensureWorkflowGrant(db: Db, orgId: string, ownerId: string): Promise<void> {
  const active = await db.query(
    `select 1 from public.entitlement_grants
     where organization_id = $1 and metric = 'ACTIVE_WORKFLOWS' and reason = $2
       and revoked_at is null and (expires_at is null or expires_at > now())`,
    [orgId, FIXTURE_GRANT_REASON],
  );
  if (active.rowCount) return;
  await db.query(
    `insert into public.entitlement_grants (organization_id, metric, amount, reason, granted_by_user_id)
     values ($1, 'ACTIVE_WORKFLOWS', $2, $3, $4)`,
    [orgId, FIXTURE_GRANT_AMOUNT, FIXTURE_GRANT_REASON, ownerId],
  );
}

/** Removes what a journey creates, only inside the given fixture organizations. */
async function clearJourneyData(db: Db, orgIds: string[]): Promise<void> {
  await db.query("begin");
  try {
    for (const table of [
      "workflow_runs",
      "activities",
      "bookings",
      "calendar_events",
      "contacts",
      "notifications",
    ]) {
      await db.query(`delete from public.${table} where organization_id = any($1::uuid[])`, [
        orgIds,
      ]);
    }
    await db.query("commit");
  } catch (error) {
    await db.query("rollback");
    throw error;
  }
}

/** Fixture org ids for cleanup, without creating anything; refuses non-fixture orgs. */
async function existingFixtureOrgIds(db: Db): Promise<string[]> {
  const { rows } = await db.query<{ id: string; marker: string | null }>(
    "select id, settings->>'e2eFixture' as marker from public.organizations where slug = any($1::text[])",
    [FIXTURE_ORGS.map((o) => o.slug)],
  );
  if (rows.some((r) => r.marker !== FIXTURE_MARKER)) {
    fail("an organization with a fixture slug is not a fixture organization; refusing");
  }
  return rows.map((r) => r.id);
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (mode !== "prepare" && mode !== "cleanup") {
    fail("usage: ensure-e2e-booking-workflow-fixtures.ts prepare|cleanup");
  }

  const db = new Client({ connectionString: requireEnv("DIRECT_URL") });
  await db.connect();
  try {
    if (mode === "cleanup") {
      const orgIds = await existingFixtureOrgIds(db);
      if (orgIds.length) await clearJourneyData(db, orgIds);
      console.log(
        `${LOG_PREFIX}: journey data removed from ${orgIds.length} fixture organization(s).`,
      );
      return;
    }

    const e2eEmail = requireEnv("E2E_USER_EMAIL");
    const admin = createClient(
      requireEnv("SUPABASE_URL"),
      requireEnv("SUPABASE_SERVICE_ROLE_KEY"),
      {
        auth: { autoRefreshToken: false, persistSession: false },
      },
    );

    // Refuse before changing anything if either fixture slug is taken by a
    // non-fixture organization (ensureOrg re-checks each one's owner).
    await existingFixtureOrgIds(db);
    const orgIds: string[] = [];
    for (const org of FIXTURE_ORGS) {
      const ownerId = await ensureOwner(db, admin, ownerEmail(e2eEmail, org.key));
      const orgId = await ensureOrg(db, org, ownerId);
      await ensureScheduleAndBookingType(db, orgId, ownerId);
      await ensureWorkflows(db, orgId, ownerId);
      await ensureWorkflowGrant(db, orgId, ownerId);
      orgIds.push(orgId);
    }
    await clearJourneyData(db, orgIds);
    console.log(`${LOG_PREFIX}: fixtures ready.`);
  } finally {
    await db.end();
  }
}

main().catch((error) => {
  // Messages above are fixed strings; anything else is reduced to its name.
  const message =
    error instanceof Error && error.message.startsWith(LOG_PREFIX)
      ? error.message
      : `${LOG_PREFIX}: unexpected ${error instanceof Error ? error.name : "error"}`;
  console.error(message);
  process.exit(1);
});
