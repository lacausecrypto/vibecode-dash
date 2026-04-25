import type { Database } from 'bun:sqlite';
import type { Settings } from '../config';
import {
  type PresenceSourceRow,
  createDraft,
  markSourceScanned,
  updateDraftBody,
} from '../lib/presence';
import { classifyImageNeed, generateDraft, scoreCandidate } from '../lib/presenceDrafter';
import {
  type RedditPost,
  listSubredditHot,
  listSubredditNew,
  listUserSubmitted,
  redditAccessMode,
} from '../wrappers/redditApi';

/**
 * Reddit scanner — one pass over a single source.
 *
 * Flow:
 *   1. Fetch the listing (hot/new) or user submitted — whatever the source kind
 *      calls for. We use `since_id` style cursoring: we record the newest
 *      fullname seen and next run only produces drafts for items strictly
 *      newer. Reddit returns sticky posts at the top of hot; we filter those
 *      out in the wrapper.
 *   2. Dedup against existing drafts by (platform, external_thread_id). Reddit
 *      post ids are short alphanumeric strings ("1xabcd"); we prefix with `t3_`
 *      to match the full Reddit fullname format.
 *   3. Stage 1 score (Haiku). Below threshold → skip, no Sonnet cost.
 *   4. Stage 2 draft (Sonnet). Persist iff draft body is non-empty.
 *
 * Freshness: each draft gets `freshness_expires_at` set from the source's
 * per-source TTL (240 min default). The `presence_expire_stale` job sweeps
 * these once the window passes.
 *
 * Thread ID discipline:
 *   - Posts: external_thread_id = "t3_<postid>"
 *   - external_thread_url = "https://reddit.com<permalink>"
 *   - The engagement poller parses t3_/t1_ fullnames back via
 *     permalinkToFullname to fetch latest metrics.
 */

const SCORE_THRESHOLD = 0.65;
const MIN_POST_AGE_SEC = 60; // skip 5-second-old posts (no signal yet)
const MAX_POST_AGE_SEC = 48 * 3600; // 2 days; older threads are rarely worth commenting
const MAX_CANDIDATES_PER_SOURCE = 20;
const MIN_SELFTEXT_FOR_CONTEXT = 40; // skip threads too thin for the scorer

export type RedditScanOutcome = {
  source_id: string;
  candidates_seen: number;
  scored: number;
  drafts_created: number;
  skipped_duplicate: number;
  skipped_low_score: number;
  skipped_no_draft: number;
  error?: string;
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function rowExistsForThread(db: Database, platform: 'reddit', externalId: string): boolean {
  const row = db
    .query<{ id: string }, [string, string]>(
      'SELECT id FROM presence_drafts WHERE platform = ? AND external_thread_id = ? LIMIT 1',
    )
    .get(platform, externalId);
  return Boolean(row);
}

async function fetchPosts(source: PresenceSourceRow): Promise<RedditPost[]> {
  const id = source.identifier.replace(/^\/?(r|u|user)\//, '');
  if (source.kind === 'subreddit') {
    // Alternate hot + new: hot gets high-signal threads regardless of recency,
    // new catches freshly-posted items where being early matters.
    const [hot, fresh] = await Promise.all([
      listSubredditHot(id, { limit: 25 }),
      listSubredditNew(id, { limit: 25 }),
    ]);
    // Dedup by post id (hot and new overlap for young popular threads).
    const seen = new Set<string>();
    const combined: RedditPost[] = [];
    for (const p of [...hot.posts, ...fresh.posts]) {
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      combined.push(p);
    }
    return combined;
  }
  if (source.kind === 'reddit_user') {
    return listUserSubmitted(id, { limit: 25 });
  }
  return [];
}

function postToCandidate(post: RedditPost) {
  return {
    platform: 'reddit' as const,
    thread: {
      author: post.author,
      title: post.title,
      body: post.selftext,
      score: post.score,
      url: `https://reddit.com${post.permalink}`,
      created_utc: post.created_utc,
    },
    preferredFormat: 'comment' as const,
  };
}

export async function scanRedditSource(
  db: Database,
  settings: Settings,
  source: PresenceSourceRow,
): Promise<RedditScanOutcome> {
  const outcome: RedditScanOutcome = {
    source_id: source.id,
    candidates_seen: 0,
    scored: 0,
    drafts_created: 0,
    skipped_duplicate: 0,
    skipped_low_score: 0,
    skipped_no_draft: 0,
  };

  // Reddit reads work in two modes: OAuth (richer data + higher rate cap) or
  // public (.json endpoints, ~10 req/min). We attempt both; the wrapper picks
  // automatically based on whether creds are configured. Engagement polling
  // on the user's own posts still requires OAuth — that part of the pipeline
  // degrades gracefully when only public mode is available.
  const accessMode = await redditAccessMode();

  let posts: RedditPost[];
  try {
    posts = await fetchPosts(source);
  } catch (error) {
    outcome.error = String(error).slice(0, 300);
    markSourceScanned(db, source.id, { status: `error:${outcome.error}` });
    return outcome;
  }

  outcome.candidates_seen = posts.length;

  const now = nowSec();
  const ttlSec = source.freshness_ttl_minutes * 60;
  const sinceId = source.last_since_id;

  // Establish new checkpoint as the newest post name we see this run.
  // Reddit names are base36 monotonically increasing per post — simple string
  // compare is NOT reliable across subs, so we just track the top-of-list.
  const newestSeen = posts[0]?.name ?? null;

  // Filter by age + since_id cutoff
  const fresh = posts.filter((p) => {
    if (sinceId && p.name === sinceId) return false; // already processed
    const age = now - p.created_utc;
    if (age < MIN_POST_AGE_SEC || age > MAX_POST_AGE_SEC) return false;
    if (p.selftext.length < MIN_SELFTEXT_FOR_CONTEXT && p.num_comments < 3) return false;
    return true;
  });

  const candidates = fresh.slice(0, MAX_CANDIDATES_PER_SOURCE);

  for (const post of candidates) {
    const externalId = `t3_${post.id}`;
    if (rowExistsForThread(db, 'reddit', externalId)) {
      outcome.skipped_duplicate += 1;
      continue;
    }

    // Stage 1
    const candidate = postToCandidate(post);
    const scored = await scoreCandidate(db, settings, candidate);
    outcome.scored += 1;
    if (scored.score < SCORE_THRESHOLD) {
      outcome.skipped_low_score += 1;
      continue;
    }

    // Stage 2
    let draft: Awaited<ReturnType<typeof generateDraft>>;
    try {
      draft = await generateDraft(db, settings, candidate, scored.score);
    } catch (error) {
      // Treat transient draft failures as low-score skips — the scanner will
      // retry the same thread next run since we didn't persist.
      outcome.skipped_no_draft += 1;
      console.warn(`[presenceReddit] draft failed for ${externalId}: ${String(error)}`);
      continue;
    }

    if (!draft.draft_body || draft.draft_body.length < 20 || draft.score < SCORE_THRESHOLD) {
      outcome.skipped_no_draft += 1;
      continue;
    }

    const created = createDraft(db, {
      platform: 'reddit',
      source_id: source.id,
      external_thread_id: externalId,
      external_thread_url: candidate.thread.url ?? null,
      thread_snapshot: {
        author: post.author,
        title: post.title,
        body: post.selftext.slice(0, 3000),
        score: post.score,
        num_comments: post.num_comments,
        created_utc: post.created_utc,
        subreddit: post.subreddit,
      },
      format: draft.format,
      relevance_score: draft.score,
      freshness_expires_at: now + ttlSec,
      draft_body: draft.draft_body,
      draft_rationale: draft.rationale,
      vault_citations: draft.vault_citations,
      radar_insight_ids: draft.radar_insight_ids,
    });
    outcome.drafts_created += 1;

    // Pre-classify image suggestion right after draft creation. Storing the
    // `kind` + `prompt` lets the UI render a "image suggested: illustration
    // <prompt>" placeholder with a 1-click gen button. We DON'T generate the
    // image now — gen costs $0.14 each and most drafts won't be approved.
    void preClassifyImage(db, settings, created.id, draft.draft_body);
  }

  markSourceScanned(db, source.id, {
    sinceId: newestSeen,
    status: `ok[${accessMode}]:${outcome.drafts_created}/${outcome.scored}`,
  });
  return outcome;
}

/**
 * Fire-and-forget image suggestion: classify what kind of visual would suit
 * the draft (none / diagram / illustration / photo) and a candidate prompt.
 * Result lands in `image_plan_json` so the UI shows the suggestion + a
 * 1-click gen button. Errors are swallowed — pre-classification is a UX
 * nicety, not load-bearing.
 */
async function preClassifyImage(
  db: import('bun:sqlite').Database,
  settings: Settings,
  draftId: string,
  body: string,
): Promise<void> {
  try {
    const plan = await classifyImageNeed(db, settings, draftId, body);
    if (plan.kind !== 'none') {
      updateDraftBody(db, draftId, {
        image_plan: { kind: plan.kind, prompt: plan.prompt, reason: plan.reason, suggested: true },
      });
    }
  } catch (error) {
    console.warn(`[presenceReddit] image pre-classify failed for ${draftId}: ${String(error)}`);
  }
}
