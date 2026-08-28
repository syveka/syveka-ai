import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { queryRawMock, pingMock } = vi.hoisted(() => ({
  queryRawMock: vi.fn(async () => [{ "?column?": 1 }]),
  pingMock: vi.fn(async () => "PONG"),
}));

vi.mock("@/server/db/tenant", () => ({
  unscopedPrisma: { $queryRaw: queryRawMock },
}));

vi.mock("@/server/integrations/redis", () => ({
  redis: { ping: pingMock },
}));

import { GET } from "@/app/api/health/route";

beforeEach(() => {
  vi.clearAllMocks();
  queryRawMock.mockResolvedValue([{ "?column?": 1 }]);
  pingMock.mockResolvedValue("PONG");
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/health", () => {
  it("reports healthy with 200 when both checks succeed", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "healthy",
      checks: { database: "ok", redis: "ok" },
    });
  });

  it("reports degraded with 503 when only the database check fails", async () => {
    queryRawMock.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.1:5432"));
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "degraded",
      checks: { database: "fail", redis: "ok" },
    });
  });

  it("reports degraded with 503 when only the redis check fails", async () => {
    pingMock.mockRejectedValue(new Error("Unauthorized"));
    const response = await GET();
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      status: "degraded",
      checks: { database: "ok", redis: "fail" },
    });
  });

  it("logs a sanitized, truncated error instead of swallowing the failure silently", async () => {
    queryRawMock.mockRejectedValue(
      new Error(
        "invalid connection string: postgresql://ci_user:super-secret-pw@db.internal:5432/app",
      ),
    );
    await GET();
    expect(console.error).toHaveBeenCalledTimes(1);
    const [label, details] = (console.error as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect(label).toBe("health check: database failed");
    expect(details.name).toBe("Error");
    expect(details.message).not.toContain("super-secret-pw");
    expect(details.message).toContain("[redacted-url]");
  });

  it("logs a non-reversible password fingerprint for DATABASE_URL on database failure, never the password itself", async () => {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL =
      "postgresql://postgres.abc:theRealPassword@aws-0-eu.pooler.supabase.com:6543/postgres";
    try {
      queryRawMock.mockRejectedValue(new Error("boom"));
      await GET();
      const calls = (console.error as ReturnType<typeof vi.fn>).mock.calls;
      expect(calls).toHaveLength(2);
      const [label, fingerprint] = calls[1]!;
      expect(label).toBe("health check: DATABASE_URL password fingerprint");
      expect(fingerprint).toBe(createHash("sha256").update("theRealPassword").digest("hex"));
      const serialized = JSON.stringify(calls);
      expect(serialized).not.toContain("theRealPassword");
    } finally {
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
  });
});
