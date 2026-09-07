/**
 * Phase 1 (task brief): read-only, live discovery of the Google Calendar
 * toolkit's real current shape - no OAuth, no writes, no connected
 * accounts created, no auth configs created.
 *
 * Endpoint paths/header below are the exact ones the official
 * `@composio/client` SDK source uses (verified directly from its
 * generated resource files, not from memory or docs.composio.dev, which
 * is unreachable from this sandbox) - see docs/skills/composio-calendar-poc.md
 * "Phase 1: API verification" for the file-by-file trail.
 *
 * Deliberately uses raw `fetch`, matching scripts/verify-composio-key.ts's
 * precedent, rather than adding `@composio/client` as a new project
 * dependency for a throwaway PoC script.
 *
 * Run: COMPOSIO_API_KEY=... npx tsx scripts/poc/composio-calendar/discover.ts
 */

// Explicit module marker: without any import/export, TS treats a script as a
// global (non-module) file - this one would otherwise collide with
// scripts/verify-composio-key.ts's own top-level `maskKey`/`main`
// declarations under the root tsconfig's broad `**/*.ts` include.
export {};

const BASE_URL = process.env.COMPOSIO_BASE_URL || "https://backend.composio.dev";
const TOOLKIT_SLUG = "googlecalendar";

function maskKey(key: string): string {
  if (key.length <= 8) return "*".repeat(key.length);
  return `${key.slice(0, 4)}${"*".repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`;
}

async function get(apiKey: string, path: string): Promise<{ status: number; body: unknown }> {
  const res = await fetch(new URL(path, BASE_URL), {
    method: "GET",
    headers: { "x-api-key": apiKey },
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    // non-JSON response - body stays null, status still reported
  }
  return { status: res.status, body };
}

async function main(): Promise<void> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    console.error("COMPOSIO_API_KEY is not set - failing closed, nothing to discover.");
    process.exitCode = 1;
    return;
  }

  console.log(`Discovering Google Calendar toolkit via ${BASE_URL} using key ${maskKey(apiKey)}`);
  console.log("Read-only calls only: toolkit info, tool list, existing auth configs. No writes.\n");

  const toolkit = await get(apiKey, `/api/v3.1/toolkits/${TOOLKIT_SLUG}`);
  console.log(`GET /api/v3.1/toolkits/${TOOLKIT_SLUG} -> ${toolkit.status}`);
  if (toolkit.status === 200 && toolkit.body && typeof toolkit.body === "object") {
    const b = toolkit.body as Record<string, unknown>;
    console.log(
      "  composio_managed_auth (scope ceiling):",
      JSON.stringify(b.composio_managed_auth ?? "(not present)"),
    );
    console.log(
      "  is_locally_managed_by_composio / enabled:",
      JSON.stringify(b.enabled ?? "(unknown)"),
    );
  } else if (toolkit.status !== 200) {
    console.log(
      "  (toolkit lookup did not return 200 - see status above; slug may differ from 'googlecalendar')",
    );
  }

  const tools = await get(apiKey, `/api/v3.1/tools?toolkit_slug=${TOOLKIT_SLUG}&limit=50`);
  console.log(`\nGET /api/v3.1/tools?toolkit_slug=${TOOLKIT_SLUG} -> ${tools.status}`);
  if (tools.status === 200 && tools.body && typeof tools.body === "object") {
    const items = (tools.body as { items?: Array<{ slug?: string; name?: string }> }).items ?? [];
    console.log(`  ${items.length} tool(s) found. Slugs:`);
    for (const item of items) {
      console.log(`    - ${item.slug ?? "(no slug)"}  ${item.name ? `(${item.name})` : ""}`);
    }
    console.log(
      "\n  ACTION REQUIRED (per Phase 2): from this real list, identify the exact slugs for list-events, " +
        "create-event, get-event, and delete-event, and record them in docs/skills/composio-calendar-poc.md - " +
        "do not guess/reuse remembered names for the actual PoC run.",
    );
  }

  const existingAuthConfigs = await get(
    apiKey,
    `/api/v3.1/auth_configs?toolkit_slug=${TOOLKIT_SLUG}`,
  );
  console.log(
    `\nGET /api/v3.1/auth_configs?toolkit_slug=${TOOLKIT_SLUG} -> ${existingAuthConfigs.status}`,
  );
  if (
    existingAuthConfigs.status === 200 &&
    existingAuthConfigs.body &&
    typeof existingAuthConfigs.body === "object"
  ) {
    const items =
      (existingAuthConfigs.body as { items?: Array<Record<string, unknown>> }).items ?? [];
    console.log(`  ${items.length} existing auth config(s) for this toolkit on this project.`);
    for (const item of items) {
      console.log(
        `    - id=${item.id} name=${item.name} type=${item.type} is_composio_managed=${item.is_composio_managed} status=${item.status} no_of_connections=${item.no_of_connections}`,
      );
    }
    if (items.length > 0) {
      console.log(
        "\n  An existing auth config was found - re-using it (if its scopes/tool_access_config are " +
          "already least-privilege) may be preferable to creating a new one. Do not assume; inspect it.",
      );
    } else {
      console.log(
        "\n  No existing auth config for this toolkit - a new one must be created (Phase 4).",
      );
    }
  }

  console.log(
    "\nDone. No OAuth was initiated, no auth config was created, no connected account was touched.",
  );
}

main().catch((err) => {
  console.error("Discovery failed:", (err as Error).message);
  process.exitCode = 1;
});
