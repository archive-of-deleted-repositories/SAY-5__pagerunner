/**
 * Per-model token pricing for cost accounting on each LLM call.
 * Prices are in USD per 1M tokens.
 *
 * Prices last verified 2026-05-02 — update from anthropic.com/pricing on bumps.
 */
export interface ModelPrice {
  inputPerMTok: number;
  outputPerMTok: number;
}

export const MODEL_PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-4-7-20250929': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-sonnet-4-5-20250929': { inputPerMTok: 3, outputPerMTok: 15 },
  'claude-haiku-4-5-20251001': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-opus-4-5-20251001': { inputPerMTok: 15, outputPerMTok: 75 },
};

const FALLBACK_PRICE: ModelPrice = { inputPerMTok: 3, outputPerMTok: 15 };

export const priceFor = (model: string): ModelPrice => MODEL_PRICES[model] ?? FALLBACK_PRICE;

export const computeCostUsd = (model: string, tokensIn: number, tokensOut: number): number => {
  const p = priceFor(model);
  return (tokensIn * p.inputPerMTok + tokensOut * p.outputPerMTok) / 1_000_000;
};
