import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV_KEYS = ["VAPI_API_KEY", "VAPI_WEBHOOK_SECRET", "VAPI_WEBHOOK_CREDENTIAL_ID"] as const;
const snapshot = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const SECRET = "vapi-webhook-secret-at-least-16-chars";

function sign(body: string, secret: string = SECRET): string {
  return createHmac("sha256", secret).update(body).digest("hex");
}

beforeEach(() => {
  delete process.env.SKIP_ENV_VALIDATION;
  process.env.VAPI_API_KEY = "vapi-api-key";
  process.env.VAPI_WEBHOOK_SECRET = SECRET;
  process.env.VAPI_WEBHOOK_CREDENTIAL_ID = "cred_vapi_test";
});

afterEach(() => {
  vi.unstubAllGlobals();
  for (const key of ENV_KEYS) {
    if (snapshot[key] === undefined) delete process.env[key];
    else process.env[key] = snapshot[key];
  }
});

/**
 * Real HMAC-SHA256 verification (no mocking) — this is the wire format a
 * Vapi Custom Credential produces with Algorithm=SHA256, Payload Format=
 * {body}, Signature Header=x-vapi-signature: hex digest of the raw body.
 * This half of the contract is independently confirmed by tracked
 * repository code (src/server/integrations/vapi.ts) and is unchanged by the
 * Custom Credential migration — verifyVapiSignature never accepted a raw
 * secret and still doesn't.
 */
describe("verifyVapiSignature — Vapi Custom Credential HMAC contract", () => {
  it("accepts a correctly signed body", async () => {
    const { verifyVapiSignature } = await import("@/server/integrations/vapi");
    const body = JSON.stringify({ message: { type: "status-update" } });
    expect(verifyVapiSignature(body, sign(body))).toBe(true);
  });

  it("rejects a tampered body signed for different content", async () => {
    const { verifyVapiSignature } = await import("@/server/integrations/vapi");
    const originalBody = JSON.stringify({ message: { type: "status-update" } });
    const signature = sign(originalBody);
    const tamperedBody = JSON.stringify({ message: { type: "end-of-call-report" } });
    expect(verifyVapiSignature(tamperedBody, signature)).toBe(false);
  });

  it("rejects a signature computed with the wrong secret", async () => {
    const { verifyVapiSignature } = await import("@/server/integrations/vapi");
    const body = JSON.stringify({ message: { type: "status-update" } });
    const wrongSignature = sign(body, "a-completely-different-secret-value");
    expect(verifyVapiSignature(body, wrongSignature)).toBe(false);
  });

  it("rejects a missing signature (fails closed)", async () => {
    const { verifyVapiSignature } = await import("@/server/integrations/vapi");
    const body = JSON.stringify({ message: { type: "status-update" } });
    expect(verifyVapiSignature(body, null)).toBe(false);
  });

  it("rejects an empty-string signature (fails closed, not treated as valid)", async () => {
    const { verifyVapiSignature } = await import("@/server/integrations/vapi");
    const body = JSON.stringify({ message: { type: "status-update" } });
    expect(verifyVapiSignature(body, "")).toBe(false);
  });

  it("rejects a well-formed but incorrect-length signature without throwing", async () => {
    const { verifyVapiSignature } = await import("@/server/integrations/vapi");
    const body = JSON.stringify({ message: { type: "status-update" } });
    expect(verifyVapiSignature(body, "deadbeef")).toBe(false);
  });

  /**
   * Regression guard specific to this migration: the legacy server.secret
   * mechanism made Vapi send the raw secret value verbatim as the header. If
   * verification ever regressed toward accepting a raw value again (instead
   * of requiring a real HMAC digest), this is the exact case that would
   * start passing incorrectly. The raw secret is never a valid HMAC-SHA256
   * hex digest of an arbitrary body, so it must be rejected.
   */
  it("rejects the raw legacy secret value presented as though it were the signature", async () => {
    const { verifyVapiSignature } = await import("@/server/integrations/vapi");
    const body = JSON.stringify({ message: { type: "status-update" } });
    expect(verifyVapiSignature(body, SECRET)).toBe(false);
  });

  /**
   * Documents current, intentional scope: this HMAC contract has no timestamp
   * binding (Vapi's timestamp header is optional and not configured here), so
   * a captured-and-replayed valid (body, signature) pair still verifies true.
   * Replay protection for the one side effect that matters (post-call
   * enqueue) is handled at the application layer — see the Redis dedupe
   * marker + QStash deduplicationId in the webhook route's end-of-call-report
   * handling — not at this signature layer. Not a gap introduced by this
   * change; recorded here so it isn't mistaken for one later.
   */
  it("does not by itself provide replay protection — a captured valid pair verifies again", async () => {
    const { verifyVapiSignature } = await import("@/server/integrations/vapi");
    const body = JSON.stringify({ message: { type: "end-of-call-report", call: { id: "c1" } } });
    const signature = sign(body);
    expect(verifyVapiSignature(body, signature)).toBe(true);
    expect(verifyVapiSignature(body, signature)).toBe(true);
  });
});

/**
 * Outbound assistant-sync payload shape. Vapi's Custom Credential mechanism
 * is referenced by ID, not by pushing the secret value in the request body —
 * this proves the migration actually removed the raw-secret outbound path,
 * not just added a new field alongside it.
 */
describe("upsertVapiAssistant — outbound server config uses credentialId, never a raw secret", () => {
  const baseConfig = {
    name: "Test Assistant",
    firstMessage: "Hello",
    systemPrompt: "You are helpful.",
    language: "fi" as const,
    voiceProvider: "azure",
    voiceId: null,
    serverUrl: "https://app.example.test/api/v1/voice/webhook",
    serverCredentialId: "cred_vapi_test",
    tools: [],
    maxDurationSeconds: 900,
  };

  it("PATCH body contains server.credentialId and no server.secret field", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ id: "assistant-1" }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { upsertVapiAssistant } = await import("@/server/integrations/vapi");
    await upsertVapiAssistant(baseConfig, "assistant-1");

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0]!;
    const sentBody = JSON.parse((init as RequestInit).body as string);

    expect(sentBody.server).toEqual({
      url: baseConfig.serverUrl,
      credentialId: baseConfig.serverCredentialId,
    });
    expect(sentBody.server.secret).toBeUndefined();
    expect(JSON.stringify(sentBody)).not.toContain('"secret"');
  });

  it("POST (create) body also contains server.credentialId and no server.secret field", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => ({
      ok: true,
      json: async () => ({ id: "assistant-new" }),
      text: async () => "",
    }));
    vi.stubGlobal("fetch", fetchMock);

    const { upsertVapiAssistant } = await import("@/server/integrations/vapi");
    await upsertVapiAssistant(baseConfig, null);

    const [, init] = fetchMock.mock.calls[0]!;
    const sentBody = JSON.parse((init as RequestInit).body as string);

    expect(sentBody.server).toEqual({
      url: baseConfig.serverUrl,
      credentialId: baseConfig.serverCredentialId,
    });
    expect(sentBody.server.secret).toBeUndefined();
  });
});
