/**
 * Opt-in, explicit live smoke harness for the Syveka Google Calendar PoC:
 * LIST -> CREATE -> GET -> DELETE against a real, already-connected custom
 * OAuth test account, using CalendarService (scripts/poc/composio-calendar/lib).
 *
 * SAFETY DESIGN - read before running:
 *
 * - Never runs in normal CI or as a side effect of `npm test`/`npm run
 *   typecheck` etc. It is only ever invoked directly:
 *     npx tsx scripts/live-smoke/composio-calendar-smoke.ts
 * - Requires LIVE_SMOKE_ENABLED=true. Absent that, it prints a SKIPPED
 *   report and exits 0 - this is the expected state in every automated
 *   context.
 * - Requires five more env vars (below) naming the exact custom auth config,
 *   connected account, and TEST tenant identity to use. There is no
 *   discovery/guessing of any of these - all must be supplied explicitly.
 * - Before any mutation, independently re-verifies (via
 *   security-contract.ts, fail-closed):
 *     - the auth config is NOT Composio-managed (rejects the shared managed
 *       OAuth client outright)
 *     - OAuth scopes are exactly the two approved scopes
 *     - the execution allowlist is exactly the four approved tools
 *     - the connected account is ACTIVE and bound to exactly the expected
 *       TEST identity (rejects any pg-test-* or other mismatched identity)
 * - LIST runs first; if the calendar is not empty, the harness stops before
 *   any mutation (refuses to assume an existing event is safe to ignore).
 * - CREATE makes exactly one clearly-labeled disposable event (no
 *   attendees, no recurrence, no conferencing - enforced by
 *   CalendarService's CreateEventInput type, not just by the arguments this
 *   script happens to pass).
 * - Cleanup (DELETE of the exact event id this run created) is attempted in
 *   a finally block - if CREATE succeeds but GET fails, cleanup still runs.
 *   This script will NEVER delete any event id other than the one its own
 *   CREATE call returned.
 * - Every stage is timed and audited via CalendarAuditLog (secrets
 *   scrubbed); the final report never includes a raw provider payload,
 *   token, or client credential.
 *
 * Required environment variables (only read when LIVE_SMOKE_ENABLED=true):
 *   COMPOSIO_API_KEY
 *   LIVE_SMOKE_AUTH_CONFIG_ID       e.g. ac_xJH5GAyq03KJ (the custom config)
 *   LIVE_SMOKE_CONNECTED_ACCOUNT_ID e.g. ca_ZKv0PWsGs8J4
 *   LIVE_SMOKE_TENANT_ORG_ID        e.g. org-test-poc
 *   LIVE_SMOKE_TENANT_USER_ID       e.g. user-test-poc
 */
import {
  TenantComposioConnectionRegistry,
  type TenantComposioConnection,
} from "../poc/composio-calendar/tenant-binding.js";
import {
  assertAuthConfigContract,
  assertTenantBindingContract,
  SecurityContractViolation,
} from "../poc/composio-calendar/lib/security-contract.js";
import {
  CalendarService,
  createComposioToolExecutor,
} from "../poc/composio-calendar/lib/calendar-service.js";
import { CalendarAuditLog, withAudit } from "../poc/composio-calendar/lib/audit.js";

const BASE_URL = process.env.COMPOSIO_BASE_URL || "https://backend.composio.dev";
const EVENT_TITLE = "SYVEKA LIVE SMOKE TEST — SAFE TO DELETE";

interface StageResult {
  stage: string;
  ok: boolean;
  detail: string;
  durationMs: number;
}

function maskSecretShaped(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(maskSecretShaped);
  if (obj && typeof obj === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = /key|token|secret|password|credential/i.test(k) ? "[REDACTED]" : maskSecretShaped(v);
    }
    return out;
  }
  return obj;
}

async function fetchAuthConfig(
  apiKey: string,
  authConfigId: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(new URL(`/api/v3.1/auth_configs/${authConfigId}`, BASE_URL), {
    headers: { "x-api-key": apiKey },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Failed to read auth config ${authConfigId}: HTTP ${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

async function fetchConnectedAccount(
  apiKey: string,
  connectedAccountId: string,
): Promise<Record<string, unknown>> {
  const res = await fetch(new URL(`/api/v3.1/connected_accounts/${connectedAccountId}`, BASE_URL), {
    headers: { "x-api-key": apiKey },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Failed to read connected account ${connectedAccountId}: HTTP ${res.status}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

function extractScopes(authConfigDetail: Record<string, unknown>): unknown {
  const creds = authConfigDetail.credentials as Record<string, unknown> | undefined;
  return creds?.scopes;
}

async function main(): Promise<void> {
  if (process.env.LIVE_SMOKE_ENABLED !== "true") {
    console.log(
      "=== Composio Calendar live smoke: SKIPPED ===\n" +
        'LIVE_SMOKE_ENABLED is not "true" - this is the expected state in CI and normal ' +
        "development. No network call was made. To run this deliberately: set LIVE_SMOKE_ENABLED=true " +
        "plus COMPOSIO_API_KEY, LIVE_SMOKE_AUTH_CONFIG_ID, LIVE_SMOKE_CONNECTED_ACCOUNT_ID, " +
        "LIVE_SMOKE_TENANT_ORG_ID, LIVE_SMOKE_TENANT_USER_ID.",
    );
    process.exitCode = 0;
    return;
  }

  const apiKey = process.env.COMPOSIO_API_KEY;
  const authConfigId = process.env.LIVE_SMOKE_AUTH_CONFIG_ID;
  const connectedAccountId = process.env.LIVE_SMOKE_CONNECTED_ACCOUNT_ID;
  const tenantOrgId = process.env.LIVE_SMOKE_TENANT_ORG_ID;
  const tenantUserId = process.env.LIVE_SMOKE_TENANT_USER_ID;

  const missing = [
    ["COMPOSIO_API_KEY", apiKey],
    ["LIVE_SMOKE_AUTH_CONFIG_ID", authConfigId],
    ["LIVE_SMOKE_CONNECTED_ACCOUNT_ID", connectedAccountId],
    ["LIVE_SMOKE_TENANT_ORG_ID", tenantOrgId],
    ["LIVE_SMOKE_TENANT_USER_ID", tenantUserId],
  ].filter(([, v]) => !v);
  if (missing.length > 0) {
    console.error(
      `BLOCKED: LIVE_SMOKE_ENABLED=true but missing required env var(s): ${missing.map((m) => m[0]).join(", ")}`,
    );
    process.exitCode = 1;
    return;
  }

  const stages: StageResult[] = [];
  const audit = new CalendarAuditLog();
  let createdEventId: string | undefined;

  const runStage = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const start = Date.now();
    try {
      const result = await fn();
      stages.push({ stage: name, ok: true, detail: "ok", durationMs: Date.now() - start });
      return result;
    } catch (err) {
      stages.push({
        stage: name,
        ok: false,
        detail: (err as Error).message,
        durationMs: Date.now() - start,
      });
      throw err;
    }
  };

  try {
    console.log("=== Composio Calendar live smoke: RUNNING ===\n");

    await runStage("verify auth config contract", async () => {
      const detail = await fetchAuthConfig(apiKey!, authConfigId!);
      assertAuthConfigContract({
        authConfigId: authConfigId!,
        status: detail.status,
        isComposioManaged: detail.is_composio_managed,
        scopes: extractScopes(detail),
        executionAllowlist: (
          detail.tool_access_config as { tools_available_for_execution?: unknown[] } | undefined
        )?.tools_available_for_execution,
      });
    });

    const expectedComposioUserId = `syveka:${tenantOrgId}:${tenantUserId}`;
    await runStage("verify tenant binding contract", async () => {
      const detail = await fetchConnectedAccount(apiKey!, connectedAccountId!);
      assertTenantBindingContract({
        expectedComposioUserId,
        reportedUserId: detail.user_id,
        connectionStatus: detail.status,
      });
    });

    const registry = new TenantComposioConnectionRegistry();
    const connection: TenantComposioConnection = {
      organizationId: tenantOrgId!,
      userId: tenantUserId!,
      provider: "composio",
      toolkitSlug: "googlecalendar",
      composioConnectedAccountId: connectedAccountId!,
      composioUserId: expectedComposioUserId,
      status: "ACTIVE",
    };
    registry.register(connection);
    const ctx = { orgId: tenantOrgId!, userId: tenantUserId! };
    const service = new CalendarService(registry, createComposioToolExecutor(apiKey!));

    const listResult = await runStage("LIST (pre-check calendar is empty)", () =>
      withAudit(
        audit,
        {
          tenantOrgId: tenantOrgId!,
          tenantUserId: tenantUserId!,
          operation: "listEvents",
          connectedAccountId,
        },
        () => service.listEvents(ctx),
        (r) => ({ success: r.success, errorClass: r.success ? undefined : r.errorClass }),
      ),
    );
    if (!listResult.success) {
      throw new Error(`LIST failed: ${listResult.message}`);
    }
    if (listResult.kind === "eventList" && listResult.events.length > 0) {
      throw new Error(
        `Calendar is not empty (${listResult.events.length} existing event(s)) - refusing to CREATE.`,
      );
    }

    const start = new Date(Date.now() + 60 * 60 * 1000);
    const toIso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "");
    const createResult = await runStage("CREATE (one disposable event)", () =>
      withAudit(
        audit,
        {
          tenantOrgId: tenantOrgId!,
          tenantUserId: tenantUserId!,
          operation: "createEvent",
          connectedAccountId,
        },
        () =>
          service.createEvent(ctx, {
            summary: EVENT_TITLE,
            startDateTime: toIso(start),
            durationMinutes: 15,
            timezone: "UTC",
          }),
        (r) => ({ success: r.success, errorClass: r.success ? undefined : r.errorClass }),
      ),
    );
    if (!createResult.success) {
      throw new Error(`CREATE failed: ${createResult.message}`);
    }
    if (createResult.kind !== "event") {
      throw new Error("CREATE reported success but did not return an event.");
    }
    createdEventId = createResult.event.id;

    const getResult = await runStage("GET (verify the exact created event)", () =>
      withAudit(
        audit,
        {
          tenantOrgId: tenantOrgId!,
          tenantUserId: tenantUserId!,
          operation: "getEvent",
          connectedAccountId,
          eventId: createdEventId,
        },
        () => service.getEvent(ctx, { eventId: createdEventId! }),
        (r) => ({ success: r.success, errorClass: r.success ? undefined : r.errorClass }),
      ),
    );
    if (!getResult.success) throw new Error(`GET failed: ${getResult.message}`);
    if (getResult.kind !== "event") {
      throw new Error("GET reported success but did not return an event.");
    }
    if (getResult.event.id !== createdEventId || getResult.event.summary !== EVENT_TITLE) {
      throw new Error("GET returned an event that does not match what CREATE just made.");
    }

    console.log("\n=== LIVE CALENDAR SMOKE: PASS ===");
  } catch (err) {
    console.error(`\n=== LIVE CALENDAR SMOKE: BLOCKED - ${(err as Error).message} ===`);
    process.exitCode = 1;
  } finally {
    if (createdEventId && apiKey && connectedAccountId && tenantOrgId && tenantUserId) {
      const registry = new TenantComposioConnectionRegistry();
      registry.register({
        organizationId: tenantOrgId,
        userId: tenantUserId,
        provider: "composio",
        toolkitSlug: "googlecalendar",
        composioConnectedAccountId: connectedAccountId,
        composioUserId: `syveka:${tenantOrgId}:${tenantUserId}`,
        status: "ACTIVE",
      });
      const service = new CalendarService(registry, createComposioToolExecutor(apiKey));
      const ctx = { orgId: tenantOrgId, userId: tenantUserId };
      try {
        const deleteResult = await runStage(`cleanup DELETE ${createdEventId}`, () =>
          withAudit(
            audit,
            {
              tenantOrgId,
              tenantUserId,
              operation: "deleteEvent",
              connectedAccountId,
              eventId: createdEventId,
            },
            () => service.deleteEvent(ctx, { eventId: createdEventId! }),
            (r) => ({ success: r.success, errorClass: r.success ? undefined : r.errorClass }),
          ),
        );
        if (!deleteResult.success) {
          console.error(
            `CLEANUP WARNING: DELETE of ${createdEventId} did not succeed - manual review needed.`,
          );
          process.exitCode = 1;
        }
      } catch (cleanupErr) {
        console.error(
          `CLEANUP WARNING: DELETE of ${createdEventId} threw - manual review needed: ${(cleanupErr as Error).message}`,
        );
        process.exitCode = 1;
      }
    }

    console.log("\n=== Stage report (timings, no secrets) ===");
    for (const s of stages) {
      console.log(
        `  [${s.ok ? "OK" : "FAIL"}] ${s.stage} - ${s.durationMs}ms${s.ok ? "" : ` - ${s.detail}`}`,
      );
    }
    console.log("\n=== Audit records (scrubbed) ===");
    console.log(JSON.stringify(maskSecretShaped(audit.all()), null, 2));
  }
}

main().catch((err) => {
  if (err instanceof SecurityContractViolation) {
    console.error(`BLOCKED (security contract): ${err.message}`);
  } else {
    console.error("live smoke harness failed:", (err as Error).message);
  }
  process.exitCode = 1;
});
