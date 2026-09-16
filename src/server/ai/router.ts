import "server-only";

/**
 * Model router (§15.2). Config-driven so model upgrades are ops changes.
 * Pinned versions reviewed monthly (arch §25 "Continuous").
 */
export type AiTask =
  | "chat"
  | "deep"
  | "utility"
  | "title"
  | "sentiment"
  | "summary"
  | "draft"
  | "voice"
  | "publicAssistant";

export type ModelChoice = {
  provider: "anthropic" | "openai";
  model: string;
  maxTokens: number;
};

const ROUTES: Record<AiTask, ModelChoice> = {
  chat: { provider: "anthropic", model: "claude-sonnet-4-5", maxTokens: 4096 },
  deep: { provider: "anthropic", model: "claude-opus-4-8", maxTokens: 8192 },
  utility: { provider: "anthropic", model: "claude-haiku-4-5-20251001", maxTokens: 1024 },
  title: { provider: "anthropic", model: "claude-haiku-4-5-20251001", maxTokens: 64 },
  sentiment: { provider: "anthropic", model: "claude-haiku-4-5-20251001", maxTokens: 16 },
  summary: { provider: "anthropic", model: "claude-haiku-4-5-20251001", maxTokens: 1024 },
  draft: { provider: "anthropic", model: "claude-sonnet-4-5", maxTokens: 1024 },
  // Vapi voice assistants (src/server/integrations/vapi.ts) -- Vapi validates
  // model.model against its own accepted-model allowlist, confirmed 2026-09-15
  // in production (Vapi POST /assistant -> 400 rejected the unrelated "chat"
  // model string this route previously duplicated). maxTokens is unused by the
  // Vapi path today; kept for type consistency with every other route.
  voice: { provider: "anthropic", model: "claude-haiku-4-5-20251001", maxTokens: 1024 },
  // Public marketing-site assistant (src/app/api/v1/public/assistant) --
  // unauthenticated, so kept on the cheapest model with a small output cap
  // regardless of the requester's plan (there is no plan; there's no login).
  publicAssistant: { provider: "anthropic", model: "claude-haiku-4-5-20251001", maxTokens: 512 },
};

const FALLBACK: ModelChoice = { provider: "openai", model: "gpt-4o", maxTokens: 4096 };

export function routeModel(task: AiTask, pinnedModel?: string | null): ModelChoice {
  const route = ROUTES[task];
  if (pinnedModel) return { ...route, model: pinnedModel };
  return route;
}

export function fallbackModel(): ModelChoice {
  return FALLBACK;
}
