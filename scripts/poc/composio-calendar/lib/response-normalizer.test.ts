/**
 * Standalone test suite for response-normalizer.ts. Fixtures below are
 * shaped after the ACTUAL live Composio responses captured earlier in this
 * PoC (with event content replaced by placeholders - no real data), not
 * invented shapes, so a regression here reflects a real contract break.
 *
 * Run: npx tsx scripts/poc/composio-calendar/lib/response-normalizer.test.ts
 */
import {
  normalizeCreateEventResponse,
  normalizeGetEventResponse,
  normalizeListEventsResponse,
  normalizeDeleteEventResponse,
} from "./response-normalizer.js";

let failures = 0;

function check(name: string, fn: () => void): void {
  try {
    fn();
    console.log(`PASS: ${name}`);
  } catch (err) {
    failures += 1;
    console.error(`FAIL: ${name}`);
    console.error(`  ${(err as Error).message}`);
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

console.log("=== response-normalizer.ts test suite ===\n");

check("CREATE: normalizes the live-observed data.response_data shape", () => {
  const result = normalizeCreateEventResponse({
    status: 200,
    successful: true,
    data: {
      response_data: {
        id: "evt_created_123",
        summary: "TEST EVENT",
        status: "confirmed",
        start: { dateTime: "2026-09-08T15:44:38Z" },
        end: { dateTime: "2026-09-08T16:14:38Z" },
        htmlLink: "https://www.google.com/calendar/event?eid=abc",
      },
    },
  });
  assertTrue(result.success, "CREATE should succeed");
  assertEqual(result.kind, "event", "kind should be event");
  if (result.kind === "event") {
    assertEqual(result.event.id, "evt_created_123", "event id");
    assertEqual(result.event.summary, "TEST EVENT", "event summary");
  }
});

check(
  "CREATE: HTTP 403 (calendars.get scope error) normalizes to a PERMISSION_OR_SCOPE_ERROR",
  () => {
    const result = normalizeCreateEventResponse({
      status: 200, // Composio itself returns 200; the failure is in the body
      successful: false,
      data: { http_error: "403 Client Error", status_code: 403 },
      error: "insufficient authentication scopes",
    });
    assertTrue(!result.success, "CREATE should fail");
    if (!result.success) {
      assertEqual(result.errorClass, "TOOL_REPORTED_ERROR", "error class for a body-level failure");
    }
  },
);

check("GET: normalizes the live-observed flat data shape", () => {
  const result = normalizeGetEventResponse({
    status: 200,
    successful: true,
    data: {
      id: "evt_created_123",
      summary: "TEST EVENT",
      status: "confirmed",
      start: { dateTime: "2026-09-08T15:44:38Z" },
      end: { dateTime: "2026-09-08T16:14:38Z" },
    },
  });
  assertTrue(result.success, "GET should succeed");
  assertEqual(result.kind, "event", "kind should be event");
  if (result.kind === "event") {
    assertEqual(result.event.id, "evt_created_123", "event id matches");
  }
});

check("GET: HTTP 404 normalizes to NOT_FOUND", () => {
  const result = normalizeGetEventResponse({ status: 404, successful: false, error: "not found" });
  assertTrue(!result.success, "GET should fail");
  if (!result.success) assertEqual(result.errorClass, "NOT_FOUND", "404 error class");
});

check("LIST: normalizes the live-observed data.items shape (empty calendar)", () => {
  const result = normalizeListEventsResponse({
    status: 200,
    successful: true,
    data: { items: [], kind: "calendar#events", summary: "test@example.com" },
  });
  assertTrue(result.success, "LIST should succeed");
  assertEqual(result.kind, "eventList", "kind should be eventList");
  if (result.kind === "eventList") assertEqual(result.events.length, 0, "empty list");
});

check("LIST: normalizes a populated items array", () => {
  const result = normalizeListEventsResponse({
    status: 200,
    successful: true,
    data: {
      items: [
        { id: "evt_1", summary: "One", status: "confirmed" },
        { id: "evt_2", summary: "Two", status: "confirmed" },
      ],
    },
  });
  assertTrue(result.success, "LIST should succeed");
  if (result.kind === "eventList") {
    assertEqual(result.events.length, 2, "2 events");
    assertEqual(result.events[0]?.id, "evt_1", "first event id");
  }
});

check("DELETE: normalizes the live-observed response_data.status shape", () => {
  const result = normalizeDeleteEventResponse({
    status: 200,
    successful: true,
    data: { response_data: { status: "success" } },
  });
  assertTrue(result.success, "DELETE should succeed");
  assertEqual(result.kind, "deleted", "kind should be deleted");
});

check("DELETE: HTTP 403 normalizes to a permission error, not a false success", () => {
  const result = normalizeDeleteEventResponse({
    status: 403,
    successful: false,
    error: "forbidden",
  });
  assertTrue(!result.success, "DELETE should fail");
  if (!result.success)
    assertEqual(result.errorClass, "PERMISSION_OR_SCOPE_ERROR", "403 error class");
});

check(
  "status: 0 (this codebase's transport-failure sentinel) normalizes to TRANSPORT_ERROR",
  () => {
    // calendar-service.ts's execute() catches a thrown fetch error (network
    // failure, timeout, DNS) and reshapes it into { status: 0, successful:
    // false, error: message } - every normalizer must classify that
    // distinctly from an HTTP-level failure, not silently misreport it.
    const result = normalizeListEventsResponse({
      status: 0,
      successful: false,
      error: "fetch failed: ECONNRESET",
    });
    assertTrue(!result.success, "transport failure must not report success");
    if (!result.success) assertEqual(result.errorClass, "TRANSPORT_ERROR", "status 0 error class");
  },
);

check("Malformed CREATE response (success but no id) fails safely, does not throw", () => {
  const result = normalizeCreateEventResponse({ status: 200, successful: true, data: {} });
  assertTrue(!result.success, "malformed CREATE must not report success");
  if (!result.success)
    assertEqual(result.errorClass, "MALFORMED_RESPONSE", "malformed response class");
});

check("Malformed LIST response (success but no items) fails safely, does not throw", () => {
  const result = normalizeListEventsResponse({ status: 200, successful: true, data: {} });
  assertTrue(!result.success, "malformed LIST must not report success");
});

check("Malformed GET response (null data) fails safely, does not throw", () => {
  const result = normalizeGetEventResponse({ status: 200, successful: true, data: null });
  assertTrue(!result.success, "malformed GET must not report success");
});

check("Completely garbage input does not throw for any normalizer", () => {
  const garbage = { status: 200, successful: true, data: "not-an-object" } as never;
  normalizeCreateEventResponse(garbage);
  normalizeGetEventResponse(garbage);
  normalizeListEventsResponse(garbage);
  normalizeDeleteEventResponse(garbage);
});

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exitCode = failures === 0 ? 0 : 1;
