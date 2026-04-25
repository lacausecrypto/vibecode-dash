import type { Database } from 'bun:sqlite';

/**
 * Social Presence Copilot — data access layer.
 *
 * All reads/writes for drafts, sources, cost ledger and engagement metrics
 * funnel through here so the HTTP routes stay thin and the scanner/drafter
 * workers (Phase 2+) import the same helpers. Zero external calls live in
 * this file: it's pure SQL + typing.
 *
 * Status machine (enforced at the app layer, not via DB CHECK):
 *
 *   proposed ──► viewed ──► approved ──► posted
 *        │          │           │
 *        ├──────────┴──► rejected / ignored
 *        └──► expired  (freshness_expires_at < now and still proposed)
 */

export const PRESENCE_PLATFORMS = ['reddit', 'x'] as const;
export type PresencePlatform = (typeof PRESENCE_PLATFORMS)[number];

export const PRESENCE_SOURCE_KINDS = [
  'subreddit',
  'reddit_user',
  'x_list',
  'x_user',
  'x_topic',
] as const;
export type PresenceSourceKind = (typeof PRESENCE_SOURCE_KINDS)[number];

export const PRESENCE_DRAFT_STATUSES = [
  'proposed',
  'viewed',
  'approved',
  'posted',
  'expired',
  'ignored',
  'rejected',
] as const;
export type PresenceDraftStatus = (typeof PRESENCE_DRAFT_STATUSES)[number];

export const PRESENCE_DRAFT_FORMATS = ['comment', 'reply', 'post', 'quote'] as const;
export type PresenceDraftFormat = (typeof PRESENCE_DRAFT_FORMATS)[number];

export const PRESENCE_ENGAGEMENT_TAGS = ['t+1h', 't+24h', 't+7d', 'manual'] as const;
export type PresenceEngagementTag = (typeof PRESENCE_ENGAGEMENT_TAGS)[number];

export type PresenceSourceRow = {
  id: string;
  platform: PresencePlatform;
  kind: PresenceSourceKind;
  identifier: string;
  label: string | null;
  weight: number;
  freshness_ttl_minutes: number;
  active: number;
  last_since_id: string | null;
  last_scanned_at: number | null;
  last_scan_status: string | null;
  added_at: number;
  /** Last validation outcome from the platform's existence check. */
  validation_status: SourceValidationStatus | null;
  /** Unix seconds of the last validation attempt. */
  validated_at: number | null;
  /** Latest ROI classification (Pack B). NULL = never classified. */
  health_status: SourceHealthStatus | null;
  health_snapshot_at: number | null;
  /** JSON of the raw counts that drove `health_status`. See sourceHealth.ts. */
  health_metrics_json: string | null;
  /**
   * Pack C — last time the user dismissed a prune suggestion for this
   * source ("Keep, recompute next week"). The /prune-suggestions endpoint
   * excludes any source within 7 days of this timestamp.
   */
  prune_dismissed_at: number | null;
};

/**
 * ROI classification states for a source. Computed daily by sourceHealth.ts
 * from drafts / events / engagement signals. The UI maps these to colour
 * bands: workhorse + pristine (green), unscored + never_scanned (neutral),
 * noisy + stale (warn), dead (danger).
 */
export type SourceHealthStatus =
  | 'never_scanned'
  | 'unscored'
  | 'pristine'
  | 'workhorse'
  | 'noisy'
  | 'stale'
  | 'dead';

/**
 * Outcome of a source-existence check (Reddit /about.json or X syndication
 * follow-button info). NULL on the row means the source has never been
 * validated yet. Values are persisted as text in `validation_status`.
 */
export type SourceValidationStatus =
  | 'valid'
  | 'not_found'
  | 'private'
  | 'banned'
  | 'invalid_format'
  | 'partial' // x_topic with mixed valid + dead from: handles
  | 'error';

export type SourceValidationDetail = {
  status: SourceValidationStatus;
  /** Per-handle breakdown for x_topic queries with multiple from: clauses. */
  handles?: Array<{ handle: string; status: SourceValidationStatus }>;
  details?: string;
};

export type PresenceDraftRow = {
  id: string;
  platform: PresencePlatform;
  source_id: string | null;
  external_thread_id: string | null;
  external_thread_url: string | null;
  thread_snapshot_json: string;
  format: PresenceDraftFormat;
  relevance_score: number;
  freshness_expires_at: number;
  draft_body: string;
  draft_rationale: string | null;
  vault_citations_json: string | null;
  radar_insight_ids_json: string | null;
  image_plan_json: string | null;
  status: PresenceDraftStatus;
  posted_external_id: string | null;
  posted_external_url: string | null;
  posted_at: number | null;
  created_at: number;
  viewed_at: number | null;
  decided_at: number | null;
};

export type PresenceDraftEventRow = {
  id: number;
  draft_id: string;
  event_type: string;
  payload_json: string | null;
  at: number;
};

export type PresenceCostRow = {
  id: number;
  draft_id: string | null;
  service: string;
  operation: string;
  units: number | null;
  unit_cost_usd: number | null;
  total_usd: number;
  meta_json: string | null;
  at: number;
};

export type PresenceEngagementRow = {
  id: number;
  draft_id: string;
  snapshot_tag: PresenceEngagementTag;
  at: number;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  impressions: number | null;
  ratio: number | null;
  raw_json: string | null;
};

export type PresenceConnectionRow = {
  platform: PresencePlatform;
  account_handle: string | null;
  keychain_ref: string | null;
  scopes_json: string | null;
  connected_at: number | null;
  last_refresh_at: number | null;
  rate_limit_state_json: string | null;
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Compute a normalized edit ratio between two texts: 0 = identical, 1 =
 * unrecognizable. Levenshtein distance over max length, with a fast-path
 * for empty / identical inputs. Used to track how much the user edits
 * drafts vs how much they post as-is — strong signal for tuning persona +
 * scoring threshold.
 */
export function editRatio(before: string, after: string): number {
  if (before === after) return 0;
  if (!before || !after) return 1;
  const m = before.length;
  const n = after.length;
  // Two-row Levenshtein. Fine for draft-sized strings (typically <2KB).
  const prev = new Array<number>(n + 1);
  const curr = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = before.charCodeAt(i - 1) === after.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= n; j++) prev[j] = curr[j];
  }
  return Math.min(1, prev[n] / Math.max(m, n));
}

/**
 * Strip ALL punctuation dashes — em-dash, en-dash, horizontal bar AND the
 * standalone hyphen-with-spaces ` - ` pattern that LLMs use as a poor-man's
 * em-dash. The user reads any of these as LLM tics. Substitution is a
 * comma-space, which preserves the parenthetical sense without inserting
 * another visual dash.
 *
 * Word-internal hyphens are PRESERVED (`self-hosted`, `t-shirt`,
 * `model-context-protocol`) since those are valid English orthography. The
 * regex `(?<=\S) - (?=\S)` only matches when both sides are whitespace +
 * non-space, never inside a compound word.
 *
 * Run defensively at every write path: drafter output AND user-edited PATCH
 * bodies. Translator output also routes through here via updateDraftBody.
 */
export function stripEmDashes(input: string): string {
  if (!input) return input;
  return (
    input
      // em-dash (U+2014), en-dash (U+2013), horizontal bar (U+2015) → comma
      .replace(/[—–―]/g, ', ')
      // standalone hyphen between two spaces (LLM "em-dash substitute") → comma
      // Lookbehind ensures we don't touch list items at line start.
      .replace(/(?<=\S) - (?=\S)/g, ', ')
      // collapse runs created by the substitution
      .replace(/ {2,}/g, ' ')
      .replace(/, , /g, ', ')
      // tidy ", ." or ", ;" artefacts
      .replace(/, ([,.;:!?])/g, '$1')
  );
}

// ───────────────────────── First-run defaults ─────────────────────────

/**
 * Versioned seed. We push fresh batches by adding a new V_N array, NOT by
 * editing past arrays — once a batch is sealed, deleted entries from that
 * batch must stay deleted across restarts. The kv flag `presence:seeded_v<N>`
 * marks each batch as applied; absent flags trigger application.
 *
 * Seed strategy:
 *   - V1 (initial 8 sources): tiny starter pack, all reddit + a few x topics.
 *   - V2 (this batch): broadens the pool to ~60 sources covering CEOs,
 *     researchers, indie hackers, MCP protocol, vibecode niches, AI labs.
 *     Most active by default; a few niche subs land inactive so the user
 *     can opt in without burning X PAYG quota.
 *
 * The user can delete any seeded source at any time. Their deletion sticks
 * — re-running the boot seed only inserts batches the user hasn't seen yet,
 * not items the user actively deleted.
 */
type SeedDef = {
  platform: PresencePlatform;
  kind: PresenceSourceKind;
  identifier: string;
  label: string;
  freshness_ttl_minutes: number;
  active?: boolean; // default true
};

const SEED_V1: SeedDef[] = [
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'LocalLLaMA',
    label: 'Local LLM / agents',
    freshness_ttl_minutes: 240,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'ClaudeAI',
    label: 'Claude-specific',
    freshness_ttl_minutes: 240,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'selfhosted',
    label: 'Self-hosted / local-first',
    freshness_ttl_minutes: 360,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'AI_Agents',
    label: 'Agentic AI',
    freshness_ttl_minutes: 360,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'OpenAI',
    label: 'OpenAI ecosystem',
    freshness_ttl_minutes: 360,
  },
  {
    platform: 'x',
    kind: 'x_topic',
    identifier: 'Claude Code',
    label: 'Claude Code mentions',
    freshness_ttl_minutes: 120,
  },
  {
    platform: 'x',
    kind: 'x_topic',
    identifier: 'vibecoding OR vibecode',
    label: 'Vibecode niche',
    freshness_ttl_minutes: 240,
  },
  {
    platform: 'x',
    kind: 'x_topic',
    identifier: 'agentic coding',
    label: 'Agentic dev',
    freshness_ttl_minutes: 240,
  },
];

/**
 * V2 — broad, opinionated default catalog matching an indie dev focused on
 * Claude/Codex tooling, OSS, and agent infrastructure. Reddit is free in
 * public mode (cost neutral); X PAYG is $0.017/read so we batch accounts
 * into OR-grouped topic searches and keep the most expensive ones inactive.
 */
const SEED_V2_ADDITIONS: SeedDef[] = [
  // ─── Reddit subreddits (active) ───
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'ChatGPTCoding',
    label: 'AI-assisted coding',
    freshness_ttl_minutes: 240,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'cursor',
    label: 'Cursor IDE community',
    freshness_ttl_minutes: 240,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'LLMDevs',
    label: 'LLM dev practitioners',
    freshness_ttl_minutes: 240,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'LangChain',
    label: 'LangChain ecosystem',
    freshness_ttl_minutes: 360,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'programming',
    label: 'Generic programming',
    freshness_ttl_minutes: 480,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'typescript',
    label: 'TypeScript',
    freshness_ttl_minutes: 480,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'reactjs',
    label: 'React.js',
    freshness_ttl_minutes: 480,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'node',
    label: 'Node.js',
    freshness_ttl_minutes: 480,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'webdev',
    label: 'Web development',
    freshness_ttl_minutes: 480,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'macapps',
    label: 'macOS apps',
    freshness_ttl_minutes: 720,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'SaaS',
    label: 'SaaS building',
    freshness_ttl_minutes: 360,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'indiehackers',
    label: 'Indie hackers',
    freshness_ttl_minutes: 360,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'SideProject',
    label: 'Side projects',
    freshness_ttl_minutes: 360,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'Anthropic',
    label: 'Anthropic-specific',
    freshness_ttl_minutes: 240,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'aipromptprogramming',
    label: 'Prompt engineering',
    freshness_ttl_minutes: 360,
  },

  // ─── Reddit subreddits (inactive — optional, user can activate) ───
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'MachineLearning',
    label: 'ML research',
    freshness_ttl_minutes: 480,
    active: false,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'learnmachinelearning',
    label: 'ML learning',
    freshness_ttl_minutes: 720,
    active: false,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'datascience',
    label: 'Data science',
    freshness_ttl_minutes: 720,
    active: false,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'devops',
    label: 'DevOps',
    freshness_ttl_minutes: 720,
    active: false,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'artificial',
    label: 'Generic AI discussion',
    freshness_ttl_minutes: 720,
    active: false,
  },

  // ─── X grouped account searches (active) ───
  // OR-grouped to fold many handles into one $0.017 read per scan.
  {
    platform: 'x',
    kind: 'x_topic',
    identifier:
      '(from:sama OR from:elonmusk OR from:satyanadella OR from:sundarpichai OR from:tim_cook OR from:pmarca) -is:retweet',
    label: 'Tech CEOs',
    freshness_ttl_minutes: 240,
  },
  {
    platform: 'x',
    kind: 'x_topic',
    identifier:
      '(from:AnthropicAI OR from:OpenAI OR from:perplexity_ai OR from:cognition_labs OR from:cursor_ai) -is:retweet',
    label: 'AI labs official',
    freshness_ttl_minutes: 240,
  },
  {
    platform: 'x',
    kind: 'x_topic',
    identifier:
      '(from:karpathy OR from:ylecun OR from:simonw OR from:goodside OR from:swyx OR from:emollick) -is:retweet',
    label: 'AI researchers / educators',
    freshness_ttl_minutes: 240,
  },
  {
    platform: 'x',
    kind: 'x_topic',
    identifier:
      '(from:dhh OR from:patio11 OR from:levelsio OR from:marckohlbrugge OR from:nikitabier OR from:tobi) -is:retweet',
    label: 'Indie hackers / founders',
    freshness_ttl_minutes: 360,
  },
  {
    platform: 'x',
    kind: 'x_topic',
    identifier: '("MCP server" OR "MCP protocol" OR "Model Context Protocol") -is:retweet lang:en',
    label: 'MCP protocol',
    freshness_ttl_minutes: 240,
  },
  {
    platform: 'x',
    kind: 'x_topic',
    identifier: '"building in public" -is:retweet lang:en',
    label: 'Building in public',
    freshness_ttl_minutes: 360,
  },

  // ─── X grouped account searches (inactive — opt-in to spare PAYG) ───
  {
    platform: 'x',
    kind: 'x_topic',
    identifier: '(from:hwchase17 OR from:LangChainAI OR from:karinanguyen_) -is:retweet',
    label: 'LLM tooling voices',
    freshness_ttl_minutes: 360,
    active: false,
  },
  {
    platform: 'x',
    kind: 'x_topic',
    identifier: '(local LLM OR ollama OR "llama.cpp" OR "lm studio") -is:retweet lang:en',
    label: 'Local LLM tooling',
    freshness_ttl_minutes: 360,
    active: false,
  },
  {
    platform: 'x',
    kind: 'x_topic',
    identifier: '("open source AI" OR "open weights" OR "open-source AI") -is:retweet lang:en',
    label: 'OSS AI movement',
    freshness_ttl_minutes: 480,
    active: false,
  },
  {
    platform: 'x',
    kind: 'x_topic',
    identifier: '(Cursor OR Windsurf OR Codeium OR "Cline" OR "Continue.dev") -is:retweet lang:en',
    label: 'AI coding tools',
    freshness_ttl_minutes: 360,
    active: false,
  },
];

/**
 * V3 — quality-first curation. Two simultaneous moves:
 *
 *   (a) ADDITIONS: a small set of high-signal accounts and subs missing
 *       from V1/V2 (Dwarkesh Patel for AI strategy, Omar Sanseviero for
 *       Hugging Face / OSS, smart practitioners). Kept tight on purpose —
 *       quality > quantity.
 *
 *   (b) DEACTIVATIONS: V2 sources I now believe are too noisy by default
 *       (programming, webdev, reactjs, typescript, node — generic dev subs
 *       where the AI/agent angle is rare; aipromptprogramming — repetitive
 *       prompt-share; "Building in public" — diluted hashtag). They're set
 *       to active=0, NOT deleted, so the user can re-enable any of them
 *       from the Sources table if the context changes.
 *
 * Safety rule on deactivation: only flip active→0 if `last_scanned_at` is
 * NULL (the user has never let the source run). If a source has scanned at
 * least once, the user implicitly endorses it; we don't second-guess.
 */
const SEED_V3_ADDITIONS: SeedDef[] = [
  // ─── Reddit niches (active by default) ───
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'PromptEngineering',
    label: 'Prompt craft (deep)',
    freshness_ttl_minutes: 360,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'mcp',
    label: 'Model Context Protocol',
    freshness_ttl_minutes: 240,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'rust',
    label: 'Rust dev community',
    freshness_ttl_minutes: 720,
    active: false,
  },
  {
    platform: 'reddit',
    kind: 'subreddit',
    identifier: 'emacs',
    label: 'Power users / extensible tooling',
    freshness_ttl_minutes: 720,
    active: false,
  },

  // ─── X high-signal additions ───
  {
    platform: 'x',
    kind: 'x_topic',
    identifier:
      '(from:dwarkesh_sp OR from:omarsar0 OR from:jackclarkSF OR from:karinanguyen_ OR from:miramurati) -is:retweet',
    label: 'AI strategy thinkers',
    freshness_ttl_minutes: 240,
  },
  {
    platform: 'x',
    kind: 'x_topic',
    identifier:
      '(from:_jasonwei OR from:NoahShachtman OR from:DrJimFan OR from:agihippo OR from:abacaj) -is:retweet',
    label: 'AI practitioners (deep)',
    freshness_ttl_minutes: 240,
  },
];

/**
 * V2 sources I'm deactivating in V3. Each entry is a (platform, kind,
 * identifier-lowercase) tuple matching the unique index. We only flip
 * active=0 if last_scanned_at IS NULL (user hasn't engaged with the source
 * yet), so anyone who's already been using e.g. r/programming keeps it on.
 */
const V3_DEACTIVATIONS: Array<{
  platform: PresencePlatform;
  kind: PresenceSourceKind;
  identifier: string;
}> = [
  // Generic dev subs — too broad for high-quality social commentary.
  { platform: 'reddit', kind: 'subreddit', identifier: 'programming' },
  { platform: 'reddit', kind: 'subreddit', identifier: 'webdev' },
  { platform: 'reddit', kind: 'subreddit', identifier: 'reactjs' },
  { platform: 'reddit', kind: 'subreddit', identifier: 'typescript' },
  { platform: 'reddit', kind: 'subreddit', identifier: 'node' },
  { platform: 'reddit', kind: 'subreddit', identifier: 'macapps' },
  // Prompt-share heavy, low actionable signal.
  { platform: 'reddit', kind: 'subreddit', identifier: 'aipromptprogramming' },
  // Diluted hashtag — too much noise from random product launches.
  { platform: 'x', kind: 'x_topic', identifier: '"building in public" -is:retweet lang:en' },
  // Tech CEOs query — most posts are non-AI corp chatter; opt-in only.
  {
    platform: 'x',
    kind: 'x_topic',
    identifier:
      '(from:sama OR from:elonmusk OR from:satyanadella OR from:sundarpichai OR from:tim_cook OR from:pmarca) -is:retweet',
  },
];

/**
 * V5 — focused additions on AI-tech CEOs, after the user noted V2/V3 were
 * thin on this band (V2 had a "Tech CEOs" group that mixed corp chatter
 * with little AI signal, V3 retired it without replacement). The Pack A
 * validator runs at boot, so any handle we get wrong here is auto-flagged
 * `partial` for the user to review — no silent dead handles.
 *
 * Grouping is by ROLE rather than by company: founder-CEOs of AI labs,
 * compute/infra CEOs, AI corporate leaders (Microsoft / xAI), and chief
 * scientists. Each group is a single OR query so it costs $0.017 per scan
 * regardless of how many handles inside.
 *
 * Active by default for the first three; the VC/accelerator group is
 * opt-in (the signal there leans heavily corp/announcement, not technical).
 */
const SEED_V5_ADDITIONS: SeedDef[] = [
  // Founder-CEOs of foundation-model and AI-product labs.
  {
    platform: 'x',
    kind: 'x_topic',
    identifier:
      '(from:sama OR from:DarioAmodei OR from:demishassabis OR from:arthurmensch OR from:AravSrinivas OR from:aidangomez) -is:retweet',
    label: 'AI lab CEOs',
    freshness_ttl_minutes: 240,
  },
  // Compute / infrastructure / chip leadership shaping the substrate.
  {
    platform: 'x',
    kind: 'x_topic',
    identifier:
      '(from:JensenHuang OR from:LisaSu OR from:alighodsi OR from:patrickc OR from:matei_zaharia) -is:retweet',
    label: 'AI infra & chip CEOs',
    freshness_ttl_minutes: 360,
  },
  // Microsoft, xAI, Inflection-derived leadership; orthogonal to the AI
  // labs group above (these run product orgs the size of countries).
  {
    platform: 'x',
    kind: 'x_topic',
    identifier:
      '(from:elonmusk OR from:mustafasuleyman OR from:satyanadella OR from:kevin_scott OR from:ericschmidt) -is:retweet',
    label: 'AI corporate leaders',
    freshness_ttl_minutes: 360,
  },
  // Chief scientists / individual researchers running labs of their own.
  // Karpathy is in the v3 "AI researchers" group already; included here
  // again deliberately so the user sees this group as the "deep voice"
  // band even if v3 is later deactivated.
  {
    platform: 'x',
    kind: 'x_topic',
    identifier:
      '(from:gdb OR from:ilyasut OR from:jeffdean OR from:hardmaru OR from:AndrewYNg) -is:retweet',
    label: 'AI chief scientists',
    freshness_ttl_minutes: 240,
  },
  // VC / accelerator voices: high signal on directional bets, but heavy
  // corp content too. Inactive by default; user opts in if desired.
  {
    platform: 'x',
    kind: 'x_topic',
    identifier: '(from:paulg OR from:garrytan OR from:mwseibel OR from:pmarca) -is:retweet',
    label: 'AI VC / accelerator',
    freshness_ttl_minutes: 480,
    active: false,
  },
];

const SEED_BATCHES: Array<{ key: string; defs: SeedDef[] }> = [
  { key: 'presence:seeded_v1', defs: SEED_V1 },
  { key: 'presence:seeded_v2', defs: SEED_V2_ADDITIONS },
  { key: 'presence:seeded_v3', defs: SEED_V3_ADDITIONS },
  { key: 'presence:seeded_v5', defs: SEED_V5_ADDITIONS },
];

export function seedDefaultPresenceSources(db: Database): { seeded: number; batches: string[] } {
  const at = nowSec();
  const insert = db.query<
    unknown,
    [string, string, string, string, string | null, number, number, number, number]
  >(
    `INSERT OR IGNORE INTO presence_sources (
       id, platform, kind, identifier, label, weight, freshness_ttl_minutes, active, added_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const setKv = db.query<unknown, [string, string]>(
    'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)',
  );
  const getKv = db.query<{ value: string }, [string]>('SELECT value FROM kv WHERE key = ?');

  let totalSeeded = 0;
  const appliedBatches: string[] = [];

  for (const batch of SEED_BATCHES) {
    if (getKv.get(batch.key)) continue; // already applied; skip silently
    let seededHere = 0;
    const tx = db.transaction(() => {
      for (const def of batch.defs) {
        const res = insert.run(
          crypto.randomUUID(),
          def.platform,
          def.kind,
          def.identifier,
          def.label,
          1.0,
          def.freshness_ttl_minutes,
          def.active === false ? 0 : 1,
          at,
        );
        if ((res.changes ?? 0) > 0) seededHere += 1;
      }
      setKv.run(batch.key, String(at));
    });
    tx();
    totalSeeded += seededHere;
    appliedBatches.push(`${batch.key}:${seededHere}`);
  }

  // V3 deactivations: flip active=0 on noisy v2 entries only if the user
  // hasn't actually scanned them (last_scanned_at NULL). Idempotent — safe
  // to re-run; deactivated sources can be re-enabled from the Sources tab.
  let deactivated = 0;
  if (getKv.get('presence:seeded_v3')) {
    const tx = db.transaction(() => {
      const update = db.query<unknown, [string, string, string]>(
        `UPDATE presence_sources
            SET active = 0
          WHERE platform = ? AND kind = ? AND LOWER(identifier) = LOWER(?)
            AND active = 1
            AND last_scanned_at IS NULL`,
      );
      for (const d of V3_DEACTIVATIONS) {
        const res = update.run(d.platform, d.kind, d.identifier);
        deactivated += res.changes ?? 0;
      }
    });
    tx();
    if (deactivated > 0) {
      appliedBatches.push(`v3_deactivated:${deactivated}`);
    }
  }

  return { seeded: totalSeeded, batches: appliedBatches };
}

// ───────────────────────── Sources ─────────────────────────

export function listSources(
  db: Database,
  opts: { platform?: PresencePlatform; activeOnly?: boolean } = {},
): PresenceSourceRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.platform) {
    where.push('platform = ?');
    params.push(opts.platform);
  }
  if (opts.activeOnly) {
    where.push('active = 1');
  }
  const sql = `SELECT * FROM presence_sources ${
    where.length ? `WHERE ${where.join(' AND ')}` : ''
  } ORDER BY platform, kind, identifier`;
  return db.query<PresenceSourceRow, typeof params>(sql).all(...params);
}

export function getSource(db: Database, id: string): PresenceSourceRow | null {
  return (
    db.query<PresenceSourceRow, [string]>('SELECT * FROM presence_sources WHERE id = ?').get(id) ||
    null
  );
}

export function createSource(
  db: Database,
  input: {
    platform: PresencePlatform;
    kind: PresenceSourceKind;
    identifier: string;
    label?: string | null;
    weight?: number;
    freshness_ttl_minutes?: number;
  },
): PresenceSourceRow {
  const id = crypto.randomUUID();
  const at = nowSec();
  db.query<unknown, [string, string, string, string, string | null, number, number, number]>(
    `INSERT INTO presence_sources (
       id, platform, kind, identifier, label, weight, freshness_ttl_minutes, added_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    input.platform,
    input.kind,
    input.identifier,
    input.label ?? null,
    input.weight ?? 1.0,
    input.freshness_ttl_minutes ?? 240,
    at,
  );
  return getSource(db, id) as PresenceSourceRow;
}

export function updateSource(
  db: Database,
  id: string,
  patch: {
    label?: string | null;
    weight?: number;
    freshness_ttl_minutes?: number;
    active?: boolean;
  },
): PresenceSourceRow | null {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  if (patch.label !== undefined) {
    sets.push('label = ?');
    params.push(patch.label);
  }
  if (patch.weight !== undefined) {
    sets.push('weight = ?');
    params.push(patch.weight);
  }
  if (patch.freshness_ttl_minutes !== undefined) {
    sets.push('freshness_ttl_minutes = ?');
    params.push(patch.freshness_ttl_minutes);
  }
  if (patch.active !== undefined) {
    sets.push('active = ?');
    params.push(patch.active ? 1 : 0);
  }
  if (sets.length === 0) return getSource(db, id);
  params.push(id);
  db.query<unknown, typeof params>(
    `UPDATE presence_sources SET ${sets.join(', ')} WHERE id = ?`,
  ).run(...params);
  return getSource(db, id);
}

export function deleteSource(db: Database, id: string): boolean {
  const res = db.query<unknown, [string]>('DELETE FROM presence_sources WHERE id = ?').run(id);
  return (res.changes ?? 0) > 0;
}

export function markSourceScanned(
  db: Database,
  id: string,
  opts: { sinceId?: string | null; status: string },
): void {
  db.query<unknown, [string, string, string | null, string]>(
    `UPDATE presence_sources
       SET last_scanned_at = CAST(? AS INTEGER),
           last_scan_status = ?,
           last_since_id = COALESCE(?, last_since_id)
       WHERE id = ?`,
  ).run(String(nowSec()), opts.status, opts.sinceId ?? null, id);
}

// ───────────────────────── Drafts ─────────────────────────

export function listDrafts(
  db: Database,
  opts: {
    platform?: PresencePlatform;
    statuses?: PresenceDraftStatus[];
    limit?: number;
    includeExpired?: boolean;
  } = {},
): PresenceDraftRow[] {
  const where: string[] = [];
  const params: (string | number)[] = [];
  if (opts.platform) {
    where.push('platform = ?');
    params.push(opts.platform);
  }
  if (opts.statuses && opts.statuses.length > 0) {
    where.push(`status IN (${opts.statuses.map(() => '?').join(', ')})`);
    for (const s of opts.statuses) params.push(s);
  }
  const limit = Math.min(500, Math.max(1, opts.limit ?? 100));
  const sql = `SELECT * FROM presence_drafts ${
    where.length ? `WHERE ${where.join(' AND ')}` : ''
  } ORDER BY created_at DESC LIMIT ${limit}`;
  return db.query<PresenceDraftRow, typeof params>(sql).all(...params);
}

export function getDraft(db: Database, id: string): PresenceDraftRow | null {
  return (
    db.query<PresenceDraftRow, [string]>('SELECT * FROM presence_drafts WHERE id = ?').get(id) ||
    null
  );
}

export type CreateDraftInput = {
  platform: PresencePlatform;
  source_id: string | null;
  external_thread_id: string | null;
  external_thread_url: string | null;
  thread_snapshot: unknown;
  format: PresenceDraftFormat;
  relevance_score: number;
  freshness_expires_at: number;
  draft_body: string;
  draft_rationale?: string | null;
  vault_citations?: string[];
  radar_insight_ids?: string[];
  image_plan?: unknown;
};

export function createDraft(db: Database, input: CreateDraftInput): PresenceDraftRow {
  const id = crypto.randomUUID();
  const at = nowSec();
  const tx = db.transaction(() => {
    db.query<
      unknown,
      [
        string,
        string,
        string | null,
        string | null,
        string | null,
        string,
        string,
        number,
        number,
        string,
        string | null,
        string | null,
        string | null,
        string | null,
        number,
      ]
    >(
      `INSERT INTO presence_drafts (
         id, platform, source_id, external_thread_id, external_thread_url,
         thread_snapshot_json, format, relevance_score, freshness_expires_at,
         draft_body, draft_rationale, vault_citations_json, radar_insight_ids_json,
         image_plan_json, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      input.platform,
      input.source_id,
      input.external_thread_id,
      input.external_thread_url,
      JSON.stringify(input.thread_snapshot),
      input.format,
      input.relevance_score,
      input.freshness_expires_at,
      stripEmDashes(input.draft_body),
      input.draft_rationale ?? null,
      input.vault_citations ? JSON.stringify(input.vault_citations) : null,
      input.radar_insight_ids ? JSON.stringify(input.radar_insight_ids) : null,
      input.image_plan !== undefined ? JSON.stringify(input.image_plan) : null,
      at,
    );
    recordEvent(db, id, 'created', null);
  });
  tx();
  return getDraft(db, id) as PresenceDraftRow;
}

export function updateDraftBody(
  db: Database,
  id: string,
  patch: { draft_body?: string; image_plan?: unknown },
): PresenceDraftRow | null {
  const sets: string[] = [];
  const params: (string | number | null)[] = [];
  // Capture the previous row BEFORE we mutate, so we can compute edit
  // distance + decide if the existing image suggestion is now stale.
  const before = patch.draft_body !== undefined ? getDraft(db, id) : null;
  if (patch.draft_body !== undefined) {
    sets.push('draft_body = ?');
    // Defensive: even user-pasted edits get em-dashes stripped, so the
    // forbidden character can never re-enter via the PATCH path.
    params.push(stripEmDashes(patch.draft_body));

    // F1 — Image plan invalidation on body change.
    //
    // When the user edits the body, any previous image SUGGESTION (kind +
    // prompt synthesised from the old body) is likely stale. We drop only
    // the suggestion form; if an actual image is already generated (url/b64
    // present), we keep it because the user explicitly approved that visual.
    // The image_plan column is set inline so the same UPDATE writes both,
    // unless the caller is also passing an explicit image_plan in the patch
    // (in which case the explicit value wins, handled below).
    if (patch.image_plan === undefined && before?.image_plan_json) {
      try {
        const plan = JSON.parse(before.image_plan_json) as {
          suggested?: boolean;
          url?: string | null;
          b64?: string | null;
          mermaid?: string | null;
        };
        const hasGenerated = Boolean(plan.url || plan.b64 || plan.mermaid);
        if (plan.suggested === true && !hasGenerated) {
          sets.push('image_plan_json = ?');
          params.push(null);
        }
      } catch {
        /* malformed plan — leave it alone */
      }
    }
  }
  if (patch.image_plan !== undefined) {
    sets.push('image_plan_json = ?');
    params.push(JSON.stringify(patch.image_plan));
  }
  if (sets.length === 0) return getDraft(db, id);
  params.push(id);
  db.query<unknown, typeof params>(
    `UPDATE presence_drafts SET ${sets.join(', ')} WHERE id = ?`,
  ).run(...params);

  // Edit-distance: enrich the 'edited' event payload with the ratio so the
  // stats layer can identify which sources / scoring buckets produce drafts
  // the user has to rewrite heavily. Low ratio = drafter nailed it; high
  // ratio = anti-pattern signal worth feeding back into persona.
  let payload: Record<string, unknown> = { ...(patch as Record<string, unknown>) };
  if (patch.draft_body !== undefined && before) {
    const ratio = editRatio(before.draft_body, stripEmDashes(patch.draft_body));
    payload = {
      ...payload,
      edit_ratio: Math.round(ratio * 1000) / 1000,
      // Cap stored snippets so the event log doesn't bloat.
      before_snippet: before.draft_body.slice(0, 240),
      after_snippet: stripEmDashes(patch.draft_body).slice(0, 240),
    };
  }
  recordEvent(db, id, 'edited', payload);
  return getDraft(db, id);
}

/**
 * Transition a draft to a new status. Some transitions write side-columns
 * (viewed_at on 'viewed', decided_at on terminal states, posted_at + external
 * refs on 'posted'). Non-idempotent — calling twice will log two events.
 */
export function transitionDraft(
  db: Database,
  id: string,
  next: PresenceDraftStatus,
  opts: { posted_external_id?: string; posted_external_url?: string } = {},
): PresenceDraftRow | null {
  const at = nowSec();
  const sets: string[] = ['status = ?'];
  const params: (string | number | null)[] = [next];

  if (next === 'viewed') {
    sets.push('viewed_at = COALESCE(viewed_at, ?)');
    params.push(at);
  }
  if (next === 'approved' || next === 'ignored' || next === 'rejected' || next === 'expired') {
    sets.push('decided_at = COALESCE(decided_at, ?)');
    params.push(at);
  }
  if (next === 'posted') {
    sets.push('posted_at = ?');
    params.push(at);
    sets.push('decided_at = COALESCE(decided_at, ?)');
    params.push(at);
    if (opts.posted_external_id !== undefined) {
      sets.push('posted_external_id = ?');
      params.push(opts.posted_external_id);
    }
    if (opts.posted_external_url !== undefined) {
      sets.push('posted_external_url = ?');
      params.push(opts.posted_external_url);
    }
  }

  params.push(id);
  db.query<unknown, typeof params>(
    `UPDATE presence_drafts SET ${sets.join(', ')} WHERE id = ?`,
  ).run(...params);
  recordEvent(db, id, next, opts);
  return getDraft(db, id);
}

/**
 * Bulk transition: apply the same target status to multiple drafts in one
 * transaction. Honours the same side-column writes as the single-draft
 * transition (viewed_at on 'viewed', posted_at + decided_at on 'posted',
 * decided_at on 'ignored'/'rejected'/'expired'/'approved'). Returns the
 * count of drafts actually updated so the UI can toast accurately.
 */
export function bulkTransitionDrafts(
  db: Database,
  ids: string[],
  status: PresenceDraftStatus,
): number {
  if (ids.length === 0) return 0;
  let changed = 0;
  const tx = db.transaction(() => {
    for (const id of ids) {
      const row = transitionDraft(db, id, status);
      if (row) changed += 1;
    }
  });
  tx();
  return changed;
}

/**
 * Hard-delete a draft and its cascaded events / engagement metrics. Cost
 * ledger rows have ON DELETE SET NULL so they survive (with draft_id=null)
 * and stay in the cost-by-service aggregate — the spend happened regardless
 * of whether the draft was kept.
 */
export function deleteDraft(db: Database, id: string): boolean {
  const res = db.query<unknown, [string]>('DELETE FROM presence_drafts WHERE id = ?').run(id);
  return (res.changes ?? 0) > 0;
}

/**
 * Bulk-delete drafts in terminal statuses. Used by the "wipe archived"
 * action in the feed. Returns the number of rows actually removed so the
 * UI can toast accurately.
 */
export function bulkDeleteDrafts(db: Database, statuses: PresenceDraftStatus[]): number {
  if (statuses.length === 0) return 0;
  const placeholders = statuses.map(() => '?').join(', ');
  const res = db
    .query<unknown, string[]>(`DELETE FROM presence_drafts WHERE status IN (${placeholders})`)
    .run(...statuses);
  return res.changes ?? 0;
}

/**
 * Mark all proposed drafts whose freshness window has elapsed as 'expired'.
 * Called by the scheduler (or on-demand from the stats page) to clean the
 * feed without losing the row — expired drafts stay in stats forever.
 */
export function expireStaleDrafts(db: Database): number {
  const now = nowSec();
  const rows = db
    .query<{ id: string }, [number]>(
      `SELECT id FROM presence_drafts
        WHERE status = 'proposed' AND freshness_expires_at < ?`,
    )
    .all(now);
  const tx = db.transaction(() => {
    const stmt = db.query<unknown, [string, number, string]>(
      'UPDATE presence_drafts SET status = ?, decided_at = ? WHERE id = ?',
    );
    const eventStmt = db.query<unknown, [string, string, string | null, number]>(
      'INSERT INTO presence_draft_events (draft_id, event_type, payload_json, at) VALUES (?, ?, ?, ?)',
    );
    for (const row of rows) {
      stmt.run('expired', now, row.id);
      eventStmt.run(row.id, 'expired', null, now);
    }
  });
  tx();
  return rows.length;
}

// ───────────────────────── Events ─────────────────────────

export function recordEvent(
  db: Database,
  draftId: string,
  eventType: string,
  payload: unknown,
): void {
  db.query<unknown, [string, string, string | null, number]>(
    'INSERT INTO presence_draft_events (draft_id, event_type, payload_json, at) VALUES (?, ?, ?, ?)',
  ).run(draftId, eventType, payload == null ? null : JSON.stringify(payload), nowSec());
}

export function listEvents(db: Database, draftId: string): PresenceDraftEventRow[] {
  return db
    .query<PresenceDraftEventRow, [string]>(
      'SELECT * FROM presence_draft_events WHERE draft_id = ? ORDER BY at DESC',
    )
    .all(draftId);
}

// ───────────────────────── Cost ledger ─────────────────────────

export type CostInput = {
  draft_id?: string | null;
  service: string;
  operation: string;
  units?: number;
  unit_cost_usd?: number;
  total_usd: number;
  meta?: unknown;
};

export function recordCost(db: Database, input: CostInput): void {
  db.query<
    unknown,
    [string | null, string, string, number | null, number | null, number, string | null, number]
  >(
    `INSERT INTO presence_cost_ledger
       (draft_id, service, operation, units, unit_cost_usd, total_usd, meta_json, at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    input.draft_id ?? null,
    input.service,
    input.operation,
    input.units ?? null,
    input.unit_cost_usd ?? null,
    input.total_usd,
    input.meta === undefined ? null : JSON.stringify(input.meta),
    nowSec(),
  );
}

// ───────────────────────── Engagement ─────────────────────────

export type EngagementInput = {
  draft_id: string;
  snapshot_tag: PresenceEngagementTag;
  likes?: number | null;
  replies?: number | null;
  reposts?: number | null;
  impressions?: number | null;
  ratio?: number | null;
  raw?: unknown;
};

export function recordEngagement(db: Database, input: EngagementInput): void {
  db.query<
    unknown,
    [
      string,
      string,
      number,
      number | null,
      number | null,
      number | null,
      number | null,
      number | null,
      string | null,
    ]
  >(
    `INSERT INTO presence_engagement_metrics
       (draft_id, snapshot_tag, at, likes, replies, reposts, impressions, ratio, raw_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (draft_id, snapshot_tag) DO UPDATE SET
       at = excluded.at,
       likes = excluded.likes,
       replies = excluded.replies,
       reposts = excluded.reposts,
       impressions = excluded.impressions,
       ratio = excluded.ratio,
       raw_json = excluded.raw_json`,
  ).run(
    input.draft_id,
    input.snapshot_tag,
    nowSec(),
    input.likes ?? null,
    input.replies ?? null,
    input.reposts ?? null,
    input.impressions ?? null,
    input.ratio ?? null,
    input.raw === undefined ? null : JSON.stringify(input.raw),
  );
}

export function listDraftEngagement(db: Database, draftId: string): PresenceEngagementRow[] {
  return db
    .query<PresenceEngagementRow, [string]>(
      'SELECT * FROM presence_engagement_metrics WHERE draft_id = ? ORDER BY at',
    )
    .all(draftId);
}

// ───────────────────────── Platform connections ─────────────────────────

export function listConnections(db: Database): PresenceConnectionRow[] {
  return db.query<PresenceConnectionRow, []>('SELECT * FROM presence_platform_connections').all();
}

export function upsertConnection(
  db: Database,
  input: {
    platform: PresencePlatform;
    account_handle?: string | null;
    keychain_ref?: string | null;
    scopes?: string[];
  },
): PresenceConnectionRow {
  const at = nowSec();
  db.query<unknown, [string, string | null, string | null, string | null, number, number]>(
    `INSERT INTO presence_platform_connections
       (platform, account_handle, keychain_ref, scopes_json, connected_at, last_refresh_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (platform) DO UPDATE SET
       account_handle = COALESCE(excluded.account_handle, account_handle),
       keychain_ref   = COALESCE(excluded.keychain_ref,   keychain_ref),
       scopes_json    = COALESCE(excluded.scopes_json,    scopes_json),
       last_refresh_at = excluded.last_refresh_at`,
  ).run(
    input.platform,
    input.account_handle ?? null,
    input.keychain_ref ?? null,
    input.scopes ? JSON.stringify(input.scopes) : null,
    at,
    at,
  );
  return db
    .query<PresenceConnectionRow, [string]>(
      'SELECT * FROM presence_platform_connections WHERE platform = ?',
    )
    .get(input.platform) as PresenceConnectionRow;
}

export function deleteConnection(db: Database, platform: PresencePlatform): boolean {
  const res = db
    .query<unknown, [string]>('DELETE FROM presence_platform_connections WHERE platform = ?')
    .run(platform);
  return (res.changes ?? 0) > 0;
}

// ───────────────────────── Stats aggregates ─────────────────────────

export type FunnelRow = {
  platform: PresencePlatform | 'all';
  proposed: number;
  viewed: number;
  approved: number;
  posted: number;
  expired: number;
  ignored: number;
  rejected: number;
};

export function getFunnel(db: Database, windowDays = 30): FunnelRow[] {
  const since = nowSec() - windowDays * 86400;
  const rows = db
    .query<{ platform: string; status: string; n: number }, [number]>(
      `SELECT platform, status, COUNT(*) AS n
         FROM presence_drafts
         WHERE created_at >= ?
         GROUP BY platform, status`,
    )
    .all(since);

  const bucket = (): FunnelRow => ({
    platform: 'all',
    proposed: 0,
    viewed: 0,
    approved: 0,
    posted: 0,
    expired: 0,
    ignored: 0,
    rejected: 0,
  });

  const byPlatform = new Map<string, FunnelRow>();
  const all = bucket();
  all.platform = 'all';

  for (const row of rows) {
    const p = row.platform as PresencePlatform;
    if (!byPlatform.has(p)) {
      const b = bucket();
      b.platform = p;
      byPlatform.set(p, b);
    }
    const target = byPlatform.get(p) as FunnelRow;
    const key = row.status as keyof FunnelRow;
    if (key in target && typeof target[key] === 'number') {
      (target[key] as number) = row.n;
      (all[key] as number) += row.n;
    }
  }
  return [all, ...byPlatform.values()];
}

export type CostBucketRow = { bucket: string; total_usd: number };

export function getCostByDay(db: Database, windowDays = 30): CostBucketRow[] {
  const since = nowSec() - windowDays * 86400;
  return db
    .query<CostBucketRow, [number]>(
      `SELECT DATE(at, 'unixepoch') AS bucket, ROUND(SUM(total_usd), 4) AS total_usd
         FROM presence_cost_ledger
         WHERE at >= ?
         GROUP BY bucket
         ORDER BY bucket`,
    )
    .all(since);
}

export type CostServiceRow = {
  service: string;
  operation: string;
  calls: number;
  total_usd: number;
};

export function getCostByService(db: Database, windowDays = 30): CostServiceRow[] {
  const since = nowSec() - windowDays * 86400;
  return db
    .query<CostServiceRow, [number]>(
      `SELECT service, operation, COUNT(*) AS calls, ROUND(SUM(total_usd), 4) AS total_usd
         FROM presence_cost_ledger
         WHERE at >= ?
         GROUP BY service, operation
         ORDER BY total_usd DESC`,
    )
    .all(since);
}

export type SourceRoiRow = {
  source_id: string | null;
  label: string | null;
  platform: string | null;
  kind: string | null;
  identifier: string | null;
  proposed: number;
  posted: number;
  expired: number;
  ignored_rejected: number;
  post_rate: number;
};

export type TopSourceSummary = {
  source_id: string;
  label: string | null;
  platform: string;
  kind: string;
  identifier: string;
  posted: number;
  proposed: number;
  post_rate: number;
} | null;

export function getSourceRoi(db: Database, windowDays = 30): SourceRoiRow[] {
  const since = nowSec() - windowDays * 86400;
  return db
    .query<SourceRoiRow, [number]>(
      `SELECT
         d.source_id,
         s.label,
         s.platform,
         s.kind,
         s.identifier,
         COUNT(*) AS proposed,
         SUM(CASE WHEN d.status = 'posted' THEN 1 ELSE 0 END) AS posted,
         SUM(CASE WHEN d.status = 'expired' THEN 1 ELSE 0 END) AS expired,
         SUM(CASE WHEN d.status IN ('ignored','rejected') THEN 1 ELSE 0 END) AS ignored_rejected,
         ROUND(
           CAST(SUM(CASE WHEN d.status = 'posted' THEN 1 ELSE 0 END) AS REAL)
           / NULLIF(COUNT(*), 0),
         3) AS post_rate
       FROM presence_drafts d
       LEFT JOIN presence_sources s ON s.id = d.source_id
       WHERE d.created_at >= ?
       GROUP BY d.source_id
       ORDER BY posted DESC, proposed DESC`,
    )
    .all(since);
}

export type EngagementSummaryRow = {
  platform: string;
  tag: string;
  samples: number;
  avg_likes: number | null;
  avg_replies: number | null;
  avg_reposts: number | null;
  avg_impressions: number | null;
  avg_ratio: number | null;
};

/**
 * Per-draft latest engagement snapshot (any tag, including `manual`).
 * Surfaces the most recent live read for each posted draft, so the user
 * sees data immediately after a manual poll instead of waiting for the
 * t+1h window. The time-series aggregate (EngagementSummaryRow) keeps
 * its strict tag filter so averages don't drift.
 */
export type LatestEngagementRow = {
  draft_id: string;
  platform: string;
  /** Truncated draft body so the UI can identify the post without a join. */
  draft_body_preview: string;
  posted_external_url: string | null;
  posted_at: number;
  snapshot_tag: string;
  snapshot_at: number;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  impressions: number | null;
};

export type TranslationStatsRow = {
  lang: string;
  generated: number;
  saved: number;
  discarded: number;
  acceptance_rate: number | null;
};

export type RadarEngagementRow = {
  insight_type: string; // market_gap | overlap | vault_echo
  drafts_posted: number;
  /** Avg likes (Reddit upvote score / X like_count) on the latest snapshot per draft. */
  avg_likes: number | null;
  /** Avg replies / conversation_count on the latest snapshot. */
  avg_replies: number | null;
};

/**
 * Per-draft latest snapshot. Pulls one row per posted draft showing the
 * most recent engagement read regardless of tag (manual or scheduled).
 * Used by the UI right after a manual poll so the user sees data they
 * just captured without waiting for the next time-series tick.
 */
export function getLatestEngagementPerDraft(db: Database, windowDays = 30): LatestEngagementRow[] {
  const since = nowSec() - windowDays * 86400;
  return db
    .query<LatestEngagementRow, [number]>(
      `WITH latest AS (
         SELECT draft_id,
                snapshot_tag,
                at AS snapshot_at,
                likes, replies, reposts, impressions,
                ROW_NUMBER() OVER (PARTITION BY draft_id ORDER BY at DESC) AS rn
           FROM presence_engagement_metrics
          WHERE at >= ?
       )
       SELECT
         l.draft_id,
         d.platform,
         substr(d.draft_body, 1, 140) AS draft_body_preview,
         d.posted_external_url,
         d.posted_at,
         l.snapshot_tag,
         l.snapshot_at,
         l.likes, l.replies, l.reposts, l.impressions
       FROM latest l
       JOIN presence_drafts d ON d.id = l.draft_id
       WHERE l.rn = 1
       ORDER BY d.posted_at DESC`,
    )
    .all(since);
}

export function getEngagementSummary(db: Database, windowDays = 30): EngagementSummaryRow[] {
  const since = nowSec() - windowDays * 86400;
  // Exclude `manual` snapshots from the time-series aggregate — they're
  // captured at arbitrary times by user click and would skew the average
  // for the canonical t+1h / t+24h / t+7d buckets. Manual snapshots stay
  // queryable separately for the "latest live engagement" mini-card.
  return db
    .query<EngagementSummaryRow, [number]>(
      `SELECT
         d.platform,
         e.snapshot_tag AS tag,
         COUNT(*) AS samples,
         ROUND(AVG(e.likes), 2)        AS avg_likes,
         ROUND(AVG(e.replies), 2)      AS avg_replies,
         ROUND(AVG(e.reposts), 2)      AS avg_reposts,
         ROUND(AVG(e.impressions), 2)  AS avg_impressions,
         ROUND(AVG(e.ratio), 3)        AS avg_ratio
       FROM presence_engagement_metrics e
       JOIN presence_drafts d ON d.id = e.draft_id
       WHERE e.at >= ?
         AND e.snapshot_tag IN ('t+1h', 't+24h', 't+7d')
       GROUP BY d.platform, e.snapshot_tag
       ORDER BY d.platform, e.snapshot_tag`,
    )
    .all(since);
}

export type HeatmapCell = {
  hour: number; // 0-23
  weekday: number; // 0=Sun .. 6=Sat (SQLite strftime '%w')
  n: number;
};

/**
 * Per-format performance breakdown. Comments vs replies vs top-level posts
 * have different acceptance + engagement profiles; the user wants to know
 * "are my reply drafts more useful than my comments?" without a manual
 * cohort split.
 */
export type FormatEngagementRow = {
  format: string;
  proposed: number;
  posted: number;
  post_rate: number | null;
  avg_likes: number | null;
  avg_replies: number | null;
};

/**
 * Score-band calibration: did the scorer's relevance estimate predict
 * actual posting? Drafts in the 0.8+ band that all expire is a signal
 * the scorer is overconfident; drafts in 0.5-0.6 that get posted
 * regularly means the threshold is too high.
 */
export type ScoreBandRow = {
  band: string;
  total: number;
  posted: number;
  expired: number;
  ignored: number;
  post_rate: number | null;
};

/**
 * Day-of-week posting cadence + engagement. SQLite strftime('%w') returns
 * 0=Sunday..6=Saturday. Helps the user spot "I always post Saturday but
 * Tuesday gets 2x likes" type signals.
 */
export type DayOfWeekRow = {
  weekday: number; // 0=Sun..6=Sat
  posted: number;
  avg_likes: number | null;
};

export type EditHotspotRow = {
  ngram: string;
  occurrences: number;
};

export type OverviewStats = {
  funnel: FunnelRow[];
  cost_by_day: CostBucketRow[];
  cost_by_service: CostServiceRow[];
  source_roi: SourceRoiRow[];
  engagement: EngagementSummaryRow[];
  latest_engagement: LatestEngagementRow[];
  posted_heatmap: HeatmapCell[];
  expired_heatmap: HeatmapCell[];
  edit_hotspots: EditHotspotRow[];
  translations: TranslationStatsRow[];
  radar_engagement: RadarEngagementRow[];
  format_engagement: FormatEngagementRow[];
  score_bands: ScoreBandRow[];
  dow_posting: DayOfWeekRow[];
  totals: {
    drafts_total: number;
    drafts_posted: number;
    cost_total_usd: number;
    cost_per_posted_usd: number | null;
    sub_leverage_usd: number;
    avg_edit_ratio: number | null;
  };
};

/**
 * Hour × weekday matrix for posted or expired drafts, in the user's local
 * timezone via SQLite's `localtime` modifier. Sparse output (only n>0
 * cells); the UI fills the grid from this.
 */
function getHeatmap(
  db: Database,
  column: 'posted_at' | 'decided_at',
  filter: string,
  since: number,
): HeatmapCell[] {
  return db
    .query<HeatmapCell, [number]>(
      `SELECT
         CAST(strftime('%H', ${column}, 'unixepoch', 'localtime') AS INTEGER) AS hour,
         CAST(strftime('%w', ${column}, 'unixepoch', 'localtime') AS INTEGER) AS weekday,
         COUNT(*) AS n
       FROM presence_drafts
       WHERE ${column} IS NOT NULL
         AND ${column} >= ?
         AND ${filter}
       GROUP BY hour, weekday`,
    )
    .all(since);
}

/**
 * Top n-grams the user removes when editing. Reads 'edited' event payloads
 * (with before_snippet / after_snippet captured by editRatio tracking) and
 * surfaces 2-3-word phrases present in the before-snippet but absent from
 * the after-snippet. Cheap tokeniser — flag recurring filler words / LLM
 * tics the user kills systematically; the data eventually feeds the
 * persona's anti-pattern hint.
 */
function getEditHotspots(db: Database, since: number, limit = 12): EditHotspotRow[] {
  type EventPayload = {
    before_snippet?: string;
    after_snippet?: string;
    edit_ratio?: number;
  };
  const rows = db
    .query<{ payload_json: string | null }, [number]>(
      `SELECT payload_json FROM presence_draft_events
        WHERE event_type = 'edited' AND at >= ?
        ORDER BY at DESC
        LIMIT 500`,
    )
    .all(since);

  const counter = new Map<string, number>();
  const STOP = new Set([
    'the',
    'a',
    'an',
    'is',
    'it',
    'of',
    'to',
    'in',
    'on',
    'and',
    'or',
    'but',
    'for',
    'with',
    'as',
    'at',
    'by',
    'be',
    'are',
    'was',
    'were',
    'this',
    'that',
    'i',
    'you',
    'we',
    'they',
    'he',
    'she',
    'my',
    'your',
    'our',
  ]);

  for (const row of rows) {
    if (!row.payload_json) continue;
    let payload: EventPayload;
    try {
      payload = JSON.parse(row.payload_json) as EventPayload;
    } catch {
      continue;
    }
    const before = (payload.before_snippet || '').toLowerCase();
    const after = (payload.after_snippet || '').toLowerCase();
    if (!before || !after) continue;
    const beforeTokens = before.match(/\b[a-z']+\b/g) || [];
    const afterSet = new Set(after.match(/\b[a-z']+\b/g) || []);
    for (let i = 0; i < beforeTokens.length - 1; i++) {
      for (const len of [2, 3]) {
        if (i + len > beforeTokens.length) continue;
        const slice = beforeTokens.slice(i, i + len);
        if (slice.some((t) => STOP.has(t) || t.length < 3)) continue;
        if (!slice.every((t) => !afterSet.has(t))) continue;
        const ngram = slice.join(' ');
        counter.set(ngram, (counter.get(ngram) || 0) + 1);
      }
    }
  }
  return [...counter.entries()]
    .filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([ngram, occurrences]) => ({ ngram, occurrences }));
}

/**
 * Average engagement per radar insight TYPE on posted drafts. Joins:
 *   - `presence_drafts` posted in window with `radar_insight_ids_json` set
 *   - JSON-each over the id array → matches against `insights` table
 *   - latest engagement snapshot per draft (max(at) per draft_id)
 *
 * Tells the user "drafts that referenced market_gap insights got 2.3× more
 * likes than vault_echo ones" → which kinds of insights to lean into when
 * promoting from radar.
 */
function getRadarEngagement(db: Database, since: number): RadarEngagementRow[] {
  return db
    .query<RadarEngagementRow, [number]>(
      `WITH latest_eng AS (
         SELECT draft_id,
                AVG(likes)   AS likes,
                AVG(replies) AS replies
           FROM presence_engagement_metrics
          GROUP BY draft_id
       ),
       posted AS (
         SELECT d.id, d.radar_insight_ids_json
           FROM presence_drafts d
          WHERE d.status = 'posted'
            AND d.posted_at >= ?
            AND d.radar_insight_ids_json IS NOT NULL
       ),
       linked AS (
         SELECT p.id AS draft_id,
                json_each.value AS insight_id
           FROM posted p, json_each(p.radar_insight_ids_json)
       )
       SELECT i.type AS insight_type,
              COUNT(DISTINCT l.draft_id) AS drafts_posted,
              ROUND(AVG(le.likes), 2)    AS avg_likes,
              ROUND(AVG(le.replies), 2)  AS avg_replies
         FROM linked l
         JOIN insights i ON i.id = l.insight_id
         LEFT JOIN latest_eng le ON le.draft_id = l.draft_id
        GROUP BY i.type
        ORDER BY drafts_posted DESC`,
    )
    .all(since);
}

/**
 * Translation acceptance rate per target language. Reads `translation_*`
 * events from `presence_draft_events`. Helps spot a translator that's
 * underperforming for one language (e.g. "FR translations only saved 25%
 * of the time → tighten the FR prompt or switch model").
 */
/**
 * Per-format breakdown. Joins drafts with their latest engagement snapshot
 * (any tag that was actually captured: t+1h/t+24h/t+7d/manual) so the
 * "avg likes" reflects the freshest read we have, not just the t+1h
 * canonical (which may not have fired yet for recent posts).
 */
function getFormatEngagement(db: Database, since: number): FormatEngagementRow[] {
  return db
    .query<FormatEngagementRow, [number]>(
      `WITH latest AS (
         SELECT draft_id, likes, replies,
                ROW_NUMBER() OVER (PARTITION BY draft_id ORDER BY at DESC) AS rn
           FROM presence_engagement_metrics
       )
       SELECT
         d.format,
         COUNT(*) AS proposed,
         SUM(CASE WHEN d.status = 'posted' THEN 1 ELSE 0 END) AS posted,
         CAST(SUM(CASE WHEN d.status = 'posted' THEN 1 ELSE 0 END) AS REAL)
           / NULLIF(COUNT(*), 0) AS post_rate,
         ROUND(AVG(CASE WHEN d.status = 'posted' AND l.rn = 1 THEN l.likes END), 2)   AS avg_likes,
         ROUND(AVG(CASE WHEN d.status = 'posted' AND l.rn = 1 THEN l.replies END), 2) AS avg_replies
       FROM presence_drafts d
       LEFT JOIN latest l ON l.draft_id = d.id
       WHERE d.created_at >= ?
       GROUP BY d.format
       ORDER BY proposed DESC`,
    )
    .all(since)
    .map((r) => ({
      ...r,
      post_rate: r.post_rate == null ? null : Math.round(r.post_rate * 1000) / 1000,
    }));
}

/**
 * Score-band calibration. Buckets every draft by the relevance score the
 * stage-2 drafter assigned, then shows what fraction of each band actually
 * made it to posted. A scorer is well-calibrated when post_rate climbs
 * monotonically from low band → high band; clusters of expired drafts
 * in the 0.8+ band reveal an overconfident threshold.
 */
function getScoreBands(db: Database, since: number): ScoreBandRow[] {
  return db
    .query<ScoreBandRow, [number]>(
      `SELECT
         CASE
           WHEN relevance_score < 0.5 THEN '<0.5'
           WHEN relevance_score < 0.6 THEN '0.5-0.6'
           WHEN relevance_score < 0.7 THEN '0.6-0.7'
           WHEN relevance_score < 0.8 THEN '0.7-0.8'
           ELSE '0.8+'
         END AS band,
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'posted'  THEN 1 ELSE 0 END) AS posted,
         SUM(CASE WHEN status = 'expired' THEN 1 ELSE 0 END) AS expired,
         SUM(CASE WHEN status = 'ignored' OR status = 'rejected' THEN 1 ELSE 0 END) AS ignored,
         CAST(SUM(CASE WHEN status = 'posted' THEN 1 ELSE 0 END) AS REAL)
           / NULLIF(COUNT(*), 0) AS post_rate
       FROM presence_drafts
       WHERE created_at >= ?
       GROUP BY band
       ORDER BY MIN(relevance_score)`,
    )
    .all(since)
    .map((r) => ({
      ...r,
      post_rate: r.post_rate == null ? null : Math.round(r.post_rate * 1000) / 1000,
    }));
}

/**
 * Day-of-week posting cadence + engagement. Surfaces the dual signal
 * "when do I post" + "when do my posts perform" — separate axes that
 * the heatmap mixes together.
 */
function getDayOfWeekPosting(db: Database, since: number): DayOfWeekRow[] {
  return db
    .query<DayOfWeekRow, [number]>(
      `WITH latest AS (
         SELECT draft_id, likes,
                ROW_NUMBER() OVER (PARTITION BY draft_id ORDER BY at DESC) AS rn
           FROM presence_engagement_metrics
       )
       SELECT
         CAST(strftime('%w', d.posted_at, 'unixepoch', 'localtime') AS INTEGER) AS weekday,
         COUNT(*) AS posted,
         ROUND(AVG(CASE WHEN l.rn = 1 THEN l.likes END), 2) AS avg_likes
       FROM presence_drafts d
       LEFT JOIN latest l ON l.draft_id = d.id
       WHERE d.status = 'posted' AND d.posted_at >= ?
       GROUP BY weekday
       ORDER BY weekday`,
    )
    .all(since);
}

function getTranslationStats(db: Database, since: number): TranslationStatsRow[] {
  const rows = db
    .query<{ lang: string; outcome: string; n: number }, [number]>(
      `SELECT
         json_extract(payload_json, '$.lang') AS lang,
         event_type AS outcome,
         COUNT(*) AS n
       FROM presence_draft_events
       WHERE event_type IN ('translation_generated','translation_saved','translation_discarded')
         AND at >= ?
         AND json_extract(payload_json, '$.lang') IS NOT NULL
       GROUP BY lang, outcome`,
    )
    .all(since);

  const byLang = new Map<string, { generated: number; saved: number; discarded: number }>();
  for (const row of rows) {
    if (!row.lang) continue;
    const slot = byLang.get(row.lang) || { generated: 0, saved: 0, discarded: 0 };
    if (row.outcome === 'translation_generated') slot.generated = row.n;
    if (row.outcome === 'translation_saved') slot.saved = row.n;
    if (row.outcome === 'translation_discarded') slot.discarded = row.n;
    byLang.set(row.lang, slot);
  }
  return [...byLang.entries()]
    .map(([lang, s]) => ({
      lang,
      generated: s.generated,
      saved: s.saved,
      discarded: s.discarded,
      // Acceptance rate = saved / (saved + discarded); if neither happened
      // (just generated, no commit decision yet), report null so the UI
      // doesn't show a misleading 0%.
      acceptance_rate:
        s.saved + s.discarded > 0
          ? Math.round((s.saved / (s.saved + s.discarded)) * 1000) / 1000
          : null,
    }))
    .sort((a, b) => b.generated - a.generated);
}

export function getOverviewStats(db: Database, windowDays = 30): OverviewStats {
  const since = nowSec() - windowDays * 86400;
  const funnel = getFunnel(db, windowDays);
  const cost_by_day = getCostByDay(db, windowDays);
  const cost_by_service = getCostByService(db, windowDays);
  const source_roi = getSourceRoi(db, windowDays);
  const engagement = getEngagementSummary(db, windowDays);
  const latest_engagement = getLatestEngagementPerDraft(db, windowDays);
  const posted_heatmap = getHeatmap(db, 'posted_at', "status = 'posted'", since);
  const expired_heatmap = getHeatmap(db, 'decided_at', "status = 'expired'", since);
  const edit_hotspots = getEditHotspots(db, since);
  const translations = getTranslationStats(db, since);
  const format_engagement = getFormatEngagement(db, since);
  const score_bands = getScoreBands(db, since);
  const dow_posting = getDayOfWeekPosting(db, since);
  const radar_engagement = getRadarEngagement(db, since);

  const totals_row = db
    .query<{ total: number; posted: number }, [number]>(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'posted' THEN 1 ELSE 0 END) AS posted
       FROM presence_drafts
       WHERE created_at >= ?`,
    )
    .get(since) || { total: 0, posted: 0 };

  const cost_total_row = db
    .query<{ total: number | null }, [number]>(
      'SELECT SUM(total_usd) AS total FROM presence_cost_ledger WHERE at >= ?',
    )
    .get(since) || { total: 0 };

  // Sub leverage: sum of api_equivalent_usd recorded for CLI calls (where
  // billing='subscription'). "Your sub paid for $X of work that PAYG would
  // have charged."
  const sub_row = db
    .query<{ saved: number | null }, [number]>(
      `SELECT SUM(CAST(json_extract(meta_json, '$.api_equivalent_usd') AS REAL)) AS saved
         FROM presence_cost_ledger
        WHERE at >= ?
          AND json_extract(meta_json, '$.billing') = 'subscription'`,
    )
    .get(since) || { saved: 0 };

  // Average edit ratio from 'edited' events — how much of the drafter's
  // output you typically rewrite.
  const edit_row = db
    .query<{ avg_ratio: number | null }, [number]>(
      `SELECT AVG(CAST(json_extract(payload_json, '$.edit_ratio') AS REAL)) AS avg_ratio
         FROM presence_draft_events
        WHERE event_type = 'edited' AND at >= ?
          AND json_extract(payload_json, '$.edit_ratio') IS NOT NULL`,
    )
    .get(since) || { avg_ratio: null };

  const cost_total_usd = cost_total_row.total ?? 0;
  const cost_per_posted_usd = totals_row.posted > 0 ? cost_total_usd / totals_row.posted : null;

  return {
    funnel,
    cost_by_day,
    cost_by_service,
    source_roi,
    engagement,
    latest_engagement,
    posted_heatmap,
    expired_heatmap,
    edit_hotspots,
    translations,
    radar_engagement,
    format_engagement,
    score_bands,
    dow_posting,
    totals: {
      drafts_total: totals_row.total ?? 0,
      drafts_posted: totals_row.posted ?? 0,
      cost_total_usd: Math.round(cost_total_usd * 10000) / 10000,
      cost_per_posted_usd:
        cost_per_posted_usd === null ? null : Math.round(cost_per_posted_usd * 10000) / 10000,
      sub_leverage_usd: Math.round((sub_row.saved ?? 0) * 10000) / 10000,
      avg_edit_ratio:
        edit_row.avg_ratio === null ? null : Math.round(edit_row.avg_ratio * 1000) / 1000,
    },
  };
}

/**
 * Quick at-a-glance feed summary for the nav badge: how many proposed
 * drafts are still alive, how many die in the next hour. The badge surfaces
 * the urgency count.
 */
export type FeedSummary = {
  proposed: number;
  proposed_unviewed: number;
  dying_within_1h: number;
  dying_within_24h: number;
  top_source: TopSourceSummary;
};

/**
 * Pick the source with the best post_rate over the last 30 days, requiring
 * at least 2 posted drafts so a single lucky post doesn't crown the chip.
 * Used by the FeedView header to show "🏆 r/foo · 80% post rate (4/5)".
 */
function getTopSource(db: Database, windowDays = 30): TopSourceSummary {
  const since = nowSec() - windowDays * 86400;
  const row = db
    .query<
      {
        source_id: string | null;
        label: string | null;
        platform: string | null;
        kind: string | null;
        identifier: string | null;
        proposed: number;
        posted: number;
        post_rate: number | null;
      },
      [number]
    >(
      `SELECT
         d.source_id,
         s.label,
         s.platform,
         s.kind,
         s.identifier,
         COUNT(*) AS proposed,
         SUM(CASE WHEN d.status = 'posted' THEN 1 ELSE 0 END) AS posted,
         CAST(SUM(CASE WHEN d.status = 'posted' THEN 1 ELSE 0 END) AS REAL)
           / NULLIF(COUNT(*), 0) AS post_rate
       FROM presence_drafts d
       JOIN presence_sources s ON s.id = d.source_id
       WHERE d.created_at >= ?
       GROUP BY d.source_id
       HAVING posted >= 2
       ORDER BY post_rate DESC, posted DESC
       LIMIT 1`,
    )
    .get(since);
  if (!row || !row.source_id || !row.platform || !row.kind || !row.identifier) return null;
  return {
    source_id: row.source_id,
    label: row.label,
    platform: row.platform,
    kind: row.kind,
    identifier: row.identifier,
    proposed: row.proposed,
    posted: row.posted,
    post_rate: Math.round((row.post_rate ?? 0) * 1000) / 1000,
  };
}

export function getFeedSummary(db: Database): FeedSummary {
  const now = nowSec();
  const counts = db
    .query<Omit<FeedSummary, 'top_source'>, [number, number, number, number]>(
      `SELECT
         SUM(CASE WHEN status = 'proposed' THEN 1 ELSE 0 END) AS proposed,
         SUM(CASE WHEN status = 'proposed' AND viewed_at IS NULL THEN 1 ELSE 0 END) AS proposed_unviewed,
         SUM(CASE WHEN status = 'proposed' AND freshness_expires_at <= ? AND freshness_expires_at > ? THEN 1 ELSE 0 END) AS dying_within_1h,
         SUM(CASE WHEN status = 'proposed' AND freshness_expires_at <= ? AND freshness_expires_at > ? THEN 1 ELSE 0 END) AS dying_within_24h
       FROM presence_drafts`,
    )
    .get(now + 3600, now, now + 86400, now) || {
    proposed: 0,
    proposed_unviewed: 0,
    dying_within_1h: 0,
    dying_within_24h: 0,
  };
  return { ...counts, top_source: getTopSource(db, 30) };
}
