import fs from "node:fs";
import path from "node:path";
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
  member: true,
  reserve: vi.fn(),
  order: [] as string[],
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
  redis: { eval: vi.fn() },
}));
vi.mock("@/server/ai/transcription-pilot", () => ({
  isTranscriptionPilotMember: () => m.member,
  reserveDailyTranscriptionAttempt: m.reserve,
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
      if (m.quotaExceeded) throw new EntitlementError("aiMessagesPerOrgMonth");
    }),
    recordUsage: m.recordUsage,
  };
});

import { POST } from "@/app/api/v1/ai/transcribe/route";

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
/** Real ~2 s Chromium MediaRecorder output (synthetic audio source). */
const REAL_WEBM = new Uint8Array(
  fs.readFileSync(path.join(__dirname, "fixtures/audio/chrome-opus-2s.webm")),
);
const webm = (size?: number) => {
  if (size === undefined) return REAL_WEBM.slice();
  const bytes = new Uint8Array(size);
  bytes.set([0x1a, 0x45, 0xdf, 0xa3]);
  return bytes;
};
/** A valid WebM/Opus file holding `packets` × 60 ms of audio in very few bytes. */
function longWebm(packets: number) {
  const el = (id: number[], body: number[], size?: number[]) => [
    ...id,
    ...(size ??
      (body.length < 0x7f
        ? [0x80 | body.length]
        : [0x40 | (body.length >> 8), body.length & 0xff])),
    ...body,
  ];
  const unknown = [0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff];
  const track = el(
    [0xae],
    [
      ...el([0xd7], [1]),
      ...el(
        [0x86],
        Array.from("A_OPUS", (c) => c.charCodeAt(0)),
      ),
    ],
  );
  const blocks = Array.from({ length: packets }, () => el([0xa3], [0x81, 0, 0, 0x80, 0x18]));
  return new Uint8Array([
    ...el([0x1a, 0x45, 0xdf, 0xa3], []),
    ...el([0x18, 0x53, 0x80, 0x67], [], unknown),
    ...el([0x16, 0x54, 0xae, 0x6b], track),
    ...el([0x1f, 0x43, 0xb6, 0x75], [], unknown),
    ...blocks.flat(),
  ]);
}

function request(
  body?: Uint8Array<ArrayBuffer> | null,
  extra: Record<string, string> = {},
  headers: Record<string, string> = { "sec-fetch-site": "same-origin" },
) {
  const form = new FormData();
  if (body) form.append("audio", new Blob([body], { type: "audio/webm" }), "recording");
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  return new Request("http://localhost/api/v1/ai/transcribe", {
    method: "POST",
    body: form,
    headers,
  });
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
  m.member = true;
  m.order = [];
  m.reserve.mockReset().mockImplementation(async () => {
    m.order.push("reserve");
    return { ok: true, used: 1 };
  });
  m.transcribe.mockReset().mockImplementation(async () => {
    m.order.push("provider");
    return "Hei, varaa aika huomiselle";
  });
  m.recordUsage.mockClear();
  vi.spyOn(console, "error").mockImplementation(() => {});
});

describe("POST /api/v1/ai/transcribe guardrails (checked before any paid call)", () => {
  it.each([
    ["Sec-Fetch-Site cross-site", { "sec-fetch-site": "cross-site" }],
    ["Sec-Fetch-Site same-site (sibling subdomain)", { "sec-fetch-site": "same-site" }],
    ["a foreign Origin", { origin: "https://evil.example", host: "localhost" }],
  ])(
    "403 for a cross-origin browser request (%s), before auth or any cost",
    async (_l, headers) => {
      const res = await call(request(webm(), {}, headers));
      expect(res).toEqual({ status: 403, body: { error: { code: "cross_origin_request" } } });
      expect(m.limit).not.toHaveBeenCalled();
      expect(m.transcribe).not.toHaveBeenCalled();
    },
  );

  it("allows same-origin requests by Origin/Host when Sec-Fetch-Site is absent", async () => {
    const res = await call(
      request(webm(), {}, { origin: "https://app.example", host: "app.example" }),
    );
    expect(res.status).toBe(200);
  });

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

  it("503 (fails closed) when the rate limiter couldn't reach Redis in time", async () => {
    m.rate = { success: false, unavailable: true, reset: 0, limit: 0, remaining: 0 };
    const res = await call(request(webm()));
    expect(res).toEqual({ status: 503, body: { error: { code: "transcription_unavailable" } } });
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

  it("422 when the decoded audio is longer than the recording limit (small file, long audio)", async () => {
    const file = longWebm(2000); // 2000 × 60 ms = 120 s, only ~20 kB
    expect(file.length).toBeLessThan(25_000);
    const res = await call(request(file));
    expect(res).toEqual({ status: 422, body: { error: { code: "audio_too_long" } } });
    expect(m.transcribe).not.toHaveBeenCalled();
    expect(m.recordUsage).not.toHaveBeenCalled();
  });

  it("accepts exactly 60 s and refuses 60.06 s (hard server cap, no tolerance)", async () => {
    expect((await call(request(longWebm(1000)))).status).toBe(200); // 60.00 s
    const over = await call(request(longWebm(1001))); // 60.06 s
    expect(over.body.error.code).toBe("audio_too_long");
  });

  it("415 when the audio can't be measured (container magic alone isn't enough)", async () => {
    const res = await call(request(webm(4096)));
    expect(res.body.error.code).toBe("unsupported_audio_format");
    expect(m.transcribe).not.toHaveBeenCalled();
  });

  it("415 when the bytes are not a supported audio container (declared type ignored)", async () => {
    const res = await call(request(new TextEncoder().encode("%PDF-1.7 ".repeat(200))));
    expect(res).toEqual({ status: 415, body: { error: { code: "unsupported_audio_format" } } });
    expect(m.transcribe).not.toHaveBeenCalled();
  });
});

describe("staging pilot: allowlist and daily attempts", () => {
  it("403 for a user outside the pilot allowlist, before any limit or reservation", async () => {
    m.member = false;
    const res = await call(request(webm()));
    expect(res).toEqual({ status: 403, body: { error: { code: "voice_not_enabled" } } });
    expect(m.limit).not.toHaveBeenCalled();
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.transcribe).not.toHaveBeenCalled();
  });

  it.each([
    ["unauthenticated", () => (m.ctx = null)],
    ["role without chat:use", () => (m.ctx = { orgId: ORG, userId: USER, role: "VIEWER" })],
    ["feature disabled", () => (m.enabled = false)],
    [
      "short-window rate limit",
      () => (m.rate = { success: false, reset: 0, limit: 20, remaining: 0 }),
    ],
    ["quota exhausted", () => (m.quotaExceeded = true)],
  ])("never reserves an attempt when refused for: %s", async (_label, arrange) => {
    arrange();
    await call(request(webm()));
    expect(m.reserve).not.toHaveBeenCalled();
    expect(m.transcribe).not.toHaveBeenCalled();
  });

  it.each([
    ["missing audio", () => request(null)],
    ["oversized upload", () => request(webm(2 * 1024 * 1024 + 1))],
    ["unmeasurable audio", () => request(webm(4096))],
    ["over-duration audio", () => request(longWebm(2000))],
  ])("never reserves an attempt for %s", async (_label, build) => {
    await call(build());
    expect(m.reserve).not.toHaveBeenCalled();
  });

  it("reserves exactly one attempt, immediately before the single provider call", async () => {
    const res = await call(request(webm()));
    expect(res.status).toBe(200);
    expect(m.order).toEqual(["reserve", "provider"]);
    expect(m.reserve).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ orgId: ORG, userId: USER }),
    );
  });

  it("429 daily_limit_reached when the day's attempts are used, without calling the provider", async () => {
    m.reserve.mockResolvedValue({ ok: false, used: 10 });
    const res = await call(request(webm()));
    expect(res).toEqual({ status: 429, body: { error: { code: "daily_limit_reached" } } });
    expect(m.transcribe).not.toHaveBeenCalled();
  });

  it("503 (fails closed) when the limit store is unavailable", async () => {
    m.reserve.mockRejectedValue(new Error("ECONNREFUSED"));
    const res = await call(request(webm()));
    expect(res).toEqual({ status: 503, body: { error: { code: "transcription_unavailable" } } });
    expect(m.transcribe).not.toHaveBeenCalled();
  });

  it("a failed provider attempt still consumed its reservation and is not retried", async () => {
    m.transcribe.mockImplementation(async () => {
      m.order.push("provider");
      throw Object.assign(new Error("upstream 500"), { status: 500 });
    });
    const res = await call(request(webm()));
    expect(res.status).toBe(502);
    expect(m.order).toEqual(["reserve", "provider"]); // one attempt, no refund step
  });
});

describe("provider outcomes", () => {
  it("200 returns the transcript only; the detected container picks the extension", async () => {
    const res = await call(request(webm()));
    expect(res).toEqual({ status: 200, body: { data: { text: "Hei, varaa aika huomiselle" } } });
    expect(m.transcribe.mock.calls[0]![1]).toBe("webm");
    expect(m.recordUsage).toHaveBeenCalledTimes(1);
    // Accounting uses the measured duration (observability, not a spending cap).
    const meta = (m.recordUsage.mock.calls[0] as unknown[])[3] as { audioSeconds: number };
    expect(meta.audioSeconds).toBeGreaterThan(1.7);
    expect(meta.audioSeconds).toBeLessThan(2.3);
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
