/**
 * Phases 6-8 (task brief): the controlled live event roundtrip - CREATE one
 * disposable test event, GET it back, DELETE it, and verify cleanup - against
 * a connected account that has already been confirmed (by
 * post-oauth-verify-and-list.ts) to be ACTIVE, correctly tenant-bound, and
 * backed by an empty calendar (no pre-existing personal/business data).
 *
 * This script re-runs that same empty-calendar safety gate itself
 * immediately before creating anything (fail-closed if any event already
 * exists on the calendar - defense in depth, not trusting a human's earlier
 * visual confirmation alone), then:
 *
 *   1. CREATE exactly one event via GOOGLECALENDAR_CREATE_EVENT - fixed,
 *      hardcoded safe arguments (no attendees, no recurrence, no conference
 *      link, short duration, near-future time). Nothing about the event's
 *      content is caller-configurable.
 *   2. GET that exact event id back via GOOGLECALENDAR_EVENTS_GET and verify
 *      id/title match.
 *   3. DELETE that exact same event id via GOOGLECALENDAR_DELETE_EVENT - the
 *      id used is always the one captured from this script's own CREATE
 *      response, never a caller-supplied or hardcoded id, so it can never
 *      delete a pre-existing event.
 *   4. Re-GET the same id (expect a not-found/deleted response) and re-LIST
 *      the calendar (expect it empty again) to verify cleanup.
 *
 * Every tool call goes through the same tenant-binding enforcement choke
 * point (buildToolExecuteRequest) as post-oauth-verify-and-list.ts - the
 * connected_account_id is always server-resolved from the TEST tenant
 * context, never caller-supplied.
 *
 * Run: COMPOSIO_API_KEY=... npx tsx scripts/poc/composio-calendar/event-roundtrip.ts <connected_account_id>
 */
import {
  TenantComposioConnectionRegistry,
  verifyConnectionOwnership,
  buildToolExecuteRequest,
  type TenantComposioConnection,
} from "./tenant-binding.js";

export {};

const BASE_URL = process.env.COMPOSIO_BASE_URL || "https://backend.composio.dev";
const TOOLKIT_SLUG = "googlecalendar";
const TARGET_AUTH_CONFIG_NAME = "syveka-poc-googlecalendar-events-scope-only";
const EXPECTED_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const APPROVED_TOOL_SLUGS = [
  "GOOGLECALENDAR_EVENTS_LIST",
  "GOOGLECALENDAR_CREATE_EVENT",
  "GOOGLECALENDAR_EVENTS_GET",
  "GOOGLECALENDAR_DELETE_EVENT",
] as const;

const TEST_ORG_ID = "org-test-poc";
const TEST_USER_ID = "user-test-poc";
const TEST_COMPOSIO_USER_ID = `syveka:${TEST_ORG_ID}:${TEST_USER_ID}`;
const ACTIVE_STATUSES = new Set(["ACTIVE", "CONNECTED"]);

const EVENT_TITLE = "SYVEKA COMPOSIO LIVE POC — SAFE TO DELETE";
const EVENT_DESCRIPTION = "Syveka Composio test event - safe to delete";

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

async function callComposio(
  apiKey: string,
  method: "GET" | "POST",
  path: string,
  opts?: { query?: Record<string, string>; body?: unknown },
): Promise<{ status: number; body: unknown }> {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(opts?.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      "x-api-key": apiKey,
      ...(opts?.body ? { "content-type": "application/json" } : {}),
    },
    body: opts?.body ? JSON.stringify(opts.body) : undefined,
  });
  let parsed: unknown = null;
  try {
    parsed = await res.json();
  } catch {
    // non-JSON response - status is still reported below
  }
  return { status: res.status, body: parsed };
}

function extractScopes(authConfigDetail: Record<string, unknown>): string[] {
  const creds = authConfigDetail.credentials as Record<string, unknown> | undefined;
  const raw = creds?.scopes;
  if (typeof raw === "string") return raw.split(/[,\s]+/).filter(Boolean);
  if (Array.isArray(raw)) return raw.filter((s): s is string => typeof s === "string");
  return [];
}

function extractExecutionAllowlist(authConfigDetail: Record<string, unknown>): string[] {
  const tac = authConfigDetail.tool_access_config as
    { tools_available_for_execution?: string[] } | undefined;
  return tac?.tools_available_for_execution ?? [];
}

async function executeTool(
  apiKey: string,
  toolSlug: (typeof APPROVED_TOOL_SLUGS)[number],
  connectedAccountId: string,
  args: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  return callComposio(apiKey, "POST", `/api/v3.1/tools/execute/${toolSlug}`, {
    body: {
      connected_account_id: connectedAccountId,
      entity_id: TEST_COMPOSIO_USER_ID,
      arguments: args,
    },
  });
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
    console.error("Usage: npx tsx event-roundtrip.ts <connected_account_id> - failing closed.");
    process.exitCode = 1;
    return;
  }

  console.log("=== Pre-flight: re-verify connection, tenant binding, scope, allowlist ===\n");
  const caResult = await callComposio(
    apiKey,
    "GET",
    `/api/v3.1/connected_accounts/${connectedAccountId}`,
  );
  if (caResult.status < 200 || caResult.status >= 300) {
    console.error("FAIL CLOSED: could not read connected account. Stopping.");
    process.exitCode = 1;
    return;
  }
  const ca = caResult.body as Record<string, unknown>;
  const status = ca.status as string | undefined;
  const reportedUserId = ca.user_id as string | undefined;
  const authConfigId = (ca.auth_config as { id?: string } | undefined)?.id;

  console.log(
    `connected_account_id=${connectedAccountId} status=${status} user_id=${reportedUserId}`,
  );

  if (!status || !ACTIVE_STATUSES.has(status)) {
    console.error(`FAIL CLOSED: status "${status}" is not active. Stopping.`);
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
  try {
    verifyConnectionOwnership(reportedUserId ?? "", expectedConn);
    console.log("PASS: tenant binding matches expected TEST identity.");
  } catch (err) {
    console.error(`FAIL CLOSED: ${(err as Error).message}`);
    process.exitCode = 1;
    return;
  }

  const listAuthResult = await callComposio(apiKey, "GET", "/api/v3.1/auth_configs", {
    query: { toolkit_slug: TOOLKIT_SLUG, search: TARGET_AUTH_CONFIG_NAME },
  });
  const listAuthBody = listAuthResult.body as { items?: Array<{ id: string; name: string }> };
  const exactMatches = (listAuthBody.items ?? []).filter((i) => i.name === TARGET_AUTH_CONFIG_NAME);
  if (exactMatches.length !== 1) {
    console.error(`FAIL CLOSED: expected exactly 1 auth config, found ${exactMatches.length}.`);
    process.exitCode = 1;
    return;
  }
  const resolvedAuthConfigId = exactMatches[0]!.id;
  if (authConfigId && authConfigId !== resolvedAuthConfigId) {
    console.error("FAIL CLOSED: connected account's auth_config does not match the approved one.");
    process.exitCode = 1;
    return;
  }
  const detailResult = await callComposio(
    apiKey,
    "GET",
    `/api/v3.1/auth_configs/${resolvedAuthConfigId}`,
  );
  const detail = (detailResult.body ?? {}) as Record<string, unknown>;
  const scopes = extractScopes(detail);
  const execution = extractExecutionAllowlist(detail);
  const approvedSet = new Set<string>(APPROVED_TOOL_SLUGS);
  const executionSet = new Set(execution);
  const missing = [...approvedSet].filter((s) => !executionSet.has(s));
  const extra = execution.filter((s) => !approvedSet.has(s));
  const scopeOk = scopes.length === 1 && scopes[0] === EXPECTED_SCOPE;
  const executionOk = missing.length === 0 && extra.length === 0 && execution.length === 4;
  console.log(`scopes=${JSON.stringify(scopes)} execution=${JSON.stringify(execution)}`);
  if (!scopeOk || !executionOk) {
    console.error("FAIL CLOSED: scope/execution boundary drifted. Stopping.");
    process.exitCode = 1;
    return;
  }
  console.log("PASS: scope and execution allowlist both exact.\n");

  console.log("=== Safety gate: re-confirm the calendar is empty before creating anything ===");
  const preListReq = buildToolExecuteRequest(
    registry,
    { orgId: TEST_ORG_ID, userId: TEST_USER_ID },
    {},
  );
  const preListResult = await executeTool(
    apiKey,
    "GOOGLECALENDAR_EVENTS_LIST",
    preListReq.connected_account_id,
    {},
  );
  if (preListResult.status < 200 || preListResult.status >= 300) {
    console.error("FAIL CLOSED: pre-create LIST failed. Stopping - no event created.");
    console.error(JSON.stringify(maskSecretShaped(preListResult.body), null, 2));
    process.exitCode = 1;
    return;
  }
  const preListBody = preListResult.body as { data?: { items?: unknown[] } };
  const preItems = preListBody.data?.items ?? [];
  console.log(`Pre-existing events on calendar: ${preItems.length}`);
  if (preItems.length > 0) {
    console.error(
      "FAIL CLOSED: calendar is not empty - refusing to create a test event on a calendar that " +
        "already has data on it. Stopping before any mutation.",
    );
    process.exitCode = 1;
    return;
  }
  console.log("PASS: calendar confirmed empty. Proceeding to CREATE.\n");

  console.log("=== Step: CREATE exactly one disposable test event ===");
  const now = new Date();
  const start = new Date(now.getTime() + 10 * 60 * 1000); // 10 minutes from now
  const toIso = (d: Date) => d.toISOString().replace(/\.\d+Z$/, "");
  const createArgs = {
    summary: EVENT_TITLE,
    description: EVENT_DESCRIPTION,
    start_datetime: toIso(start),
    event_duration_minutes: 15,
    create_meeting_room: false,
    timezone: "UTC",
  };
  console.log("CREATE arguments:", JSON.stringify(createArgs, null, 2));
  const createReq = buildToolExecuteRequest(
    registry,
    { orgId: TEST_ORG_ID, userId: TEST_USER_ID },
    createArgs,
  );
  const createResult = await executeTool(
    apiKey,
    "GOOGLECALENDAR_CREATE_EVENT",
    createReq.connected_account_id,
    createReq.arguments,
  );
  console.log(`-> HTTP ${createResult.status}`);
  console.log(JSON.stringify(maskSecretShaped(createResult.body), null, 2));
  if (createResult.status < 200 || createResult.status >= 300) {
    console.error("CREATE FAILED - stopping.");
    process.exitCode = 1;
    return;
  }
  const createBody = createResult.body as { data?: Record<string, unknown> };
  const createdEventId = createBody.data?.id as string | undefined;
  const createdCalendarId = (createBody.data?.organizer as { email?: string } | undefined)?.email;
  if (!createdEventId) {
    console.error("FAIL CLOSED: CREATE response did not include an event id. Stopping.");
    process.exitCode = 1;
    return;
  }
  console.log(
    `\nCreated event id: ${createdEventId} (calendar: ${createdCalendarId ?? "primary"})\n`,
  );

  console.log("=== Step: GET exactly the created event ===");
  const getReq = buildToolExecuteRequest(
    registry,
    { orgId: TEST_ORG_ID, userId: TEST_USER_ID },
    {
      event_id: createdEventId,
    },
  );
  const getResult = await executeTool(
    apiKey,
    "GOOGLECALENDAR_EVENTS_GET",
    getReq.connected_account_id,
    getReq.arguments,
  );
  console.log(`-> HTTP ${getResult.status}`);
  console.log(JSON.stringify(maskSecretShaped(getResult.body), null, 2));
  if (getResult.status < 200 || getResult.status >= 300) {
    console.error("GET FAILED after CREATE succeeded - stopping before DELETE (unverified event).");
    process.exitCode = 1;
    return;
  }
  const getBody = getResult.body as { data?: Record<string, unknown> };
  const gotId = getBody.data?.id as string | undefined;
  const gotSummary = getBody.data?.summary as string | undefined;
  const idMatches = gotId === createdEventId;
  const titleMatches = gotSummary === EVENT_TITLE;
  console.log(`\nGET verification: id matches=${idMatches} title matches=${titleMatches}`);
  if (!idMatches || !titleMatches) {
    console.error("FAIL CLOSED: GET did not return the expected event - stopping before DELETE.");
    process.exitCode = 1;
    return;
  }
  console.log("PASS: GET confirms the exact created event.\n");

  console.log("=== Step: DELETE exactly the created event ===");
  const deleteReq = buildToolExecuteRequest(
    registry,
    { orgId: TEST_ORG_ID, userId: TEST_USER_ID },
    {
      event_id: createdEventId,
    },
  );
  const deleteResult = await executeTool(
    apiKey,
    "GOOGLECALENDAR_DELETE_EVENT",
    deleteReq.connected_account_id,
    deleteReq.arguments,
  );
  console.log(`-> HTTP ${deleteResult.status}`);
  console.log(JSON.stringify(maskSecretShaped(deleteResult.body), null, 2));
  if (deleteResult.status < 200 || deleteResult.status >= 300) {
    console.error("DELETE FAILED - the disposable test event may still exist. Stopping.");
    process.exitCode = 1;
    return;
  }
  console.log("PASS: DELETE call succeeded.\n");

  console.log("=== Step: verify cleanup (re-GET + re-LIST) ===");
  const reGetReq = buildToolExecuteRequest(
    registry,
    { orgId: TEST_ORG_ID, userId: TEST_USER_ID },
    {
      event_id: createdEventId,
    },
  );
  const reGetResult = await executeTool(
    apiKey,
    "GOOGLECALENDAR_EVENTS_GET",
    reGetReq.connected_account_id,
    reGetReq.arguments,
  );
  const reGetBody = reGetResult.body as { data?: Record<string, unknown> };
  const reGetStatus = reGetBody.data?.status as string | undefined;
  const deletedConfirmedByGet = reGetResult.status === 404 || reGetStatus === "cancelled";
  console.log(
    `Re-GET same event id -> HTTP ${reGetResult.status}` +
      (reGetStatus ? `, status field: ${reGetStatus}` : ""),
  );

  const reListReq = buildToolExecuteRequest(
    registry,
    { orgId: TEST_ORG_ID, userId: TEST_USER_ID },
    {},
  );
  const reListResult = await executeTool(
    apiKey,
    "GOOGLECALENDAR_EVENTS_LIST",
    reListReq.connected_account_id,
    {},
  );
  const reListBody = reListResult.body as { data?: { items?: Array<Record<string, unknown>> } };
  const reListItems = reListBody.data?.items ?? [];
  const activeItems = reListItems.filter((i) => i.status !== "cancelled");
  console.log(
    `Re-LIST -> ${reListItems.length} item(s) returned, ${activeItems.length} non-cancelled`,
  );

  const cleanupVerified = deletedConfirmedByGet && activeItems.length === 0;
  console.log(
    `\nCLEANUP VERIFICATION: ${cleanupVerified ? "PASS" : "FAIL"} ` +
      `(deletedConfirmedByGet=${deletedConfirmedByGet}, activeItemsRemaining=${activeItems.length})`,
  );

  if (!cleanupVerified) {
    console.error("Cleanup could not be fully verified - review the calendar manually.");
    process.exitCode = 1;
    return;
  }

  console.log(
    "\nLIVE CALENDAR EVENT ROUNDTRIP: PASS - CREATE, GET, DELETE all succeeded against the exact " +
      "same event id, and cleanup is verified. The calendar is left with no artifact from this test.",
  );
  console.log(`\nEvent id used throughout: ${createdEventId}`);
}

main().catch((err) => {
  console.error("event-roundtrip failed:", (err as Error).message);
  process.exitCode = 1;
});
