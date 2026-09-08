/**
 * Standalone test suite for audit.ts - focused on redaction safety (the
 * property that actually matters here) and the withAudit wrapper's
 * success/failure/exception recording.
 *
 * Run: npx tsx scripts/poc/composio-calendar/lib/audit.test.ts
 */
import { scrub, CalendarAuditLog, withAudit } from "./audit.js";

let failures = 0;

function check(name: string, fn: () => void | Promise<void>): Promise<void> | void {
  const finish = (): void => console.log(`PASS: ${name}`);
  const fail = (err: unknown): void => {
    failures += 1;
    console.error(`FAIL: ${name}`);
    console.error(`  ${(err as Error).message}`);
  };
  try {
    const result = fn();
    if (result instanceof Promise) return result.then(finish, fail);
    finish();
  } catch (err) {
    fail(err);
  }
}

function assertEqual<T>(actual: T, expected: T, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg} - expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

function assertTrue(actual: boolean, msg: string): void {
  if (!actual) throw new Error(`expected true - ${msg}`);
}

async function main(): Promise<void> {
  console.log("=== audit.ts test suite ===\n");

  check("scrub: redacts top-level secret-shaped keys", () => {
    const out = scrub({ access_token: "shhh", client_secret: "shhh2", ok: "fine" });
    assertEqual(out.access_token, "[REDACTED]", "access_token redacted");
    assertEqual(out.client_secret, "[REDACTED]", "client_secret redacted");
    assertEqual(out.ok, "fine", "non-secret field untouched");
  });

  check("scrub: redacts nested secret-shaped keys recursively", () => {
    const out = scrub({ data: { headers: { Authorization: "Bearer xyz" }, id: "evt_1" } });
    const data = out.data as Record<string, unknown>;
    const headers = data.headers as Record<string, unknown>;
    assertEqual(headers.Authorization, "[REDACTED]", "nested Authorization redacted");
    assertEqual(data.id, "evt_1", "nested non-secret field untouched");
  });

  check("scrub: does not choke on arrays or null values", () => {
    const out = scrub({ list: [1, 2, 3], nothing: null });
    assertTrue(Array.isArray(out.list), "array preserved as array");
    assertEqual(out.nothing, null, "null preserved");
  });

  check(
    "CalendarAuditLog.record: CRITICAL - a caller-supplied secret-shaped field is redacted",
    () => {
      const log = new CalendarAuditLog();
      const entry = log.record({
        tenantOrgId: "org-test-poc",
        tenantUserId: "user-test-poc",
        operation: "createEvent",
        connectedAccountId: "ca_abc",
        success: true,
        durationMs: 12,
        // @ts-expect-error - deliberately smuggling a field the type doesn't declare, to prove scrub() still catches it at runtime
        accessToken: "should-never-survive",
      });
      assertEqual(
        (entry as unknown as Record<string, unknown>).accessToken,
        "[REDACTED]",
        "smuggled token redacted",
      );
    },
  );

  check("CalendarAuditLog.record: never includes event content beyond an id", () => {
    const log = new CalendarAuditLog();
    const entry = log.record({
      tenantOrgId: "org-test-poc",
      tenantUserId: "user-test-poc",
      operation: "getEvent",
      eventId: "evt_1",
      success: true,
      durationMs: 5,
    });
    assertTrue(!("summary" in entry), "no summary/title field exists on the record type");
    assertTrue(!("attendees" in entry), "no attendees field exists on the record type");
  });

  await check("withAudit: records success with duration and no thrown error", async () => {
    const log = new CalendarAuditLog();
    const result = await withAudit(
      log,
      { tenantOrgId: "org-test-poc", tenantUserId: "user-test-poc", operation: "listEvents" },
      async () => ({ success: true as const }),
      (r) => ({ success: r.success }),
    );
    assertTrue(result.success, "operation result returned normally");
    const records = log.all();
    assertEqual(records.length, 1, "one record written");
    assertEqual(records[0]?.success, true, "recorded as success");
    assertTrue(records[0]!.durationMs >= 0, "duration recorded");
  });

  await check("withAudit: records failure classification without throwing itself", async () => {
    const log = new CalendarAuditLog();
    await withAudit(
      log,
      { tenantOrgId: "org-test-poc", tenantUserId: "user-test-poc", operation: "createEvent" },
      async () => ({ success: false as const, errorClass: "PERMISSION_OR_SCOPE_ERROR" }),
      (r) => ({ success: r.success, errorClass: r.errorClass }),
    );
    const records = log.all();
    assertEqual(records[0]?.success, false, "recorded as failure");
    assertEqual(records[0]?.errorClass, "PERMISSION_OR_SCOPE_ERROR", "error class recorded");
  });

  await check("withAudit: an exception is still recorded before re-throwing", async () => {
    const log = new CalendarAuditLog();
    let threw = false;
    try {
      await withAudit(
        log,
        { tenantOrgId: "org-test-poc", tenantUserId: "user-test-poc", operation: "deleteEvent" },
        async () => {
          throw new Error("boom");
        },
        () => ({ success: true }),
      );
    } catch {
      threw = true;
    }
    assertTrue(threw, "exception must propagate to the caller");
    const records = log.all();
    assertEqual(records.length, 1, "one record written even though fn() threw");
    assertEqual(records[0]?.success, false, "recorded as failure on exception");
  });

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("audit.test failed:", (err as Error).message);
  process.exitCode = 1;
});
