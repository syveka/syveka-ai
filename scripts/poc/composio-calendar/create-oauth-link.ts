/**
 * Phase 7 (task brief "SYVEKA — COMPOSIO GOOGLE CALENDAR HUMAN OAUTH GATE"):
 * generates the Composio OAuth connection link ONLY so the human gate can be
 * presented - per that task's explicit instruction "It is acceptable to
 * generate the Composio OAuth connection link ONLY if needed to present the
 * human gate. Do NOT open/approve it automatically." This script never opens,
 * follows, or approves the returned redirect_url; it only prints it for a
 * human to review and decide.
 *
 * Targets ONLY the already-proven auth config
 * ("syveka-poc-googlecalendar-events-scope-only"), discovered by exact name
 * (never a hardcoded id), and re-verifies BOTH previously-proven boundaries
 * (OAuth scope == exactly the approved 2-scope set - calendar.events plus
 * calendar.calendars.readonly, added via update-auth-config-scope.ts to
 * satisfy GOOGLECALENDAR_CREATE_EVENT's internal calendars.get dependency;
 * execution allowlist == exactly the 4 approved tool slugs) before calling
 * link.create() - so this script can never accidentally initiate OAuth
 * against a broader/wrong auth config.
 *
 * The `user_id` sent to Composio is a fixed, clearly-labeled TEST identity
 * string (never a real Syveka org/user), matching the shape
 * scripts/poc/composio-calendar/tenant-binding.ts expects
 * (`syveka:{orgId}:{userId}`) - this is the value that, per that module's
 * design, a real implementation would derive from a server-verified session,
 * never a client-supplied value.
 *
 * Run: COMPOSIO_API_KEY=... npx tsx scripts/poc/composio-calendar/create-oauth-link.ts
 */

export {};

const BASE_URL = process.env.COMPOSIO_BASE_URL || "https://backend.composio.dev";
const TOOLKIT_SLUG = "googlecalendar";
const TARGET_AUTH_CONFIG_NAME = "syveka-poc-googlecalendar-events-scope-only";
// Expanded from calendar.events alone (see update-auth-config-scope.ts):
// GOOGLECALENDAR_CREATE_EVENT's internal calendars.get call requires a scope
// calendar.events does not cover; calendar.calendars.readonly is the
// narrowest scope Google's own discovery document lists that satisfies it.
const EXPECTED_SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.calendars.readonly",
] as const;
const APPROVED_TOOL_SLUGS = [
  "GOOGLECALENDAR_EVENTS_LIST",
  "GOOGLECALENDAR_CREATE_EVENT",
  "GOOGLECALENDAR_EVENTS_GET",
  "GOOGLECALENDAR_DELETE_EVENT",
] as const;

// TEST-only identity - never a real Syveka org/user. Mirrors the
// `syveka:{orgId}:{userId}` shape tenant-binding.ts documents as the
// composioUserId a real implementation would derive from a server-verified
// session context.
const TEST_ORG_ID = "org-test-poc";
const TEST_USER_ID = "user-test-poc";
const TEST_COMPOSIO_USER_ID = `syveka:${TEST_ORG_ID}:${TEST_USER_ID}`;

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

async function main(): Promise<void> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    console.error("COMPOSIO_API_KEY is not set - failing closed. No OAuth link will be created.");
    process.exitCode = 1;
    return;
  }

  console.log(
    "=== Pre-OAuth human gate: generate connection link only (no auto-open/approve) ===\n",
  );
  console.log(`Target auth config name: ${TARGET_AUTH_CONFIG_NAME}`);
  console.log(`TEST identity to bind: org=${TEST_ORG_ID} user=${TEST_USER_ID}`);
  console.log(`Composio user_id to send: ${TEST_COMPOSIO_USER_ID}`);

  console.log("\n=== Step 1: discover the target auth config by exact name ===");
  const listResult = await callComposio(apiKey, "GET", "/api/v3.1/auth_configs", {
    query: { toolkit_slug: TOOLKIT_SLUG, search: TARGET_AUTH_CONFIG_NAME },
  });
  if (listResult.status < 200 || listResult.status >= 300) {
    console.error("Discovery FAILED - stopping. No link created.");
    console.error(JSON.stringify(maskSecretShaped(listResult.body), null, 2));
    process.exitCode = 1;
    return;
  }
  const listBody = listResult.body as { items?: Array<{ id: string; name: string }> };
  const exactMatches = (listBody.items ?? []).filter((i) => i.name === TARGET_AUTH_CONFIG_NAME);
  if (exactMatches.length !== 1) {
    console.error(
      `FAIL CLOSED: expected exactly 1 auth config named "${TARGET_AUTH_CONFIG_NAME}", found ` +
        `${exactMatches.length}. No link created.`,
    );
    process.exitCode = 1;
    return;
  }
  const authConfigId = exactMatches[0]!.id;
  console.log(`Resolved auth config id: ${authConfigId}`);

  console.log(
    "\n=== Step 2: re-verify BOTH least-privilege boundaries before initiating OAuth ===",
  );
  const detailResult = await callComposio(apiKey, "GET", `/api/v3.1/auth_configs/${authConfigId}`);
  if (detailResult.status < 200 || detailResult.status >= 300) {
    console.error("Pre-link verification read FAILED - stopping. No link created.");
    process.exitCode = 1;
    return;
  }
  const detail = (detailResult.body ?? {}) as Record<string, unknown>;
  const scopes = extractScopes(detail);
  const execution = extractExecutionAllowlist(detail);
  const status = detail.status as string | undefined;
  const isComposioManaged = detail.is_composio_managed as boolean | undefined;

  console.log(`status=${status} is_composio_managed=${isComposioManaged}`);
  console.log(`scopes=${JSON.stringify(scopes)}`);
  console.log(`execution allowlist=${JSON.stringify(execution)}`);

  const expectedScopeSet = new Set<string>(EXPECTED_SCOPES);
  const scopeSet = new Set(scopes);
  const scopeOk =
    scopes.length === EXPECTED_SCOPES.length &&
    scopes.every((s) => expectedScopeSet.has(s)) &&
    [...expectedScopeSet].every((s) => scopeSet.has(s));
  const approvedSet = new Set<string>(APPROVED_TOOL_SLUGS);
  const executionSet = new Set(execution);
  const missing = [...approvedSet].filter((s) => !executionSet.has(s));
  const extra = execution.filter((s) => !approvedSet.has(s));
  const executionOk = missing.length === 0 && extra.length === 0 && execution.length === 4;
  const statusOk = status === "ENABLED";

  if (!scopeOk || !executionOk || !statusOk) {
    console.error(
      "\nFAIL CLOSED: pre-link verification did not match the approved boundaries exactly " +
        `(scopeOk=${scopeOk}, executionOk=${executionOk}, statusOk=${statusOk}, missing=${JSON.stringify(missing)}, extra=${JSON.stringify(extra)}). No link created.`,
    );
    process.exitCode = 1;
    return;
  }
  console.log("\nBoth boundaries verified immediately before link creation. Proceeding.");

  console.log("\n=== Step 3: POST /api/v3.1/connected_accounts/link ===");
  const linkBody = {
    auth_config_id: authConfigId,
    user_id: TEST_COMPOSIO_USER_ID,
  };
  console.log("Request body:", JSON.stringify(linkBody, null, 2));

  const linkResult = await callComposio(apiKey, "POST", "/api/v3.1/connected_accounts/link", {
    body: linkBody,
  });
  console.log(`\n-> HTTP ${linkResult.status}`);
  if (linkResult.status < 200 || linkResult.status >= 300) {
    console.error("Link creation FAILED - stopping. No OAuth initiated.");
    console.error(JSON.stringify(maskSecretShaped(linkResult.body), null, 2));
    process.exitCode = 1;
    return;
  }

  const linkBodyParsed = linkResult.body as {
    connected_account_id?: string;
    redirect_url?: string;
    expires_at?: string;
  };

  console.log("\n=== RESULT (link_token deliberately not printed) ===");
  console.log(`connected_account_id: ${linkBodyParsed.connected_account_id}`);
  console.log(`expires_at: ${linkBodyParsed.expires_at}`);
  console.log(`redirect_url (open this ONLY after explicit human authorization):`);
  console.log(linkBodyParsed.redirect_url);

  console.log(
    "\nSTOPPING HERE, as instructed: this script did not open, follow, or approve the redirect_url. " +
      "No Google account has been touched. The connected account created by this call is in a " +
      "pending/INITIATED state until a human completes Google's consent screen at the URL above.",
  );
}

main().catch((err) => {
  console.error("create-oauth-link failed:", (err as Error).message);
  process.exitCode = 1;
});
