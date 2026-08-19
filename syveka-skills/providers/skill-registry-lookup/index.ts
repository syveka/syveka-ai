import type { Provider } from "../types.js";
import type { ProviderResult } from "../../schemas/index.js";
import { searchRegistry } from "../../core/registry/index.js";

/**
 * Real "skill discovery" provider - searches the actual Syveka Skills
 * Registry (core/registry/data.ts, itself sourced from
 * docs/skills/SKILLS_REGISTRY.md at the repo root). Not a live web search:
 * this MVP does not have a working Vercel Labs "Find Skills" connection, so
 * discovery is scoped to what Syveka has actually reviewed. A query that
 * matches nothing returns an honest empty result, not a fabricated one -
 * see docs/architecture.md "Discovery never equals trust".
 */
export function createSkillRegistryLookupProvider(): Provider {
  return {
    id: "skill-registry-lookup",
    isAvailable: () => true,
    async execute(input: Record<string, unknown>): Promise<ProviderResult> {
      const query =
        typeof input.query === "string"
          ? input.query
          : typeof input.request === "string"
            ? input.request
            : "";
      const results = searchRegistry(query);
      return {
        status: "SUCCESS",
        message:
          results.length > 0
            ? `found ${results.length} registry match(es) for "${query}"`
            : `no approved/reviewed skill found for "${query}" - discovery scope is limited to ` +
              "what has actually been reviewed; recommend a manual review before adopting anything new",
        evidence: [
          {
            type: "database_query",
            description: `searchRegistry("${query}")`,
            data: JSON.stringify(
              results.map((r) => ({ id: r.id, capability: r.capability, status: r.status })),
            ),
            timestamp: new Date().toISOString(),
          },
        ],
        data: results,
      };
    },
  };
}
