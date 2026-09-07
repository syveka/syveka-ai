/**
 * Security follow-up test (task brief): does Composio-managed auth honor
 * an EXPLICIT `credentials.scopes` override, or does it silently widen
 * back to whatever it computes from `tools_for_connected_account_creation`
 * (which, for these 4 tools, is known to include the broader
 * https://www.googleapis.com/auth/calendar scope - see
 * scripts/poc/composio-calendar/create-auth-config.ts's prior live run)?
 *
 * Creates ONE NEW, SEPARATE auth config - the existing broader one
 * (docs/skills/composio-calendar-poc.md) is never read, modified, or
 * deleted by this script. No OAuth link is created; `client.link.create()`
 * / `POST /connected_accounts/link` is not referenced anywhere here.
 *
 * Run: COMPOSIO_API_KEY=... npx tsx scripts/poc/composio-calendar/test-scoped-auth-config.ts
 */

// Explicit module marker - see discover.ts/create-auth-config.ts's
// identical comment on the global-script collision with
// scripts/verify-composio-key.ts under the root tsconfig's broad include.
export {};

const BASE_URL = process.env.COMPOSIO_BASE_URL || "https://backend.composio.dev";
const TOOLKIT_SLUG = "googlecalendar";
const REQUESTED_SCOPE = "https://www.googleapis.com/auth/calendar.events";

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

  console.log("=== Managed-auth explicit-scope test (does Composio honor a narrower ask?) ===\n");
  console.log(`Requested scope: ${REQUESTED_SCOPE}`);
  console.log("Approved tool allowlist (exactly these 4, nothing else):");
  for (const slug of APPROVED_TOOL_SLUGS) console.log(`  - ${slug}`);

  const requestBody = {
    toolkit: { slug: TOOLKIT_SLUG },
    auth_config: {
      type: "use_composio_managed_auth" as const,
      name: "syveka-poc-googlecalendar-scoped-test",
      credentials: { scopes: REQUESTED_SCOPE },
      tool_access_config: {
        tools_for_connected_account_creation: [...APPROVED_TOOL_SLUGS],
      },
    },
  };

  console.log("\nRequest body (POST /api/v3.1/auth_configs) - a NEW, separate config:");
  console.log(JSON.stringify(requestBody, null, 2));

  const createResult = await callComposio(apiKey, "POST", "/api/v3.1/auth_configs", requestBody);
  console.log(`\n-> HTTP ${createResult.status}`);
  console.log(JSON.stringify(maskSecretShaped(createResult.body), null, 2));

  if (createResult.status < 200 || createResult.status >= 300) {
    console.error(
      "\nAuth config creation FAILED - stopping. No OAuth attempted, no scope gate to evaluate.",
    );
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

  const toolkitSlug = (detail.toolkit as { slug?: string } | undefined)?.slug;
  console.log(
    `\nSummary: id=${detail.id} toolkit=${toolkitSlug} type=${detail.type} ` +
      `is_composio_managed=${detail.is_composio_managed} status=${detail.status}`,
  );

  const allowlist =
    (detail.tool_access_config as { tools_for_connected_account_creation?: string[] } | undefined)
      ?.tools_for_connected_account_creation ?? [];
  console.log(`Allowlisted tools: ${JSON.stringify(allowlist)}`);
  const allowlistMatches =
    allowlist.length === APPROVED_TOOL_SLUGS.length &&
    APPROVED_TOOL_SLUGS.every((s) => allowlist.includes(s));
  console.log(
    `Allowlist matches exactly the approved 4: ${allowlistMatches ? "YES" : "NO - MISMATCH"}`,
  );

  const returnedScopes = extractScopes(detail);
  console.log(`\nREQUESTED scope: ${REQUESTED_SCOPE}`);
  console.log(`RETURNED scopes on the created auth config: ${JSON.stringify(returnedScopes)}`);

  console.log("\n=== Independent cross-check: toolkit's own managed-auth scope ceiling ===");
  const toolkitResult = await callComposio(apiKey, "GET", `/api/v3.1/toolkits/${TOOLKIT_SLUG}`);
  console.log(`GET /api/v3.1/toolkits/${TOOLKIT_SLUG} -> ${toolkitResult.status}`);
  const toolkitDetail = (toolkitResult.body ?? {}) as { composio_managed_auth?: unknown };
  console.log(
    "composio_managed_auth:",
    JSON.stringify(toolkitDetail.composio_managed_auth, null, 2),
  );

  console.log("\n=== GATE: PASS only if returned scopes are EXACTLY [calendar.events] ===");
  const exactMatch = returnedScopes.length === 1 && returnedScopes[0] === REQUESTED_SCOPE;
  const widened = returnedScopes.some((s) => s !== REQUESTED_SCOPE);

  if (exactMatch) {
    console.log(
      `PASS: Composio honored the explicit request - returned scope is exactly ${REQUESTED_SCOPE}.`,
    );
    console.log(
      "\nSTOPPING HERE, as scoped: no OAuth link was created, no redirect URL generated, no Google " +
        "account touched. This is now HUMAN OAUTH GATE ready for THIS auth config - separate, explicit " +
        "approval is still required before Phase 5 (OAuth) proceeds.",
    );
    process.exitCode = 0;
  } else {
    console.log(
      `BLOCKED: Composio ${widened ? "widened" : "did not confirm"} the scope. ` +
        `Returned: ${JSON.stringify(returnedScopes)} vs requested: ${REQUESTED_SCOPE}.`,
    );
    console.log(
      "\nPer the task's gate: stopping immediately. No OAuth link created, no Google account touched. " +
        "Recommend evaluating custom Google OAuth (bring-your-own Google Cloud OAuth client) as the next " +
        "path - see docs/skills/composio-calendar-poc.md.",
    );
    process.exitCode = 1;
  }

  console.log(
    `\nNote: the pre-existing broader auth config (created via create-auth-config.ts) was not read, ` +
      "modified, or deleted by this script - only this new, separate config was touched.",
  );
}

main().catch((err) => {
  console.error("test-scoped-auth-config failed:", (err as Error).message);
  process.exitCode = 1;
});
