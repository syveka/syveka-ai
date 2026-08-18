import type { ProviderResult } from "../schemas/index.js";

/**
 * Every capability implementation - real or stub - implements this. The
 * router and orchestrator only ever see this interface, never a concrete
 * provider type; that's what keeps a provider swap from touching core logic.
 */
export interface Provider {
  /** Stable provider id, matches RegistryEntry.provider. */
  id: string;
  /**
   * Whether this provider can actually be used right now. Must reflect
   * reality - a stub with no live connection returns false, it does not
   * pretend to be available and fail later. See docs/provider-model.md.
   */
  isAvailable(): Promise<boolean> | boolean;
  execute(input: Record<string, unknown>): Promise<ProviderResult>;
}
