import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client/client";
import { CalendarBusyError, lockOrgCalendar } from "@/server/calendar/locks";

/**
 * The real lockOrgCalendar on a real Postgres, with the app's client settings:
 * one connection and Prisma's default 5 s interactive-transaction limit.
 *
 * Skipped unless CALENDAR_LOCK_PG_URL points at a scratch database. It only
 * takes advisory locks, so it needs no schema. Not run in CI.
 */
const PG_URL = process.env.CALENDAR_LOCK_PG_URL;

describe.skipIf(!PG_URL)("organization calendar lock wait on real Postgres", () => {
  let prisma: PrismaClient;
  let holder: Client;

  beforeAll(async () => {
    prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: PG_URL, max: 1 }) });
    holder = new Client({ connectionString: PG_URL });
    await holder.connect();
  });
  afterAll(async () => {
    await holder.end();
    await prisma.$disconnect();
  });

  const hold = async (orgId: string) => {
    await holder.query("BEGIN");
    await holder.query("SELECT pg_advisory_xact_lock(hashtext($1), 0)", [orgId]);
  };

  it("gives up at the limit and leaves the connection free at once", async () => {
    const orgId = randomUUID();
    await hold(orgId);
    try {
      const started = Date.now();
      const outcome = await prisma
        .$transaction(async (tx) => {
          await lockOrgCalendar(tx, orgId);
          return "locked";
        })
        .catch((error: unknown) => error);
      const waited = Date.now() - started;
      expect(outcome).toBeInstanceOf(CalendarBusyError);
      expect(waited).toBeGreaterThanOrEqual(2_900);
      expect(waited).toBeLessThan(4_500);

      const next = Date.now();
      await prisma.$queryRaw`SELECT 1`;
      expect(Date.now() - next).toBeLessThan(500);
    } finally {
      await holder.query("COMMIT");
    }
  }, 15_000);

  it("takes the lock once it is free, and another organization never waits", async () => {
    const orgId = randomUUID();
    await hold(orgId);
    try {
      const started = Date.now();
      await prisma.$transaction(async (tx) => lockOrgCalendar(tx, randomUUID()));
      expect(Date.now() - started).toBeLessThan(1_000);

      const waiting = prisma.$transaction(async (tx) => {
        await lockOrgCalendar(tx, orgId);
        return "locked";
      });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      await holder.query("COMMIT");
      await expect(waiting).resolves.toBe("locked");
    } catch (error) {
      await holder.query("COMMIT").catch(() => undefined);
      throw error;
    }
  }, 15_000);
});
