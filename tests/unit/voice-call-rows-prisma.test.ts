import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PrismaClient as PrismaClientType } from "@/generated/prisma/client/client";
import type { upsertOwnCall as UpsertOwnCall } from "@/server/voice/call-rows";

/**
 * upsertOwnCall through the real Prisma client and query compiler, over a scripted
 * driver adapter in place of Postgres. This pins the SQL Prisma plans for the webhook's
 * two upsert shapes, and how it reports a conflict, which the mocked tests in
 * voice-webhook.test.ts take as given. The adapter answers as Postgres does: an
 * ON CONFLICT DO UPDATE whose WHERE is false returns no row; an INSERT on an existing
 * vapi_call_id is a unique violation. It is not a database test (see
 * voice-call-rows.postgres.test.ts for that).
 */

const ORG_B = "22222222-2222-4222-8222-222222222222";
const ASSISTANT_B = "33333333-3333-4333-8333-333333333333";

type Reply = { columnNames: string[]; columnTypes: number[]; rows: unknown[][] } | Error;
const TEXT = 7;
const noRows: Reply = { columnNames: [], columnTypes: [], rows: [] };
const idRow: Reply = { columnNames: ["id"], columnTypes: [TEXT], rows: [["row-1"]] };

function uniqueViolation(): Error {
  return Object.assign(new Error("duplicate key value violates unique constraint"), {
    name: "DriverAdapterError",
    cause: { kind: "UniqueConstraintViolation", constraint: { fields: ["vapi_call_id"] } },
  });
}

/** Records every statement; answers each with the first matching scripted reply. */
function scriptedAdapter(script: (sql: string) => Reply) {
  const statements: string[] = [];
  const queryable = {
    provider: "postgres" as const,
    adapterName: "@prisma/adapter-pg",
    async queryRaw({ sql }: { sql: string }) {
      statements.push(sql);
      const reply = script(sql);
      if (reply instanceof Error) throw reply;
      return reply;
    },
    async executeRaw({ sql }: { sql: string }) {
      statements.push(sql);
      return 1;
    },
  };
  const connection = {
    ...queryable,
    async executeScript() {},
    async startTransaction() {
      return {
        ...queryable,
        options: { usePhantomQuery: false },
        async commit() {},
        async rollback() {},
      };
    },
    async dispose() {},
  };
  return {
    statements,
    factory: {
      provider: "postgres" as const,
      adapterName: "@prisma/adapter-pg",
      async connect() {
        return connection;
      },
    },
  };
}

const call = {
  vapiCallId: "call-of-org-a",
  create: {
    organizationId: ORG_B,
    assistantId: ASSISTANT_B,
    vapiCallId: "call-of-org-a",
    startedAt: new Date("2026-10-11T08:00:00Z"),
    status: "IN_PROGRESS" as const,
  },
};
// The end-of-call-report shape (fields to update) and the status-update shape (none).
const reportUpdate = { status: "COMPLETED" as const, durationSeconds: 61 };
const statusUpdate = {};

let upsertOwnCall: typeof UpsertOwnCall;
let PrismaClient: typeof PrismaClientType;
beforeAll(async () => {
  ({ upsertOwnCall } = await import("@/server/voice/call-rows"));
  ({ PrismaClient } = await import("@/generated/prisma/client/client"));
  vi.spyOn(console, "error").mockImplementation(() => {});
});

function run(script: (sql: string) => Reply, update: object) {
  const adapter = scriptedAdapter(script);
  const db = new PrismaClient({ adapter: adapter.factory as never });
  return {
    statements: adapter.statements,
    result: upsertOwnCall(db, ORG_B, { ...call, update }),
  };
}

describe("upsertOwnCall on the real Prisma query compiler", () => {
  it("a report is one ON CONFLICT upsert that only updates a row of the assistant's organization", async () => {
    const { statements, result } = run(() => idRow, reportUpdate);

    await expect(result).resolves.toBe("ok");
    expect(statements).toHaveLength(1);
    expect(statements[0]).toMatch(/^INSERT INTO "public"\."voice_calls"/);
    expect(statements[0]).toContain('ON CONFLICT ("vapi_call_id") DO UPDATE SET');
    expect(statements[0]).toMatch(/WHERE \(.*"voice_calls"\."organization_id" = \$\d+\)/);
  });

  it("a report for another organization's call id updates nothing there and is reported foreign", async () => {
    // Postgres returns no row when the ON CONFLICT ... WHERE excludes the existing row.
    const { statements, result } = run(() => noRows, reportUpdate);

    await expect(result).resolves.toBe("foreign");
    expect(statements.some((sql) => /^UPDATE /.test(sql))).toBe(false);
  });

  it("a status-update for another organization's call id fails its INSERT and is reported foreign", async () => {
    const { statements, result } = run(
      (sql) => (sql.startsWith("INSERT") ? uniqueViolation() : noRows),
      statusUpdate,
    );

    await expect(result).resolves.toBe("foreign");
    // SELECT within the organization, INSERT (refused), then the conflict check.
    expect(statements[0]).toMatch(/^SELECT .*"organization_id" = \$\d+/);
    expect(statements[1]).toMatch(/^INSERT INTO "public"\."voice_calls"/);
    expect(statements[1]).not.toContain("ON CONFLICT");
    expect(statements.some((sql) => /^UPDATE /.test(sql))).toBe(false);
  });

  it("a status-update racing this organization's own first write retries and succeeds", async () => {
    let inserted = false;
    const { result } = run((sql) => {
      if (sql.startsWith("INSERT")) {
        inserted = true;
        return uniqueViolation();
      }
      // The row is visible to every SELECT after the refused INSERT.
      return inserted ? idRow : noRows;
    }, statusUpdate);

    await expect(result).resolves.toBe("ok");
  });

  it("any other database error propagates", async () => {
    const lost = Object.assign(new Error("connection terminated"), {
      name: "DriverAdapterError",
      cause: { kind: "postgres", code: "08006", severity: "FATAL", message: "terminated" },
    });
    const { result } = run(() => lost, reportUpdate);

    await expect(result).rejects.toThrow();
    await expect(result).rejects.not.toMatchObject({ code: "P2002" });
  });
});
