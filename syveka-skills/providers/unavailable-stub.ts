import type { Provider } from "./types.js";

/**
 * Shared shape for a provider that is real, registered, and reviewed (see
 * the registry), but has no live connection configured in this
 * environment. `isAvailable()` returns false - this is not a "fake"
 * provider that pretends to work and then fails; it honestly reports
 * unavailability up front, so the router can fall back or the orchestrator
 * can report CAPABILITY_UNAVAILABLE instead of fabricating a result.
 *
 * Per the product brief's failure-handling requirement: "If a provider is
 * unavailable: report capability unavailable instead of pretending
 * success." Every external-service provider in this MVP (shadcn MCP,
 * 21st.dev, Scrapling, claude-video) uses this shape until a real
 * connection is wired and independently verified.
 */
export function createUnavailableStubProvider(params: { id: string; reason: string }): Provider {
  return {
    id: params.id,
    isAvailable: () => false,
    async execute() {
      return {
        status: "UNAVAILABLE" as const,
        message: params.reason,
        evidence: [],
      };
    },
  };
}
