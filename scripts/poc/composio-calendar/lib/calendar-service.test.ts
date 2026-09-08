/**
 * Standalone test suite for calendar-service.ts. Uses an in-memory mock
 * ToolExecutor - no network calls, no live Composio/Google access. Proves
 * both the normal-path behavior and the tenant-isolation/allowlist
 * enforcement the service is supposed to guarantee.
 *
 * Run: npx tsx scripts/poc/composio-calendar/lib/calendar-service.test.ts
 */
import {
  TenantComposioConnectionRegistry,
  type TenantComposioConnection,
} from "../tenant-binding.js";
import {
  CalendarService,
  CalendarServiceError,
  type ToolExecutor,
  type ToolExecutorRequest,
} from "./calendar-service.js";

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

async function assertRejects(
  p: Promise<unknown>,
  ErrorClass: new (...args: never[]) => Error,
  msg: string,
) {
  try {
    await p;
  } catch (err) {
    if (err instanceof ErrorClass) return;
    throw new Error(`${msg} - threw wrong error type: ${(err as Error).constructor.name}`);
  }
  throw new Error(`${msg} - did not reject`);
}

const TENANT_A = { orgId: "org-a", userId: "user-a" };
const TENANT_B = { orgId: "org-b", userId: "user-b" };

function buildRegistry(): TenantComposioConnectionRegistry {
  const registry = new TenantComposioConnectionRegistry();
  const connA: TenantComposioConnection = {
    organizationId: TENANT_A.orgId,
    userId: TENANT_A.userId,
    provider: "composio",
    toolkitSlug: "googlecalendar",
    composioConnectedAccountId: "ca_tenant_a",
    composioUserId: "syveka:org-a:user-a",
    status: "ACTIVE",
  };
  const connB: TenantComposioConnection = {
    organizationId: TENANT_B.orgId,
    userId: TENANT_B.userId,
    provider: "composio",
    toolkitSlug: "googlecalendar",
    composioConnectedAccountId: "ca_tenant_b",
    composioUserId: "syveka:org-b:user-b",
    status: "ACTIVE",
  };
  registry.register(connA);
  registry.register(connB);
  return registry;
}

function mockExecutor(calls: ToolExecutorRequest[]): ToolExecutor {
  return async (req) => {
    calls.push(req);
    switch (req.toolSlug) {
      case "GOOGLECALENDAR_EVENTS_LIST":
        return { status: 200, successful: true, data: { items: [] } };
      case "GOOGLECALENDAR_CREATE_EVENT":
        return {
          status: 200,
          successful: true,
          data: {
            response_data: {
              id: "evt_mock_1",
              summary: req.arguments.summary,
              status: "confirmed",
              start: { dateTime: "2026-09-08T15:44:38Z" },
              end: { dateTime: "2026-09-08T16:14:38Z" },
            },
          },
        };
      case "GOOGLECALENDAR_EVENTS_GET":
        return {
          status: 200,
          successful: true,
          data: { id: req.arguments.event_id, summary: "TEST EVENT", status: "confirmed" },
        };
      case "GOOGLECALENDAR_DELETE_EVENT":
        return { status: 200, successful: true, data: { response_data: { status: "success" } } };
    }
  };
}

async function main(): Promise<void> {
  console.log("=== calendar-service.ts test suite ===\n");

  await check(
    "listEvents: resolves the correct tenant's connection and calls LIST only",
    async () => {
      const calls: ToolExecutorRequest[] = [];
      const svc = new CalendarService(buildRegistry(), mockExecutor(calls));
      const result = await svc.listEvents(TENANT_A);
      assertEqual(result.success, true, "list should succeed");
      assertEqual(calls.length, 1, "exactly one tool call");
      assertEqual(calls[0]?.toolSlug, "GOOGLECALENDAR_EVENTS_LIST", "correct tool");
      assertEqual(calls[0]?.connectedAccountId, "ca_tenant_a", "tenant A's own connection used");
    },
  );

  await check(
    "createEvent: forces create_meeting_room false and never accepts attendees",
    async () => {
      const calls: ToolExecutorRequest[] = [];
      const svc = new CalendarService(buildRegistry(), mockExecutor(calls));
      const result = await svc.createEvent(TENANT_A, {
        summary: "TEST",
        startDateTime: "2026-09-08T15:00:00",
        durationMinutes: 30,
      });
      assertEqual(result.success, true, "create should succeed");
      assertEqual(calls[0]?.arguments.create_meeting_room, false, "conferencing always disabled");
      assertEqual(
        "attendees" in calls[0]!.arguments,
        false,
        "attendees never sent - not in the type",
      );
      assertEqual(
        "recurrence" in calls[0]!.arguments,
        false,
        "recurrence never sent - not in the type",
      );
    },
  );

  await check(
    "createEvent: CRITICAL - tenant A's context can never resolve to tenant B's connection",
    async () => {
      const calls: ToolExecutorRequest[] = [];
      const svc = new CalendarService(buildRegistry(), mockExecutor(calls));
      await svc.createEvent(TENANT_A, {
        summary: "TEST",
        startDateTime: "2026-09-08T15:00:00",
        durationMinutes: 30,
      });
      if (calls[0]?.connectedAccountId === "ca_tenant_b") {
        throw new Error("tenant A resolved to tenant B's connection - CROSS-TENANT LEAK");
      }
      assertEqual(calls[0]?.connectedAccountId, "ca_tenant_a", "must be tenant A's own connection");
    },
  );

  await check(
    "getEvent/deleteEvent: caller-supplied fields cannot smuggle a different connected_account_id",
    async () => {
      const calls: ToolExecutorRequest[] = [];
      const svc = new CalendarService(buildRegistry(), mockExecutor(calls));
      // Simulate a compromised/malicious call site trying to sneak an id into
      // eventId (the only string field an attacker fully controls here).
      await svc.getEvent(TENANT_A, { eventId: "ca_tenant_b" });
      assertEqual(
        calls[0]?.connectedAccountId,
        "ca_tenant_a",
        "connection is still tenant A's own",
      );
    },
  );

  await check("listEvents: unknown/unbound tenant fails closed, no tool call made", async () => {
    const calls: ToolExecutorRequest[] = [];
    const svc = new CalendarService(buildRegistry(), mockExecutor(calls));
    await assertRejects(
      svc.listEvents({ orgId: "org-nobody", userId: "user-nobody" }),
      CalendarServiceError,
      "unbound tenant must throw, not fall back",
    );
    assertEqual(calls.length, 0, "no tool call should have been attempted");
  });

  await check("listEvents: rejects a window larger than the maximum allowed", async () => {
    const svc = new CalendarService(buildRegistry(), mockExecutor([]));
    await assertRejects(
      svc.listEvents(TENANT_A, {
        timeMin: "2020-01-01T00:00:00Z",
        timeMax: "2030-01-01T00:00:00Z",
      }),
      CalendarServiceError,
      "10-year window must be rejected - no unbounded retrieval",
    );
  });

  await check(
    "listEvents: defaults to a bounded maxResults and sends it to the executor",
    async () => {
      const calls: ToolExecutorRequest[] = [];
      const svc = new CalendarService(buildRegistry(), mockExecutor(calls));
      await svc.listEvents(TENANT_A);
      assertEqual(calls[0]?.arguments.maxResults, 100, "default maxResults sent to the provider");
    },
  );

  await check(
    "listEvents: CRITICAL - rejects a maxResults above the provider's own ceiling, no unbounded result count",
    async () => {
      const calls: ToolExecutorRequest[] = [];
      const svc = new CalendarService(buildRegistry(), mockExecutor(calls));
      await assertRejects(
        svc.listEvents(TENANT_A, { maxResults: 999_999 }),
        CalendarServiceError,
        "absurd maxResults must be rejected before any tool call",
      );
      assertEqual(calls.length, 0, "no tool call for an out-of-bounds maxResults");
    },
  );

  await check("listEvents: rejects a non-positive maxResults", async () => {
    const svc = new CalendarService(buildRegistry(), mockExecutor([]));
    await assertRejects(
      svc.listEvents(TENANT_A, { maxResults: 0 }),
      CalendarServiceError,
      "zero maxResults must be rejected",
    );
  });

  await check("listEvents: rejects an inverted time window", async () => {
    const svc = new CalendarService(buildRegistry(), mockExecutor([]));
    await assertRejects(
      svc.listEvents(TENANT_A, {
        timeMin: "2026-09-10T00:00:00Z",
        timeMax: "2026-09-01T00:00:00Z",
      }),
      CalendarServiceError,
      "timeMax before timeMin must be rejected",
    );
  });

  await check(
    "createEvent: rejects a missing summary before ever calling the executor",
    async () => {
      const calls: ToolExecutorRequest[] = [];
      const svc = new CalendarService(buildRegistry(), mockExecutor(calls));
      await assertRejects(
        svc.createEvent(TENANT_A, {
          summary: "",
          startDateTime: "2026-09-08T15:00:00",
          durationMinutes: 30,
        }),
        CalendarServiceError,
        "empty summary must be rejected",
      );
      assertEqual(calls.length, 0, "no tool call for invalid input");
    },
  );

  await check(
    "getEvent/deleteEvent: rejects a missing eventId before calling the executor",
    async () => {
      const svc = new CalendarService(buildRegistry(), mockExecutor([]));
      await assertRejects(
        svc.getEvent(TENANT_A, { eventId: "" }),
        CalendarServiceError,
        "empty eventId must be rejected for GET",
      );
      await assertRejects(
        svc.deleteEvent(TENANT_A, { eventId: "" }),
        CalendarServiceError,
        "empty eventId must be rejected for DELETE",
      );
    },
  );

  await check("deleteEvent: normal path succeeds and returns a deleted result", async () => {
    const svc = new CalendarService(buildRegistry(), mockExecutor([]));
    const result = await svc.deleteEvent(TENANT_A, { eventId: "evt_mock_1" });
    assertEqual(result.success, true, "delete should succeed");
    assertEqual(result.kind, "deleted", "kind should be deleted");
  });

  await check(
    "listEvents: a throwing executor (network failure) resolves to a safe failed result, not an uncaught rejection",
    async () => {
      const throwingExecutor: ToolExecutor = async () => {
        throw new Error("fetch failed: ECONNRESET");
      };
      const svc = new CalendarService(buildRegistry(), throwingExecutor);
      const result = await svc.listEvents(TENANT_A); // must not throw
      assertEqual(result.success, false, "transport failure must resolve to success:false");
      if (!result.success)
        assertEqual(result.errorClass, "TRANSPORT_ERROR", "transport error class");
    },
  );

  console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
  process.exitCode = failures === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error("calendar-service.test failed:", (err as Error).message);
  process.exitCode = 1;
});
