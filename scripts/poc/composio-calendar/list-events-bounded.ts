/**
 * Phase 6 (custom-OAuth PoC continuation): exactly ONE read-only
 * GOOGLECALENDAR_EVENTS_LIST call, bounded to a small time window, against
 * the new custom-OAuth connected account. No other Calendar tool is
 * referenced anywhere in this file.
 *
 * Goes through the same tenant-binding enforcement choke point as every
 * other execution script in this PoC (buildToolExecuteRequest) - the
 * connected_account_id is resolved only from the server-verified TEST
 * tenant context, never a caller-supplied value.
 *
 * Run: COMPOSIO_API_KEY=... npx tsx scripts/poc/composio-calendar/list-events-bounded.ts <connected_account_id>
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
  if (!connectedAccountId) {
    console.error("Usage: npx tsx list-events-bounded.ts <connected_account_id> - failing closed.");
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

  const timeMin = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const timeMax = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();

  const listArgs = { calendarId: CALENDAR_ID, timeMin, timeMax };
  const req = buildToolExecuteRequest(
    registry,
    { orgId: TEST_ORG_ID, userId: TEST_USER_ID },
    listArgs,
  );

  if (req.connected_account_id !== connectedAccountId) {
    console.error(
      "FAIL CLOSED: tenant-resolved connected_account_id does not match the requested connection.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("=== GOOGLECALENDAR_EVENTS_LIST (read-only, bounded window) ===");
  console.log(`connected_account_id: ${req.connected_account_id}`);
  console.log(`calendar_id: ${CALENDAR_ID}`);
  console.log(`time window: ${timeMin} .. ${timeMax}`);

  const res = await fetch(new URL("/api/v3.1/tools/execute/GOOGLECALENDAR_EVENTS_LIST", BASE_URL), {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      connected_account_id: req.connected_account_id,
      entity_id: TEST_COMPOSIO_USER_ID,
      arguments: req.arguments,
    }),
  });
  const body = (await res.json().catch(() => null)) as {
    data?: { items?: Array<Record<string, unknown>> };
    successful?: boolean;
    error?: unknown;
  } | null;

  console.log(`\n-> HTTP ${res.status}`);
  console.log(`successful: ${body?.successful}`);
  if (body?.error) console.log(`error: ${JSON.stringify(maskSecretShaped(body.error))}`);

  const items = body?.data?.items ?? [];
  console.log(`\nresult count: ${items.length}`);
  for (const item of items) {
    console.log(` - ${JSON.stringify(item.summary ?? "(no title)")}`);
  }

  const scopeOrPermissionError =
    res.status === 403 ||
    (typeof body?.error === "string" &&
      /insufficient|permission|scope/i.test(body.error as string));

  console.log(
    `\nSucceeded without scope/permission errors: ${res.status >= 200 && res.status < 300 && body?.successful === true && !scopeOrPermissionError}`,
  );

  process.exitCode = res.status >= 200 && res.status < 300 && body?.successful === true ? 0 : 1;
}

main().catch((err) => {
  console.error("list-events-bounded failed:", (err as Error).message);
  process.exitCode = 1;
});
