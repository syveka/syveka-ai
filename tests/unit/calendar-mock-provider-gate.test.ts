import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The MOCK calendar provider is a test double. It is offered and connectable
 * outside production, and in production only with CALENDAR_MOCK_PROVIDER=1:
 * the gate is the adapter's own isConfigured(), which startConnectionUrl
 * checks for every provider, so hiding it from the settings list is not the
 * only thing keeping a fake calendar out of a production organization.
 */
vi.mock("@/server/db/tenant", () => ({ unscopedPrisma: {}, tenantDb: vi.fn() }));
vi.mock("@/server/services/audit", () => ({ audit: vi.fn() }));

import { listAvailableProviders } from "@/server/integrations/calendar";
import { mockCalendarAdapter } from "@/server/integrations/calendar/mock";
import { ConnectionError, startConnectionUrl } from "@/server/services/calendar-connections";
import type { TenantContext } from "@/server/auth/session";

const ctx: TenantContext = {
  orgId: "11111111-1111-4111-8111-111111111111",
  userId: "22222222-2222-4222-8222-222222222222",
  email: "owner@example.test",
  role: "OWNER",
  locale: "en",
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("MOCK calendar provider availability", () => {
  it("outside production it is configured, listed and connectable", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CALENDAR_MOCK_PROVIDER", "");
    vi.stubEnv("CALENDAR_OAUTH_STATE_SECRET", "a-test-secret-of-sufficient-length");

    expect(mockCalendarAdapter.isConfigured()).toBe(true);
    expect(listAvailableProviders().map((p) => p.provider)).toContain("MOCK");
    expect(startConnectionUrl(ctx, "MOCK")).toContain("code=mock-auth-code");
  });

  it("in production it is neither listed nor connectable: not_configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CALENDAR_MOCK_PROVIDER", "");
    vi.stubEnv("CALENDAR_OAUTH_STATE_SECRET", "a-test-secret-of-sufficient-length");

    expect(mockCalendarAdapter.isConfigured()).toBe(false);
    expect(listAvailableProviders().map((p) => p.provider)).not.toContain("MOCK");
    let error: unknown;
    try {
      startConnectionUrl(ctx, "MOCK");
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ConnectionError);
    expect((error as ConnectionError).code).toBe("not_configured");
  });

  it("in production CALENDAR_MOCK_PROVIDER=1 enables it explicitly (staging E2E)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CALENDAR_MOCK_PROVIDER", "1");
    vi.stubEnv("CALENDAR_OAUTH_STATE_SECRET", "a-test-secret-of-sufficient-length");

    expect(mockCalendarAdapter.isConfigured()).toBe(true);
    expect(listAvailableProviders().map((p) => p.provider)).toContain("MOCK");
    expect(startConnectionUrl(ctx, "MOCK")).toContain("code=mock-auth-code");
  });
});
