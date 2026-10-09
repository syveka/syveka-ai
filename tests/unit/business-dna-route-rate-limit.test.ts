import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PUT /api/v1/business-dna: profile saves are rate-limited per organization
 * (each one re-syncs the organization's live voice assistants). Mocked: the
 * permission guard, the limiter and the save itself.
 */
const m = vi.hoisted(() => ({
  limit: vi.fn(async (_key: string) => ({
    success: true,
    limit: 30,
    remaining: 29,
    reset: Date.now() + 60_000,
  })),
  upsert: vi.fn(async () => ({ id: "bd-1" })),
  role: "MANAGER" as string,
}));

vi.mock("@/server/auth/guard", async () => {
  const { AuthError } = await import("@/server/auth/session");
  return {
    requirePermission: vi.fn(async (permission: string) => {
      if (permission === "business-dna:write" && !["MANAGER", "ADMIN", "OWNER"].includes(m.role)) {
        throw new AuthError("forbidden", 403);
      }
      return {
        orgId: "org-a",
        userId: "user-1",
        role: m.role,
        email: "u@example.com",
        locale: "en",
      };
    }),
  };
});
vi.mock("@/server/integrations/redis", () => ({
  rateLimiters: { businessDnaWrite: { limit: m.limit } },
}));
vi.mock("@/server/services/business-dna", () => ({
  getBusinessDNA: vi.fn(),
  upsertBusinessDNA: m.upsert,
}));

import { PUT } from "@/app/api/v1/business-dna/route";

const put = (body: unknown) =>
  PUT(
    new Request("http://localhost/api/v1/business-dna", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
  );

beforeEach(() => {
  vi.clearAllMocks();
  m.role = "MANAGER";
});

describe("PUT /api/v1/business-dna rate limit", () => {
  it("counts each save against the organization's limit", async () => {
    const res = await put({ displayName: "Acme" });

    expect(res.status).toBe(200);
    expect(m.limit).toHaveBeenCalledWith("org-a");
    expect(m.upsert).toHaveBeenCalledTimes(1);
  });

  it("answers 429 with Retry-After and saves nothing once the limit is reached", async () => {
    m.limit.mockResolvedValueOnce({
      success: false,
      limit: 30,
      remaining: 0,
      reset: Date.now() + 120_000,
    });

    const res = await put({ displayName: "Acme" });

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: { code: "rate_limited" } });
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("checks the permission before counting anything", async () => {
    m.role = "MEMBER";

    const res = await put({ displayName: "Acme" });

    expect(res.status).toBe(403);
    expect(m.limit).not.toHaveBeenCalled();
    expect(m.upsert).not.toHaveBeenCalled();
  });

  it("answers 503 and saves nothing when the limit can't be checked", async () => {
    m.limit.mockRejectedValueOnce(new Error("ECONNREFUSED"));

    const res = await put({ displayName: "Acme" });

    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: { code: "service_unavailable" } });
    expect(m.upsert).not.toHaveBeenCalled();
  });
});
