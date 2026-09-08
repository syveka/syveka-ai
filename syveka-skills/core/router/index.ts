import type { RegistryEntry } from "../../schemas/index.js";
import { eligibleForRouting, findByCapability } from "../registry/index.js";
import type { Provider } from "../../providers/types.js";

/**
 * Routes an abstract capability (e.g. "ui.component.search") to a concrete,
 * approved provider. This is the layer that makes third parties replaceable:
 * nothing above this module ever references "shadcn" or "21st.dev" by name -
 * only a capability id. Swapping a provider means changing the registry and
 * the provider map, not the orchestrator.
 */

export type RouteResult =
  | { outcome: "ROUTED"; entry: RegistryEntry; provider: Provider }
  | { outcome: "NO_APPROVED_PROVIDER"; capability: string; candidates: RegistryEntry[] }
  | { outcome: "PROVIDER_UNAVAILABLE"; capability: string; entry: RegistryEntry };

export async function routeCapability(
  capability: string,
  providerMap: Record<string, Provider>,
  /**
   * Defaults to the real, committed registry (findByCapability(capability))
   * - every existing caller gets identical behavior to before this
   * parameter existed. The only legitimate reason to pass something else is
   * a deterministic test proving the routing/permission/evidence pipeline
   * itself works correctly, without needing a REVIEW/REFERENCE capability
   * to actually become routable in the real, committed registry data - see
   * evals/voice-call-summary.test.ts's "explicit deterministic test-provider
   * injection" case. This is the same trust boundary `providerMap` itself
   * already has: both are supplied by first-party calling code, never by an
   * external Skill/provider/agent.
   */
  candidates: RegistryEntry[] = findByCapability(capability),
): Promise<RouteResult> {
  const eligible = eligibleForRouting(candidates);

  if (eligible.length === 0) {
    return { outcome: "NO_APPROVED_PROVIDER", capability, candidates };
  }

  // Highest trust first (TRUSTED > CONDITIONAL > UNTRUSTED), stable order
  // otherwise - deterministic, not "whichever came first in the array".
  const trustRank: Record<string, number> = { TRUSTED: 0, CONDITIONAL: 1, UNTRUSTED: 2 };
  const ranked = [...eligible].sort(
    (a, b) => trustRank[a.trust_level]! - trustRank[b.trust_level]!,
  );

  for (const entry of ranked) {
    const provider = providerMap[entry.provider];
    if (!provider) continue;
    // Sequential by design: fall through to the next-ranked provider only
    // if the higher-trust one is unavailable, not a parallel race.
    const available = await provider.isAvailable();
    if (available) {
      return { outcome: "ROUTED", entry, provider };
    }
  }

  return { outcome: "PROVIDER_UNAVAILABLE", capability, entry: ranked[0]! };
}
