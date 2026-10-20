/**
 * Staging-only fixtures for the invitation-acceptance journeys
 * (tests/e2e/invite-journeys.spec.ts, run by
 * .github/workflows/staging-invite-journeys.yml).
 *
 *   preview   Read-only. Counts only: which fixtures exist, their members and
 *             invitations, and what reset would remove. Refuses (exit 1) on
 *             anything reset would refuse.
 *   prepare   Ensures the dedicated identities (pre-confirmed `+invite-e2e-*`
 *             sub-addresses of the staging E2E email, so no email is ever
 *             sent; one fresh random password per run) and the four marked
 *             fixture orgs, restores the baseline memberships, and inserts
 *             one invitation row per journey directly -- never through
 *             inviteMember(), which emails the invitee.
 *   reset     Restores the baseline: deletes the fixture orgs' invitations
 *             and the memberships the journeys created, resets
 *             last_active_org, and rotates the password to an unknown value.
 *   teardown  Deletes the fixture orgs and identities entirely.
 *
 * Every write is limited to marked fixtures (scripts/lib/invite-journeys.ts),
 * and the script refuses to run unless the Supabase API host and the
 * database connection both name the staging project, which differs from
 * production. Never logs an email, id, password or invitation token.
 * Standalone script: no `@/` aliases (see scripts/verify-release-chain.ts).
 */
import { randomBytes } from "node:crypto";
import { appendFileSync } from "node:fs";
import { PrismaClient } from "../src/generated/prisma/client/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createClient } from "@supabase/supabase-js";
import { DEFAULT_PIPELINE_STAGES } from "../src/lib/constants";
import {
  BASELINE_ACTIVE_ORG,
  FixtureRefusal,
  INVITE_FIXTURE_TAG,
  INVITE_ORG_KEYS,
  INVITE_ORGS,
  INVITE_USER_KEYS,
  MAIN_SEAT_GRANT,
  ORG_OWNER,
  READONLY_PAST_DUE_AGE_DAYS,
  assertMarkers,
  assertStagingTarget,
  assertTeardownSafe,
  fixtureEmails,
  invitationRows,
  planReset,
  type FixtureSnapshot,
  type InviteOrgKey,
  type InviteUserKey,
} from "./lib/invite-journeys";

const LOG_PREFIX = "invite-journey-fixtures";

function fail(message: string): never {
  throw new FixtureRefusal(message);
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) fail(`missing required env var ${name}`);
  return value;
}

function log(message: string): void {
  console.log(`${LOG_PREFIX}: ${message}`);
}

function exportMasked(name: string, value: string): void {
  console.log(`::add-mask::${value}`);
  appendFileSync(requireEnv("GITHUB_ENV"), `${name}=${value}\n`, { encoding: "utf8" });
}

function assertTarget(): void {
  assertStagingTarget({
    stagingRef: process.env.STAGING_SUPABASE_PROJECT_REF,
    productionRef: process.env.PRODUCTION_SUPABASE_PROJECT_REF,
    supabaseUrl: process.env.SUPABASE_URL,
    databaseUrl: process.env.DATABASE_URL,
  });
}

function connect(): PrismaClient {
  const databaseUrl = requireEnv("DATABASE_URL");
  if (databaseUrl !== requireEnv("DIRECT_URL")) {
    fail("DATABASE_URL and DIRECT_URL must be the same direct/session connection");
  }
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl }) });
}

function supabaseAdmin() {
  return createClient(requireEnv("SUPABASE_URL"), requireEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

type Admin = ReturnType<typeof supabaseAdmin>;

async function findAuthUser(
  prisma: PrismaClient,
  email: string,
): Promise<{ id: string; marker: string | null } | null> {
  const rows = await prisma.$queryRaw<Array<{ id: string; marker: string | null }>>`
    select id::text as id, raw_app_meta_data->>'e2e_fixture' as marker
    from auth.users where lower(email) = lower(${email})`;
  if (rows.length > 1) fail("ambiguous auth user lookup");
  return rows[0] ?? null;
}

async function snapshot(prisma: PrismaClient): Promise<FixtureSnapshot> {
  const emails = fixtureEmails(requireEnv("E2E_USER_EMAIL"));
  const users = {} as FixtureSnapshot["users"];
  for (const key of INVITE_USER_KEYS) users[key] = await findAuthUser(prisma, emails[key]);
  const wrongTargetHasAccount = (await findAuthUser(prisma, emails.wrongTarget)) !== null;

  const orgs = {} as FixtureSnapshot["orgs"];
  for (const key of INVITE_ORG_KEYS) {
    const org = await prisma.organization.findFirst({
      where: { slug: INVITE_ORGS[key].slug },
      select: { id: true, slug: true, settings: true, deletedAt: true },
    });
    if (org?.deletedAt) fail(`the ${key} fixture org is soft-deleted; refusing to reuse it`);
    orgs[key] = org
      ? {
          id: org.id,
          slug: org.slug,
          marker: (org.settings as Record<string, unknown> | null)?.e2e_fixture,
        }
      : null;
  }

  const orgIds = INVITE_ORG_KEYS.flatMap((k) => (orgs[k] ? [orgs[k]!.id] : []));
  const userIds = INVITE_USER_KEYS.flatMap((k) => (users[k] ? [users[k]!.id] : []));
  const memberships = await prisma.organizationMember.findMany({
    where: { OR: [{ organizationId: { in: orgIds } }, { userId: { in: userIds } }] },
    select: { organizationId: true, userId: true, role: true },
  });
  const invitationCount = await prisma.invitation.count({
    where: { organizationId: { in: orgIds } },
  });
  return { users, wrongTargetHasAccount, orgs, memberships, invitationCount };
}

function describe(s: FixtureSnapshot): void {
  const present = (o: unknown) => (o ? "present" : "absent");
  for (const key of INVITE_USER_KEYS) log(`identity ${key}: ${present(s.users[key])}`);
  log(`wrong-account address has an account: ${s.wrongTargetHasAccount ? "YES" : "no"}`);
  for (const key of INVITE_ORG_KEYS) {
    const org = s.orgs[key];
    const members = org ? s.memberships.filter((m) => m.organizationId === org.id).length : 0;
    log(`org ${key}: ${present(org)}, ${members} member(s)`);
  }
  log(`invitations in fixture orgs: ${s.invitationCount}`);
}

async function preview(prisma: PrismaClient): Promise<void> {
  const s = await snapshot(prisma);
  describe(s);
  assertMarkers(s);
  const complete =
    INVITE_USER_KEYS.every((k) => s.users[k]) && INVITE_ORG_KEYS.every((k) => s.orgs[k]);
  if (!complete) {
    log("fixtures are not all present yet; prepare creates the missing ones.");
    return;
  }
  const plan = planReset(s);
  log(
    `reset would delete ${plan.deleteInvitations} invitation(s) and ` +
      `${plan.deleteMemberships.length} journey membership(s), and restore ` +
      `${plan.createMemberships.length} baseline membership(s).`,
  );
}

async function ensureIdentities(
  prisma: PrismaClient,
  admin: Admin,
  password: string,
): Promise<Record<InviteUserKey, string>> {
  const emails = fixtureEmails(requireEnv("E2E_USER_EMAIL"));
  if (await findAuthUser(prisma, emails.wrongTarget)) {
    fail("the wrong-account address must never have an account, but one exists");
  }
  const ids = {} as Record<InviteUserKey, string>;
  for (const key of INVITE_USER_KEYS) {
    const existing = await findAuthUser(prisma, emails[key]);
    if (existing) {
      if (existing.marker !== INVITE_FIXTURE_TAG) {
        fail(`an account with the ${key} fixture address exists but is not this suite's fixture`);
      }
      const rotated = await admin.auth.admin.updateUserById(existing.id, { password });
      if (rotated.error) fail(`failed to set the ${key} fixture password`);
      ids[key] = existing.id;
    } else {
      // Pre-confirmed: createUser with email_confirm sends no email.
      const created = await admin.auth.admin.createUser({
        email: emails[key],
        password,
        email_confirm: true,
        app_metadata: { e2e_fixture: INVITE_FIXTURE_TAG },
        user_metadata: { full_name: `Invite E2E ${key} (fixture)` },
      });
      if (created.error || !created.data.user) fail(`failed to create the ${key} fixture identity`);
      ids[key] = created.data.user.id;
      log(`created the ${key} fixture identity.`);
    }
  }
  // handle_new_user() mirrors auth.users into public.users.
  for (const key of INVITE_USER_KEYS) {
    let found = false;
    for (let attempt = 0; attempt < 10 && !found; attempt++) {
      found = (await prisma.user.count({ where: { id: ids[key] } })) === 1;
      if (!found) await new Promise((r) => setTimeout(r, 1000));
    }
    if (!found) fail(`the ${key} fixture identity never appeared in public.users`);
  }
  return ids;
}

async function ensureOrgs(
  prisma: PrismaClient,
  userIds: Record<InviteUserKey, string>,
): Promise<Record<InviteOrgKey, string>> {
  const ids = {} as Record<InviteOrgKey, string>;
  for (const key of INVITE_ORG_KEYS) {
    const found = await prisma.organization.findFirst({
      where: { slug: INVITE_ORGS[key].slug },
      select: { id: true, settings: true, deletedAt: true },
    });
    if (found) {
      if (found.deletedAt) fail(`the ${key} fixture org is soft-deleted; refusing to reuse it`);
      if ((found.settings as Record<string, unknown> | null)?.e2e_fixture !== INVITE_FIXTURE_TAG) {
        fail(`an organization with the ${key} fixture slug exists but is not this suite's fixture`);
      }
      ids[key] = found.id;
      continue;
    }
    // Same shape as createOrganization(): owner membership, FREE subscription
    // and the default pipeline, plus this suite's marker.
    const owner = userIds[ORG_OWNER[key]];
    const created = await prisma.$transaction(async (tx) => {
      const org = await tx.organization.create({
        data: {
          name: INVITE_ORGS[key].name,
          slug: INVITE_ORGS[key].slug,
          defaultLocale: "EN",
          settings: { e2e_fixture: INVITE_FIXTURE_TAG },
        },
      });
      await tx.organizationMember.create({
        data: { organizationId: org.id, userId: owner, role: "OWNER" },
      });
      await tx.subscription.create({
        data: { organizationId: org.id, plan: "FREE", status: "ACTIVE", seats: 1 },
      });
      await tx.pipeline.create({
        data: {
          organizationId: org.id,
          name: "Pipeline",
          isDefault: true,
          stages: { create: DEFAULT_PIPELINE_STAGES.map((s) => ({ ...s })) },
        },
      });
      return org;
    });
    ids[key] = created.id;
    log(`created the ${key} fixture organization.`);
  }
  return ids;
}

/**
 * Billing state that drives the journeys: FREE everywhere, one marked seat
 * grant on main, and readonly PAST_DUE for longer than the 14-day grace.
 * Refuses anything that looks like real billing (a Stripe subscription id)
 * or a grant this suite didn't make.
 */
async function ensureBilling(
  prisma: PrismaClient,
  orgIds: Record<InviteOrgKey, string>,
): Promise<void> {
  for (const key of INVITE_ORG_KEYS) {
    const organizationId = orgIds[key];
    const sub = await prisma.subscription.findUnique({ where: { organizationId } });
    if (sub?.stripeSubscriptionId)
      fail(`the ${key} fixture org has a Stripe subscription; refusing`);
    const status = key === "readonly" ? "PAST_DUE" : "ACTIVE";
    await prisma.subscription.upsert({
      where: { organizationId },
      create: { organizationId, plan: "FREE", status, seats: 1 },
      update: { plan: "FREE", status, seats: 1, cancelAtPeriodEnd: false, trialEndsAt: null },
    });

    const grants = await prisma.entitlementGrant.findMany({
      where: {
        organizationId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { metric: true, amount: true, reason: true },
    });
    const ours = (g: (typeof grants)[number]) =>
      key === "main" &&
      g.metric === MAIN_SEAT_GRANT.metric &&
      g.amount === MAIN_SEAT_GRANT.amount &&
      g.reason === MAIN_SEAT_GRANT.reason;
    if (grants.some((g) => !ours(g)) || grants.length > 1) {
      fail(`the ${key} fixture org has an entitlement grant this suite didn't make; refusing`);
    }
    if (key === "main" && grants.length === 0) {
      await prisma.entitlementGrant.create({
        data: {
          organizationId,
          metric: MAIN_SEAT_GRANT.metric,
          amount: MAIN_SEAT_GRANT.amount,
          reason: MAIN_SEAT_GRANT.reason,
        },
      });
    }
  }
  // updated_at is @updatedAt, so the backdating is a separate raw update.
  await prisma.$executeRaw`
    update public.subscriptions
    set updated_at = now() - make_interval(days => ${READONLY_PAST_DUE_AGE_DAYS})
    where organization_id = ${orgIds.readonly}::uuid and status = 'PAST_DUE'`;
}

async function restoreBaseline(
  prisma: PrismaClient,
  admin: Admin,
  s: FixtureSnapshot,
  createInvitations: boolean,
): Promise<void> {
  const plan = planReset(s);
  const orgIds = Object.fromEntries(INVITE_ORG_KEYS.map((k) => [k, s.orgs[k]!.id])) as Record<
    InviteOrgKey,
    string
  >;
  const userIds = Object.fromEntries(INVITE_USER_KEYS.map((k) => [k, s.users[k]!.id])) as Record<
    InviteUserKey,
    string
  >;
  const fixtureOrgIds = Object.values(orgIds);
  const fixtureUserIds = Object.values(userIds);

  await prisma.$transaction(async (tx) => {
    const removedInvitations = await tx.invitation.deleteMany({
      where: { organizationId: { in: fixtureOrgIds } },
    });
    let removedMemberships = 0;
    for (const m of plan.deleteMemberships) {
      const removed = await tx.organizationMember.deleteMany({
        where: {
          organizationId: m.organizationId,
          userId: m.userId,
          role: { not: "OWNER" },
          AND: [{ organizationId: { in: fixtureOrgIds } }, { userId: { in: fixtureUserIds } }],
        },
      });
      removedMemberships += removed.count;
    }
    if (removedMemberships !== plan.deleteMemberships.length) {
      fail("fixture memberships changed while resetting; rolled back");
    }
    for (const m of plan.createMemberships) {
      await tx.organizationMember.create({ data: m });
    }
    log(
      `removed ${removedInvitations.count} invitation(s) and ${removedMemberships} journey ` +
        `membership(s); restored ${plan.createMemberships.length} baseline membership(s).`,
    );

    if (createInvitations) {
      const rows = invitationRows({
        now: new Date(),
        orgIds,
        userIds,
        emails: fixtureEmails(requireEnv("E2E_USER_EMAIL")),
      });
      for (const row of rows) {
        await tx.invitation.create({
          data: {
            organizationId: row.organizationId,
            email: row.email,
            role: row.role,
            invitedById: row.invitedById,
            expiresAt: row.expiresAt,
            status: "PENDING",
          },
        });
      }
      log(`inserted ${rows.length} fixture invitation(s) directly (no email).`);
    }
  });

  for (const key of INVITE_USER_KEYS) {
    const active = BASELINE_ACTIVE_ORG[key];
    const updated = await admin.auth.admin.updateUserById(userIds[key], {
      app_metadata: {
        e2e_fixture: INVITE_FIXTURE_TAG,
        last_active_org: active ? orgIds[active] : null,
      },
    });
    if (updated.error) fail(`failed to reset the ${key} identity's active organization`);
  }
}

async function prepare(prisma: PrismaClient): Promise<void> {
  const admin = supabaseAdmin();
  const password = randomBytes(24).toString("base64url");
  const userIds = await ensureIdentities(prisma, admin, password);
  const orgIds = await ensureOrgs(prisma, userIds);
  await ensureBilling(prisma, orgIds);
  await restoreBaseline(prisma, admin, await snapshot(prisma), true);
  exportMasked("INVITE_E2E_PASSWORD", password);
  log("fixtures ready.");
}

async function reset(prisma: PrismaClient): Promise<void> {
  const admin = supabaseAdmin();
  const s = await snapshot(prisma);
  await restoreBaseline(prisma, admin, s, false);
  // The run's password is no longer valid once the run is over.
  const unknown = randomBytes(24).toString("base64url");
  for (const key of INVITE_USER_KEYS) {
    const rotated = await admin.auth.admin.updateUserById(s.users[key]!.id, { password: unknown });
    if (rotated.error) fail(`failed to rotate the ${key} fixture password`);
  }
  log("baseline restored; fixture passwords rotated to an unknown value.");
}

async function teardown(prisma: PrismaClient): Promise<void> {
  const admin = supabaseAdmin();
  const s = await snapshot(prisma);
  describe(s);
  assertTeardownSafe(s);
  const orgIds = INVITE_ORG_KEYS.flatMap((k) => (s.orgs[k] ? [s.orgs[k]!.id] : []));
  const deleted = await prisma.organization.deleteMany({
    where: {
      id: { in: orgIds },
      slug: { in: INVITE_ORG_KEYS.map((k) => INVITE_ORGS[k].slug) },
    },
  });
  log(`deleted ${deleted.count} fixture organization(s) (their rows cascade).`);
  for (const key of INVITE_USER_KEYS) {
    const user = s.users[key];
    if (!user) continue;
    const removed = await admin.auth.admin.deleteUser(user.id);
    if (removed.error) fail(`failed to delete the ${key} fixture identity`);
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
  log("fixture identities deleted.");
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  if (!["preview", "prepare", "reset", "teardown"].includes(mode ?? "")) {
    fail("usage: invite-journey-fixtures.ts preview|prepare|reset|teardown");
  }
  assertTarget();
  const prisma = connect();
  try {
    if (mode === "preview") await preview(prisma);
    else if (mode === "prepare") await prepare(prisma);
    else if (mode === "reset") await reset(prisma);
    else await teardown(prisma);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  // Refusals are fixed strings; anything else is reduced to its name, since
  // driver errors can quote connection details or row values.
  const message =
    error instanceof FixtureRefusal
      ? `${LOG_PREFIX}: ${error.message}`
      : `${LOG_PREFIX}: unexpected ${error instanceof Error ? error.name : "error"}`;
  console.error(message);
  process.exit(1);
});
