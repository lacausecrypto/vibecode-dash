import type { Database } from 'bun:sqlite';
import type { Settings } from '../config';
import { type AgentProvider, execAgentCli } from '../wrappers/agentCli';
import { type PresenceDraftFormat, type PresencePlatform, recordCost } from './presence';
import { type PresenceContext, buildPresenceContext } from './presenceContext';

/**
 * Presence drafter — scoring + drafting + image classification.
 *
 * All three stages go through the local Claude or Codex CLI (user choice,
 * persisted in settings.presence). This honours the workspace rule "pour la
 * couche agent, utiliser exclusivement les CLI (claude, codex), pas de SDK":
 * no vendor API is called directly, and cost is bounded by the user's
 * existing subscription / OAuth session.
 *
 * OpenRouter is used ONLY for image generation (see wrappers/openrouter.ts
 * `orImage`), not for any text workload.
 *
 * Stage shapes:
 *   1. scoreCandidate → Claude Haiku 4.5 by default. Cheap filter so we
 *      only spend Sonnet tokens on threads worth a full draft.
 *   2. generateDraft  → Claude Sonnet 4.6 by default. Full persona + vault
 *      context injected, returns JSON with score/rationale/draft/format.
 *   3. classifyImageNeed → Haiku again, lazy (only when user asks or right
 *      before posting — never during scan).
 *
 * Both `model` and `provider` come from `settings.presence.*` so the user
 * can swap to Codex + GPT-5.5 (or any catalog entry) without code changes.
 */

type StageKind = 'score' | 'score_batch' | 'draft' | 'image_classify';

const STAGE_TIMEOUT_MS: Record<StageKind, number> = {
  score: 60_000,
  // Batch scoring rates 5–10 candidates in one call. Output is larger
  // (one JSON entry per candidate) so we widen the budget vs single-score,
  // but the wall-clock saving is huge: 1 cold-start + 1 inference vs N.
  score_batch: 120_000,
  draft: 180_000,
  image_classify: 45_000,
};

/**
 * Max candidates per batch scoring call. Tuned for Haiku 4.5 throughput:
 *   - Output stays well under model max (each entry ~80 tokens × 8 = 640).
 *   - Wall clock per batch ≈ 18-22s vs ~15s per single call.
 *   - Above 10 the JSON output starts truncating reliably.
 */
const SCORE_BATCH_SIZE = 8;

export type DraftCandidate = {
  platform: PresencePlatform;
  thread: {
    author?: string;
    title?: string;
    body?: string;
    score?: number;
    url?: string;
    created_utc?: number;
  };
  /** Hint for what format the caller expects (scanner decides). */
  preferredFormat?: PresenceDraftFormat;
};

export type DraftScore = {
  score: number;
  rationale: string;
  cost_usd: number;
  model: string;
};

export type DraftGeneration = {
  score: number;
  rationale: string;
  draft_body: string;
  format: PresenceDraftFormat;
  vault_citations: string[];
  /** Ids of radar insights that were available to the drafter as context. */
  radar_insight_ids: string[];
  cost_usd: number;
  model: string;
};

const FORMATS: readonly PresenceDraftFormat[] = ['comment', 'reply', 'post', 'quote'];

function extractJsonBlock(raw: string): unknown {
  // Accept a fenced ```json ... ``` block first, then fall back to the first
  // {...} substring. Keep it tolerant — the CLI occasionally leaks commentary.
  const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const candidate = fenced?.[1] ?? raw;
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace < 0 || lastBrace <= firstBrace) return null;
  try {
    return JSON.parse(candidate.slice(firstBrace, lastBrace + 1));
  } catch {
    return null;
  }
}

/**
 * Parse a fenced or bare JSON array from raw CLI output. Mirrors the
 * tolerance of `extractJsonBlock` (accepts commentary around the block,
 * recovers the first `[ ... ]` substring when the model forgets fences).
 * Returns null on any parse failure — caller decides whether to fall back
 * to single-call scoring.
 *
 * Exported for unit tests. Not part of the public surface.
 */
export function extractJsonArray(raw: string): unknown[] | null {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]+?)\s*```/);
  const candidate = fenced?.[1] ?? raw;
  const firstBracket = candidate.indexOf('[');
  const lastBracket = candidate.lastIndexOf(']');
  if (firstBracket < 0 || lastBracket <= firstBracket) return null;
  try {
    const parsed = JSON.parse(candidate.slice(firstBracket, lastBracket + 1));
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function clampScore(n: unknown): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

function topicTextFor(candidate: DraftCandidate): string {
  const { title, body } = candidate.thread;
  return [title, body?.slice(0, 600)].filter((s) => s && s.trim().length > 0).join(' — ');
}

function candidateDigest(candidate: DraftCandidate): string {
  const { platform } = candidate;
  const { author, title, body, score, url } = candidate.thread;
  const bodyTrim = body ? body.slice(0, 1200) : '';
  return [
    `Platform: ${platform}`,
    author ? `Author: @${author}` : null,
    title ? `Title: ${title}` : null,
    bodyTrim ? `Body:\n${bodyTrim}` : null,
    score != null ? `Thread score: ${score}` : null,
    url ? `URL: ${url}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function providerFromSettings(settings: Settings): AgentProvider {
  return settings.presence?.drafterProvider ?? 'claude';
}

function scorerModel(settings: Settings): string {
  return settings.presence?.scorerModel ?? 'claude-haiku-4-5-20251001';
}

function drafterModel(settings: Settings): string {
  return settings.presence?.drafterModel ?? 'claude-sonnet-4-6';
}

/**
 * Run the Claude/Codex CLI with `prompt` and return the parsed JSON payload
 * plus the usage/cost metadata for ledger bookkeeping. Stage-specific
 * timeouts + tool policy are applied here so callers stay declarative.
 *
 * We run with `toolPolicy: 'none'` for all three stages: the drafter should
 * generate content purely from the injected context, not shell out to read
 * the filesystem or the web. Keeps cost/latency bounded and deterministic.
 */
async function runCliJson(opts: {
  db: Database;
  settings: Settings;
  stage: StageKind;
  systemPrompt: string;
  userPrompt: string;
  draft_id?: string;
}): Promise<{ parsed: unknown; raw: string; model: string; cost_usd: number }> {
  const provider = providerFromSettings(opts.settings);
  const model = opts.stage === 'draft' ? drafterModel(opts.settings) : scorerModel(opts.settings);

  const prompt = `${opts.systemPrompt}\n\n---\n\n${opts.userPrompt}`;

  const res = await execAgentCli({
    provider,
    prompt,
    model,
    toolPolicy: 'none',
    timeoutMs: STAGE_TIMEOUT_MS[opts.stage],
  });

  // Subscription billing: the user pays a flat monthly fee for Claude Max /
  // Codex Pro, so the marginal $ per CLI call is effectively zero. We keep
  // the API-equivalent figure (what PAYG would have charged) in `meta_json`
  // for potential "your sub saved $X" displays, but the ledger's total_usd
  // stays at 0 so aggregates don't mix sub-covered work with real PAYG spend.
  const apiEquivalentUsd = res.costUsd ?? 0;
  recordCost(opts.db, {
    draft_id: opts.draft_id,
    service: provider,
    operation: opts.stage,
    units: res.usage ? res.usage.inputTokens + res.usage.outputTokens : undefined,
    total_usd: 0,
    meta: {
      model: res.model ?? model,
      timed_out: res.timedOut,
      exit_code: res.exitCode,
      usage: res.usage,
      api_equivalent_usd: apiEquivalentUsd,
      billing: 'subscription',
    },
  });

  if (!res.ok) {
    throw new Error(
      `${provider} CLI stage=${opts.stage} failed (exit ${res.exitCode}${
        res.timedOut ? ', timeout' : ''
      }): ${res.stderr.slice(0, 300)}`,
    );
  }

  return {
    parsed: extractJsonBlock(res.text),
    raw: res.text,
    model: res.model ?? model,
    cost_usd: 0, // sub-covered, see meta.api_equivalent_usd for the PAYG figure
  };
}

// ───────────────────────── Stage 1 · score ─────────────────────────

export async function scoreCandidate(
  db: Database,
  settings: Settings,
  candidate: DraftCandidate,
): Promise<DraftScore> {
  const ctx = await buildPresenceContext({
    db,
    settings,
    topicText: topicTextFor(candidate),
  });

  const system = [
    'You are the relevance scorer for a personal social presence copilot.',
    'Given the user persona + recent vault notes and a candidate thread, rate how useful it would be for the user to reply/post on it — 0 to 1.',
    'Only high-signal threads the user has real expertise on should score above 0.70.',
    'Reply with a single fenced ```json``` block: {"score": number, "rationale": "one sentence"}.',
    'Do NOT produce a draft — scoring only.',
  ].join('\n');

  const user = [
    '## User context',
    ctx.contextBlock,
    '',
    '## Candidate thread',
    candidateDigest(candidate),
    '',
    'Rate relevance (0-1).',
  ].join('\n');

  try {
    const { parsed, model, cost_usd } = await runCliJson({
      db,
      settings,
      stage: 'score',
      systemPrompt: system,
      userPrompt: user,
    });
    const obj = parsed as { score?: unknown; rationale?: unknown } | null;
    const score = clampScore(obj?.score);
    const rationale =
      typeof obj?.rationale === 'string' ? obj.rationale.slice(0, 400) : '(no rationale)';
    return { score, rationale, cost_usd, model };
  } catch (error) {
    // Cost-free failure: surface 0 score so the scanner drops this candidate.
    return {
      score: 0,
      rationale: `scorer failed: ${String(error).slice(0, 200)}`,
      cost_usd: 0,
      model: scorerModel(settings),
    };
  }
}

// ───────────────────────── Stage 1b · batch score ─────────────────────────

/**
 * Score N candidates in a single CLI call. The persona + vault context
 * (~2-3k tokens) is shared once across the batch instead of duplicated per
 * candidate, and one cold start replaces N. Live measurements on Haiku 4.5
 * with `SCORE_BATCH_SIZE = 8`:
 *
 *   N sequential single-score calls : ~15 s × N  → 8 × 15 s = 120 s
 *   1 batch call of N=8              : ~18-22 s     → ~6× speed-up
 *
 * Order-preserving: returns scores in the same order as `candidates`.
 *
 * Failure modes:
 *   1. Whole batch fails (CLI error, empty output, JSON parse) → fall back
 *      to per-candidate `scoreCandidate` so the scan still progresses.
 *   2. Partial batch — model dropped some indices → re-score the missing
 *      ones individually. Rare on Haiku at batch=8 but defensive.
 *   3. Index drift — model invented indices → match by position only,
 *      skip out-of-range entries.
 *
 * Cost ledger writes one row per CLI call (the batch), with usage = sum of
 * prompt + completion tokens. Per-candidate breakdown is intentionally not
 * tracked: subscription billing is flat, the only thing that matters is
 * "one CLI invocation happened".
 */
export async function scoreCandidatesBatch(
  db: Database,
  settings: Settings,
  candidates: DraftCandidate[],
): Promise<DraftScore[]> {
  if (candidates.length === 0) return [];

  // Single-candidate batch is just `scoreCandidate` — avoid the batch
  // prompt overhead (numbering, JSON-array parse) for no gain.
  if (candidates.length === 1) {
    const score = await scoreCandidate(db, settings, candidates[0]);
    return [score];
  }

  // Chunk to SCORE_BATCH_SIZE so a 20-candidate scan still benefits from
  // batching but stays inside Haiku's reliable JSON-output window. We run
  // chunks sequentially to avoid bursting subscription quota — parallel is
  // a follow-up if the user moves to Pro tier.
  const out: DraftScore[] = [];
  for (let i = 0; i < candidates.length; i += SCORE_BATCH_SIZE) {
    const chunk = candidates.slice(i, i + SCORE_BATCH_SIZE);
    const chunkScores = await scoreOneBatch(db, settings, chunk);
    out.push(...chunkScores);
  }
  return out;
}

async function scoreOneBatch(
  db: Database,
  settings: Settings,
  chunk: DraftCandidate[],
): Promise<DraftScore[]> {
  // Shared context — built once for the chunk. Topic text is the
  // concatenation of all candidate topics so vault retrieval surfaces notes
  // relevant to any of them (mild over-retrieval is cheaper than per-call
  // retrieval × N).
  const ctx = await buildPresenceContext({
    db,
    settings,
    topicText: chunk.map(topicTextFor).join(' — '),
  });

  const system = [
    'You are the relevance scorer for a personal social presence copilot.',
    'You will receive a numbered list of candidate threads. For each one, rate how useful it would be for the user to reply/post on it — 0 to 1.',
    'Only high-signal threads the user has real expertise on should score above 0.70.',
    'Be DECISIVE: most candidates should score below 0.50 (the funnel exists for a reason).',
    'Reply with a single fenced ```json``` block containing an array, one entry per candidate, in the SAME ORDER as the input:',
    '[{"idx": 1, "score": number, "rationale": "one short sentence"}, ...]',
    `Return EXACTLY ${chunk.length} entries. No commentary outside the JSON block.`,
    'Do NOT produce drafts — scoring only.',
  ].join('\n');

  const numbered = chunk
    .map((c, i) => `### Candidate ${i + 1}\n${candidateDigest(c)}`)
    .join('\n\n');

  const user = [
    '## User context',
    ctx.contextBlock,
    '',
    '## Candidates',
    numbered,
    '',
    `Rate all ${chunk.length} candidates. Return the JSON array now.`,
  ].join('\n');

  let raw: string;
  let model: string;
  try {
    const result = await runCliJson({
      db,
      settings,
      stage: 'score_batch',
      systemPrompt: system,
      userPrompt: user,
    });
    raw = result.raw;
    model = result.model;
  } catch (error) {
    // Whole-batch failure: fall back to single calls. Slower but the scan
    // still produces correct results — degradation, not data loss.
    console.warn(
      `[presenceDrafter] batch score CLI failed (${chunk.length} candidates), falling back to sequential: ${String(error).slice(0, 200)}`,
    );
    return Promise.all(chunk.map((c) => scoreCandidate(db, settings, c)));
  }

  const arr = extractJsonArray(raw);
  if (!arr || arr.length === 0) {
    console.warn(
      `[presenceDrafter] batch score parse failed (${chunk.length} candidates), falling back to sequential`,
    );
    return Promise.all(chunk.map((c) => scoreCandidate(db, settings, c)));
  }

  // Map results back to candidate slots. Prefer explicit `idx` (1-based)
  // when the model emits it; fall back to array position. Out-of-range
  // entries are dropped — anything unmatched gets re-scored individually.
  const slotted: (DraftScore | null)[] = chunk.map(() => null);
  for (let i = 0; i < arr.length; i++) {
    const entry = arr[i] as { idx?: unknown; score?: unknown; rationale?: unknown } | null;
    if (!entry || typeof entry !== 'object') continue;
    const explicitIdx = Number(entry.idx);
    const slot =
      Number.isInteger(explicitIdx) && explicitIdx >= 1 && explicitIdx <= chunk.length
        ? explicitIdx - 1
        : i;
    if (slot < 0 || slot >= chunk.length) continue;
    if (slotted[slot]) continue; // already filled by an earlier entry
    slotted[slot] = {
      score: clampScore(entry.score),
      rationale:
        typeof entry.rationale === 'string' ? entry.rationale.slice(0, 400) : '(no rationale)',
      cost_usd: 0,
      model,
    };
  }

  // Backfill any candidate the model dropped — score them individually.
  // Counter-intuitively, doing this in parallel here is fine: it's already
  // an exception path, and if 4+ candidates were dropped we want speed
  // back, not stricter sequencing.
  const out: DraftScore[] = [];
  const missingIndices: number[] = [];
  for (let i = 0; i < chunk.length; i++) {
    const s = slotted[i];
    if (s) {
      out[i] = s;
    } else {
      missingIndices.push(i);
    }
  }
  if (missingIndices.length > 0) {
    console.warn(
      `[presenceDrafter] batch score returned ${arr.length}/${chunk.length} entries, individually scoring ${missingIndices.length} dropped candidates`,
    );
    const recovered = await Promise.all(
      missingIndices.map((i) => scoreCandidate(db, settings, chunk[i])),
    );
    for (let k = 0; k < missingIndices.length; k++) {
      out[missingIndices[k]] = recovered[k];
    }
  }

  return out;
}

// ───────────────────────── Stage 2 · draft ─────────────────────────

export async function generateDraft(
  db: Database,
  settings: Settings,
  candidate: DraftCandidate,
  seedScore: number,
): Promise<DraftGeneration> {
  const ctx: PresenceContext = await buildPresenceContext({
    db,
    settings,
    topicText: topicTextFor(candidate),
  });

  const platformGuide =
    candidate.platform === 'x'
      ? [
          'X length tiers:',
          '  ONE-LINER (60-180 chars): single observation with a sharp twist. Lowercase OK.',
          '  PARAGRAPH (180-280 chars): hook claim + 1-sentence mechanism. No filler.',
          'No hashtags unless essential. No links unless they add real value.',
        ].join('\n')
      : [
          'Reddit comment length is EARNED, not assumed:',
          '  "+1 with one nuance" (30-80 words): OP is right, you add a small qualifier.',
          '  "pointed counter-take" (80-160 words): you disagree on ONE specific thing.',
          '  "substantive analysis" (150-300 words): topic deserves it AND you have a real story or data.',
          '  "longform" (300-500 words): only for top-level posts you initiate.',
          'DEFAULT to the SHORTEST viable length. If you can say it in 50 words, do not write 200.',
          'Prose > bullet lists. Bullet lists ONLY when 4+ items are genuinely parallel.',
        ].join('\n');

  const system = [
    "You are drafting a social post in the user's own voice.",
    '',
    '═══ KARPATHY SCHEMA (apply rigorously) ═══',
    'Three structural patterns, pick by length tier:',
    '',
    '1) ONE-LINER (≤180 chars):',
    '   {concrete observation} {twist that flips the obvious read}',
    '   Example shape: "tokenization is the source of much weirdness in LLMs"',
    '',
    '2) PARAGRAPH (50-200 words):',
    '   Hook (specific claim, no preamble) → Mechanism (why this is true, 1-2 sentences) → Asymmetric closer (implication, counterexample, or open question).',
    '',
    '3) STRUCTURED (200-500 words):',
    '   Lead with the conclusion → mechanism with a CONCRETE reference (file path, lib name, paper, your own experience) → end with the reframe.',
    '',
    'Style traits Karpathy uses, match them:',
    '  - CONCRETE > abstract. Always cite a specific tool, library, paper, or your own commit/experiment.',
    '  - MECHANISM over conclusion. Explain WHY, not just WHAT.',
    '  - NO hedging: drop "maybe", "I think", "in my experience", "imo".',
    '  - Short sentences alternating with one longer one for rhythm.',
    '  - The most interesting bit comes LAST, not first (asymmetric punchline).',
    '  - Candid > polished. "I was wrong about X for years" beats "Here are 3 things I learned".',
    '',
    'NEVER do (these scream LLM):',
    '  - Open with "Great point" / "I love this" / "Just thinking about..."',
    "  - Restate the OP's question.",
    '  - "It depends" closer.',
    '  - "That said" / "On the other hand" transitions.',
    '  - Bullet lists of 3 generic insights.',
    '',
    '═══ PLATFORM RULES ═══',
    platformGuide,
    '',
    '═══ OUTPUT RULES ═══',
    'Use the user persona + radar insights to shape voice and angle. Do NOT invent opinions the user does not hold.',
    'Vault notes (if provided): treat as background CONTEXT only. Cite as [[path]] ONLY when a specific claim in your draft DIRECTLY references the note. If you would not cite it in a real conversation, do not cite it here.',
    'Never mention you are an AI.',
    'FORBIDDEN PUNCTUATION: em-dash (—), en-dash (–), horizontal bar (―), AND standalone hyphens between words (" - "). All read as LLM tics. Use commas, periods, or restructure. Word-internal hyphens stay (self-hosted, t-shirt, model-context-protocol). Forbidden characters are silently stripped at write time, produce clean output first try.',
    "If the thread is outside the user's expertise zones, return score < 0.4 and an empty draft.",
    '',
    'Output: a single fenced ```json``` block:',
    '{',
    '  "score": number,',
    '  "rationale": "one sentence",',
    '  "format": "comment|reply|post|quote",',
    '  "draft": "final text",',
    '  "citations": ["Concepts/foo.md", ...]  // ONLY notes you actually referenced in the draft',
    '}',
  ].join('\n');

  const user = [
    '## User context',
    ctx.contextBlock,
    '',
    '## Candidate thread',
    candidateDigest(candidate),
    '',
    `Seed relevance score from stage 1: ${seedScore.toFixed(2)}`,
    '',
    'Generate the draft now.',
  ].join('\n');

  const { parsed, model, cost_usd } = await runCliJson({
    db,
    settings,
    stage: 'draft',
    systemPrompt: system,
    userPrompt: user,
  });

  const obj = parsed as {
    score?: unknown;
    rationale?: unknown;
    format?: unknown;
    draft?: unknown;
    citations?: unknown;
  } | null;

  const score = clampScore(obj?.score ?? seedScore);
  const rationale =
    typeof obj?.rationale === 'string' ? obj.rationale.slice(0, 600) : '(no rationale)';
  const fmtRaw = typeof obj?.format === 'string' ? (obj.format as PresenceDraftFormat) : null;
  const format: PresenceDraftFormat =
    fmtRaw && FORMATS.includes(fmtRaw) ? fmtRaw : (candidate.preferredFormat ?? 'comment');
  const draft = typeof obj?.draft === 'string' ? obj.draft.trim() : '';
  const citations = Array.isArray(obj?.citations)
    ? (obj.citations as unknown[]).filter((c): c is string => typeof c === 'string').slice(0, 10)
    : [];

  return {
    score,
    rationale,
    draft_body: draft,
    format,
    vault_citations: citations,
    // Track which radar insights were in context. The model may not have
    // explicitly cited them, but their presence shaped the draft, and that's
    // the signal we want for engagement-by-radar-type aggregation.
    radar_insight_ids: ctx.radarInsights.map((i) => i.id),
    cost_usd,
    model,
  };
}

// ───────────────────────── Translator ─────────────────────────

const TRANSLATION_LANGS = {
  fr: 'French (français)',
  en: 'English',
  es: 'Spanish (español)',
} as const;

export type TranslationLang = keyof typeof TRANSLATION_LANGS;

export type TranslationResult = {
  translated: string;
  target_lang: TranslationLang;
  model: string;
  cost_usd: number;
};

/**
 * Translate a draft to FR / EN / ES while preserving the user's voice,
 * length, and tone. Uses the local Claude / Codex CLI (sub-covered, not
 * OpenRouter) — same provider/model the user picked for drafting.
 *
 * Output goes back through the strip-em-dashes guard at the persistence
 * layer (updateDraftBody), so even if the translation introduces banned
 * characters they're cleaned before storage.
 */
export async function translateDraft(
  db: Database,
  settings: Settings,
  draftId: string,
  body: string,
  targetLang: TranslationLang,
): Promise<TranslationResult> {
  const langLabel = TRANSLATION_LANGS[targetLang];

  const system = [
    `You are translating a social-media draft to ${langLabel}.`,
    'Hard rules:',
    '- Preserve the original tone, voice, and register exactly. If the user is direct and informal, stay direct and informal.',
    '- Preserve length within ±20% of the original character count. No padding, no abbreviation.',
    '- Preserve technical terms (Claude, Codex, MCP, OAuth, vibecode, etc.) as-is — do NOT translate brand names, library names, or function names.',
    '- Preserve markdown links, code blocks, and inline code unchanged.',
    '- FORBIDDEN PUNCTUATION: em-dash (—), en-dash (–), AND standalone hyphens between words (" - "). Use a comma, a period, or restructure. Word-internal hyphens stay (self-hosted, t-shirt).',
    '- Do NOT add any framing, preamble, or commentary. Output ONLY the translated text, nothing else.',
  ].join('\n');

  const user = `## Original draft\n${body}\n\n## Translate to ${langLabel} (output the translation only, no quotes, no preamble):`;

  const { raw, model, cost_usd } = await runCliJson({
    db,
    settings,
    stage: 'draft',
    systemPrompt: system,
    userPrompt: user,
    draft_id: draftId,
  });
  // The translator system prompt asks for raw text, not JSON. runCliJson
  // tries to extract a JSON block which will fail — we want res.text directly.
  // Easiest: re-request without the JSON expectation, OR just use raw which
  // contains the unparsed CLI output.
  const translated = raw.trim();
  return { translated, target_lang: targetLang, model, cost_usd };
}

// ───────────────────────── Image classifier (lazy) ─────────────────────────

export type ImagePlan = {
  kind: 'none' | 'diagram' | 'illustration' | 'photo';
  prompt: string | null;
  reason: string;
};

/**
 * Decide if a finalised draft benefits from an image. Called lazily — right
 * before posting or on explicit user click — never during scan. Uses the
 * same Claude/Codex CLI as scoring (scorerModel), not OpenRouter.
 *
 * The actual image *generation* still goes through OpenRouter (orImage),
 * since Claude/Codex CLIs don't do image synthesis.
 */
export async function classifyImageNeed(
  db: Database,
  settings: Settings,
  draft_id: string,
  draft_body: string,
): Promise<ImagePlan> {
  const system = [
    'You decide if a social post benefits from an image, AND craft a high-quality prompt.',
    'Return a fenced ```json``` block: {"kind":"none|diagram|illustration|photo","prompt":"...|null","reason":"..."}.',
    '',
    'Kind selection:',
    '- "diagram"      → technical flow/architecture, render via mermaid later.',
    '- "illustration" → abstract or symbolic concept (best for AI/dev/agent topics).',
    '- "photo"        → real-world scene, devices, people, products.',
    '- "none"         → text alone is stronger. Default to "none" when unsure.',
    '',
    'Prompt craft (when kind ≠ none/diagram):',
    '- 30–80 words, English, concrete and visual.',
    '- ALWAYS lead with a clear subject and composition (e.g. "Wide shot of...", "Close-up of...").',
    '- Specify ONE coherent style: editorial flat illustration / isometric tech / cinematic photo / minimal line-art.',
    '- Specify lighting + palette: "soft purple-and-cyan gradient", "warm tungsten under-lighting", etc.',
    '- For AI/dev topics, prefer: editorial flat illustration, isometric tech diagrams, soft gradients.',
    '- AVOID hype words ("ultra-detailed", "8k", "masterpiece", "trending on artstation") — modern image models read prompts as natural language.',
    "- AVOID people's faces unless central; framing/silhouette is safer.",
  ].join('\n');

  const user = `## Draft\n${draft_body.slice(0, 1800)}`;

  try {
    const { parsed } = await runCliJson({
      db,
      settings,
      stage: 'image_classify',
      systemPrompt: system,
      userPrompt: user,
      draft_id,
    });
    const obj = parsed as { kind?: unknown; prompt?: unknown; reason?: unknown } | null;
    const rawKind = typeof obj?.kind === 'string' ? obj.kind : 'none';
    const kind: ImagePlan['kind'] =
      rawKind === 'diagram' || rawKind === 'illustration' || rawKind === 'photo' ? rawKind : 'none';
    return {
      kind,
      prompt: typeof obj?.prompt === 'string' && obj.prompt !== 'null' ? obj.prompt : null,
      reason: typeof obj?.reason === 'string' ? obj.reason.slice(0, 300) : '',
    };
  } catch (error) {
    return {
      kind: 'none',
      prompt: null,
      reason: `classifier failed: ${String(error).slice(0, 200)}`,
    };
  }
}
