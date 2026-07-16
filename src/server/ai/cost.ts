export type TokenUsage = { tokensIn: number; tokensOut: number };

type ModelPrice = { inputPerMillionUsd: number; outputPerMillionUsd: number };

const MODEL_PRICES: Array<[RegExp, ModelPrice]> = [
  [/claude-opus/i, { inputPerMillionUsd: 15, outputPerMillionUsd: 75 }],
  [/claude-sonnet/i, { inputPerMillionUsd: 3, outputPerMillionUsd: 15 }],
  [/claude-haiku/i, { inputPerMillionUsd: 0.8, outputPerMillionUsd: 4 }],
  [/gpt-4o-mini/i, { inputPerMillionUsd: 0.15, outputPerMillionUsd: 0.6 }],
  [/gpt-4o/i, { inputPerMillionUsd: 2.5, outputPerMillionUsd: 10 }],
];

const DEFAULT_PRICE: ModelPrice = { inputPerMillionUsd: 3, outputPerMillionUsd: 15 };

export function estimateAiCostUsd(model: string, usage: TokenUsage): number {
  return estimateAiCost(model, usage).totalUsd;
}

export function estimateAiCost(
  model: string,
  usage: TokenUsage,
): {
  promptUsd: number;
  completionUsd: number;
  totalUsd: number;
} {
  const price = MODEL_PRICES.find(([pattern]) => pattern.test(model))?.[1] ?? DEFAULT_PRICE;
  const promptUsd = (usage.tokensIn * price.inputPerMillionUsd) / 1_000_000;
  const completionUsd = (usage.tokensOut * price.outputPerMillionUsd) / 1_000_000;
  return {
    promptUsd: Number(promptUsd.toFixed(8)),
    completionUsd: Number(completionUsd.toFixed(8)),
    totalUsd: Number((promptUsd + completionUsd).toFixed(8)),
  };
}
