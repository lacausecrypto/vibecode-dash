import type { Database } from 'bun:sqlite';
import type { Settings } from '../config';
import {
  type PresenceSourceRow,
  createDraft,
  markSourceScanned,
  recordCost,
  updateDraftBody,
} from '../lib/presence';
import { classifyImageNeed, generateDraft, scoreCandidate } from '../lib/presenceDrafter';
import {
  type XTweet,
  buildTopicQuery,
  getListTimeline,
  getUserTimeline,
  searchRecent,
  xIsConnected,
} from '../wrappers/xApi';

/**
 * X scanner — PAYG-conscious funnel.
 *
 * Reads cost $. Every call records to presence_cost_ledger so the stats view
 * shows where the budget goes. The per-read unit cost comes from
 * `settings.presence.xReadCostUsd` (default $0.017, observed on Basic tier);
 * pass a different value to honour tier changes.
 *
 * Strategy per source kind:
 *   - x_list  → GET /2/lists/:id/tweets  (1 call, up to 100 tweets)
 *   - x_user  → GET /2/users/:id/tweets  (1 call, up to 100 tweets)
 *   - x_topic → GET /2/tweets/search/recent with `-is:retweet -is:reply lang:en`
 *
 * The scanner NEVER fetches conversation threads on its own — that's a
 * separate expansion only triggered once a candidate passes scoring, to
 * avoid spending reads on threads that won't convert.
 */
const SCORE_THRESHOLD = 0.7; // X is costlier than Reddit, we raise the bar
const MIN_TWEET_AGE_SEC = 120;
const MAX_TWEET_AGE_SEC = 24 * 3600;
const MAX_CANDIDATES_PER_SOURCE = 15;

export type XScanOutcome = {
  source_id: string;
  reads: number;
  candidates_seen: number;
  scored: number;
  drafts_created: number;
  skipped_duplicate: number;
  skipped_low_score: number;
  skipped_no_draft: number;
  cost_usd: number;
  error?: string;
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function rowExistsForTweet(db: Database, tweetId: string): boolean {
  const row = db
    .query<{ id: string }, [string, string]>(
      'SELECT id FROM presence_drafts WHERE platform = ? AND external_thread_id = ? LIMIT 1',
    )
    .get('x', tweetId);
  return Boolean(row);
}

function tweetToCandidate(t: XTweet) {
  return {
    platform: 'x' as const,
    thread: {
      author: t.author_username,
      title: undefined,
      body: t.text,
      score: t.public_metrics.like_count,
      url: `https://x.com/${t.author_username ?? 'i'}/status/${t.id}`,
      created_utc: Math.floor(new Date(t.created_at).getTime() / 1000),
    },
    preferredFormat: 'reply' as const,
  };
}

async function fetchTweets(
  source: PresenceSourceRow,
): Promise<{ tweets: XTweet[]; reads: number }> {
  const id = source.identifier.trim();
  if (source.kind === 'x_list') {
    return { tweets: await getListTimeline(id, { maxResults: 50 }), reads: 1 };
  }
  if (source.kind === 'x_user') {
    return { tweets: await getUserTimeline(id, { maxResults: 20 }), reads: 1 };
  }
  if (source.kind === 'x_topic') {
    // No min_faves: that operator requires Pro tier. Relevance scorer
    // (Haiku) filters low-value tweets cheaply enough on Basic tier.
    const query = buildTopicQuery(id, { lang: 'en' });
    return { tweets: await searchRecent(query, { maxResults: 25 }), reads: 1 };
  }
  return { tweets: [], reads: 0 };
}

export async function scanXSource(
  db: Database,
  settings: Settings,
  source: PresenceSourceRow,
): Promise<XScanOutcome> {
  const outcome: XScanOutcome = {
    source_id: source.id,
    reads: 0,
    candidates_seen: 0,
    scored: 0,
    drafts_created: 0,
    skipped_duplicate: 0,
    skipped_low_score: 0,
    skipped_no_draft: 0,
    cost_usd: 0,
  };

  if (!(await xIsConnected())) {
    outcome.error = 'x_not_connected';
    markSourceScanned(db, source.id, { status: 'not_connected' });
    return outcome;
  }

  let fetched: { tweets: XTweet[]; reads: number };
  try {
    fetched = await fetchTweets(source);
  } catch (error) {
    outcome.error = String(error).slice(0, 300);
    markSourceScanned(db, source.id, { status: `error:${outcome.error}` });
    return outcome;
  }

  outcome.reads = fetched.reads;
  outcome.candidates_seen = fetched.tweets.length;
  const unitCostUsd = settings.presence?.xReadCostUsd ?? 0.017;
  outcome.cost_usd = fetched.reads * unitCostUsd;

  recordCost(db, {
    service: 'x_api',
    operation: 'scan',
    units: fetched.reads,
    unit_cost_usd: unitCostUsd,
    total_usd: outcome.cost_usd,
    meta: { source_id: source.id, kind: source.kind },
  });

  const now = nowSec();
  const ttlSec = source.freshness_ttl_minutes * 60;

  const fresh = fetched.tweets.filter((t) => {
    const createdSec = Math.floor(new Date(t.created_at).getTime() / 1000);
    const age = now - createdSec;
    if (age < MIN_TWEET_AGE_SEC || age > MAX_TWEET_AGE_SEC) return false;
    // skip retweets/replies even if the API didn't filter them for us
    if (t.referenced_tweets?.some((r) => r.type === 'retweeted')) return false;
    // Engagement threshold is a coarse pre-filter (kills bots / 0-interaction
    // throwaways). The real noise filter is the Claude scorer downstream — we
    // intentionally let low-engagement tweets through when the topic is niche
    // (Basic tier can't apply min_faves operator at the API level).
    return t.public_metrics.like_count >= 1 || t.public_metrics.reply_count >= 1;
  });

  const candidates = fresh.slice(0, MAX_CANDIDATES_PER_SOURCE);

  for (const tweet of candidates) {
    if (rowExistsForTweet(db, tweet.id)) {
      outcome.skipped_duplicate += 1;
      continue;
    }

    const candidate = tweetToCandidate(tweet);
    const scored = await scoreCandidate(db, settings, candidate);
    outcome.scored += 1;
    if (scored.score < SCORE_THRESHOLD) {
      outcome.skipped_low_score += 1;
      continue;
    }

    let draft: Awaited<ReturnType<typeof generateDraft>>;
    try {
      draft = await generateDraft(db, settings, candidate, scored.score);
    } catch (error) {
      outcome.skipped_no_draft += 1;
      console.warn(`[presenceX] draft failed for ${tweet.id}: ${String(error)}`);
      continue;
    }

    if (!draft.draft_body || draft.draft_body.length < 20 || draft.score < SCORE_THRESHOLD) {
      outcome.skipped_no_draft += 1;
      continue;
    }

    const created = createDraft(db, {
      platform: 'x',
      source_id: source.id,
      external_thread_id: tweet.id,
      external_thread_url: candidate.thread.url ?? null,
      thread_snapshot: {
        author: tweet.author_username,
        author_id: tweet.author_id,
        body: tweet.text,
        created_utc: candidate.thread.created_utc,
        public_metrics: tweet.public_metrics,
        conversation_id: tweet.conversation_id,
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

    // Pre-classify image (suggestion only, no generation — see Reddit scanner).
    void (async () => {
      try {
        const plan = await classifyImageNeed(db, settings, created.id, draft.draft_body);
        if (plan.kind !== 'none') {
          updateDraftBody(db, created.id, {
            image_plan: {
              kind: plan.kind,
              prompt: plan.prompt,
              reason: plan.reason,
              suggested: true,
            },
          });
        }
      } catch (error) {
        console.warn(`[presenceX] image pre-classify failed for ${created.id}: ${String(error)}`);
      }
    })();
  }

  markSourceScanned(db, source.id, {
    status: `ok:${outcome.drafts_created}/${outcome.scored}`,
  });
  return outcome;
}
