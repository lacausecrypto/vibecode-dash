import { keychain } from '../lib/keychain';

/**
 * OpenRouter wrapper — **image generation only**.
 *
 * Text workloads (scoring, drafting, image classification) intentionally do
 * NOT go through OpenRouter. They route via the local Claude / Codex CLI
 * (see `wrappers/agentCli.ts`) to respect the workspace rule "pour la
 * couche agent, utiliser exclusivement les CLI (claude, codex), pas de
 * SDK" and to reuse the user's existing subscription / OAuth session.
 *
 * OpenRouter is PAYG on the user's account and covers image models the
 * CLIs can't produce. Pricing is per-token (prompt + completion) for the
 * current image-capable models — we compute the per-call cost from the
 * usage block returned in the response.
 *
 * Catalogue snapshot (verify with GET /api/v1/models):
 *   - google/gemini-2.5-flash-image          (cheap, fast — illustrations)
 *   - google/gemini-3.1-flash-image-preview  (mid)
 *   - google/gemini-3-pro-image-preview      (high quality)
 *   - openai/gpt-5-image-mini                (cheap photoreal)
 *   - openai/gpt-5-image                     (photoreal)
 *   - openai/gpt-5.4-image-2                 (latest photoreal)
 *
 * Credential: single API key stored in macOS Keychain under account
 * `openrouter:api_key`. No secret ever leaves this wrapper.
 */

const BASE_URL = 'https://openrouter.ai/api/v1';

async function loadKey(): Promise<string> {
  try {
    return await keychain.get('openrouter:api_key');
  } catch (error) {
    throw new Error(
      `OpenRouter API key missing — set it via /presence settings (${String(error)})`,
    );
  }
}

export async function openrouterIsConfigured(): Promise<boolean> {
  try {
    await loadKey();
    return true;
  } catch {
    return false;
  }
}

export async function saveOpenrouterKey(key: string): Promise<void> {
  if (!key || key.length < 10) throw new Error('Invalid OpenRouter key');
  await keychain.set('openrouter:api_key', key);
}

export async function deleteOpenrouterKey(): Promise<void> {
  await keychain.delete('openrouter:api_key');
}

// ───────────────────────── Image generation ─────────────────────────

/**
 * OpenRouter image-gen API is model-specific: flux returns an image URL in
 * `choices[0].message.images[0].image_url.url`, gpt-image-1 returns a
 * base64 data URI at the same slot. We normalize both to
 * `{ url?: string; b64?: string }` so the UI can render either directly.
 *
 * Cost reporting: we set `usage: { include: true }` in the request body so
 * OpenRouter returns the real charged USD amount in `usage.cost`. This is
 * the source of truth for the cost ledger — the per-token estimation table
 * below is only a fallback when the response omits cost (rare).
 */
export type OrImageResult = {
  model: string;
  url: string | null;
  b64: string | null;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    /** USD cost as billed by OpenRouter — present when `usage.include` was set. */
    cost?: number;
  };
};

type OrImageResponse = {
  model: string;
  choices: Array<{
    message: {
      content?: string;
      images?: Array<{
        type?: string;
        image_url?: { url?: string };
      }>;
    };
  }>;
  usage?: OrImageResult['usage'];
};

export async function orImage(opts: {
  model: string;
  prompt: string;
  signal?: AbortSignal;
}): Promise<OrImageResult> {
  const key = await loadKey();
  const body = {
    model: opts.model,
    modalities: ['image', 'text'],
    messages: [{ role: 'user', content: opts.prompt }],
    // Tell OpenRouter to attach the actual billed cost to the response.
    // Without this, `usage.cost` is omitted and we'd have to estimate.
    usage: { include: true },
  };
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'http://127.0.0.1:4317',
      'X-Title': 'vibecode-dash presence',
    },
    body: JSON.stringify(body),
    signal: opts.signal,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`OpenRouter image failed (${res.status}): ${text.slice(0, 300)}`);
  }
  const raw = (await res.json()) as OrImageResponse;
  const images = raw.choices?.[0]?.message?.images;
  const firstUrl = images?.[0]?.image_url?.url ?? null;
  let url: string | null = null;
  let b64: string | null = null;
  if (firstUrl?.startsWith('data:')) {
    const m = firstUrl.match(/^data:[^;]+;base64,(.+)$/);
    b64 = m ? m[1] : null;
  } else if (firstUrl) {
    url = firstUrl;
  }
  return { model: raw.model, url, b64, usage: raw.usage };
}

// ───────────────────────── Cost estimation ─────────────────────────

/**
 * Per-token rates (USD per token, NOT per million) for OpenRouter image
 * models. Source: GET /api/v1/models on 2026-04-25. Refresh manually after
 * OpenRouter pricing changes — used only for the dashboard's cost ledger,
 * not for actual billing (OpenRouter is the source of truth there).
 */
export const OR_IMAGE_PRICING: Record<string, { prompt: number; completion: number }> = {
  'google/gemini-2.5-flash-image': { prompt: 0.0000003, completion: 0.0000025 },
  'google/gemini-3.1-flash-image-preview': { prompt: 0.0000005, completion: 0.000003 },
  'google/gemini-3-pro-image-preview': { prompt: 0.000002, completion: 0.000012 },
  'openai/gpt-5-image-mini': { prompt: 0.0000025, completion: 0.000002 },
  'openai/gpt-5-image': { prompt: 0.00001, completion: 0.00001 },
  'openai/gpt-5.4-image-2': { prompt: 0.000008, completion: 0.000015 },
};

/**
 * Resolve per-call USD cost. Priority order:
 *   1. `usage.cost` from OpenRouter (authoritative, billed amount)
 *   2. Per-token estimate from OR_IMAGE_PRICING (coarse approximation)
 *   3. Flat fallback for unknown models
 *
 * The token-based estimate is only a fallback — image models charge per-image
 * AND per-token in ways the public pricing table doesn't fully capture (image
 * output tokens count differently from text). Always prefer `usage.cost`.
 */
export function estimateImageCost(model: string, usage?: OrImageResult['usage']): number {
  if (usage?.cost != null && Number.isFinite(usage.cost)) return usage.cost;
  const rate = OR_IMAGE_PRICING[model];
  if (!rate) return 0.04; // unknown model — assume mid-tier image
  if (!usage) return 0.01; // no usage block — coarse default
  return usage.prompt_tokens * rate.prompt + usage.completion_tokens * rate.completion;
}
