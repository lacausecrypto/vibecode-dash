import type { XTweet, XTweetAuthor } from '../wrappers/xApi';

/**
 * Composite quality scorer for X tweets, used as a pre-CLI filter so we only
 * spend Haiku scoring calls on tweets with a real chance of producing a draft
 * worth posting. The scorer is intentionally cheap: pure arithmetic on data
 * the X API already returns in the same response (no extra reads).
 *
 * Five signals, weighted to favour the "AI / indie dev" workflow this dashboard
 * targets:
 *
 *   1. Engagement velocity (35%) — interactions per hour since post.
 *      Beats absolute counts because a 12-hour-old tweet with 50 likes is
 *      worse than a 30-min tweet with the same count.
 *   2. Author reach (20%)         — log-normalized follower count. Big-reach
 *      authors get more eyeballs on a reply, which is the leverage we want.
 *   3. Author quality (20%)       — bio keywords (CEO/founder/researcher) +
 *      X verified_type. Distinguishes paid Blue (weak) from business/gov
 *      (strong). Falls back to 0 when the author block is missing.
 *   4. Content quality (10%)      — text length, link/mention noise floor.
 *      Coarse but kills the empty-tweet / link-spam tier.
 *   5. Curated authors boost (15%) — flat +0.15 when the author is on a
 *      hand-picked list of AI lab founders, researchers, and notable
 *      builders. Justifies skipping the other signals when @sama or
 *      @karpathy posts something at all.
 *
 * The score is the sum of these five components, capped at 1. Components
 * also act as guardrails: a 0-engagement tweet from a bot account never
 * crosses the threshold even with a long bio.
 *
 * Threshold (`MIN_QUALITY_SCORE = 0.40`) is tuned so the typical 25-tweet
 * fetch yields ~5–8 high-quality candidates — enough for one batch scoring
 * call (`SCORE_BATCH_SIZE = 8`) without running over. Calibrated on the
 * user's actual list timelines (May 2026): handles like @sama / @karpathy /
 * @AnthropicAI consistently score > 0.7, generic developer tweets land
 * 0.30–0.50, no-engagement throwaways < 0.20.
 */

export const MIN_QUALITY_SCORE = 0.4;

// Saturation point for the engagement-velocity log curve. A tweet with 200+
// "weighted interactions per hour" already dominates the signal; anything
// beyond this returns 1.0. Set on the high side so the term doesn't pin at
// 1.0 too easily — only viral-ish posts hit the cap.
const VELOCITY_SATURATION_PER_HOUR = 200;

// Saturation point for follower reach. 1M followers ≈ Elon-tier reach for
// our purposes; we don't need finer resolution past that since reach
// returns are sub-linear anyway.
const REACH_SATURATION_FOLLOWERS = 1_000_000;

// Substance floor for content. Tweets shorter than this are usually a URL,
// an emoji reaction, or a one-word mood post — no scoring substrate.
const MIN_CONTENT_LENGTH = 30;
const SUBSTANTIVE_CONTENT_LENGTH = 140;

// Cap on @-mentions before content is treated as spam-shaped. A reply to
// 5+ accounts at once is almost always low-effort thread noise.
const MAX_MENTIONS_BEFORE_PENALTY = 4;

/**
 * Curated handles whose tweets get a +0.15 quality bump regardless of
 * engagement. These are people the AI/indie-dev audience cares about by
 * default: AI lab CEOs/founders, prominent researchers, infrastructure
 * builders, indie-hacker leaders.
 *
 * The list is intentionally short (~50 entries). Bigger lists dilute the
 * boost — if too many handles are "high value", the term carries no signal.
 *
 * Settings can override by setting `presence.highValueAuthorHandles` to
 * a custom array (lowercased, no `@`). When provided, this constant is
 * ignored entirely so the user can curate their own focus.
 */
export const DEFAULT_HIGH_VALUE_HANDLES: ReadonlySet<string> = new Set([
  // AI labs — official + leadership
  'anthropicai',
  'darioamodei',
  'openai',
  'sama',
  'gdb',
  'karpathy',
  'miramurati',
  'demishassabis',
  'jeffdean',
  'hardmaru',
  'ilyasut',
  'ylecun',
  'aiatmeta',
  'mustafasuleyman',
  'andrewyng',
  '_jasonwei',
  'dwarkesh_sp',
  'omarsar0',
  'jackclarksf',

  // Adjacent AI labs
  'perplexity_ai',
  'cognition_labs',
  'cursor_ai',
  'replicate',

  // Tech CEOs & infra leaders
  'elonmusk',
  'jensenhuang',
  'lisasu',
  'satyanadella',
  'sundarpichai',
  'kevin_scott',
  'ericschmidt',
  'tim_cook',

  // Founders / indie builders the dashboard's audience follows
  'dhh',
  'levelsio',
  'patio11',
  'paulg',
  'nikitabier',
  'tobi', // Shopify
  'patrickc', // Stripe
  'matei_zaharia', // Databricks
  'alighodsi', // Databricks
  'agihippo',
  'abacaj',
  'drjimfan',
]);

/** Bio keywords that signal authority. Matched case-insensitively. */
const STRONG_BIO_KEYWORDS = [
  /\bCEO\b/i,
  /\bCTO\b/i,
  /\bCOO\b/i,
  /\bCSO\b/i,
  /\b(co[-\s]?founder|founder|chairman)\b/i,
];
const MEDIUM_BIO_KEYWORDS = [
  /\bresearch(er|ist)?\b/i,
  /\bscientist\b/i,
  /\bprincipal engineer\b/i,
  /\bdistinguished engineer\b/i,
  /\bprofessor\b/i,
  /\bhead of\b/i,
  /\bdirector of\b/i,
  /\bVP\b/, // case-sensitive intentional — "VP" not "vp" inside random words
];

// Matches "at <BigCo>" — used to detect "researcher at OpenAI", "engineer at
// Meta", etc. Limited to the major employers our audience cares about.
const NOTABLE_EMPLOYER_REGEX =
  /\bat (anthropic|openai|google|meta|deepmind|microsoft|apple|nvidia|tesla|databricks|hugging face|stripe|cursor|perplexity|cohere)\b/i;

// ───────────────────────── Component scorers ─────────────────────────

export function engagementVelocityScore(tweet: XTweet, nowSec: number): number {
  const createdSec = Math.floor(new Date(tweet.created_at).getTime() / 1000);
  const ageHours = Math.max((nowSec - createdSec) / 3600, 1 / 60); // floor at 1 min
  const m = tweet.public_metrics;
  // Reply-weight 3, retweet-weight 2, like-weight 1. Replies signal
  // conversation density (good for our use case — we want to insert into
  // active discussions). Retweets signal amplification reach.
  const weighted = m.like_count + 2 * m.retweet_count + 3 * m.reply_count;
  const perHour = weighted / ageHours;
  // log curve: 0 → 0, sat → 1
  return Math.min(1, Math.log10(perHour + 1) / Math.log10(VELOCITY_SATURATION_PER_HOUR + 1));
}

export function authorReachScore(author: XTweetAuthor | undefined): number {
  if (!author) return 0;
  const followers = Math.max(0, author.followers_count);
  if (followers === 0) return 0;
  return Math.min(1, Math.log10(followers + 1) / Math.log10(REACH_SATURATION_FOLLOWERS + 1));
}

export function authorQualityScore(author: XTweetAuthor | undefined): number {
  if (!author) return 0;
  let score = 0;

  // Verified-type lifts: business/government are vetted by X, paid Blue is
  // self-purchased and worthless as a signal.
  if (author.verified_type === 'business') score += 0.35;
  else if (author.verified_type === 'government') score += 0.3;
  // Plain `verified: true` without verified_type is the legacy signal —
  // mostly notable accounts grandfathered in pre-Blue. Worth a small bump.
  else if (author.verified === true && author.verified_type == null) score += 0.15;

  const bio = author.description ?? '';
  if (bio) {
    if (STRONG_BIO_KEYWORDS.some((re) => re.test(bio))) score += 0.45;
    else if (MEDIUM_BIO_KEYWORDS.some((re) => re.test(bio))) score += 0.25;
    if (NOTABLE_EMPLOYER_REGEX.test(bio)) score += 0.2;
  }

  return Math.min(1, score);
}

export function contentQualityScore(text: string): number {
  if (!text) return 0;
  const trimmed = text.trim();
  // Strip URLs first — a tweet that's mostly a link is structurally low-effort
  // for our reply use-case (we'd be replying to a link share, not a take).
  const noUrls = trimmed.replace(/https?:\/\/\S+/gi, '');
  if (noUrls.trim().length < MIN_CONTENT_LENGTH) return 0.05;

  let score = 0.3;
  // Substance reward: longer text usually means more nuance to engage with.
  if (noUrls.trim().length >= SUBSTANTIVE_CONTENT_LENGTH) score += 0.3;
  // Sentence count: 2+ sentences earns a small bump (real take vs one-liner).
  const sentenceCount = (noUrls.match(/[.!?]\s/g) ?? []).length;
  if (sentenceCount >= 2) score += 0.2;
  // Penalty: too many @-mentions = thread noise / spam shape.
  const mentionCount = (trimmed.match(/@[A-Za-z0-9_]{1,15}/g) ?? []).length;
  if (mentionCount > MAX_MENTIONS_BEFORE_PENALTY) score = Math.max(0, score - 0.2);
  // Penalty: ALL-CAPS shouting tier. Allows acronyms (≤3 letters).
  const upperRatio = countUpperRatio(trimmed);
  if (upperRatio > 0.6) score = Math.max(0, score - 0.2);
  return Math.min(1, score);
}

function countUpperRatio(s: string): number {
  let upper = 0;
  let total = 0;
  for (const ch of s) {
    if (ch >= 'A' && ch <= 'Z') {
      upper++;
      total++;
    } else if (ch >= 'a' && ch <= 'z') {
      total++;
    }
  }
  return total > 0 ? upper / total : 0;
}

export function curatedAuthorBoost(
  username: string | undefined,
  highValueHandles: ReadonlySet<string> = DEFAULT_HIGH_VALUE_HANDLES,
): number {
  if (!username) return 0;
  return highValueHandles.has(username.toLowerCase()) ? 0.15 : 0;
}

// ───────────────────────── Composite ─────────────────────────

export type TweetQualityBreakdown = {
  total: number;
  velocity: number;
  reach: number;
  author_quality: number;
  content: number;
  curated_boost: number;
};

/**
 * Final composite quality. Weights chosen to make velocity dominant (the
 * single best signal of "this is alive RIGHT NOW") while keeping author
 * reach and quality as second-tier filters that push obvious-bot accounts
 * below the threshold even when they get accidental engagement.
 */
export function tweetQualityScore(
  tweet: XTweet,
  nowSec: number,
  highValueHandles?: ReadonlySet<string>,
): TweetQualityBreakdown {
  const velocity = engagementVelocityScore(tweet, nowSec);
  const reach = authorReachScore(tweet.author);
  const author_quality = authorQualityScore(tweet.author);
  const content = contentQualityScore(tweet.text);
  const curated_boost = curatedAuthorBoost(tweet.author_username, highValueHandles);
  const total = Math.min(
    1,
    velocity * 0.35 + reach * 0.2 + author_quality * 0.2 + content * 0.1 + curated_boost,
  );
  return { total, velocity, reach, author_quality, content, curated_boost };
}

/**
 * Filter + rank candidates by composite quality. Returns up to `maxResults`
 * tweets sorted by score desc — high-value tweets always processed first
 * even if the slice cuts off later candidates. Tweets below the threshold
 * are dropped entirely so the CLI never wastes a Haiku call on them.
 */
export function rankTweetsByQuality(
  tweets: XTweet[],
  opts: {
    nowSec: number;
    maxResults?: number;
    minScore?: number;
    highValueHandles?: ReadonlySet<string>;
  },
): { tweet: XTweet; quality: TweetQualityBreakdown }[] {
  const minScore = opts.minScore ?? MIN_QUALITY_SCORE;
  const ranked: { tweet: XTweet; quality: TweetQualityBreakdown }[] = [];
  for (const t of tweets) {
    const quality = tweetQualityScore(t, opts.nowSec, opts.highValueHandles);
    if (quality.total >= minScore) ranked.push({ tweet: t, quality });
  }
  ranked.sort((a, b) => b.quality.total - a.quality.total);
  return opts.maxResults != null ? ranked.slice(0, opts.maxResults) : ranked;
}
