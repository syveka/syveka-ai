import { listRegistry } from "../core/registry/index.js";

/**
 * The single source of truth every adapter renders from. This is what
 * "model portability" means concretely in this codebase: adapters/
 * claude-code, adapters/codex, and adapters/gemini all read the SAME
 * registry data and produce a target-specific rendering of it - none of
 * them owns a second copy of "what Syveka can do." See
 * evals/model-portability.test.ts, which asserts all three adapters agree
 * on the same underlying capability set.
 */
export function describedCapabilities(): {
  capability: string;
  provider: string;
  status: string;
}[] {
  return listRegistry().map((e) => ({
    capability: e.capability,
    provider: e.provider,
    status: e.status,
  }));
}
