/**
 * Phase 7 (custom-OAuth PoC continuation, CREATE only): exactly ONE
 * GOOGLECALENDAR_CREATE_EVENT call against the new custom-OAuth connected
 * account. No GET, DELETE, LIST, UPDATE, or any other tool is referenced
 * anywhere in this file - this script stops immediately after CREATE, per
 * explicit instruction.
 *
 * Goes through the same tenant-binding enforcement choke point as every
 * other execution script in this PoC (buildToolExecuteRequest) - the
 * connected_account_id is resolved only from the server-verified TEST
 * tenant context, never a caller-supplied value.
 *
 * Fixed, hardcoded safe event parameters - nothing about the event's
 * content is caller-configurable: no attendees, no recurrence, no
 * conference link, ~30 minute duration, near-future start time.
 *
 * Run: COMPOSIO_API_KEY=... npx tsx scripts/poc/composio-calendar/create-event-only.ts <connected_account_id>
 */
import {
  TenantComposioConnectionRegistry,
  buildToolExecuteRequest,
  type TenantComposioConnection,
} from "./tenant-binding.js";

export {};

const BASE_URL = process.env.COMPOSIO_BASE_URL || "https://backend.composio.dev";
const TEST_ORG_ID = "org-test-poc";
const TEST_USER_ID = "user-test-poc";
const TEST_COMPOSIO_USER_ID = `syveka:${TEST_ORG_ID}:${TEST_USER_ID}`;
const CALENDAR_ID = "primary";
const EVENT_TITLE = "SYVEKA POC CALENDAR TEST";

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

async function main(): Promise<void> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    console.error("COMPOSIO_API_KEY is not set - failing closed.");
    process.exitCode = 1;
    return;
  }
  const connectedAccountId = process.argv[2];
  if (!connectedAccountId) {
    console.error("Usage: npx tsx create-event-only.ts <connected_account_id> - failing closed.");
    process.exitCode = 1;
    return;
  }

  const registry = new TenantComposioConnectionRegistry();
  const expectedConn: TenantComposioConnection = {
    organizationId: TEST_ORG_ID,
    userId: TEST_USER_ID,
    provider: "composio",
    toolkitSlug: "googlecalendar",
    composioConnectedAccountId: connectedAccountId,
    composioUserId: TEST_COMPOSIO_USER_ID,
    status: "ACTIVE",
  };
  registry.register(expectedConn);

  const now = new Date();
  const start = new Date(now.getTime() + 60 * 60 * 1000); // 1 hour from now
  const toIso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "");

  const createArgs = {
    calendar_id: CALENDAR_ID,
    summary: EVENT_TITLE,
    start_datetime: toIso(start),
    event_duration_minutes: 30,
    create_meeting_room: false,
    timezone: "UTC",
  };
  const req = buildToolExecuteRequest(
    registry,
    { orgId: TEST_ORG_ID, userId: TEST_USER_ID },
    createArgs,
  );

  if (req.connected_account_id !== connectedAccountId) {
    console.error(
      "FAIL CLOSED: tenant-resolved connected_account_id does not match the requested connection.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("=== GOOGLECALENDAR_CREATE_EVENT (single disposable event) ===");
  console.log(`connected_account_id: ${req.connected_account_id}`);
  console.log("arguments:", JSON.stringify(req.arguments, null, 2));

  const res = await fetch(
    new URL("/api/v3.1/tools/execute/GOOGLECALENDAR_CREATE_EVENT", BASE_URL),
    {
      method: "POST",
      headers: { "x-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        connected_account_id: req.connected_account_id,
        entity_id: TEST_COMPOSIO_USER_ID,
        arguments: req.arguments,
      }),
    },
  );
  const body = (await res.json().catch(() => null)) as {
    data?: Record<string, unknown>;
    successful?: boolean;
    error?: unknown;
  } | null;

  console.log(`\n-> HTTP ${res.status}`);
  console.log(`successful: ${body?.successful}`);
  if (body?.error) console.log(`error: ${JSON.stringify(maskSecretShaped(body.error))}`);
  console.log(JSON.stringify(maskSecretShaped(body?.data), null, 2));

  // GOOGLECALENDAR_CREATE_EVENT nests the created event under
  // data.response_data, not directly under data - confirmed live, not
  // assumed from the other tools' shapes.
  const created = body?.data?.response_data as Record<string, unknown> | undefined;
  const eventId = created?.id as string | undefined;
  const summary = created?.summary as string | undefined;
  const start_ = created?.start as unknown;
  const end_ = created?.end as unknown;

  const scopeOrPermissionError =
    res.status === 403 ||
    (typeof body?.error === "string" &&
      /insufficient|permission|scope/i.test(body.error as string));

  const succeeded = res.status >= 200 && res.status < 300 && body?.successful === true && !!eventId;

  console.log(`\nevent_id: ${eventId ?? "(none - creation did not succeed)"}`);
  console.log(`title: ${summary ?? "(n/a)"}`);
  console.log(`start: ${JSON.stringify(start_)}`);
  console.log(`end: ${JSON.stringify(end_)}`);
  console.log(`Succeeded without scope/permission errors: ${succeeded && !scopeOrPermissionError}`);

  process.exitCode = succeeded ? 0 : 1;
}

main().catch((err) => {
  console.error("create-event-only failed:", (err as Error).message);
  process.exitCode = 1;
});
