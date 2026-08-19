import { registryEntrySchema, type RegistryEntry } from "../../schemas/index.js";
import { REGISTRY } from "./data.js";

/** Validates the seed data once at module load - fail loudly, not silently, on a bad entry. */
const VALIDATED: RegistryEntry[] = REGISTRY.map((entry) => registryEntrySchema.parse(entry));

export function listRegistry(): RegistryEntry[] {
  return VALIDATED;
}

export function findByCapability(capability: string): RegistryEntry[] {
  return VALIDATED.filter((e) => e.capability === capability);
}

export function findById(id: string): RegistryEntry | undefined {
  return VALIDATED.find((e) => e.id === id);
}

/**
 * Entries eligible to actually be selected by the router. Deliberately
 * narrower than "everything in the registry" - REJECTED and RESEARCH_ONLY
 * entries exist in the registry for documentation/audit purposes but must
 * never be routable, even if nothing else claims their capability.
 *
 * Gates on BOTH independent axes, not just `status`: a registry entry can
 * be `status: "APPROVED"` (the review said yes) while `integration_state`
 * is still `"REFERENCE"` or `"REVIEWED"` (no provider code exists yet) or
 * `"INSTALLED"` (code exists but has never been run against the real
 * dependency) - none of those are safe to route to, regardless of review
 * status. Only `"CONNECTED"` (manually run at least once) or `"VERIFIED"`
 * (automated evals actually exercised the real integration and passed)
 * represent code a caller could reasonably have wired into a real
 * providerMap. See docs/skills-registry.md "Integration state vs. review
 * status" for the full precedence rules this enforces.
 *
 * Found during independent adversarial review of PR #87/#88: this function
 * predates `integration_state` (added later, in Milestone 2's schema
 * change) and was never updated to gate on it - `status` alone was
 * sufficient before that field existed, but became an incomplete safety
 * net once a second, independent trust axis was introduced without also
 * teaching this function about it. Fixed here, on the branch that
 * introduced the field, rather than left as documentation-only.
 */
export function eligibleForRouting(entries: RegistryEntry[]): RegistryEntry[] {
  return entries.filter(
    (e) =>
      (e.status === "APPROVED" || e.status === "EXPERIMENTAL") &&
      (e.integration_state === "CONNECTED" || e.integration_state === "VERIFIED"),
  );
}

const STOPWORDS = new Set([
  "a",
  "an",
  "the",
  "for",
  "find",
  "skill",
  "tool",
  "plugin",
  "to",
  "of",
  "and",
  "or",
]);

/**
 * Keyword search over name/capability/id: extracts significant words from
 * a free-text query (e.g. "Find a skill for PDF analysis" -> ["pdf",
 * "analysis"]) and matches an entry if any registry field contains any
 * keyword as a substring. Deliberately keyword-based, not whole-phrase
 * substring matching - a full sentence almost never literally appears
 * inside a short registry field, which would make search look broken
 * (silently return nothing) even when a real, obvious match exists.
 */
export function searchRegistry(query: string): RegistryEntry[] {
  const keywords = query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));

  if (keywords.length === 0) return [];

  return VALIDATED.filter((e) => {
    const haystack = `${e.name} ${e.capability} ${e.id}`.toLowerCase();
    return keywords.some((k) => haystack.includes(k));
  });
}
