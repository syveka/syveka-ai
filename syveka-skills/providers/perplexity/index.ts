import { createUnavailableStubProvider } from "../unavailable-stub.js";

/**
 * Perplexity API (capability `research.cited`) - P2/optional research provider, REVIEW
 * status in the registry (see core/registry/data.ts). Honestly unavailable: no live
 * connection, no PERPLEXITY_API_KEY provisioned. Complements, not replaces, the existing
 * `web.research` capability (Scrapling) - see docs/skills/perplexity-research-integration.md
 * for the distinction, the required conditions before this can move past REFERENCE, and the
 * benchmark PoC that would earn CONNECTED/VERIFIED.
 */
export const perplexityProvider = createUnavailableStubProvider({
  id: "perplexity",
  reason:
    "Perplexity is an optional, P2 research provider - not connected in this environment. " +
    "Requires a provisioned PERPLEXITY_API_KEY and a benchmark against the existing " +
    "web.research pipeline before any live use. See " +
    "docs/skills/perplexity-research-integration.md.",
});
