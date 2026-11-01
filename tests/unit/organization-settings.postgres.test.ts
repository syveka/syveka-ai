import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type * as OrgSettings from "@/server/services/organization-settings";
import type * as FeatureFlags from "@/server/services/feature-flags";
import type * as SettingsActions from "@/actions/settings";

/**
 * Organization.settings writes on a real Postgres (full migration history):
 * the app changes only its own keys, atomically on the current value, so an
 * overlapping write can't drop another key — above all the operator-only
 * workflow_steps_internal_only restriction, whose loss would let a pilot's
 * ACTIVE_WORKFLOWS grant send email, call paid AI or schedule runs.
 *
 * Deterministic interleaving: one connection installs the restriction in an
 * open transaction (holding the row lock, as the owner SQL does) while the
 * app's write starts and blocks; after the commit the app write proceeds on
 * the CURRENT row. A control shows the previous read-then-write pattern
 * losing the restriction under the same interleaving.
 *
 * Skipped unless ORG_SETTINGS_PG_URL points at a scratch database prepared as
 * in CI (tests/migrations/supabase-compatibility.sql, then
 * `prisma migrate deploy`). Only auth and audit are mocked.
 */
const PG_URL = process.env.ORG_SETTINGS_PG_URL;

const holder = vi.hoisted(() => ({ client: undefined as unknown, orgId: "" }));
vi.mock("@/server/db/tenant", () => ({
  get unscopedPrisma() {
    return holder.client;
  },
  tenantDb: () => {
    throw new Error("tenantDb is not used here");
  },
}));
vi.mock("@/server/auth/guard", () => ({
  requirePermission: vi.fn(async () => ({ orgId: holder.orgId, userId: randomUUID() })),
}));
vi.mock("@/server/auth/session", () => ({ getTenantContext: vi.fn() }));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

type Db = {
  $executeRaw: (q: TemplateStringsArray, ...v: unknown[]) => Promise<number>;
  $queryRaw: <T>(q: TemplateStringsArray, ...v: unknown[]) => Promise<T>;
  $transaction: <T>(fn: (tx: Db) => Promise<T>) => Promise<T>;
  organization: {
    create: (a: object) => Promise<{ id: string }>;
    findUniqueOrThrow: (a: object) => Promise<{ settings: unknown; name: string }>;
    update: (a: object) => Promise<unknown>;
  };
  $disconnect: () => Promise<void>;
};
type PgClient = {
  connect: () => Promise<void>;
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
  end: () => Promise<void>;
};

const RESTRICTION = "workflow_steps_internal_only";

describe.skipIf(!PG_URL)("organization settings writes on real Postgres", () => {
  let db: Db;
  let PgClientCtor: new (cfg: { connectionString: string }) => PgClient;
  let patchOrganizationSettings: typeof OrgSettings.patchOrganizationSettings;
  let ProtectedSettingError: typeof OrgSettings.ProtectedSettingError;
  let setFeatureEnabled: typeof FeatureFlags.setFeatureEnabled;
  let isRestrictionSet: typeof FeatureFlags.isRestrictionSet;
  let updateOrganizationAction: typeof SettingsActions.updateOrganizationAction;

  beforeAll(async () => {
    const [{ PrismaClient }, { PrismaPg }, pg] = await Promise.all([
      import("@/generated/prisma/client/client"),
      import("@prisma/adapter-pg"),
      import("pg"),
    ]);
    db = new PrismaClient({
      adapter: new PrismaPg({ connectionString: PG_URL!, max: 4 }),
    }) as unknown as Db;
    holder.client = db;
    PgClientCtor = (pg.default ?? pg).Client as never;
    ({ patchOrganizationSettings, ProtectedSettingError } =
      await import("@/server/services/organization-settings"));
    ({ setFeatureEnabled, isRestrictionSet } = await import("@/server/services/feature-flags"));
    ({ updateOrganizationAction } = await import("@/actions/settings"));
  });

  afterAll(async () => {
    await db?.$disconnect();
  });

  beforeEach(async () => {
    const org = await db.organization.create({
      data: {
        name: "Settings race test",
        slug: `settings-race-${randomUUID()}`,
        settings: { aiInstructions: "old", unrelated: { keep: true } },
      },
    });
    holder.orgId = org.id;
  });

  const settingsOf = async () =>
    (await db.organization.findUniqueOrThrow({ where: { id: holder.orgId } })).settings as Record<
      string,
      unknown
    >;
  const form = (fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return fd;
  };

  /**
   * Installs the restriction in an open transaction holding the row lock.
   * waitUntilBlocking() resolves only once Postgres reports another backend
   * waiting on this one (pg_blocking_pids), which proves the app write really
   * overlaps the operator's change instead of assuming it after a delay.
   */
  async function holdRestrictionInstall(): Promise<{
    commit: () => Promise<void>;
    waitUntilBlocking: () => Promise<void>;
  }> {
    const operator = new PgClientCtor({ connectionString: PG_URL! });
    await operator.connect();
    const pid = Number((await operator.query("select pg_backend_pid() as pid")).rows[0]!.pid);
    await operator.query("begin");
    await operator.query(
      `update organizations set settings = settings || '{"${RESTRICTION}": true}'::jsonb where id = $1`,
      [holder.orgId],
    );
    return {
      commit: async () => {
        await operator.query("commit");
        await operator.end();
      },
      waitUntilBlocking: async () => {
        for (let i = 0; i < 100; i++) {
          const { rows } = await operator.query(
            "select count(*)::int as waiting from pg_stat_activity where $1 = any(pg_blocking_pids(pid))",
            [pid],
          );
          if (Number(rows[0]!.waiting) > 0) return;
          await new Promise((r) => setTimeout(r, 50));
        }
        throw new Error("the app write never waited on the operator's row lock");
      },
    };
  }

  it("an organization save overlapping a restriction install keeps the restriction and other keys", async () => {
    const operator = await holdRestrictionInstall();
    const save = updateOrganizationAction(
      {},
      form({ name: "Renamed", businessId: "", vatId: "", aiInstructions: "new instructions" }),
    );
    await operator.waitUntilBlocking(); // proven blocked on the operator's row lock
    await operator.commit();
    await save;
    const s = await settingsOf();
    expect(s[RESTRICTION]).toBe(true);
    expect(s.aiInstructions).toBe("new instructions");
    expect(s.unrelated).toEqual({ keep: true });
    expect(await isRestrictionSet(holder.orgId, RESTRICTION)).toBe(true);
  });

  it("a feature toggle overlapping a restriction install keeps both", async () => {
    const operator = await holdRestrictionInstall();
    const toggle = setFeatureEnabled(holder.orgId, "creator_studio_v1", true);
    await operator.waitUntilBlocking();
    await operator.commit();
    await toggle;
    const s = await settingsOf();
    expect(s[RESTRICTION]).toBe(true);
    expect(s.creator_studio_v1).toBe(true);
    expect(s.aiInstructions).toBe("old");
  });

  it("control: the previous read-then-write pattern loses the restriction under the same interleaving", async () => {
    const staleRead = (await settingsOf()) as object; // read before the install commits
    const operator = await holdRestrictionInstall();
    // Prisma queries are lazy: .then() sends this one now, so it can block on the lock.
    const oldWrite = db.organization
      .update({
        where: { id: holder.orgId },
        data: { settings: { ...staleRead, aiInstructions: "stale copy" } },
      })
      .then((r) => r);
    await operator.waitUntilBlocking();
    await operator.commit();
    await oldWrite;
    expect((await settingsOf())[RESTRICTION]).toBeUndefined();
  });

  it("many concurrent saves and toggles on different keys all survive, with the restriction installed", async () => {
    await (await holdRestrictionInstall()).commit();
    await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        i % 2 === 0
          ? setFeatureEnabled(holder.orgId, `flag_${i}`, true)
          : patchOrganizationSettings(holder.orgId, { set: { [`key_${i}`]: i } }),
      ),
    );
    const s = await settingsOf();
    expect(s[RESTRICTION]).toBe(true);
    for (let i = 0; i < 12; i++) {
      expect(s[i % 2 === 0 ? `flag_${i}` : `key_${i}`]).toBe(i % 2 === 0 ? true : i);
    }
    expect(s.unrelated).toEqual({ keep: true });
  });

  it("ordinary paths can't set, clear or disable the restriction", async () => {
    await (await holdRestrictionInstall()).commit();
    await expect(
      patchOrganizationSettings(holder.orgId, { set: { [RESTRICTION]: false } }),
    ).rejects.toBeInstanceOf(ProtectedSettingError);
    await expect(
      patchOrganizationSettings(holder.orgId, { remove: [RESTRICTION] }),
    ).rejects.toBeInstanceOf(ProtectedSettingError);
    await expect(setFeatureEnabled(holder.orgId, RESTRICTION, false)).rejects.toBeInstanceOf(
      ProtectedSettingError,
    );
    // An empty AI-instructions field removes only that key.
    await updateOrganizationAction(
      {},
      form({ name: "Renamed", businessId: "", vatId: "", aiInstructions: "" }),
    );
    const s = await settingsOf();
    expect(s[RESTRICTION]).toBe(true);
    expect("aiInstructions" in s).toBe(false);
    expect(s.unrelated).toEqual({ keep: true });
  });

  it("emergency rollback re-asserting a disabled restriction overlapping an app save keeps it on", async () => {
    // The restriction was found set to false; the owner's rollback sets it back to true
    // under the row lock while an app save that read the old state is in flight.
    await db.$executeRaw`update organizations set settings = settings || '{"workflow_steps_internal_only": false}'::jsonb where id = ${holder.orgId}::uuid`;
    expect(await isRestrictionSet(holder.orgId, RESTRICTION)).toBe(false);
    const operator = await holdRestrictionInstall();
    const save = setFeatureEnabled(holder.orgId, "creator_studio_v1", false);
    await operator.waitUntilBlocking();
    await operator.commit();
    await save;
    const s = await settingsOf();
    expect(s[RESTRICTION]).toBe(true);
    expect(s.creator_studio_v1).toBe(false);
  });
});
