/**
 * Follow-up to test-scoped-auth-config.ts, which discovered a live 400:
 * "You cannot provide both scopes (or user_scopes) and
 * tool_access_config.tools_for_connected_account_creation for the same
 * auth config." This script creates a NEW, SEPARATE, SCOPES-ONLY auth
 * config (no `tool_access_config` at all) to isolate OAuth-scope
 * least-privilege from tool-execution least-privilege - two independent
 * security boundaries per docs/skills/composio-calendar-poc.md's Phase 3
 * design (see that doc's "Phase 1: repo/SDK truth" section added
 * alongside this file for the full evidence trail on why these are
 * separable, grounded in the @composio/client SDK's own
 * AuthConfigUpdateParams types - tools_available_for_execution is a
 * distinct, independently-updatable field from
 * tools_for_connected_account_creation).
 *
 * Neither the original broad auth config nor the mutually-exclusive
 * scopes+tools test config from the prior script are read, modified, or
 * deleted here - this creates a third, separate config.
 *
 * Run: COMPOSIO_API_KEY=... npx tsx scripts/poc/composio-calendar/test-scopes-only-auth-config.ts
 */

export {};

const BASE_URL = process.env.COMPOSIO_BASE_URL || "https://backend.composio.dev";
const TOOLKIT_SLUG = "googlecalendar";
const REQUESTED_SCOPE = "https://www.googleapis.com/auth/calendar.events";

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

  console.log("=== OAuth-scope-only test (no tool_access_config at all) ===\n");
  console.log(`Requested scope: ${REQUESTED_SCOPE}`);
  console.log("Deliberately NOT including tool_access_config - isolating the OAuth-scope boundary");
  console.log("from the tool-execution boundary, per the task's explicit instruction.\n");

  const requestBody = {
    toolkit: { slug: TOOLKIT_SLUG },
    auth_config: {
      type: "use_composio_managed_auth" as const,
      name: "syveka-poc-googlecalendar-events-scope-only",
      credentials: { scopes: REQUESTED_SCOPE },
    },
  };

  console.log("Request body (POST /api/v3.1/auth_configs) - a THIRD, separate config:");
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
  console.log(
    `tool_access_config on this config (expected empty/absent - none was requested): ${JSON.stringify(allowlist)}`,
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

  console.log(
    "\n=== OAUTH-SCOPE GATE: PASS only if returned scopes are EXACTLY [calendar.events] ===",
  );
  const exactMatch = returnedScopes.length === 1 && returnedScopes[0] === REQUESTED_SCOPE;
  const widened = returnedScopes.some((s) => s !== REQUESTED_SCOPE);

  if (exactMatch) {
    console.log(
      `OAUTH LEAST PRIVILEGE: PASS - Composio returned exactly ${REQUESTED_SCOPE}, nothing broader.`,
    );
    process.exitCode = 0;
  } else {
    console.log(
      `OAUTH LEAST PRIVILEGE: BLOCKED - Composio ${widened ? "widened" : "did not confirm"} the scope. ` +
        `Returned: ${JSON.stringify(returnedScopes)} vs requested: ${REQUESTED_SCOPE}.`,
    );
    process.exitCode = 1;
  }

  console.log(
    "\nTOOL EXECUTION LEAST PRIVILEGE: NOT TESTED BY THIS SCRIPT (by design - see task's explicit " +
      "'do not confuse OAuth scope restriction with tool authorization' instruction). SDK evidence " +
      "(docs/skills/composio-calendar-poc.md) indicates this config could later be updated via " +
      "`authConfigs.update(id, { type: 'default', tool_access_config: { tools_available_for_execution: " +
      "[...4 tools] } })` - a field distinct from tools_for_connected_account_creation and NOT subject " +
      "to the same mutual-exclusivity-with-scopes error seen in the prior script - but that update call " +
      "has not been executed. Status: NOT YET PROVEN.",
  );

  console.log(
    "\nSTOPPING HERE regardless of the gate result, as instructed: no OAuth link was created, no " +
      "redirect URL generated, no Google account touched. Neither the original broad auth config nor " +
      "the earlier scopes+tools (400) test config were read, modified, or deleted by this script.",
  );
}

main().catch((err) => {
  console.error("test-scopes-only-auth-config failed:", (err as Error).message);
  process.exitCode = 1;
});
