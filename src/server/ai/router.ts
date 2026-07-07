import "server-only";

/**
 * Model router (§15.2). Config-driven so model upgrades are ops changes.
 * Pinned versions reviewed monthly (arch §25 "Continuous").
 */
export type AiTask = "chat" | "deep" | "utility" | "title" | "sentiment" | "summary";

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
