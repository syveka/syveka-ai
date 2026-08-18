import { describe, expect, it } from "vitest";
import { AuditLog, scrub } from "../core/reporting/audit.js";

describe("audit log: no secrets recorded", () => {
  it("redacts top-level keys that look credential-shaped", () => {
    const scrubbed = scrub({
      apiKey: "not-a-real-key-just-test-fixture-data",
      password: "hunter2",
      cookie: "session=abc",
      authorization: "Bearer xyz",
      note: "this part is fine",
    });
    expect(scrubbed.apiKey).toBe("[REDACTED]");
    expect(scrubbed.password).toBe("[REDACTED]");
    expect(scrubbed.cookie).toBe("[REDACTED]");
    expect(scrubbed.authorization).toBe("[REDACTED]");
    expect(scrubbed.note).toBe("this part is fine");
  });

  it("redacts credential-shaped keys nested inside objects, not just top-level", () => {
    const scrubbed = scrub({
      request: { headers: { Authorization: "Bearer xyz", Accept: "text/html" } },
    });
    const request = scrubbed.request as { headers: Record<string, unknown> };
    expect(request.headers.Authorization).toBe("[REDACTED]");
    expect(request.headers.Accept).toBe("text/html");
  });

  it("AuditLog.record scrubs every event unconditionally - a caller cannot opt out", () => {
    const log = new AuditLog("task-1");
    log.record("permission_granted", { action: "x", secretToken: "do-not-log-me" });
    const events = log.all();
    expect(events[0]!.data.secretToken).toBe("[REDACTED]");
  });
});
