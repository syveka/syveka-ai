import { describe, expect, it } from "vitest";
import { describeAiChatStreamError } from "@/server/ai/stream-error-log";

/** Only non-content identifiers may leave describeAiChatStreamError(). */
describe("describeAiChatStreamError", () => {
  it("keeps well-formed identifiers from a provider (Anthropic APIError-like) error", () => {
    const err = Object.assign(new Error("overloaded"), {
      name: "APIError",
      status: 529,
      request_id: "req_011CX",
      error: { type: "overloaded_error", message: "raw provider payload" },
      headers: { authorization: "Bearer sk-ant-secret" },
    });
    expect(describeAiChatStreamError(err)).toEqual({
      event: "ai_chat_stream_failed",
      name: "APIError",
      status: 529,
      code: null,
      requestId: "req_011CX",
    });
  });

  it.each([
    ["user text as name", { name: "my private question about salaries" }],
    ["credentialed URL as name", { name: "https://user:pw@db.example/x" }],
    ["bearer token as code", { code: "Bearer sk-ant-api03-secret-token-value" }],
    ["user text as code", { code: "contains spaces and user text" }],
    ["jwt-looking request id", { request_id: "eyJhbGciOi.eyJzdWIiOi.sig" }],
  ])("drops a non-identifier %s", (_label, fields) => {
    const described = describeAiChatStreamError(Object.assign(new Error("boom"), fields));
    const serialized = JSON.stringify(described);
    expect(serialized).not.toMatch(/private|salaries|user:pw|db\.example|sk-ant|Bearer|spaces|eyJ/);
  });

  it("never includes the error message, stack, headers, or provider body", () => {
    const err = Object.assign(
      new Error('Invalid prisma.message.create() { content: "secret text" }'),
      {
        headers: { authorization: "Bearer abc" },
        error: { message: "raw" },
      },
    );
    const serialized = JSON.stringify(describeAiChatStreamError(err));
    expect(serialized).not.toMatch(/secret text|prisma\.message|Bearer|raw|at .*\.ts/);
    expect(Object.keys(describeAiChatStreamError(err)).sort()).toEqual(
      ["code", "event", "name", "requestId", "status"].sort(),
    );
  });

  it("handles non-object throws without crashing", () => {
    expect(describeAiChatStreamError("a string with user text")).toMatchObject({
      event: "ai_chat_stream_failed",
      name: "unknown",
    });
    expect(describeAiChatStreamError(undefined)).toMatchObject({ name: "unknown", status: null });
  });
});
