/**
 * Server-side pricing table — USD per 1M tokens.
 * Mirrors ccusage & Anthropic/OpenAI list pricing. Used by the daily
 * per-project sync job to compute cost_usd at ingestion time.
 */
export type PricingSource = 'claude' | 'codex';

export type ModelRates = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
};

const CLAUDE_RATES: Array<[string, ModelRates]> = [
  ['opus-4-7', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['opus-4-6', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['opus-4', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['opus', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['sonnet-4-6', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['sonnet-4', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['sonnet-3-5', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['sonnet', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['haiku-4-5', { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  ['haiku-3-5', { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
  ['haiku', { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
];

const CODEX_RATES: Array<[string, ModelRates]> = [
  ['gpt-5-codex', { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 }],
  ['gpt-5-mini', { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 }],
  ['gpt-5-nano', { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0.05 }],
  ['gpt-5', { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 }],
  ['gpt-4o-mini', { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 }],
  ['gpt-4o', { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 }],
  ['gpt-4', { input: 5, output: 15, cacheRead: 2.5, cacheWrite: 5 }],
  ['o4', { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 }],
  ['o3', { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 }],
];

const CLAUDE_FALLBACK: ModelRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const CODEX_FALLBACK: ModelRates = { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 };

export function lookupRates(model: string | null, source: PricingSource): ModelRates {
  const lower = (model || '').toLowerCase();
  const table = source === 'claude' ? CLAUDE_RATES : CODEX_RATES;
  for (const [key, rates] of table) {
    if (lower.includes(key)) {
      return rates;
    }
  }
  return source === 'claude' ? CLAUDE_FALLBACK : CODEX_FALLBACK;
}

/**
 * Event-level cost computation. Pass per-event token counts + model.
 * All inputs in raw token counts; output in USD.
 */
export function eventCostUsd(params: {
  model: string | null;
  source: PricingSource;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}): number {
  const r = lookupRates(params.model, params.source);
  return (
    (params.inputTokens * r.input +
      params.outputTokens * r.output +
      params.cacheReadTokens * r.cacheRead +
      params.cacheWriteTokens * r.cacheWrite) /
    1_000_000
  );
}
