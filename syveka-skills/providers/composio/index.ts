import { createUnavailableStubProvider } from "../unavailable-stub.js";

/**
 * Composio (capability `integration.gateway`) - P1/EXPERIMENTAL, REVIEW status in the
 * registry (see core/registry/data.ts). Honestly unavailable, same shape as
 * shadcn-mcp/twentyfirst-dev/claude-video: no live connection, no OAuth app registered, no
 * COMPOSIO_API_KEY provisioned. See docs/skills/composio-integration.md for the full
 * evaluation, the required security conditions before this can move past REFERENCE, and the
 * PoC design that would earn CONNECTED/VERIFIED.
 */
export const composioProvider = createUnavailableStubProvider({
  id: "composio",
  reason:
    "Composio is an experimental, P1 integration gateway - not connected in this " +
    "environment. Requires an approved OAuth app, a provisioned COMPOSIO_API_KEY, tenant-" +
    "mapping design, and a GDPR/privacy review before any live use. See " +
    "docs/skills/composio-integration.md.",
});
