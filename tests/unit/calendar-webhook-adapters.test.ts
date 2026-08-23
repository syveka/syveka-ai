import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { googleCalendarAdapter } from "@/server/integrations/calendar/google";
import { microsoftCalendarAdapter } from "@/server/integrations/calendar/microsoft";
import { mockCalendarAdapter } from "@/server/integrations/calendar/mock";
import { ProviderError, type OAuthTokens } from "@/server/integrations/calendar/types";

const tokens: OAuthTokens = { accessToken: "access-token", scopes: [] };

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Google adapter: subscribeWebhook", () => {
  it("includes the verification secret as the watch channel token", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      jsonResponse({ resourceId: "res-1", expiration: `${Date.now() + 3_600_000}` }),
    );

    const sub = await googleCalendarAdapter.subscribeWebhook(
      tokens,
      "cal-1",
      "https://app.example.com/api/v1/webhooks/calendar/google",
      "my-verification-secret",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect(body.token).toBe("my-verification-secret");
    expect(body.type).toBe("web_hook");
    // The adapter never echoes the raw secret back in its return value.
    expect(sub).not.toHaveProperty("token");
    expect(sub).not.toHaveProperty("verificationSecret");
    expect(JSON.stringify(sub)).not.toContain("my-verification-secret");
  });
});

describe("Google adapter: createEvent (P2: unified booking lifecycle push)", () => {
  it("sends title/location/start/end with the given timezone, and never sends attendees (avoids Google auto-emailing the guest a duplicate invite)", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(jsonResponse({ id: "google-evt-1", etag: "etag-1" }));

    const result = await googleCalendarAdapter.createEvent!(tokens, "primary", {
      title: "Haircut with Maria",
      location: "Salon Helsinki",
      startsAt: new Date("2026-08-17T10:00:00Z"),
      endsAt: new Date("2026-08-17T10:30:00Z"),
      timezone: "Europe/Helsinki",
    });

    expect(result).toEqual({ externalId: "google-evt-1", etag: "etag-1" });
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect(body.summary).toBe("Haircut with Maria");
    expect(body.location).toBe("Salon Helsinki");
    expect(body.start).toEqual({
      dateTime: "2026-08-17T10:00:00.000Z",
      timeZone: "Europe/Helsinki",
    });
    expect(body).not.toHaveProperty("attendees");
  });
});

describe("Google adapter: cancelEvent (P2: unified booking lifecycle push)", () => {
  it("204 (deleted) resolves without throwing", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true, status: 204 } as Response);
    await expect(
      googleCalendarAdapter.cancelEvent!(tokens, "primary", "google-evt-1"),
    ).resolves.toBeUndefined();
  });

  it("404 (already gone) resolves without throwing - idempotent, required for the 'missing/deleted external event' edge case", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 404 } as Response);
    await expect(
      googleCalendarAdapter.cancelEvent!(tokens, "primary", "google-evt-1"),
    ).resolves.toBeUndefined();
  });

  it("410 (gone) resolves without throwing", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 410 } as Response);
    await expect(
      googleCalendarAdapter.cancelEvent!(tokens, "primary", "google-evt-1"),
    ).resolves.toBeUndefined();
  });

  it("401 throws a token_expired ProviderError", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 401 } as Response);
    await expect(
      googleCalendarAdapter.cancelEvent!(tokens, "primary", "google-evt-1"),
    ).rejects.toMatchObject({
      code: "token_expired",
    });
  });

  it("a real server error (500) throws a ProviderError, not a silent success", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false, status: 500 } as Response);
    await expect(
      googleCalendarAdapter.cancelEvent!(tokens, "primary", "google-evt-1"),
    ).rejects.toBeInstanceOf(ProviderError);
  });
});

describe("Microsoft adapter: subscribeWebhook", () => {
  it("includes the verification secret as clientState", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValue(
      jsonResponse({ id: "sub-1", expirationDateTime: new Date().toISOString() }),
    );

    const sub = await microsoftCalendarAdapter.subscribeWebhook(
      tokens,
      "cal-1",
      "https://app.example.com/api/v1/webhooks/calendar/microsoft",
      "my-verification-secret",
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const body = JSON.parse(init!.body as string);
    expect(body.clientState).toBe("my-verification-secret");
    expect(sub).not.toHaveProperty("clientState");
    expect(JSON.stringify(sub)).not.toContain("my-verification-secret");
  });
});

describe("MOCK adapter: subscribeWebhook", () => {
  it("accepts the verification secret parameter without requiring credentials", async () => {
    const sub = await mockCalendarAdapter.subscribeWebhook(
      tokens,
      "mock-primary",
      "https://app.example.com/api/v1/webhooks/calendar/mock",
      "any-secret",
    );
    expect(sub).not.toBeNull();
    expect(sub?.subscriptionId).toEqual(expect.any(String));
    expect(JSON.stringify(sub)).not.toContain("any-secret");
  });
});
