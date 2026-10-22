import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  BASELINE_MEMBERSHIPS,
  EXPECTED_MEMBERSHIPS_AFTER_RUN,
  FixtureRefusal,
  INVITATIONS,
  INVITE_FIXTURE_TAG,
  INVITE_ORG_KEYS,
  INVITE_ORGS,
  INVITE_USER_KEYS,
  MAX_EXTRA_MEMBERSHIPS,
  MAX_FIXTURE_INVITATIONS,
  assertStagingTarget,
  assertTeardownSafe,
  fixtureEmails,
  invitationRows,
  planReset,
  redact,
  subAddress,
  type FixtureSnapshot,
  type InviteOrgKey,
  type InviteUserKey,
} from "../../scripts/lib/invite-journeys";

/**
 * Safety rules of the staging invitation-journey fixtures. Plain data only:
 * nothing here touches a database, Supabase or the network.
 */

const STAGING = "abcdefghijklmnopqrst";
const PRODUCTION = "zyxwvutsrqponmlkjihg";

const target = (overrides: Partial<Parameters<typeof assertStagingTarget>[0]> = {}) => ({
  stagingRef: STAGING,
  productionRef: PRODUCTION,
  supabaseUrl: `https://${STAGING}.supabase.co`,
  databaseUrl: `postgresql://postgres.${STAGING}:pw@aws-0-eu-north-1.pooler.supabase.com:5432/postgres`,
  ...overrides,
});

describe("staging target guard", () => {
  it("accepts the staging API host and a connection naming the staging ref", () => {
    expect(() => assertStagingTarget(target())).not.toThrow();
    expect(() =>
      assertStagingTarget(
        target({ databaseUrl: `postgresql://postgres:pw@db.${STAGING}.supabase.co:5432/postgres` }),
      ),
    ).not.toThrow();
  });

  it.each([
    ["no staging ref", { stagingRef: undefined }],
    ["a malformed staging ref", { stagingRef: "short" }],
    ["no production ref to compare against", { productionRef: undefined }],
    ["staging equal to production", { productionRef: STAGING }],
    ["the production API host", { supabaseUrl: `https://${PRODUCTION}.supabase.co` }],
    ["a non-https API host", { supabaseUrl: `http://${STAGING}.supabase.co` }],
    ["a look-alike API host", { supabaseUrl: `https://${STAGING}.supabase.co.evil.example` }],
    ["no database URL", { databaseUrl: undefined }],
    [
      "a database for another project",
      { databaseUrl: "postgresql://postgres.other:pw@host:5432/postgres" },
    ],
    [
      "a database naming production",
      {
        databaseUrl: `postgresql://postgres.${PRODUCTION}:pw@db.${STAGING}.supabase.co:5432/postgres`,
      },
    ],
  ])("refuses %s", (_label, overrides) => {
    expect(() => assertStagingTarget(target(overrides))).toThrow(FixtureRefusal);
  });

  it("refuses identical refs by that rule itself, not only because the database check catches it", () => {
    expect(() => assertStagingTarget(target({ productionRef: STAGING }))).toThrow(
      "the staging and production project refs are the same",
    );
  });

  it("never echoes a connection string it can't parse", () => {
    try {
      assertStagingTarget(target({ databaseUrl: "not a url with secret-password" }));
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain("secret-password");
    }
  });
});

describe("fixture identities", () => {
  it("are lowercase sub-addresses of the staging E2E email, one per role", () => {
    const emails = fixtureEmails("QA.Bot@Example.test");
    expect(emails.owner).toBe("qa.bot+invite-e2e-owner@example.test");
    expect(emails.wrongTarget).toBe("qa.bot+invite-e2e-wrong-target@example.test");
    expect(new Set(Object.values(emails)).size).toBe(INVITE_USER_KEYS.length + 1);
  });

  it("refuses a base address that isn't one", () => {
    expect(() => subAddress("no-at-sign", "x")).toThrow(FixtureRefusal);
    expect(() => subAddress("@example.test", "x")).toThrow(FixtureRefusal);
    expect(() => subAddress("someone@", "x")).toThrow(FixtureRefusal);
  });
});

const id = (prefix: string, n: number) =>
  `${prefix}0000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const userIds = Object.fromEntries(INVITE_USER_KEYS.map((k, i) => [k, id("1", i)])) as Record<
  InviteUserKey,
  string
>;
const orgIds = Object.fromEntries(INVITE_ORG_KEYS.map((k, i) => [k, id("2", i)])) as Record<
  InviteOrgKey,
  string
>;

function snapshot(overrides: Partial<FixtureSnapshot> = {}): FixtureSnapshot {
  return {
    users: Object.fromEntries(
      INVITE_USER_KEYS.map((k) => [k, { id: userIds[k], marker: INVITE_FIXTURE_TAG }]),
    ) as FixtureSnapshot["users"],
    wrongTargetHasAccount: false,
    orgs: Object.fromEntries(
      INVITE_ORG_KEYS.map((k) => [
        k,
        { id: orgIds[k], slug: INVITE_ORGS[k].slug, marker: INVITE_FIXTURE_TAG },
      ]),
    ) as FixtureSnapshot["orgs"],
    memberships: BASELINE_MEMBERSHIPS.map((m) => ({
      organizationId: orgIds[m.org],
      userId: userIds[m.user],
      role: m.role,
    })),
    invitationCount: 0,
    ...overrides,
  };
}

const afterRun = () =>
  EXPECTED_MEMBERSHIPS_AFTER_RUN.map((m) => ({
    organizationId: orgIds[m.org],
    userId: userIds[m.user],
    role: m.role,
  }));

describe("reset plan", () => {
  it("is a no-op at the baseline", () => {
    expect(planReset(snapshot())).toEqual({
      deleteMemberships: [],
      createMemberships: [],
      deleteInvitations: 0,
    });
  });

  it("after a full run, removes exactly the three journey joins and every invitation", () => {
    const plan = planReset(snapshot({ memberships: afterRun(), invitationCount: 9 }));
    expect(plan.deleteInvitations).toBe(9);
    expect(plan.createMemberships).toEqual([]);
    expect(plan.deleteMemberships).toEqual([
      { organizationId: orgIds.main, userId: userIds.newcomer },
      { organizationId: orgIds.main, userId: userIds.existing },
      { organizationId: orgIds.main, userId: userIds.other },
    ]);
  });

  it("restores a missing baseline membership (e.g. FULL's second seat)", () => {
    const memberships = snapshot().memberships.filter(
      (m) => !(m.organizationId === orgIds.full && m.userId === userIds.member),
    );
    expect(planReset(snapshot({ memberships })).createMemberships).toEqual([
      { organizationId: orgIds.full, userId: userIds.member, role: "MEMBER" },
    ]);
  });

  it("refuses an account outside the fixtures in a fixture org, deleting nothing", () => {
    const memberships = [
      ...snapshot().memberships,
      { organizationId: orgIds.main, userId: id("9", 1), role: "MEMBER" },
    ];
    expect(() => planReset(snapshot({ memberships }))).toThrow(/not a fixture identity/);
  });

  it("refuses a fixture identity that belongs to an organization outside the fixtures", () => {
    const memberships = [
      ...snapshot().memberships,
      { organizationId: id("9", 2), userId: userIds.other, role: "MEMBER" },
    ];
    expect(() => planReset(snapshot({ memberships }))).toThrow(/outside the fixtures/);
  });

  it("never deletes an owner, and never guesses at a changed baseline role", () => {
    const extraOwner = [
      ...snapshot().memberships,
      { organizationId: orgIds.main, userId: userIds.other, role: "OWNER" },
    ];
    expect(() => planReset(snapshot({ memberships: extraOwner }))).toThrow(/OWNER/);
    const changedRole = snapshot().memberships.map((m) =>
      m.organizationId === orgIds.main && m.userId === userIds.member ? { ...m, role: "ADMIN" } : m,
    );
    expect(() => planReset(snapshot({ memberships: changedRole }))).toThrow(/expected MEMBER/);
  });

  it("refuses more invitations or memberships than any run creates", () => {
    expect(() => planReset(snapshot({ invitationCount: MAX_FIXTURE_INVITATIONS + 1 }))).toThrow(
      /more than any run/,
    );
    // Distinct non-baseline (org, identity) pairs, so only the count can refuse.
    const baseline = new Set(BASELINE_MEMBERSHIPS.map((m) => `${m.org}:${m.user}`));
    const extras = INVITE_ORG_KEYS.flatMap((org) =>
      INVITE_USER_KEYS.filter((user) => !baseline.has(`${org}:${user}`)).map((user) => ({
        organizationId: orgIds[org],
        userId: userIds[user],
        role: "VIEWER",
      })),
    );
    expect(extras.length).toBeGreaterThan(MAX_EXTRA_MEMBERSHIPS);
    const many = [...snapshot().memberships, ...extras.slice(0, MAX_EXTRA_MEMBERSHIPS + 1)];
    expect(() => planReset(snapshot({ memberships: many }))).toThrow(/more than any run creates/);
  });

  it("refuses unmarked identities or orgs, an org returned for another slug, and a wrong-target account", () => {
    const users = { ...snapshot().users, other: { id: userIds.other, marker: null } };
    expect(() => planReset(snapshot({ users }))).toThrow(/not this suite's fixture/);
    const orgs = {
      ...snapshot().orgs,
      full: { id: orgIds.full, slug: INVITE_ORGS.full.slug, marker: "other" },
    };
    expect(() => planReset(snapshot({ orgs }))).toThrow(/not this suite's fixture/);
    const wrongSlug = {
      ...snapshot().orgs,
      main: { id: orgIds.main, slug: "customer", marker: INVITE_FIXTURE_TAG },
    };
    expect(() => planReset(snapshot({ orgs: wrongSlug }))).toThrow(/another slug/);
    expect(() => planReset(snapshot({ wrongTargetHasAccount: true }))).toThrow(
      /never have an account/,
    );
  });

  it("refuses when a fixture is missing instead of half-resetting", () => {
    expect(() => planReset(snapshot({ orgs: { ...snapshot().orgs, home: null } }))).toThrow(
      /missing/,
    );
    expect(() => planReset(snapshot({ users: { ...snapshot().users, member: null } }))).toThrow(
      /missing/,
    );
  });
});

describe("teardown guard", () => {
  it("accepts marked fixtures whose memberships stay inside them", () => {
    expect(() => assertTeardownSafe(snapshot({ memberships: afterRun() }))).not.toThrow();
  });

  it("refuses when an outside account or org is involved", () => {
    expect(() =>
      assertTeardownSafe(
        snapshot({
          memberships: [
            ...afterRun(),
            { organizationId: orgIds.home, userId: id("9", 3), role: "MEMBER" },
          ],
        }),
      ),
    ).toThrow(FixtureRefusal);
    expect(() =>
      assertTeardownSafe(
        snapshot({
          memberships: [
            ...afterRun(),
            { organizationId: id("9", 4), userId: userIds.owner, role: "OWNER" },
          ],
        }),
      ),
    ).toThrow(FixtureRefusal);
  });
});

describe("fixture invitations", () => {
  const now = new Date("2026-10-20T12:00:00Z");
  const emails = fixtureEmails("qa@example.test");
  const rows = invitationRows({ now, orgIds, userIds, emails });

  it("one per journey, unique per (organization, email), inviter = the org's owner", () => {
    expect(rows.map((r) => r.key)).toEqual(Object.keys(INVITATIONS));
    expect(new Set(rows.map((r) => `${r.organizationId}|${r.email}`)).size).toBe(rows.length);
    expect(rows.find((r) => r.key === "D2")!.invitedById).toBe(userIds.existing);
    expect(rows.find((r) => r.key === "A")!.invitedById).toBe(userIds.owner);
  });

  it("only D1 starts expired; the rest are valid for a day", () => {
    for (const row of rows) {
      const hours = (row.expiresAt.getTime() - now.getTime()) / 3_600_000;
      expect(hours, row.key).toBe(row.key === "D1" ? -24 : 24);
    }
  });

  it("the wrong-account invitation goes to the address with no account", () => {
    expect(rows.find((r) => r.key === "C")!.email).toBe(emails.wrongTarget);
  });

  it("roles come from the plan: A MEMBER, B ADMIN, E VIEWER, H ADMIN", () => {
    const role = (key: string) => rows.find((r) => r.key === key)!.role;
    expect([role("A"), role("B"), role("E"), role("H")]).toEqual([
      "MEMBER",
      "ADMIN",
      "VIEWER",
      "ADMIN",
    ]);
  });
});

describe("redaction", () => {
  it("removes every UUID (tokens and ids) from text, any case", () => {
    const sample = randomUUID();
    expect(redact(`/invite/${sample}?error=expired`)).toBe("/invite/<redacted>?error=expired");
    expect(redact(`navigated to "https://x/ar/invite/${sample.toUpperCase()}"`)).not.toContain(
      sample.toUpperCase(),
    );
    expect(redact("no ids here")).toBe("no ids here");
  });
});
