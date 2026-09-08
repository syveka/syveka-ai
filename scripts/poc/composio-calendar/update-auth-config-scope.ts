/**
 * Least-privilege scope EXPANSION, explicitly authorized and narrowly scoped
 * (task brief "Determine and implement the MINIMUM additional OAuth scope
 * required for the current four-tool Calendar PoC"): GOOGLECALENDAR_CREATE_EVENT
 * was proven live (event-roundtrip.ts) to fail with a real Google
 * `403 ACCESS_TOKEN_SCOPE_INSUFFICIENT` on an internal `calendars.get` call
 * that action makes - not caused by any argument this PoC controls.
 *
 * Verified against Google's own live API discovery document
 * (https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest, fetched
 * fresh, not memory): `calendars.get`'s accepted scopes are exactly
 * `calendar`, `calendar.app.created`, `calendar.calendars`,
 * `calendar.calendars.readonly`, `calendar.readonly`. `calendar.app.created`
 * only covers app-created resources (not the pre-existing "primary"
 * calendar, so it would not actually work here); `calendar.calendars` is
 * read+write and broader than needed for a read-only calendars.get call.
 * `calendar.calendars.readonly` is therefore the narrowest scope in that
 * list that actually satisfies the dependency. The same discovery document
 * confirms `events.list`/`insert`/`get`/`delete` (the four approved tools'
 * own operations) all already accept `calendar.events` - so it remains
 * necessary and sufficient for those, and only `calendars.get` needs the new
 * scope.
 *
 * This script updates ONLY the OAuth scope on the existing, already-approved
 * auth config (discovered by exact name, never a hardcoded id) via
 * `PATCH /api/v3.1/auth_configs/{id}`, per the SDK's own
 * `AuthConfigUpdateParams` (`type: 'default'` variant): scopes is a
 * TOP-LEVEL field on update (not nested under `credentials`, unlike
 * create-time), confirmed by inspecting the unpacked `@composio/client`
 * 0.1.0-alpha.76 tarball directly, not guessed. Nothing else is included in
 * the PATCH body - `tool_access_config` is deliberately omitted so the
 * execution allowlist is left untouched (the update endpoint's own contract:
 * "Only specified fields will be updated").
 *
 * Fails closed before touching anything unless the auth config's CURRENT
 * scope is exactly the single old scope this PoC has used throughout
 * (`calendar.events` alone) and its CURRENT execution allowlist is exactly
 * the 4 approved tool slugs - i.e. it refuses to "expand" a config that
 * isn't in the exact state this task's evidence was gathered against.
 *
 * Run: COMPOSIO_API_KEY=... npx tsx scripts/poc/composio-calendar/update-auth-config-scope.ts
 */

export {};

const BASE_URL = process.env.COMPOSIO_BASE_URL || "https://backend.composio.dev";
const TOOLKIT_SLUG = "googlecalendar";
const TARGET_AUTH_CONFIG_NAME = "syveka-poc-googlecalendar-events-scope-only";
const OLD_SCOPE = "https://www.googleapis.com/auth/calendar.events";
const NEW_SCOPE = "https://www.googleapis.com/auth/calendar.calendars.readonly";
const EXPECTED_SCOPES_AFTER = [OLD_SCOPE, NEW_SCOPE];
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

function sameSet(a: string[], b: string[]): boolean {
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
    "=== Least-privilege scope expansion: calendar.events -> calendar.events + calendar.calendars.readonly ===\n",
  );

  console.log("=== Step 1: discover the target auth config by exact name ===");
  const listResult = await callComposio(apiKey, "GET", "/api/v3.1/auth_configs", {
    query: { toolkit_slug: TOOLKIT_SLUG, search: TARGET_AUTH_CONFIG_NAME },
  });
  if (listResult.status < 200 || listResult.status >= 300) {
    console.error("Discovery FAILED - stopping. No update attempted.");
    process.exitCode = 1;
    return;
  }
  const listBody = listResult.body as { items?: Array<{ id: string; name: string }> };
  const exactMatches = (listBody.items ?? []).filter((i) => i.name === TARGET_AUTH_CONFIG_NAME);
  if (exactMatches.length !== 1) {
    console.error(
      `FAIL CLOSED: expected exactly 1 auth config named "${TARGET_AUTH_CONFIG_NAME}", found ${exactMatches.length}.`,
    );
    process.exitCode = 1;
    return;
  }
  const authConfigId = exactMatches[0]!.id;
  console.log(`Resolved auth config id: ${authConfigId}`);

  console.log("\n=== Step 2: read current state BEFORE update ===");
  const beforeResult = await callComposio(apiKey, "GET", `/api/v3.1/auth_configs/${authConfigId}`);
  if (beforeResult.status < 200 || beforeResult.status >= 300) {
    console.error("Pre-update read FAILED - stopping.");
    process.exitCode = 1;
    return;
  }
  const before = (beforeResult.body ?? {}) as Record<string, unknown>;
  const scopesBefore = extractScopes(before);
  const executionBefore = extractExecutionAllowlist(before);
  const typeBefore = before.type as string | undefined;
  console.log(`BEFORE: type=${typeBefore} scopes=${JSON.stringify(scopesBefore)}`);
  console.log(`BEFORE: tools_available_for_execution=${JSON.stringify(executionBefore)}`);

  if (scopesBefore.length !== 1 || scopesBefore[0] !== OLD_SCOPE) {
    console.error(
      `FAIL CLOSED: pre-update scopes are not exactly [${OLD_SCOPE}] (got ${JSON.stringify(scopesBefore)}). ` +
        "Refusing to proceed - this may not be the config this evidence was gathered against.",
    );
    process.exitCode = 1;
    return;
  }
  const approvedSet = new Set<string>(APPROVED_TOOL_SLUGS);
  const executionBeforeSet = new Set(executionBefore);
  const missingBefore = [...approvedSet].filter((s) => !executionBeforeSet.has(s));
  const extraBefore = executionBefore.filter((s) => !approvedSet.has(s));
  if (missingBefore.length !== 0 || extraBefore.length !== 0 || executionBefore.length !== 4) {
    console.error(
      `FAIL CLOSED: pre-update execution allowlist is not exactly the 4 approved tools ` +
        `(missing=${JSON.stringify(missingBefore)}, extra=${JSON.stringify(extraBefore)}).`,
    );
    process.exitCode = 1;
    return;
  }
  if (typeBefore !== "default") {
    console.error(`FAIL CLOSED: unexpected auth config type "${typeBefore}", expected "default".`);
    process.exitCode = 1;
    return;
  }
  console.log("PASS: pre-update state matches exactly what this evidence was gathered against.\n");

  console.log("=== Step 3: PATCH scopes only (top-level field for type: 'default', per SDK) ===");
  const updateBody = {
    type: "default" as const,
    scopes: EXPECTED_SCOPES_AFTER,
  };
  console.log("Request body:", JSON.stringify(updateBody, null, 2));
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
    console.error("Update FAILED - stopping.");
    process.exitCode = 1;
    return;
  }

  console.log("\n=== Step 4: independently re-read the config AFTER update (fresh GET) ===");
  const afterResult = await callComposio(apiKey, "GET", `/api/v3.1/auth_configs/${authConfigId}`);
  if (afterResult.status < 200 || afterResult.status >= 300) {
    console.error("FAIL CLOSED: post-update verification read FAILED - cannot confirm outcome.");
    process.exitCode = 1;
    return;
  }
  const after = (afterResult.body ?? {}) as Record<string, unknown>;
  const scopesAfter = extractScopes(after);
  const executionAfter = extractExecutionAllowlist(after);
  console.log(`AFTER: scopes=${JSON.stringify(scopesAfter)}`);
  console.log(`AFTER: tools_available_for_execution=${JSON.stringify(executionAfter)}`);

  const scopesMatch = sameSet(scopesAfter, EXPECTED_SCOPES_AFTER);
  const executionUnchanged = sameSet(executionAfter, [...APPROVED_TOOL_SLUGS]);
  const noExtraScope = scopesAfter.every((s) => EXPECTED_SCOPES_AFTER.includes(s));

  console.log(`\nScopes match exactly the intended 2-scope set: ${scopesMatch}`);
  console.log(`No unexpected extra scope present: ${noExtraScope}`);
  console.log(
    `Execution allowlist unchanged (still exactly the 4 approved tools): ${executionUnchanged}`,
  );

  const overallPass = scopesMatch && noExtraScope && executionUnchanged;
  console.log(
    `\nSCOPE EXPANSION: ${overallPass ? "PASS" : "FAILED / UNEXPECTED STATE"} - ` +
      (overallPass
        ? "scopes are now exactly calendar.events + calendar.calendars.readonly, allowlist untouched."
        : "review the state above before proceeding to any new OAuth link."),
  );
  process.exitCode = overallPass ? 0 : 1;

  console.log(
    "\nSTOPPING HERE: no OAuth link was created, no connected account touched, no Google account " +
      "accessed by this script. A NEW OAuth link/consent is required for this scope change to take " +
      "effect on any connection - existing connected accounts keep their old grant until reconnected.",
  );
}

main().catch((err) => {
  console.error("update-auth-config-scope failed:", (err as Error).message);
  process.exitCode = 1;
});
