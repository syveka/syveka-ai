import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * POST /api/v1/ai/transcribe. Mocked: the session, the Redis rate limiter,
 * billing usage/entitlements and the OpenAI transcription call (so no paid
 * request is made). Permissions and audio validation are real.
 */
const m = vi.hoisted(() => ({
  ctx: null as null | { orgId: string; userId: string; role: string },
  enabled: true,
  rate: { success: true, reset: Date.now() + 1000, limit: 20, remaining: 19 } as Record<
    string,
    unknown
  >,
  quotaExceeded: false,
  transcribe: vi.fn(),
  recordUsage: vi.fn(async () => {}),
  limit: vi.fn(),
}));

vi.mock("@/server/auth/session", () => ({
  getTenantContext: vi.fn(async () => {
    if (!m.ctx) throw new Error("unauthenticated");
    return m.ctx;
  }),
}));
vi.mock("@/env", () => ({ isChatTranscriptionEnabled: () => m.enabled }));
vi.mock("@/server/integrations/redis", () => ({
  limitAiTranscription: m.limit,
}));
vi.mock("@/server/integrations/openai", () => ({
  transcribeAudio: m.transcribe,
  TRANSCRIPTION_MODEL: "gpt-4o-mini-transcribe",
}));
vi.mock("@/server/services/billing/entitlements", () => {
  class EntitlementError extends Error {
    readonly code = "entitlement_exceeded";
    constructor(public readonly limit: string) {
      super("limit");
    }
  }
  return {
    EntitlementError,
    getMonthUsage: vi.fn(async () => 0),
    assertWithinLimit: vi.fn(async () => {
      if (m.quotaExceeded) throw new EntitlementError("aiMessagesPerUserMonth");
    }),
    recordUsage: m.recordUsage,
  };
});

import { POST } from "@/app/api/v1/ai/transcribe/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const webm = (size = 4096) => {
  const bytes = new Uint8Array(size);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
  return bytes;
};

function request(body?: Uint8Array<ArrayBuffer> | null, extra: Record<string, string> = {}) {
  const form = new FormData();
  if (body) form.append("audio", new Blob([body], { type: "audio/webm" }), "recording");
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return new Request("http://localhost/api/v1/ai/transcribe", { method: "POST", body: form });
}

async function call(req: Request) {
  const res = await POST(req);
  return {
    status: res.status,
    body: (await res.json()) as { data?: { text: string }; error: { code: string } },
  };
}

beforeEach(() => {
  m.ctx = { orgId: ORG, userId: USER, role: "MEMBER" };
  m.enabled = true;
  m.quotaExceeded = false;
  m.rate = { success: true, reset: Date.now() + 1000, limit: 20, remaining: 19 };
  m.limit.mockReset().mockImplementation(async () => m.rate);
  m.transcribe.mockReset().mockResolvedValue("Hei, varaa aika huomiselle");
  m.recordUsage.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/v1/ai/transcribe guardrails (checked before any paid call)", () => {
  it("401 without a session", async () => {
    m.ctx = null;
    expect((await call(request(webm()))).status).toBe(401);
    expect(m.transcribe).not.toHaveBeenCalled();
  });

  it("403 for a role without chat:use (VIEWER)", async () => {
    m.ctx = { orgId: ORG, userId: USER, role: "VIEWER" };
    const res = await call(request(webm()));
    expect(res).toEqual({ status: 403, body: { error: { code: "permission_denied" } } });
    expect(m.transcribe).not.toHaveBeenCalled();
  });

  it("503 when transcription is not enabled/configured", async () => {
    m.enabled = false;
    const res = await call(request(webm()));
    expect(res.body.error.code).toBe("transcription_unavailable");
    expect(res.status).toBe(503);
    expect(m.limit).not.toHaveBeenCalled();
    expect(m.transcribe).not.toHaveBeenCalled();
  });

  it("429 when rate limited, keyed by the session's org and user", async () => {
    m.rate = { success: false, reset: Date.now() + 30_000, limit: 20, remaining: 0, scope: "user" };
    const res = await call(request(webm()));
    expect(res.status).toBe(429);
    expect(m.limit).toHaveBeenCalledWith(ORG, USER);
    expect(m.transcribe).not.toHaveBeenCalled();
  });

  it("402 when the AI message quota is exhausted", async () => {
    m.quotaExceeded = true;
    const res = await call(request(webm()));
    expect(res).toEqual({ status: 402, body: { error: { code: "entitlement_exceeded" } } });
    expect(m.transcribe).not.toHaveBeenCalled();
  });

  it("ignores any client-supplied orgId/userId: usage is booked to the session", async () => {
    await call(request(webm(), { orgId: "99999999-9999-4999-8999-999999999999", userId: "x" }));
    expect(m.limit).toHaveBeenCalledWith(ORG, USER);
    expect(m.recordUsage).toHaveBeenCalledWith(
      ORG,
      "API_CALLS",
      1,
      expect.objectContaining({ kind: "ai_transcription", userId: USER }),
    );
  });
});

describe("audio validation (server-side, before the provider)", () => {
  it("400 without an audio file", async () => {
    expect((await call(request(null))).body.error.code).toBe("invalid_input");
  });

  it("413 when the declared body is too large, before parsing", async () => {
    const req = new Request("http://localhost/api/v1/ai/transcribe", {
      method: "POST",
      headers: { "content-length": String(10 * 1024 * 1024) },
      body: "x",
    });
    expect((await call(req)).status).toBe(413);
  });

  it("413 when the file exceeds the cap", async () => {
    const res = await call(request(webm(2 * 1024 * 1024 + 1)));
    expect(res.body.error.code).toBe("audio_too_large");
    expect(m.transcribe).not.toHaveBeenCalled();
  });

  it("422 for a near-empty recording", async () => {
    expect((await call(request(webm(200)))).body.error.code).toBe("audio_too_short");
  });

  it("415 when the bytes are not a supported audio container (declared type ignored)", async () => {
    const res = await call(request(new TextEncoder().encode("%PDF-1.7 ".repeat(200))));
    expect(res).toEqual({ status: 415, body: { error: { code: "unsupported_audio_format" } } });
    expect(m.transcribe).not.toHaveBeenCalled();
  });
});

describe("provider outcomes", () => {
  it("200 returns the transcript only; the detected container picks the extension", async () => {
    const res = await call(request(webm()));
    expect(res).toEqual({ status: 200, body: { data: { text: "Hei, varaa aika huomiselle" } } });
    expect(m.transcribe.mock.calls[0]![1]).toBe("webm");
    expect(m.recordUsage).toHaveBeenCalledTimes(1);
  });

  it("422 for an empty transcript, still accounted (the provider was paid)", async () => {
    m.transcribe.mockResolvedValue("");
    const res = await call(request(webm()));
    expect(res.body.error.code).toBe("empty_transcript");
    expect(m.recordUsage).toHaveBeenCalledTimes(1);
  });

  it("502 on provider failure, logging no transcript, audio or provider message", async () => {
    m.transcribe.mockRejectedValue(
      Object.assign(new Error("secret provider detail sk-live-abc"), { status: 500 }),
    );
    const res = await call(request(webm()));
    expect(res).toEqual({ status: 502, body: { error: { code: "transcription_failed" } } });
    const logged = JSON.stringify(vi.mocked(console.error).mock.calls);
    expect(logged).toContain("ai_transcription_failed");
    expect(logged).not.toContain("secret provider detail");
    expect(logged).not.toContain("sk-live");
    expect(m.recordUsage).not.toHaveBeenCalled();
  });

  it("504 when the provider exceeds the time bound", async () => {
    const timeout = new AbortController();
    const spy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
    m.transcribe.mockImplementation(
      (_a: unknown, _e: unknown, signal: AbortSignal) =>
        new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    const pending = call(request(webm()));
    await vi.waitFor(() => expect(m.transcribe).toHaveBeenCalled());
    expect(spy).toHaveBeenCalledWith(30_000);
    timeout.abort(new DOMException("timed out", "TimeoutError"));
    const res = await pending;
    spy.mockRestore();
    expect(res).toEqual({ status: 504, body: { error: { code: "transcription_timeout" } } });
  });
});
