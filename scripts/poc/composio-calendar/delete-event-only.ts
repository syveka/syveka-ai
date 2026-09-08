/**
 * Phase 9 (custom-OAuth PoC continuation, DELETE only): exactly ONE
 * GOOGLECALENDAR_DELETE_EVENT call against the new custom-OAuth connected
 * account, deleting exactly the event created in Phase 7 and read back in
 * Phase 8. No LIST, CREATE, GET, UPDATE, or any other tool is referenced
 * anywhere in this file - this script stops immediately after DELETE, per
 * explicit instruction.
 *
 * Goes through the same tenant-binding enforcement choke point as every
 * other execution script in this PoC (buildToolExecuteRequest) - the
 * connected_account_id is resolved only from the server-verified TEST
 * tenant context, never a caller-supplied value. The event_id to delete is
 * still an explicit CLI argument (the exact id created in Phase 7 and
 * confirmed in Phase 8), never discovered/guessed - so this script can
 * never delete a pre-existing event.
 *
 * Run: COMPOSIO_API_KEY=... npx tsx scripts/poc/composio-calendar/delete-event-only.ts <connected_account_id> <event_id>
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
  const eventId = process.argv[3];
  if (!connectedAccountId || !eventId) {
    console.error(
      "Usage: npx tsx delete-event-only.ts <connected_account_id> <event_id> - failing closed.",
    );
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

  const deleteArgs = { calendar_id: CALENDAR_ID, event_id: eventId };
  const req = buildToolExecuteRequest(
    registry,
    { orgId: TEST_ORG_ID, userId: TEST_USER_ID },
    deleteArgs,
  );

  if (req.connected_account_id !== connectedAccountId) {
    console.error(
      "FAIL CLOSED: tenant-resolved connected_account_id does not match the requested connection.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("=== GOOGLECALENDAR_DELETE_EVENT (single exact event) ===");
  console.log(`connected_account_id: ${req.connected_account_id}`);
  console.log("arguments:", JSON.stringify(req.arguments, null, 2));

  const res = await fetch(
    new URL("/api/v3.1/tools/execute/GOOGLECALENDAR_DELETE_EVENT", BASE_URL),
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
    data?: unknown;
    successful?: boolean;
    error?: unknown;
  } | null;

  console.log(`\n-> HTTP ${res.status}`);
  console.log(`successful: ${body?.successful}`);
  if (body?.error) console.log(`error: ${JSON.stringify(maskSecretShaped(body.error))}`);
  console.log(JSON.stringify(maskSecretShaped(body?.data), null, 2));

  const scopeOrPermissionError =
    res.status === 403 ||
    (typeof body?.error === "string" &&
      /insufficient|permission|scope/i.test(body.error as string));

  const succeeded = res.status >= 200 && res.status < 300 && body?.successful === true;

  console.log(`\nDeletion succeeded: ${succeeded}`);
  console.log(`Completed without scope/permission errors: ${succeeded && !scopeOrPermissionError}`);

  process.exitCode = succeeded ? 0 : 1;
}

main().catch((err) => {
  console.error("delete-event-only failed:", (err as Error).message);
  process.exitCode = 1;
});
