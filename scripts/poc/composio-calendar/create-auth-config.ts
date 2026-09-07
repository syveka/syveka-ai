/**
 * Phase 4 ONLY (task brief): creates ONE Composio-managed Google Calendar
 * auth config restricted to exactly 4 verified tool slugs, reads it back,
 * and reports the Google OAuth scopes Composio intends to request - then
 * stops. This file must never be extended to call `client.link.create()`
 * or any other OAuth-initiating endpoint; that is Phase 5, gated on
 * separate, explicit human approval after reviewing this script's output.
 *
 * Endpoints used (verified directly from the official `@composio/client`
 * SDK source - see docs/skills/composio-calendar-poc.md "Phase 1"):
 *   POST /api/v3.1/auth_configs        - create
 *   GET  /api/v3.1/auth_configs/{id}   - read back
 *   GET  /api/v3.1/toolkits/googlecalendar - independent scope-ceiling cross-check
 *
 * Tool slugs below are the exact 4 confirmed live via discover.ts - this
 * script hard-fails if that set is ever edited to include anything else,
 * so a future accidental broadening can't silently slip through.
 *
 * Run: COMPOSIO_API_KEY=... npx tsx scripts/poc/composio-calendar/create-auth-config.ts
 */

// Explicit module marker - see discover.ts's identical comment: without
// any import/export, TS treats this as a global script, which would
// collide with scripts/verify-composio-key.ts's own top-level `main`
// under the root tsconfig's broad `**/*.ts` include.
export {};

const BASE_URL = process.env.COMPOSIO_BASE_URL || "https://backend.composio.dev";
const TOOLKIT_SLUG = "googlecalendar";

const APPROVED_TOOL_SLUGS = [
  "GOOGLECALENDAR_EVENTS_LIST",
  "GOOGLECALENDAR_CREATE_EVENT",
  "GOOGLECALENDAR_EVENTS_GET",
  "GOOGLECALENDAR_DELETE_EVENT",
] as const;

// The narrowest Google Calendar OAuth scope that still covers event
// list/create/get/delete: Google's own scope hierarchy separates
// "calendar.events" (read/write EVENTS only) from the bare "calendar"
// scope (full access, including calendar creation/deletion and ACL/
// sharing management) - see
// https://developers.google.com/calendar/api/auth (not fetchable from
// this sandbox; documented here from Google's well-known, stable scope
// taxonomy). Anything outside this set is flagged, not silently accepted.
const ACCEPTABLE_SCOPES = new Set(["https://www.googleapis.com/auth/calendar.events"]);

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
  body?: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(new URL(path, BASE_URL), {
    method,
    headers: {
      "x-api-key": apiKey,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
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

async function main(): Promise<void> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    console.error("COMPOSIO_API_KEY is not set - failing closed. No auth config will be created.");
    process.exitCode = 1;
    return;
  }

  console.log("=== Phase 4: create least-privilege Google Calendar auth config ===\n");
  console.log("Approved tool allowlist (exactly these 4, nothing else):");
  for (const slug of APPROVED_TOOL_SLUGS) console.log(`  - ${slug}`);

  const requestBody = {
    toolkit: { slug: TOOLKIT_SLUG },
    auth_config: {
      type: "use_composio_managed_auth" as const,
      name: "syveka-poc-googlecalendar-test-only",
      tool_access_config: {
        tools_for_connected_account_creation: [...APPROVED_TOOL_SLUGS],
      },
    },
  };

  console.log("\nRequest body (POST /api/v3.1/auth_configs):");
  console.log(JSON.stringify(requestBody, null, 2));

  const createResult = await callComposio(apiKey, "POST", "/api/v3.1/auth_configs", requestBody);
  console.log(`\n-> HTTP ${createResult.status}`);
  console.log(JSON.stringify(maskSecretShaped(createResult.body), null, 2));

  if (createResult.status < 200 || createResult.status >= 300) {
    console.error("\nAuth config creation FAILED - stopping. No OAuth attempted.");
    process.exitCode = 1;
    return;
  }

  const created = createResult.body as { auth_config?: { id?: string } };
  const authConfigId = created.auth_config?.id;
  if (!authConfigId) {
    console.error(
      "\nCreate response did not include an auth_config.id - stopping. No OAuth attempted.",
    );
    process.exitCode = 1;
    return;
  }

  console.log(`\nCreated auth config id: ${authConfigId}`);
  console.log("\n=== Reading it back (GET /api/v3.1/auth_configs/{id}) ===");
  const retrieveResult = await callComposio(
    apiKey,
    "GET",
    `/api/v3.1/auth_configs/${authConfigId}`,
  );
  console.log(`-> HTTP ${retrieveResult.status}`);
  const detail = (retrieveResult.body ?? {}) as Record<string, unknown>;
  console.log(JSON.stringify(maskSecretShaped(detail), null, 2));

  console.log(
    `\nSummary: id=${detail.id} toolkit=${(detail.toolkit as { slug?: string } | undefined)?.slug} ` +
      `type=${detail.type} is_composio_managed=${detail.is_composio_managed} status=${detail.status}`,
  );
  const allowlist =
    (detail.tool_access_config as { tools_for_connected_account_creation?: string[] } | undefined)
      ?.tools_for_connected_account_creation ?? [];
  console.log(`Allowlisted tools on the created config: ${JSON.stringify(allowlist)}`);
  const allowlistMatches =
    allowlist.length === APPROVED_TOOL_SLUGS.length &&
    APPROVED_TOOL_SLUGS.every((s) => allowlist.includes(s));
  console.log(
    `Allowlist matches exactly the approved 4: ${allowlistMatches ? "YES" : "NO - MISMATCH"}`,
  );

  const scopes = extractScopes(detail);
  console.log(`\nGoogle OAuth scopes reported on the auth config: ${JSON.stringify(scopes)}`);

  console.log("\n=== Independent cross-check: toolkit's own managed-auth scope ceiling ===");
  const toolkitResult = await callComposio(apiKey, "GET", `/api/v3.1/toolkits/${TOOLKIT_SLUG}`);
  console.log(`GET /api/v3.1/toolkits/${TOOLKIT_SLUG} -> ${toolkitResult.status}`);
  const toolkitDetail = (toolkitResult.body ?? {}) as { composio_managed_auth?: unknown };
  console.log(
    "composio_managed_auth:",
    JSON.stringify(toolkitDetail.composio_managed_auth, null, 2),
  );

  console.log("\n=== SECURITY GATE ===");
  const allScopesForCheck = scopes.length > 0 ? scopes : [];
  const broaderThanNeeded = allScopesForCheck.filter((s) => !ACCEPTABLE_SCOPES.has(s));
  if (allScopesForCheck.length === 0) {
    console.log(
      "No scopes were readable directly from the auth config response - inspect the printed JSON " +
        "above and the toolkit cross-check manually before proceeding. Do NOT assume this means no " +
        "scopes will be requested.",
    );
  } else if (broaderThanNeeded.length > 0) {
    console.log(
      "BLOCKED: scopes broader than needed for list/create/get/delete events were found:",
    );
    for (const s of broaderThanNeeded) console.log(`  - ${s}`);
    console.log(
      "Per the task's security gate, this must be reported and a human decision made BEFORE any " +
        "OAuth connection is created.",
    );
  } else {
    console.log(
      `PASS: all reported scopes are within the acceptable set: ${JSON.stringify([...ACCEPTABLE_SCOPES])}`,
    );
  }

  console.log(
    "\nSTOPPING HERE, as scoped: no OAuth link was created, no redirect URL generated, no Google " +
      "account touched. Phase 5 (OAuth) requires separate, explicit human approval after reviewing " +
      "everything printed above.",
  );
}

main().catch((err) => {
  console.error("create-auth-config failed:", (err as Error).message);
  process.exitCode = 1;
});
