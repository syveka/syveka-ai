/**
 * Phase 8 (custom-OAuth PoC continuation, GET only): exactly ONE
 * GOOGLECALENDAR_EVENTS_GET call against the new custom-OAuth connected
 * account, fetching exactly the event created in Phase 7. No LIST, CREATE,
 * DELETE, UPDATE, or any other tool is referenced anywhere in this file -
 * this script stops immediately after GET, per explicit instruction.
 *
 * Goes through the same tenant-binding enforcement choke point as every
 * other execution script in this PoC (buildToolExecuteRequest) - the
 * connected_account_id is resolved only from the server-verified TEST
 * tenant context, never a caller-supplied value. The event_id to fetch is
 * still an explicit CLI argument (the exact id captured from Phase 7's
 * CREATE response), not discovered/guessed.
 *
 * Run: COMPOSIO_API_KEY=... npx tsx scripts/poc/composio-calendar/get-event-only.ts <connected_account_id> <event_id>
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
const EXPECTED_TITLE = "SYVEKA POC CALENDAR TEST";

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
      "Usage: npx tsx get-event-only.ts <connected_account_id> <event_id> - failing closed.",
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

  const getArgs = { calendar_id: CALENDAR_ID, event_id: eventId };
  const req = buildToolExecuteRequest(
    registry,
    { orgId: TEST_ORG_ID, userId: TEST_USER_ID },
    getArgs,
  );

  if (req.connected_account_id !== connectedAccountId) {
    console.error(
      "FAIL CLOSED: tenant-resolved connected_account_id does not match the requested connection.",
    );
    process.exitCode = 1;
    return;
  }

  console.log("=== GOOGLECALENDAR_EVENTS_GET (single exact event) ===");
  console.log(`connected_account_id: ${req.connected_account_id}`);
  console.log("arguments:", JSON.stringify(req.arguments, null, 2));

  const res = await fetch(new URL("/api/v3.1/tools/execute/GOOGLECALENDAR_EVENTS_GET", BASE_URL), {
    method: "POST",
    headers: { "x-api-key": apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      connected_account_id: req.connected_account_id,
      entity_id: TEST_COMPOSIO_USER_ID,
      arguments: req.arguments,
    }),
  });
  const body = (await res.json().catch(() => null)) as {
    data?: Record<string, unknown>;
    successful?: boolean;
    error?: unknown;
  } | null;

  console.log(`\n-> HTTP ${res.status}`);
  console.log(`successful: ${body?.successful}`);
  if (body?.error) console.log(`error: ${JSON.stringify(maskSecretShaped(body.error))}`);
  console.log(JSON.stringify(maskSecretShaped(body?.data), null, 2));

  // GOOGLECALENDAR_CREATE_EVENT nested its result under data.response_data;
  // check both shapes here rather than assuming this tool matches, since
  // Composio's per-tool response wrappers have already proven inconsistent.
  const nested = body?.data?.response_data as Record<string, unknown> | undefined;
  const fetched = nested ?? body?.data;
  const fetchedId = fetched?.id as string | undefined;
  const fetchedTitle = fetched?.summary as string | undefined;
  const fetchedStart = fetched?.start as unknown;
  const fetchedEnd = fetched?.end as unknown;

  const scopeOrPermissionError =
    res.status === 403 ||
    (typeof body?.error === "string" &&
      /insufficient|permission|scope/i.test(body.error as string));

  const idMatches = fetchedId === eventId;
  const titleMatches = fetchedTitle === EXPECTED_TITLE;
  const succeeded = res.status >= 200 && res.status < 300 && body?.successful === true && idMatches;

  console.log(`\nevent_id fetched: ${fetchedId ?? "(none)"} (matches requested: ${idMatches})`);
  console.log(`title: ${fetchedTitle ?? "(n/a)"} (matches expected: ${titleMatches})`);
  console.log(`start: ${JSON.stringify(fetchedStart)}`);
  console.log(`end: ${JSON.stringify(fetchedEnd)}`);
  console.log(`Succeeded without scope/permission errors: ${succeeded && !scopeOrPermissionError}`);

  process.exitCode = succeeded && titleMatches ? 0 : 1;
}

main().catch((err) => {
  console.error("get-event-only failed:", (err as Error).message);
  process.exitCode = 1;
});
