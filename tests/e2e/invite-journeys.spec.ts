import fs from "node:fs";
import path from "node:path";
import { test, expect, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Client } from "pg";
import { classifyE2ELoginPathname } from "./helpers/auth";
import {
  BASELINE_ACTIVE_ORG,
  EXPECTED_MEMBERSHIPS_AFTER_RUN,
  INVITATIONS,
  INVITE_FIXTURE_TAG,
  INVITE_ORG_KEYS,
  INVITE_ORGS,
  INVITE_USER_KEYS,
  fixtureEmails,
  redact,
  type InvitationKey,
  type InviteOrgKey,
  type InviteUserKey,
} from "../../scripts/lib/invite-journeys";

/**
 * Opt-in staging invitation-acceptance journeys, run only by
 * .github/workflows/staging-invite-journeys.yml after
 * scripts/invite-journey-fixtures.ts prepare. Each journey opens a fixture
 * invitation at the real /invite/<token> page and accepts it through the
 * real acceptInvitationAction; the invitations themselves were inserted
 * directly, never through inviteMember(), so no email is sent. Real sign-up
 * (and its confirmation email) is not covered: the new user is a
 * pre-confirmed fixture identity that signs in.
 *
 * Tokens are read from the database here, never printed: every failure is
 * rethrown with UUIDs redacted (Playwright's own messages can quote the
 * navigated URL), and traces, screenshots and video are off.
 */

const JOURNEYS_ENABLED = process.env.E2E_INVITE_JOURNEYS === "1";

type Locale = "en" | "fi" | "ar";
const PREFIX: Record<Locale, string> = { en: "/en", fi: "", ar: "/ar" };

type InviteMessages = {
  invalid: string;
  accept: string;
  signOutAndContinue: string;
  goToDashboard: string;
  errors: Record<"invalid" | "expired" | "seat_limit" | "read_only" | "already_member", string>;
};
const messages = Object.fromEntries(
  (["en", "fi", "ar"] as const).map((locale) => {
    const file = path.join(__dirname, "../../messages", `${locale}.json`);
    const json = JSON.parse(fs.readFileSync(file, "utf8")) as {
      invite: InviteMessages;
      roles: Record<string, string>;
    };
    return [locale, json];
  }),
) as Record<Locale, { invite: InviteMessages; roles: Record<string, string> }>;

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`invite journeys require ${name}`);
  return value;
}

async function query<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = [],
): Promise<T[]> {
  const db = new Client({ connectionString: requireEnv("E2E_DIRECT_URL") });
  await db.connect();
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.end();
  }
}

/** Runs a journey step; any failure is rethrown with tokens and ids redacted. */
async function guarded<T>(label: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label}: ${redact(message).slice(0, 1500)}`);
  }
}

/** The page's path and query with the token redacted: safe to assert on and print. */
function where(page: Page): string {
  const url = new URL(page.url());
  return redact(`${url.pathname}${url.search}`);
}

type Fixtures = {
  orgId: Record<InviteOrgKey, string>;
  userId: Record<InviteUserKey, string>;
  email: ReturnType<typeof fixtureEmails>;
  runStartedAt: string;
};

async function loadFixtures(): Promise<Fixtures> {
  const email = fixtureEmails(requireEnv("E2E_USER_EMAIL"));
  const orgId = {} as Fixtures["orgId"];
  for (const key of INVITE_ORG_KEYS) {
    const rows = await query<{ id: string }>(
      "select id::text as id from public.organizations where slug = $1 and settings->>'e2e_fixture' = $2 and deleted_at is null",
      [INVITE_ORGS[key].slug, INVITE_FIXTURE_TAG],
    );
    if (rows.length !== 1) throw new Error(`the ${key} fixture org is missing; run prepare first`);
    orgId[key] = rows[0]!.id;
  }
  const userId = {} as Fixtures["userId"];
  for (const key of INVITE_USER_KEYS) {
    const rows = await query<{ id: string }>(
      "select id::text as id from auth.users where lower(email) = lower($1) and raw_app_meta_data->>'e2e_fixture' = $2",
      [email[key], INVITE_FIXTURE_TAG],
    );
    if (rows.length !== 1)
      throw new Error(`the ${key} fixture identity is missing; run prepare first`);
    userId[key] = rows[0]!.id;
  }
  const [clock] = await query<{ now: string }>("select now()::text as now");
  return { orgId, userId, email, runStartedAt: clock!.now };
}

async function tokenFor(f: Fixtures, key: InvitationKey): Promise<string> {
  const spec = INVITATIONS[key];
  const rows = await query<{ token: string }>(
    "select token from public.invitations where organization_id = $1 and lower(email) = lower($2)",
    [f.orgId[spec.org], f.email[spec.to]],
  );
  if (rows.length !== 1) throw new Error(`fixture invitation ${key} is missing; run prepare first`);
  return rows[0]!.token;
}

async function invitationStatus(f: Fixtures, key: InvitationKey): Promise<string> {
  const spec = INVITATIONS[key];
  const rows = await query<{ status: string }>(
    "select status::text as status from public.invitations where organization_id = $1 and lower(email) = lower($2)",
    [f.orgId[spec.org], f.email[spec.to]],
  );
  return rows[0]?.status ?? "missing";
}

const byOrg = (a: { org: string }, b: { org: string }) =>
  a.org < b.org ? -1 : a.org > b.org ? 1 : 0;

async function membershipsOf(userId: string): Promise<Array<{ org: string; role: string }>> {
  const rows = await query<{ org: string; role: string }>(
    "select organization_id::text as org, role::text as role from public.organization_members where user_id = $1",
    [userId],
  );
  return rows.sort(byOrg);
}

async function memberCount(orgId: string): Promise<number> {
  const [row] = await query<{ n: number }>(
    "select count(*)::int as n from public.organization_members where organization_id = $1",
    [orgId],
  );
  return row!.n;
}

async function lastActiveOrg(userId: string): Promise<string | null> {
  const [row] = await query<{ org: string | null }>(
    "select raw_app_meta_data->>'last_active_org' as org from auth.users where id = $1",
    [userId],
  );
  return row?.org ?? null;
}

async function joinEvents(f: Fixtures, org: InviteOrgKey, user: InviteUserKey): Promise<number> {
  const [row] = await query<{ n: number }>(
    `select count(*)::int as n from public.audit_logs
     where organization_id = $1 and actor_id = $2 and action = 'member.join'
       and resource_type = 'organization_member' and resource_id = $2::text and created_at >= $3::timestamptz`,
    [f.orgId[org], f.userId[user], f.runStartedAt],
  );
  return row!.n;
}

/** Every membership of every fixture identity, as org/user/role keys. */
async function fixtureMemberships(f: Fixtures): Promise<string[]> {
  const orgKey = new Map(INVITE_ORG_KEYS.map((k) => [f.orgId[k], k]));
  const out: string[] = [];
  for (const user of INVITE_USER_KEYS) {
    for (const m of await membershipsOf(f.userId[user])) {
      out.push(`${orgKey.get(m.org) ?? "OUTSIDE-FIXTURES"}:${user}:${m.role}`);
    }
  }
  return out.sort();
}

async function newSession(browser: Browser): Promise<BrowserContext> {
  return browser.newContext({ storageState: { cookies: [], origins: [] } });
}

/**
 * Signs in through the real login form with the invitation as `next`, the
 * same continuation an invitee gets, and waits to land back on it.
 */
async function signInTo(page: Page, locale: Locale, email: string, token: string): Promise<void> {
  const next = encodeURIComponent(`/invite/${token}`);
  await guarded("sign in", async () => {
    await page.goto(`${PREFIX[locale]}/login?next=${next}`);
    await page.fill("#email", email);
    await page.fill("#password", requireEnv("INVITE_E2E_PASSWORD"));
    await page.locator('form button[type="submit"]').click();
    try {
      await page.waitForURL((url) => url.pathname.includes("/invite/"), { timeout: 20_000 });
    } catch {
      // A failure snapshot would otherwise capture the typed password.
      await page
        .locator("#password")
        .fill("", { timeout: 1_000 })
        .catch(() => {});
      throw new Error(`sign-in did not return to the invitation; landed on ${where(page)}`);
    }
  });
}

async function acceptOn(page: Page, locale: Locale): Promise<void> {
  await guarded("accept", async () => {
    await page.getByRole("button", { name: messages[locale].invite.accept }).click();
    await page.waitForURL(
      (url) => !url.pathname.includes("/invite/") || url.search.includes("error="),
      {
        timeout: 30_000,
      },
    );
  });
}

async function expectRtl(page: Page, locale: Locale): Promise<void> {
  const dir = await page.locator("html").getAttribute("dir");
  expect(dir, `html dir for ${locale}`).toBe(locale === "ar" ? "rtl" : "ltr");
}

async function expectAcceptError(
  page: Page,
  locale: Locale,
  code: keyof InviteMessages["errors"],
): Promise<void> {
  await guarded(`error page ${code}`, async () => {
    expect(where(page)).toBe(`${PREFIX[locale]}/invite/<redacted>?error=${code}`);
    // Filtered: Next.js also mounts an empty route-announcer role="alert".
    await expect(
      page.getByRole("alert").filter({ hasText: messages[locale].invite.errors[code] }),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: messages[locale].invite.accept })).toHaveCount(0);
  });
  await expectRtl(page, locale);
}

test.use({ trace: "off", screenshot: "off", video: "off" });

/** A journey whose every failure, including plain DB assertions, is redacted. */
function journey(
  title: string,
  body: (args: { page: Page; browser: Browser }) => Promise<void>,
): void {
  test(title, async ({ page, browser }) => guarded(title, () => body({ page, browser })));
}

test.describe("invitation acceptance journeys on staging (opt-in)", () => {
  test.describe.configure({ mode: "serial", retries: 0 });
  test.use({ storageState: { cookies: [], origins: [] } });

  let f: Fixtures;
  let other: BrowserContext | null = null;
  let otherPage: Page;

  test.beforeAll(async ({ browser }, testInfo) => {
    if (!JOURNEYS_ENABLED || testInfo.project.name !== "desktop") return;
    f = await loadFixtures();
    for (const key of Object.keys(INVITATIONS) as InvitationKey[]) {
      expect(await invitationStatus(f, key), `invitation ${key} before the run`).toBe("PENDING");
    }
    // One signed-in session for `other`, shared by C, D2, F, G and E.
    other = await newSession(browser);
    otherPage = await other.newPage();
  });

  test.afterAll(async () => {
    await other?.close();
  });

  test.beforeEach(() => {
    test.skip(
      !JOURNEYS_ENABLED,
      "Opt-in: set E2E_INVITE_JOURNEYS=1 after scripts/invite-journey-fixtures.ts prepare.",
    );
    test.skip(
      test.info().project.name !== "desktop",
      "Runs once (desktop): it changes fixture state.",
    );
    test.setTimeout(120_000);
  });

  journey(
    "D1 (EN): an invitation that had already expired shows the invalid page, signed out",
    async ({ page }) => {
      const token = await tokenFor(f, "D1");
      await guarded("D1", async () => {
        await page.goto(`/en/invite/${token}`);
        await expect(page.getByText(messages.en.invite.invalid)).toBeVisible();
        await expect(page.getByRole("button", { name: messages.en.invite.accept })).toHaveCount(0);
      });
      expect(await invitationStatus(f, "D1")).toBe("PENDING");
      expect(await membershipsOf(f.userId.newcomer)).toEqual([]);
    },
  );

  journey(
    "A (EN): a new user is sent to register, signs in, accepts and joins with the invited role",
    async ({ browser }) => {
      const token = await tokenFor(f, "A");
      const context = await newSession(browser);
      const page = await context.newPage();
      try {
        await guarded("A signed out", async () => {
          await page.goto(`/en/invite/${token}`);
          await page.waitForURL((url) => url.pathname.endsWith("/register"), { timeout: 20_000 });
          expect(where(page)).toBe("/en/register?next=%2Finvite%2F<redacted>");
        });
        await signInTo(page, "en", f.email.newcomer, token);
        await guarded("A invitation page", async () => {
          await expect(page.getByText(messages.en.roles.MEMBER!, { exact: true })).toBeVisible();
        });
        await acceptOn(page, "en");
        expect(
          classifyE2ELoginPathname(new URL(page.url()).pathname),
          `A landed on ${where(page)}`,
        ).toBe("dashboard");
        expect(where(page)).toBe("/en/dashboard");

        expect(await membershipsOf(f.userId.newcomer)).toEqual([
          { org: f.orgId.main, role: "MEMBER" },
        ]);
        expect(await invitationStatus(f, "A")).toBe("ACCEPTED");
        expect(await lastActiveOrg(f.userId.newcomer)).toBe(f.orgId.main);
        expect(await joinEvents(f, "main", "newcomer")).toBe(1);

        // The accepted link can't be used again.
        await guarded("A reuse", async () => {
          await page.goto(`/en/invite/${token}`);
          await expect(page.getByText(messages.en.invite.invalid)).toBeVisible();
        });
        expect(await membershipsOf(f.userId.newcomer)).toHaveLength(1);
      } finally {
        await context.close();
      }
    },
  );

  journey(
    "B (FI): a member of another organization joins MAIN with the invited role; HOME is untouched",
    async ({ browser }) => {
      const token = await tokenFor(f, "B");
      const context = await newSession(browser);
      const page = await context.newPage();
      try {
        await signInTo(page, "fi", f.email.existing, token);
        await guarded("B invitation page", async () => {
          await expect(page.getByText(messages.fi.roles.ADMIN!, { exact: true })).toBeVisible();
        });
        await acceptOn(page, "fi");
        expect(where(page)).toBe("/dashboard");
        expect(await membershipsOf(f.userId.existing)).toEqual(
          [
            { org: f.orgId.home, role: "OWNER" },
            { org: f.orgId.main, role: "ADMIN" },
          ].sort(byOrg),
        );
        expect(await memberCount(f.orgId.home)).toBe(1);
        expect(await invitationStatus(f, "B")).toBe("ACCEPTED");
        expect(await lastActiveOrg(f.userId.existing)).toBe(f.orgId.main);
        expect(await joinEvents(f, "main", "existing")).toBe(1);
        expect(await joinEvents(f, "home", "existing")).toBe(0);
      } finally {
        await context.close();
      }
    },
  );

  journey(
    "C (AR): signed in as another account, the page explains it and offers no Accept",
    async () => {
      const token = await tokenFor(f, "C");
      await signInTo(otherPage, "ar", f.email.other, token);
      await guarded("C page", async () => {
        expect(where(otherPage)).toBe("/ar/invite/<redacted>");
        await expect(
          otherPage.getByRole("button", { name: messages.ar.invite.signOutAndContinue }),
        ).toBeVisible();
        await expect(
          otherPage.getByRole("button", { name: messages.ar.invite.accept }),
        ).toHaveCount(0);
        const text = (await otherPage.locator("body").innerText()).toLowerCase();
        expect(text.includes(token.toLowerCase()), "the token is not shown on the page").toBe(
          false,
        );
      });
      await expectRtl(otherPage, "ar");
      expect(await invitationStatus(f, "C")).toBe("PENDING");
      expect(await membershipsOf(f.userId.other)).toEqual([]);
      expect(await lastActiveOrg(f.userId.other)).toBe(BASELINE_ACTIVE_ORG.other);
    },
  );

  journey(
    "D2 (EN): an invitation that expires after the page loaded fails as expired",
    async () => {
      const token = await tokenFor(f, "D2");
      await guarded("D2 page", async () => {
        await otherPage.goto(`/en/invite/${token}`);
        await expect(
          otherPage.getByRole("button", { name: messages.en.invite.accept }),
        ).toBeVisible();
      });
      // Expire exactly this fixture invitation, between page load and Accept.
      const expired = await query(
        `update public.invitations i set expires_at = now() - interval '1 minute'
       from public.organizations o
       where i.organization_id = o.id and o.id = $1 and o.settings->>'e2e_fixture' = $2
         and lower(i.email) = lower($3) and i.status = 'PENDING'
       returning i.id`,
        [f.orgId.home, INVITE_FIXTURE_TAG, f.email.other],
      );
      expect(expired).toHaveLength(1);
      await acceptOn(otherPage, "en");
      await expectAcceptError(otherPage, "en", "expired");
      expect(await invitationStatus(f, "D2")).toBe("EXPIRED");
      expect(await membershipsOf(f.userId.other)).toEqual([]);
      expect(await joinEvents(f, "home", "other")).toBe(0);
    },
  );

  journey("F (AR): an organization at its seat limit refuses the join", async () => {
    const token = await tokenFor(f, "F");
    const before = await memberCount(f.orgId.full);
    expect(before).toBe(2);
    await guarded("F page", async () => {
      await otherPage.goto(`/ar/invite/${token}`);
    });
    await acceptOn(otherPage, "ar");
    await expectAcceptError(otherPage, "ar", "seat_limit");
    expect(await memberCount(f.orgId.full)).toBe(before);
    expect(await invitationStatus(f, "F")).toBe("PENDING");
    expect(await membershipsOf(f.userId.other)).toEqual([]);
    expect(await joinEvents(f, "full", "other")).toBe(0);
  });

  journey("G (EN): a read-only organization refuses the join", async () => {
    const token = await tokenFor(f, "G");
    await guarded("G page", async () => {
      await otherPage.goto(`/en/invite/${token}`);
    });
    await acceptOn(otherPage, "en");
    await expectAcceptError(otherPage, "en", "read_only");
    expect(await invitationStatus(f, "G")).toBe("PENDING");
    expect(await membershipsOf(f.userId.other)).toEqual([]);
    expect(await joinEvents(f, "readonly", "other")).toBe(0);
    expect(await lastActiveOrg(f.userId.other)).toBe(BASELINE_ACTIVE_ORG.other);
  });

  journey(
    "E (EN): accepting the same invitation in two tabs joins once; the second tab fails safely",
    async () => {
      const token = await tokenFor(f, "E");
      const second = await other!.newPage();
      try {
        await guarded("E pages", async () => {
          await otherPage.goto(`/en/invite/${token}`);
          await second.goto(`/en/invite/${token}`);
          await expect(
            otherPage.getByRole("button", { name: messages.en.invite.accept }),
          ).toBeVisible();
          await expect(
            second.getByRole("button", { name: messages.en.invite.accept }),
          ).toBeVisible();
        });
        await acceptOn(otherPage, "en");
        expect(where(otherPage)).toBe("/en/dashboard");
        await acceptOn(second, "en");
        await expectAcceptError(second, "en", "invalid");

        expect(await membershipsOf(f.userId.other)).toEqual([
          { org: f.orgId.main, role: "VIEWER" },
        ]);
        expect(await invitationStatus(f, "E")).toBe("ACCEPTED");
        expect(await joinEvents(f, "main", "other")).toBe(1);
        expect(await lastActiveOrg(f.userId.other)).toBe(f.orgId.main);
      } finally {
        await second.close();
      }
    },
  );

  journey(
    "H (FI): an existing member following an invitation stays a member with the same role",
    async ({ browser }) => {
      const token = await tokenFor(f, "H");
      const context = await newSession(browser);
      const page = await context.newPage();
      try {
        await signInTo(page, "fi", f.email.member, token);
        await acceptOn(page, "fi");
        await expectAcceptError(page, "fi", "already_member");
        await guarded("H dashboard link", async () => {
          const link = page.getByRole("link", { name: messages.fi.invite.goToDashboard });
          await expect(link).toHaveAttribute("href", "/dashboard");
        });
        expect(await membershipsOf(f.userId.member)).toEqual(
          [
            { org: f.orgId.main, role: "MEMBER" },
            { org: f.orgId.full, role: "MEMBER" },
          ].sort(byOrg),
        );
        expect(await invitationStatus(f, "H")).toBe("PENDING");
        expect(await joinEvents(f, "main", "member")).toBe(0);
      } finally {
        await context.close();
      }
    },
  );

  journey(
    "tenant state after the run: only the three expected joins, nothing outside the fixtures",
    async () => {
      const expected = EXPECTED_MEMBERSHIPS_AFTER_RUN.map(
        (m) => `${m.org}:${m.user}:${m.role}`,
      ).sort();
      expect(await fixtureMemberships(f)).toEqual(expected);
      const outsiders = await query<{ n: number }>(
        `select count(*)::int as n from public.organization_members
       where organization_id = any($1::uuid[]) and not (user_id = any($2::uuid[]))`,
        [Object.values(f.orgId), Object.values(f.userId)],
      );
      expect(outsiders[0]!.n).toBe(0);
      // Exactly the three successful joins were audited during this run.
      const [joins] = await query<{ n: number }>(
        `select count(*)::int as n from public.audit_logs
       where organization_id = any($1::uuid[]) and action = 'member.join' and created_at >= $2::timestamptz`,
        [Object.values(f.orgId), f.runStartedAt],
      );
      expect(joins!.n).toBe(3);
    },
  );

  journey(
    "C, continued (AR): signing out from the wrong account returns to the invitation's sign-up",
    async () => {
      // Last: Supabase signOut ends this identity's sessions.
      const token = await tokenFor(f, "C");
      await guarded("C sign out", async () => {
        await otherPage.goto(`/ar/invite/${token}`);
        await otherPage
          .getByRole("button", { name: messages.ar.invite.signOutAndContinue })
          .click();
        await otherPage.waitForURL((url) => url.pathname.endsWith("/register"), {
          timeout: 20_000,
        });
        expect(where(otherPage)).toBe("/ar/register?next=%2Finvite%2F<redacted>");
      });
      expect(await invitationStatus(f, "C")).toBe("PENDING");
    },
  );
});
