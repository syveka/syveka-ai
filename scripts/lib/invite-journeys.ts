/**
 * Pure rules for the staging invitation-acceptance journeys
 * (tests/e2e/invite-journeys.spec.ts, scripts/invite-journey-fixtures.ts,
 * .github/workflows/staging-invite-journeys.yml). No I/O here, so every
 * identity, ownership and cleanup rule is unit-testable with plain data
 * (tests/unit/invite-journeys-fixture.test.ts).
 *
 * The fixtures never go through inviteMember(): that path sends a real
 * invitation email. Invitation rows are inserted directly, and only the
 * acceptance side -- /invite/<token> and acceptInvitationAction -- is the
 * application's own code.
 */

/** app_metadata.e2e_fixture on every fixture identity, settings.e2e_fixture on every fixture org. */
export const INVITE_FIXTURE_TAG = "invite-journeys";

export type JourneyLocale = "fi" | "en" | "ar";

/**
 * Two different locale-prefix rules meet in the journeys, and a test must
 * not mix them up (the first staging run did, on the Finnish dashboard):
 *
 * - Paths the test opens itself follow next-intl's `localePrefix:
 *   "as-needed"` routing (src/i18n/routing.ts): the default locale, Finnish,
 *   has no prefix.
 * - Destinations the server redirects to, and links the invitation page
 *   renders, come from localizedPath() (src/lib/auth-redirect.ts), which
 *   always prefixes the locale, Finnish included: /fi/dashboard,
 *   /fi/invite/<token>?error=..., /fi/register?next=....
 *
 * tests/unit/invite-journeys-locale-prefixes.test.ts proves both maps
 * against the app's own rules.
 */
export const OPEN_PATH_PREFIX: Record<JourneyLocale, string> = { fi: "", en: "/en", ar: "/ar" };
export const REDIRECT_PATH_PREFIX: Record<JourneyLocale, string> = {
  fi: "/fi",
  en: "/en",
  ar: "/ar",
};

/**
 * Fixture identities, as `+<tag>` sub-addresses of the staging E2E email.
 * `wrongTarget` is an address only: it must never have an account, so the
 * wrong-account journey has an invitation nobody signed in can accept.
 */
export const INVITE_USERS = {
  owner: "invite-e2e-owner",
  newcomer: "invite-e2e-newcomer",
  existing: "invite-e2e-existing",
  other: "invite-e2e-other",
  member: "invite-e2e-member",
} as const;
export const WRONG_TARGET_TAG = "invite-e2e-wrong-target";

export type InviteUserKey = keyof typeof INVITE_USERS;
export const INVITE_USER_KEYS = Object.keys(INVITE_USERS) as InviteUserKey[];

/**
 * - main:     where the successful journeys join. FREE plus a marked seat grant.
 * - home:     the existing user's own organization (cross-tenant check).
 * - full:     FREE (2 seats) holding exactly 2 members: seat_limit.
 * - readonly: PAST_DUE for more than 14 days, the one state getEntitlements()
 *             reports as readOnly: read_only.
 */
export const INVITE_ORGS = {
  main: { slug: "syveka-e2e-invite-main", name: "Syveka E2E invite MAIN (fixture)" },
  home: { slug: "syveka-e2e-invite-home", name: "Syveka E2E invite HOME (fixture)" },
  full: { slug: "syveka-e2e-invite-full", name: "Syveka E2E invite FULL (fixture)" },
  readonly: { slug: "syveka-e2e-invite-readonly", name: "Syveka E2E invite READ-ONLY (fixture)" },
} as const;

export type InviteOrgKey = keyof typeof INVITE_ORGS;
export const INVITE_ORG_KEYS = Object.keys(INVITE_ORGS) as InviteOrgKey[];

export type FixtureRole = "OWNER" | "ADMIN" | "MANAGER" | "MEMBER" | "VIEWER";

/** The org's owner, who is also the inviter recorded on its invitations. */
export const ORG_OWNER: Record<InviteOrgKey, InviteUserKey> = {
  main: "owner",
  home: "existing",
  full: "owner",
  readonly: "owner",
};

/** Memberships every run starts from (and reset restores). */
export const BASELINE_MEMBERSHIPS: ReadonlyArray<{
  org: InviteOrgKey;
  user: InviteUserKey;
  role: FixtureRole;
}> = [
  { org: "main", user: "owner", role: "OWNER" },
  { org: "main", user: "member", role: "MEMBER" },
  { org: "home", user: "existing", role: "OWNER" },
  { org: "full", user: "owner", role: "OWNER" },
  { org: "full", user: "member", role: "MEMBER" },
  { org: "readonly", user: "owner", role: "OWNER" },
];

/** Plan FREE allows 2 seats (src/lib/billing/plan-catalog.ts); main needs room for 3 joins. */
export const MAIN_SEAT_GRANT = {
  metric: "MAX_SEATS",
  amount: 10,
  reason: "e2e invite-journeys fixture",
} as const;

/** getEntitlements() treats PAST_DUE as read-only once it is older than 14 days. */
export const READONLY_PAST_DUE_AGE_DAYS = 15;

/** getEntitlements() caches for 60 s; the workflow waits this long after prepare. */
export const ENTITLEMENT_CACHE_WAIT_SECONDS = 65;

export type InvitationKey = "A" | "B" | "C" | "D1" | "D2" | "E" | "F" | "G" | "H";

/**
 * One invitation per journey. (organization, email) is unique, so no two
 * journeys share an org and an address.
 */
export const INVITATIONS: Record<
  InvitationKey,
  { org: InviteOrgKey; to: InviteUserKey | "wrongTarget"; role: FixtureRole; expired?: true }
> = {
  A: { org: "main", to: "newcomer", role: "MEMBER" },
  B: { org: "main", to: "existing", role: "ADMIN" },
  C: { org: "main", to: "wrongTarget", role: "MEMBER" },
  D1: { org: "full", to: "newcomer", role: "MEMBER", expired: true },
  D2: { org: "home", to: "other", role: "MEMBER" },
  E: { org: "main", to: "other", role: "VIEWER" },
  F: { org: "full", to: "other", role: "MEMBER" },
  G: { org: "readonly", to: "other", role: "MEMBER" },
  H: { org: "main", to: "member", role: "ADMIN" },
};

/** Memberships after a complete, passing run: baseline plus the three successful joins. */
export const EXPECTED_MEMBERSHIPS_AFTER_RUN: ReadonlyArray<{
  org: InviteOrgKey;
  user: InviteUserKey;
  role: FixtureRole;
}> = [
  ...BASELINE_MEMBERSHIPS,
  { org: "main", user: "newcomer", role: "MEMBER" },
  { org: "main", user: "existing", role: "ADMIN" },
  { org: "main", user: "other", role: "VIEWER" },
];

/** app_metadata.last_active_org each identity starts from. */
export const BASELINE_ACTIVE_ORG: Record<InviteUserKey, InviteOrgKey | null> = {
  owner: "main",
  newcomer: null,
  existing: "home",
  other: null,
  member: "main",
};

/**
 * More state than any single run can leave behind means something other than
 * this suite wrote to the fixtures: stop instead of deleting it.
 */
export const MAX_FIXTURE_INVITATIONS = 2 * Object.keys(INVITATIONS).length;
export const MAX_EXTRA_MEMBERSHIPS =
  2 * (EXPECTED_MEMBERSHIPS_AFTER_RUN.length - BASELINE_MEMBERSHIPS.length);

const SUPABASE_PROJECT_REF = /^[a-z0-9]{20}$/;

export class FixtureRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixtureRefusal";
  }
}

function refuse(message: string): never {
  throw new FixtureRefusal(message);
}

export function subAddress(email: string, tag: string): string {
  const at = email.lastIndexOf("@");
  if (at <= 0 || at === email.length - 1) {
    refuse("the base E2E email is not a valid email address");
  }
  return `${email.slice(0, at)}+${tag}@${email.slice(at + 1)}`.toLowerCase();
}

export function fixtureEmails(baseEmail: string): Record<InviteUserKey | "wrongTarget", string> {
  const emails = Object.fromEntries(
    INVITE_USER_KEYS.map((key) => [key, subAddress(baseEmail, INVITE_USERS[key])]),
  ) as Record<InviteUserKey, string>;
  return { ...emails, wrongTarget: subAddress(baseEmail, WRONG_TARGET_TAG) };
}

function parseUrlOrRefuse(name: string, value: string | undefined): URL {
  if (!value) refuse(`missing ${name}`);
  try {
    return new URL(value);
  } catch {
    // Never echo the value: it may be a connection string.
    refuse(`${name} is not a valid URL`);
  }
}

/**
 * Positive proof the target is the staging project: the Supabase API host
 * and the database connection both name the staging ref, which is a valid
 * ref and differs from production's. Anything uncertain refuses.
 */
export function assertStagingTarget(input: {
  stagingRef: string | undefined;
  productionRef: string | undefined;
  supabaseUrl: string | undefined;
  databaseUrl: string | undefined;
}): void {
  const { stagingRef, productionRef } = input;
  if (!stagingRef || !SUPABASE_PROJECT_REF.test(stagingRef)) {
    refuse("STAGING_SUPABASE_PROJECT_REF must be a 20-character Supabase project ref");
  }
  if (!productionRef || !SUPABASE_PROJECT_REF.test(productionRef)) {
    refuse("PRODUCTION_SUPABASE_PROJECT_REF must be present to prove the target is not production");
  }
  if (stagingRef === productionRef) refuse("the staging and production project refs are the same");

  const supabase = parseUrlOrRefuse("SUPABASE_URL", input.supabaseUrl);
  if (supabase.protocol !== "https:" || supabase.hostname !== `${stagingRef}.supabase.co`) {
    refuse("SUPABASE_URL is not the staging project's API host");
  }

  const database = parseUrlOrRefuse("DATABASE_URL", input.databaseUrl);
  const names = (value: string) =>
    database.hostname.includes(value) || database.username.includes(value);
  if (!names(stagingRef)) refuse("DATABASE_URL does not identify the staging project");
  if (names(productionRef)) refuse("DATABASE_URL identifies the production project");
}

export type AuthIdentity = { id: string; marker: string | null };
export type FixtureOrg = { id: string; slug: string; marker: unknown };
export type MembershipRow = { organizationId: string; userId: string; role: string };

export type FixtureSnapshot = {
  users: Record<InviteUserKey, AuthIdentity | null>;
  /** Whether an account exists for the wrong-account address. It must not. */
  wrongTargetHasAccount: boolean;
  orgs: Record<InviteOrgKey, FixtureOrg | null>;
  /** Every membership in a fixture org, and every membership of a fixture identity. */
  memberships: MembershipRow[];
  /** Invitations stored in the fixture orgs. */
  invitationCount: number;
};

export type ResetPlan = {
  deleteMemberships: Array<{ organizationId: string; userId: string }>;
  createMemberships: Array<{ organizationId: string; userId: string; role: FixtureRole }>;
  deleteInvitations: number;
};

/** Identities and orgs must each be either absent or carry this suite's marker. */
export function assertMarkers(snapshot: FixtureSnapshot): void {
  for (const key of INVITE_USER_KEYS) {
    const user = snapshot.users[key];
    if (user && user.marker !== INVITE_FIXTURE_TAG) {
      refuse(`an account with the ${key} fixture address exists but is not this suite's fixture`);
    }
  }
  if (snapshot.wrongTargetHasAccount) {
    refuse("the wrong-account address must never have an account, but one exists");
  }
  for (const key of INVITE_ORG_KEYS) {
    const org = snapshot.orgs[key];
    if (!org) continue;
    if (org.slug !== INVITE_ORGS[key].slug)
      refuse(`the ${key} fixture org lookup returned another slug`);
    if (org.marker !== INVITE_FIXTURE_TAG) {
      refuse(`an organization with the ${key} fixture slug exists but is not this suite's fixture`);
    }
  }
}

/**
 * Restores the baseline from any state a run can leave, and refuses
 * everything else: an outsider in a fixture org, a fixture identity in an
 * outside org, an extra owner, or more invitations/memberships than any run
 * creates. Only ever deletes non-owner memberships of fixture identities in
 * fixture orgs, and invitations of fixture orgs.
 */
export function planReset(snapshot: FixtureSnapshot): ResetPlan {
  assertMarkers(snapshot);
  const users = INVITE_USER_KEYS.map((key) => [key, snapshot.users[key]] as const);
  const orgs = INVITE_ORG_KEYS.map((key) => [key, snapshot.orgs[key]] as const);
  for (const [key, user] of users) if (!user) refuse(`the ${key} fixture identity is missing`);
  for (const [key, org] of orgs) if (!org) refuse(`the ${key} fixture organization is missing`);

  const userKeyById = new Map(users.map(([key, user]) => [user!.id, key]));
  const orgKeyById = new Map(orgs.map(([key, org]) => [org!.id, key]));
  const baselineRole = new Map<string, FixtureRole>(
    BASELINE_MEMBERSHIPS.map((m) => [`${m.org}:${m.user}`, m.role] as const),
  );

  if (snapshot.invitationCount > MAX_FIXTURE_INVITATIONS) {
    refuse(
      `the fixture orgs hold ${snapshot.invitationCount} invitations, more than any run creates`,
    );
  }

  const seen = new Set<string>();
  const deleteMemberships: ResetPlan["deleteMemberships"] = [];
  for (const row of snapshot.memberships) {
    const orgKey = orgKeyById.get(row.organizationId);
    const userKey = userKeyById.get(row.userId);
    if (!userKey) refuse("an account that is not a fixture identity belongs to a fixture org");
    if (!orgKey)
      refuse(`the ${userKey} fixture identity belongs to an organization outside the fixtures`);
    const pair = `${orgKey}:${userKey}`;
    if (seen.has(pair)) refuse(`duplicate membership for ${pair}`);
    seen.add(pair);
    const expected = baselineRole.get(pair);
    if (expected) {
      if (row.role !== expected) {
        refuse(
          `baseline membership ${pair} has role ${row.role}, expected ${expected}; refusing to guess`,
        );
      }
      continue;
    }
    if (row.role === "OWNER")
      refuse(`an unexpected OWNER membership ${pair}; refusing to delete an owner`);
    deleteMemberships.push({ organizationId: row.organizationId, userId: row.userId });
  }
  if (deleteMemberships.length > MAX_EXTRA_MEMBERSHIPS) {
    refuse(`${deleteMemberships.length} extra fixture memberships, more than any run creates`);
  }

  const createMemberships = BASELINE_MEMBERSHIPS.filter((m) => !seen.has(`${m.org}:${m.user}`)).map(
    (m) => ({
      organizationId: snapshot.orgs[m.org]!.id,
      userId: snapshot.users[m.user]!.id,
      role: m.role,
    }),
  );

  return { deleteMemberships, createMemberships, deleteInvitations: snapshot.invitationCount };
}

/**
 * Teardown deletes the fixture orgs (their invitations, memberships, audit
 * rows and grants cascade) and then the identities, so it accepts only
 * marked fixtures whose memberships all stay inside the fixtures.
 */
export function assertTeardownSafe(snapshot: FixtureSnapshot): void {
  assertMarkers(snapshot);
  const userIds = new Set(
    INVITE_USER_KEYS.flatMap((k) => (snapshot.users[k] ? [snapshot.users[k]!.id] : [])),
  );
  const orgIds = new Set(
    INVITE_ORG_KEYS.flatMap((k) => (snapshot.orgs[k] ? [snapshot.orgs[k]!.id] : [])),
  );
  for (const row of snapshot.memberships) {
    if (!userIds.has(row.userId))
      refuse("an account that is not a fixture identity belongs to a fixture org");
    if (!orgIds.has(row.organizationId)) {
      refuse("a fixture identity belongs to an organization outside the fixtures");
    }
  }
}

export function invitationRows(input: {
  now: Date;
  orgIds: Record<InviteOrgKey, string>;
  userIds: Record<InviteUserKey, string>;
  emails: Record<InviteUserKey | "wrongTarget", string>;
}): Array<{
  key: InvitationKey;
  organizationId: string;
  email: string;
  role: FixtureRole;
  invitedById: string;
  expiresAt: Date;
}> {
  const day = 24 * 60 * 60 * 1000;
  return (Object.keys(INVITATIONS) as InvitationKey[]).map((key) => {
    const spec = INVITATIONS[key];
    return {
      key,
      organizationId: input.orgIds[spec.org],
      email: input.emails[spec.to],
      role: spec.role,
      invitedById: input.userIds[ORG_OWNER[spec.org]],
      expiresAt: new Date(input.now.getTime() + (spec.expired ? -day : day)),
    };
  });
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Invitation tokens are UUIDs, so is every id: anything printed by the
 * journeys passes through here first.
 */
export function redact(text: string): string {
  return text.replace(UUID, "<redacted>");
}
