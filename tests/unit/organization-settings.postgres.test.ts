import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

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
  let patchOrganizationSettings: typeof import("@/server/services/organization-settings").patchOrganizationSettings;
  let ProtectedSettingError: typeof import("@/server/services/organization-settings").ProtectedSettingError;
  let setFeatureEnabled: typeof import("@/server/services/feature-flags").setFeatureEnabled;
  let isRestrictionSet: typeof import("@/server/services/feature-flags").isRestrictionSet;
  let updateOrganizationAction: typeof import("@/actions/settings").updateOrganizationAction;

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

  /** Installs the restriction in an open transaction holding the row lock; returns commit(). */
  async function holdRestrictionInstall(): Promise<{ commit: () => Promise<void> }> {
    const operator = new PgClientCtor({ connectionString: PG_URL! });
    await operator.connect();
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
    };
  }

  const settles = async (p: Promise<unknown>, ms = 300) =>
    Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), ms))]);

  it("an organization save overlapping a restriction install keeps the restriction and other keys", async () => {
    const operator = await holdRestrictionInstall();
    const save = updateOrganizationAction(
      {},
      form({ name: "Renamed", businessId: "", vatId: "", aiInstructions: "new instructions" }),
    );
    expect(await settles(save)).toBe(false); // blocked on the operator's row lock
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
    expect(await settles(toggle)).toBe(false);
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
    const oldWrite = db.organization.update({
      where: { id: holder.orgId },
      data: { settings: { ...staleRead, aiInstructions: "stale copy" } },
    });
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

  it("emergency rollback re-asserting the restriction overlapping an app save keeps both", async () => {
    // Restriction missing (e.g. lost before this fix); the owner's rollback re-adds it
    // under the row lock while an app save is in flight.
    const operator = await holdRestrictionInstall();
    const save = setFeatureEnabled(holder.orgId, "creator_studio_v1", false);
    expect(await settles(save)).toBe(false); // in flight, blocked on the rollback's row lock
    await operator.commit();
    await save;
    const s = await settingsOf();
    expect(s[RESTRICTION]).toBe(true);
    expect(s.creator_studio_v1).toBe(false);
  });
});
