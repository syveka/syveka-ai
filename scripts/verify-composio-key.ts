/**
 * Verifies that COMPOSIO_API_KEY is a real, currently-valid Composio API
 * key, using a single read-only, authenticated API call. Nothing more.
 *
 * SCOPE BOUNDARY (do not extend without a separate, explicit task):
 *   - This script ONLY confirms the key authenticates against Composio's
 *     API. It never creates a connected account, never calls the
 *     OAuth-initiating endpoints (`POST /api/v3.1/connected_accounts` or
 *     `POST /api/v3.1/connected_accounts/link`), and never touches any
 *     third-party app credentials. See docs/skills/composio-integration.md
 *     for the full PoC design that would exercise an actual OAuth
 *     connection - that is explicitly NOT what this script does.
 *   - Composio itself is still `status: REVIEW` / `integration_state:
 *     REFERENCE` in syveka-skills/core/registry/data.ts and
 *     providers/composio/index.ts is still an honest unavailable stub -
 *     this script does not change either of those. It exists purely to
 *     let a human confirm a freshly-provisioned key actually works before
 *     any of that changes.
 *
 * Endpoint/header/base-URL facts below were taken directly from the
 * official `@composio/client` npm package source (not from memory or
 * assumed docs) - see client.ts (`x-api-key` header, default base URL
 * `https://backend.composio.dev`) and resources/connected-accounts.ts
 * (`GET /api/v3.1/connected_accounts` - list-only, no side effects).
 *
 * SECURITY: the raw key is read from process.env only, sent solely as the
 * `x-api-key` request header, and never written to stdout/stderr, logs,
 * or any file - only a masked form (first 4 + last 4 characters) is ever
 * printed, purely so a human can visually confirm which key was used.
 */

const DEFAULT_BASE_URL = "https://backend.composio.dev";
const VERIFY_PATH = "/api/v3.1/connected_accounts?page_size=1";
const REQUEST_TIMEOUT_MS = 10_000;

function maskKey(key: string): string {
  if (key.length <= 8) return "*".repeat(key.length);
  return `${key.slice(0, 4)}${"*".repeat(Math.max(4, key.length - 8))}${key.slice(-4)}`;
}

interface VerifyResult {
  ok: boolean;
  status: number | null;
  summary: string;
}

async function verifyComposioKey(apiKey: string, baseURL: string): Promise<VerifyResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(new URL(VERIFY_PATH, baseURL), {
      method: "GET",
      headers: { "x-api-key": apiKey },
      signal: controller.signal,
    });

    if (response.ok) {
      let accountCount: number | "unknown" = "unknown";
      try {
        const body: unknown = await response.json();
        if (body && typeof body === "object" && "items" in body && Array.isArray(body.items)) {
          accountCount = body.items.length;
        }
      } catch {
        // Response was 200 but not the expected JSON shape - the key is
        // still proven valid (an unauthenticated/invalid-key request never
        // reaches 200), just report the account count as unknown rather
        // than guessing at a body shape that didn't parse.
      }
      return {
        ok: true,
        status: response.status,
        summary: `Key is valid - GET /api/v3.1/connected_accounts returned ${response.status} (visible connected accounts on this page: ${accountCount}).`,
      };
    }

    if (response.status === 401) {
      return {
        ok: false,
        status: 401,
        summary: "Key is INVALID - Composio returned 401 Unauthorized.",
      };
    }
    if (response.status === 403) {
      return {
        ok: false,
        status: 403,
        summary:
          "Key was recognized but is not permitted to call this endpoint - Composio returned 403 Forbidden.",
      };
    }
    return {
      ok: false,
      status: response.status,
      summary: `Unexpected response - Composio returned HTTP ${response.status} ${response.statusText}.`,
    };
  } catch (err) {
    const isAbort = err instanceof Error && err.name === "AbortError";
    return {
      ok: false,
      status: null,
      summary: isAbort
        ? `Request to ${baseURL} timed out after ${REQUEST_TIMEOUT_MS / 1000}s - could not confirm the key either way.`
        : `Could not reach Composio at ${baseURL} - network error. Failing closed (never assuming a key is valid when it can't be checked).`,
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function main(): Promise<void> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey || apiKey.trim().length === 0) {
    console.error(
      "COMPOSIO_API_KEY is not set (or is empty) in this environment. Failing closed - " +
        "never treating a missing key as 'nothing to verify'.",
    );
    process.exitCode = 1;
    return;
  }

  const baseURL = process.env.COMPOSIO_BASE_URL || DEFAULT_BASE_URL;

  console.log(`Verifying Composio API key (${maskKey(apiKey)}) against ${baseURL} ...`);
  console.log(
    "Scope: read-only key check only. No OAuth connection will be initiated by this script.",
  );

  const result = await verifyComposioKey(apiKey, baseURL);
  console.log(result.summary);

  if (result.ok) {
    console.log(
      "\nStopping here, as scoped: the key is confirmed valid. No connected-account creation or " +
        "OAuth flow was attempted - see docs/skills/composio-integration.md for what a real " +
        "connection PoC would additionally require and its own explicit-authorization gate.",
    );
    process.exitCode = 0;
  } else {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("Unexpected error while verifying the Composio API key:", (err as Error).message);
  process.exitCode = 1;
});
