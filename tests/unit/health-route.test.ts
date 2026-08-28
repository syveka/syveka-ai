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
    const calls = (console.error as ReturnType<typeof vi.fn>).mock.calls;
    const [label, details] = calls[0]!;
    expect(label).toBe("health check: database failed");
    expect(details.name).toBe("Error");
    expect(details.message).not.toContain("super-secret-pw");
    expect(details.message).toContain("[redacted-url]");
  });

  it("also logs safe, secret-free structural metadata for DATABASE_URL/DIRECT_URL on database failure", async () => {
    queryRawMock.mockRejectedValue(new Error("boom"));
    await GET();
    const calls = (console.error as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(4);
    expect(calls[1]![0]).toBe("health check: DATABASE_URL structure");
    expect(calls[2]![0]).toBe("health check: DIRECT_URL structure");
    expect(calls[3]![0]).toBe("health check: DATABASE_URL structure (post-sanitize)");
    const serialized = calls
      .slice(1)
      .map(([, details]) => JSON.stringify(details))
      .join("");
    expect(serialized).not.toMatch(/postgresql:\/\//);
  });
});
