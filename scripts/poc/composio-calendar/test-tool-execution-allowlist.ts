/**
 * Phase 6 (task brief): proves the SECOND, independent Composio security
 * boundary - tool-execution least privilege - on the auth config created by
 * test-scopes-only-auth-config.ts (name:
 * "syveka-poc-googlecalendar-events-scope-only"), which already proved the
 * FIRST boundary (OAuth-scope least privilege: PASS, returned scope exactly
 * https://www.googleapis.com/auth/calendar.events).
 *
 * This script does NOT create a new auth config. It discovers the existing
 * scopes-only config by name (never by a hardcoded id pasted into source),
 * fails closed if it finds zero or more than one match, records its OAuth
 * scopes and tool_access_config BEFORE any change, then issues exactly one
 * PATCH /api/v3.1/auth_configs/{id} that sets ONLY
 * tool_access_config.tools_available_for_execution to the 4 approved tool
 * slugs - per the @composio/client SDK source (AuthConfigUpdateParams,
 * verified fresh from the unpacked v0.1.0-alpha.76 tarball), this field is
 * independent of `tools_for_connected_account_creation` and of
 * `credentials.scopes`/`user_scopes`, and the update endpoint's own JSDoc
 * states "Only specified fields will be updated" - so omitting scopes here
 * must leave them untouched. The script re-reads the type already reported
 * on the config (`default`, since it was created via
 * use_composio_managed_auth) and echoes that same type back in the PATCH
 * body so the update cannot silently change the config's auth type.
 *
 * After the update, this script re-reads the config independently (a fresh
 * GET, not the PATCH response) and fails closed unless:
 *   - tools_available_for_execution is exactly the 4 approved slugs, no more
 *     and no less
 *   - the OAuth scopes are byte-for-byte identical before and after
 *
 * No connected account, link, or OAuth-initiating endpoint is referenced
 * anywhere in this file. The pre-existing broad auth config
 * (syveka-poc-googlecalendar-test-only) and the mutually-exclusive
 * scopes+tools test config (syveka-poc-googlecalendar-scoped-test) are never
 * read, matched, or touched - only the exact-name scopes-only config is a
 * valid target.
 *
 * Run: COMPOSIO_API_KEY=... npx tsx scripts/poc/composio-calendar/test-tool-execution-allowlist.ts
 */

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
  method: "GET" | "PATCH",
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

function scopesIdentical(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((v, i) => v === sb[i]);
}

async function main(): Promise<void> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    console.error("COMPOSIO_API_KEY is not set - failing closed. No update will be attempted.");
    process.exitCode = 1;
    return;
  }

  console.log(
    "=== Phase 6: tool-execution least-privilege test (update-only, no new auth config) ===\n",
  );
  console.log(`Target auth config name: ${TARGET_AUTH_CONFIG_NAME}`);
  console.log("Approved execution allowlist (exactly these 4, nothing else):");
  for (const slug of APPROVED_TOOL_SLUGS) console.log(`  - ${slug}`);

  console.log("\n=== Step 1: discover the target auth config by name (no hardcoded id) ===");
  const listResult = await callComposio(apiKey, "GET", "/api/v3.1/auth_configs", {
    query: { toolkit_slug: TOOLKIT_SLUG, search: TARGET_AUTH_CONFIG_NAME },
  });
  console.log(
    `GET /api/v3.1/auth_configs?toolkit_slug=${TOOLKIT_SLUG}&search=... -> HTTP ${listResult.status}`,
  );
  if (listResult.status < 200 || listResult.status >= 300) {
    console.error("\nDiscovery FAILED - stopping. No update attempted.");
    console.error(JSON.stringify(maskSecretShaped(listResult.body), null, 2));
    process.exitCode = 1;
    return;
  }

  const listBody = listResult.body as { items?: Array<{ id: string; name: string }> };
  const exactMatches = (listBody.items ?? []).filter(
    (item) => item.name === TARGET_AUTH_CONFIG_NAME,
  );
  console.log(
    `Items returned: ${listBody.items?.length ?? 0}; exact-name matches: ${exactMatches.length}`,
  );

  if (exactMatches.length !== 1) {
    console.error(
      `\nFAIL CLOSED: expected exactly 1 auth config named "${TARGET_AUTH_CONFIG_NAME}", found ` +
        `${exactMatches.length}. Ambiguous or missing target - no update attempted, nothing modified.`,
    );
    process.exitCode = 1;
    return;
  }

  const [matchedAuthConfig] = exactMatches;
  if (!matchedAuthConfig) {
    console.error("\nFAIL CLOSED: unreachable - exact-match count was 1 but the item is missing.");
    process.exitCode = 1;
    return;
  }
  const authConfigId = matchedAuthConfig.id;
  console.log(`Resolved auth config id: ${authConfigId}`);

  console.log(
    "\n=== Step 2: read current state BEFORE update (GET /api/v3.1/auth_configs/{id}) ===",
  );
  const beforeResult = await callComposio(apiKey, "GET", `/api/v3.1/auth_configs/${authConfigId}`);
  console.log(`-> HTTP ${beforeResult.status}`);
  if (beforeResult.status < 200 || beforeResult.status >= 300) {
    console.error("\nPre-update read FAILED - stopping. No update attempted.");
    process.exitCode = 1;
    return;
  }
  const before = (beforeResult.body ?? {}) as Record<string, unknown>;
  console.log(JSON.stringify(maskSecretShaped(before), null, 2));

  const scopesBefore = extractScopes(before);
  const executionBefore = extractExecutionAllowlist(before);
  const typeBefore = before.type as string | undefined;
  console.log(`\nBEFORE: type=${typeBefore} scopes=${JSON.stringify(scopesBefore)}`);
  console.log(`BEFORE: tools_available_for_execution=${JSON.stringify(executionBefore)}`);

  if (scopesBefore.length !== 1 || scopesBefore[0] !== EXPECTED_SCOPE) {
    console.error(
      `\nFAIL CLOSED: pre-update scopes are not exactly [${EXPECTED_SCOPE}] as Phase 2 established ` +
        `(got ${JSON.stringify(scopesBefore)}). Refusing to proceed - this may not be the config Phase 2 tested.`,
    );
    process.exitCode = 1;
    return;
  }
  if (!typeBefore) {
    console.error(
      "\nFAIL CLOSED: could not read auth config 'type' before update. No update attempted.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    "\n=== Step 3: PATCH tool_access_config.tools_available_for_execution ONLY " +
      "(type echoed back unchanged, no scopes/user_scopes field included) ===",
  );
  const updateBody = {
    type: typeBefore,
    tool_access_config: {
      tools_available_for_execution: [...APPROVED_TOOL_SLUGS],
    },
  };
  console.log("Request body (PATCH /api/v3.1/auth_configs/{id}):");
  console.log(JSON.stringify(updateBody, null, 2));

  const updateResult = await callComposio(
    apiKey,
    "PATCH",
    `/api/v3.1/auth_configs/${authConfigId}`,
    {
      body: updateBody,
    },
  );
  console.log(`\n-> HTTP ${updateResult.status}`);
  console.log(JSON.stringify(maskSecretShaped(updateResult.body), null, 2));

  if (updateResult.status < 200 || updateResult.status >= 300) {
    console.error("\nUpdate FAILED - stopping. No OAuth attempted, no Google account touched.");
    process.exitCode = 1;
    return;
  }

  console.log(
    "\n=== Step 4: independently re-read the config AFTER update (fresh GET, not the PATCH response) ===",
  );
  const afterResult = await callComposio(apiKey, "GET", `/api/v3.1/auth_configs/${authConfigId}`);
  console.log(`-> HTTP ${afterResult.status}`);
  if (afterResult.status < 200 || afterResult.status >= 300) {
    console.error(
      "\nFAIL CLOSED: post-update verification read FAILED - cannot confirm outcome. Treat as BLOCKED.",
    );
    process.exitCode = 1;
    return;
  }
  const after = (afterResult.body ?? {}) as Record<string, unknown>;
  console.log(JSON.stringify(maskSecretShaped(after), null, 2));

  const scopesAfter = extractScopes(after);
  const executionAfter = extractExecutionAllowlist(after);
  const typeAfter = after.type as string | undefined;
  console.log(`\nAFTER: type=${typeAfter} scopes=${JSON.stringify(scopesAfter)}`);
  console.log(`AFTER: tools_available_for_execution=${JSON.stringify(executionAfter)}`);

  console.log("\n=== GATES (fail closed on any ambiguity) ===");

  const scopesUnchanged = scopesIdentical(scopesBefore, scopesAfter);
  console.log(
    `OAuth scopes unchanged: ${scopesUnchanged ? "YES" : "NO"} ` +
      `(before=${JSON.stringify(scopesBefore)}, after=${JSON.stringify(scopesAfter)})`,
  );

  const approvedSet = new Set<string>(APPROVED_TOOL_SLUGS);
  const executionSet = new Set(executionAfter);
  const missing = [...approvedSet].filter((s) => !executionSet.has(s));
  const extra = executionAfter.filter((s) => !approvedSet.has(s));
  const exactExecutionMatch =
    missing.length === 0 && extra.length === 0 && executionAfter.length === 4;

  console.log(`Requested execution allowlist: ${JSON.stringify([...APPROVED_TOOL_SLUGS])}`);
  console.log(`Returned execution allowlist:  ${JSON.stringify(executionAfter)}`);
  console.log(`Missing approved tools: ${JSON.stringify(missing)}`);
  console.log(`Extra/unapproved tools: ${JSON.stringify(extra)}`);
  console.log(`Exact match: ${exactExecutionMatch ? "YES" : "NO"}`);

  const overallPass = scopesUnchanged && exactExecutionMatch;

  console.log(
    `\nTOOL EXECUTION LEAST PRIVILEGE: ${overallPass ? "PASS" : "BLOCKED"}` +
      (overallPass
        ? " - execution allowlist matches exactly the 4 approved tools, and OAuth scopes are unchanged."
        : " - either the execution allowlist did not match exactly, or OAuth scopes were altered by this update."),
  );

  process.exitCode = overallPass ? 0 : 1;

  console.log(
    "\nSTOPPING HERE, as instructed: no OAuth link was created, no redirect URL generated, no Google " +
      "account touched, no connected account created. Neither the broad auth config " +
      "(syveka-poc-googlecalendar-test-only) nor the mutually-exclusive scopes+tools test config " +
      "(syveka-poc-googlecalendar-scoped-test) were read, matched, or modified by this script.",
  );
  console.log(`\nAuth config id tested: ${authConfigId}`);
}

main().catch((err) => {
  console.error("test-tool-execution-allowlist failed:", (err as Error).message);
  process.exitCode = 1;
});
