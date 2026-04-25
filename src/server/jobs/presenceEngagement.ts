import type { Database } from 'bun:sqlite';
import type { PresenceEngagementTag } from '../lib/presence';
import { recordCost, recordEngagement } from '../lib/presence';
import type { RedditComment, RedditPost } from '../wrappers/redditApi';
import {
  fetchPermalinkPublic,
  fetchThingById,
  permalinkToFullname,
  redditIsConnected,
} from '../wrappers/redditApi';

type RedditThing = { kind: 'post'; post: RedditPost } | { kind: 'comment'; comment: RedditComment };
import { getTweetById, getTweetMetricsPublic, xIsConnected } from '../wrappers/xApi';

/**
 * Engagement poller — takes post-hoc snapshots of posted drafts.
 *
 * We snapshot each posted draft at three fixed offsets after `posted_at`:
 *
 *   t+1h   — early signal. Catches reply-guy success (or failure), X algo lift.
 *   t+24h  — stabilised. Past the noisy first hour, past the reply bubble.
 *   t+7d   — long-tail. Reddit threads keep accruing, X decays fast — both
 *            signals help calibrate the ROI scorer.
 *
 * Idempotency: the `presence_engagement_metrics` table has a UNIQUE
 * (draft_id, snapshot_tag) index and an UPSERT on write, so a poller re-run
 * within the window is a no-op — or better, refreshes a snapshot that missed
 * a transient API error the previous run. We pick the _due_ snapshot per
 * draft each tick by computing the expected window boundaries.
 */

const WINDOWS: { tag: PresenceEngagementTag; offsetSec: number; slackSec: number }[] = [
  { tag: 't+1h', offsetSec: 3600, slackSec: 30 * 60 }, // snapshot between t+1h and t+1h30
  { tag: 't+24h', offsetSec: 86400, slackSec: 2 * 3600 },
  { tag: 't+7d', offsetSec: 7 * 86400, slackSec: 12 * 3600 },
];

type DraftForPoll = {
  id: string;
  platform: 'reddit' | 'x';
  posted_at: number;
  posted_external_id: string | null;
  posted_external_url: string | null;
};

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * Select which snapshot tag (if any) is "due" for a draft right now.
 * Returns null if no snapshot window is currently open for this draft.
 * A window is "open" from posted_at + offsetSec to posted_at + offsetSec + slackSec.
 */
function dueSnapshot(draft: DraftForPoll): PresenceEngagementTag | null {
  const now = nowSec();
  for (const w of WINDOWS) {
    const windowStart = draft.posted_at + w.offsetSec;
    const windowEnd = windowStart + w.slackSec;
    if (now >= windowStart && now <= windowEnd) return w.tag;
  }
  return null;
}

function hasSnapshot(db: Database, draftId: string, tag: PresenceEngagementTag): boolean {
  const row = db
    .query<{ n: number }, [string, string]>(
      'SELECT COUNT(*) AS n FROM presence_engagement_metrics WHERE draft_id = ? AND snapshot_tag = ?',
    )
    .get(draftId, tag);
  return (row?.n ?? 0) > 0;
}

async function pollRedditDraft(
  db: Database,
  draft: DraftForPoll,
  tag: PresenceEngagementTag,
): Promise<void> {
  // Two read paths:
  //   - OAuth: /api/info?id=t3_xxx — needs auth, returns full data.
  //   - Public: GET https://reddit.com<permalink>.json — no auth, same data
  //     (score, num_comments, upvote_ratio). Rate limited ~10 req/min unauth,
  //     fine for our cadence.
  // We pick the OAuth path when available (richer + less rate-limit risk),
  // fall back to public so the poller works for users who can't / won't
  // register a Reddit app.
  const authed = await redditIsConnected();
  const fallbackPermalink = draft.posted_external_url ?? null;

  let thing: RedditThing | null = null;
  let mode: 'oauth' | 'public' = 'public';

  if (authed) {
    let fullname = draft.posted_external_id?.trim() || null;
    if (!fullname && fallbackPermalink) {
      fullname = permalinkToFullname(fallbackPermalink);
    }
    if (fullname) {
      const auth = await fetchThingById(fullname);
      // fetchThingById's comment shape includes link_title; trim back to the
      // strict RedditComment subset that matches the public path's return.
      if (auth?.kind === 'post') {
        thing = { kind: 'post', post: auth.post };
      } else if (auth?.kind === 'comment') {
        const { id, author, body, score, created_utc, permalink } = auth.comment;
        thing = {
          kind: 'comment',
          comment: { id, author, body, score, created_utc, permalink },
        };
      }
      mode = 'oauth';
    }
  }
  // If OAuth path didn't yield (no fullname, fetch failed) AND we have a
  // permalink, try public scrape. Public works on URLs alone.
  if (!thing && fallbackPermalink) {
    try {
      thing = await fetchPermalinkPublic(fallbackPermalink);
      mode = 'public';
    } catch (error) {
      console.warn(`[presenceEngagement] reddit public fetch failed: ${String(error)}`);
    }
  }

  if (!thing) {
    recordEngagement(db, {
      draft_id: draft.id,
      snapshot_tag: tag,
      likes: null,
      replies: null,
      raw: { status: 'not_found', mode },
    });
    return;
  }

  recordCost(db, {
    draft_id: draft.id,
    service: 'reddit_api',
    operation: 'engagement_poll',
    units: 1,
    total_usd: 0, // Reddit reads are free in both modes.
    meta: { tag, mode },
  });

  if (thing.kind === 'post') {
    recordEngagement(db, {
      draft_id: draft.id,
      snapshot_tag: tag,
      likes: thing.post.score,
      replies: thing.post.num_comments,
      ratio: thing.post.upvote_ratio,
      raw: { mode, ...thing.post },
    });
  } else {
    recordEngagement(db, {
      draft_id: draft.id,
      snapshot_tag: tag,
      likes: thing.comment.score,
      // Direct reply count when available (filled only by the public
      // permalink scrape; the OAuth path leaves it null because /api/info
      // doesn't return the replies subtree).
      replies: thing.comment.reply_count ?? null,
      raw: { mode, ...thing.comment },
    });
  }
}

async function pollXDraft(
  db: Database,
  draft: DraftForPoll,
  tag: PresenceEngagementTag,
): Promise<void> {
  const id = draft.posted_external_id?.trim() || null;
  if (!id) return;

  // Two read paths, picked dynamically per call:
  //   - bearer: official X API v2, costs 1 read (~$0.017 PAYG), returns
  //     full public_metrics including retweet_count + impression_count.
  //   - public: cdn.syndication.twimg.com, free, but only exposes
  //     favourite_count + conversation_count + sometimes view_count.
  // We prefer bearer when available (richer data, no resilience risk on
  // an undocumented CDN). Fall back to public if bearer is missing or
  // the bearer call returns null. Free path means no cost ledger row.
  const authed = await xIsConnected();
  let mode: 'bearer' | 'public' = 'public';
  let likes: number | null = null;
  let replies: number | null = null;
  let reposts: number | null = null;
  let impressions: number | null = null;
  let rawPayload: unknown = null;

  if (authed) {
    mode = 'bearer';
    const tweet = await getTweetById(id);
    const settings = await import('../config').then((m) => m.loadSettings());
    const unitCostUsd = settings.presence?.xReadCostUsd ?? 0.017;
    // X bills on endpoint hit regardless of result, so the ledger row
    // happens before we check the response.
    recordCost(db, {
      draft_id: draft.id,
      service: 'x_api',
      operation: 'engagement_poll',
      units: 1,
      unit_cost_usd: unitCostUsd,
      total_usd: unitCostUsd,
      meta: { tag, tweet_id: id, mode },
    });
    if (tweet) {
      likes = tweet.public_metrics.like_count;
      replies = tweet.public_metrics.reply_count;
      reposts = tweet.public_metrics.retweet_count;
      impressions = tweet.public_metrics.impression_count ?? null;
      rawPayload = { mode, ...tweet };
    }
  }

  // Public fallback: tried only if bearer didn't yield (no auth, or tweet
  // unreachable via API e.g. age-restricted). Free → no ledger row.
  if (!rawPayload) {
    try {
      const pub = await getTweetMetricsPublic(id);
      if (pub) {
        mode = 'public';
        likes = pub.favorite_count;
        // The syndication endpoint reports total conversation participants;
        // close enough to "replies" for our purposes (the user just wants
        // to know "did this thread get traction").
        replies = pub.conversation_count;
        impressions = pub.view_count;
        rawPayload = { mode, ...pub };
        // Public reads are free → record a $0 ledger row so the audit
        // trail still shows the call, with mode=public for traceability.
        recordCost(db, {
          draft_id: draft.id,
          service: 'x_api',
          operation: 'engagement_poll',
          units: 1,
          unit_cost_usd: 0,
          total_usd: 0,
          meta: { tag, tweet_id: id, mode: 'public' },
        });
      }
    } catch (error) {
      console.warn(`[presenceEngagement] x public fetch failed: ${String(error)}`);
    }
  }

  if (!rawPayload) {
    recordEngagement(db, {
      draft_id: draft.id,
      snapshot_tag: tag,
      likes: null,
      replies: null,
      raw: { status: 'not_found', id, mode },
    });
    return;
  }

  recordEngagement(db, {
    draft_id: draft.id,
    snapshot_tag: tag,
    likes,
    replies,
    reposts,
    impressions,
    raw: rawPayload,
  });
}

export type PollOutcome = {
  polled: number;
  /** Drafts whose first window has not yet opened — caller can show ETA. */
  pending: Array<{
    id: string;
    platform: 'reddit' | 'x';
    next_tag: PresenceEngagementTag;
    next_at: number; // unix seconds
    minutes_until: number;
  }>;
  /** Drafts that errored during the poll (per-draft details surface to the UI). */
  failed: Array<{ id: string; platform: 'reddit' | 'x'; reason: string }>;
};

/**
 * Compute when a draft's NEXT snapshot window opens. Used to give the user a
 * concrete ETA when a manual poll returns 0 because nothing is currently due.
 * Returns null only for drafts past all three windows + slack.
 */
function nextSnapshotEta(draft: DraftForPoll): { tag: PresenceEngagementTag; at: number } | null {
  const now = nowSec();
  for (const w of WINDOWS) {
    const windowStart = draft.posted_at + w.offsetSec;
    const windowEnd = windowStart + w.slackSec;
    if (now < windowStart) return { tag: w.tag, at: windowStart };
    // We're past windowStart but before windowEnd → window is open right now,
    // dueSnapshot would have caught it. If we're past windowEnd without a
    // snapshot, the auto poller missed it; treat the next window as the ETA.
    if (now > windowEnd) continue;
    return { tag: w.tag, at: windowStart };
  }
  return null;
}

/**
 * Main entry point. Walks all posted drafts and either:
 *   - Captures the currently-open window snapshot (auto path, default).
 *   - With `force: true` (manual "Poll now" click), captures live data
 *     immediately as a `manual` tag for any draft that has no open window.
 *     The `manual` tag is excluded from the t+1h/t+24h/t+7d aggregate so it
 *     doesn't pollute the time-series stats.
 *
 * Iteration, not batch, so one bad draft doesn't block the rest.
 */
export async function pollPresenceEngagement(
  db: Database,
  opts: { force?: boolean } = {},
): Promise<PollOutcome> {
  const force = opts.force === true;
  const now = nowSec();

  const candidates = db
    .query<DraftForPoll, []>(
      `SELECT id, platform, posted_at, posted_external_id, posted_external_url
         FROM presence_drafts
        WHERE status = 'posted'
          AND posted_at IS NOT NULL
          AND posted_at >= CAST(strftime('%s', 'now') AS INTEGER) - ${8 * 86400}`,
    )
    .all();

  const outcome: PollOutcome = { polled: 0, pending: [], failed: [] };

  for (const draft of candidates) {
    const dueTag = dueSnapshot(draft);
    let captureTag: PresenceEngagementTag | null = dueTag;

    // No window currently open. With force=true, capture as `manual` so
    // the user gets immediate feedback. Without force, surface the ETA so
    // the UI can tell the user when the next snapshot will land.
    if (!captureTag) {
      if (force) {
        // Skip if a manual snapshot was already captured very recently
        // (5 min cooldown) to avoid duplicate writes when the user spams
        // the button.
        const recent = db
          .query<{ at: number }, [string]>(
            `SELECT at FROM presence_engagement_metrics
              WHERE draft_id = ? AND snapshot_tag = 'manual'
              ORDER BY at DESC LIMIT 1`,
          )
          .get(draft.id);
        if (recent && now - recent.at < 5 * 60) continue;
        captureTag = 'manual';
      } else {
        const eta = nextSnapshotEta(draft);
        if (eta) {
          outcome.pending.push({
            id: draft.id,
            platform: draft.platform,
            next_tag: eta.tag,
            next_at: eta.at,
            minutes_until: Math.max(0, Math.round((eta.at - now) / 60)),
          });
        }
        continue;
      }
    }

    // Idempotency for the scheduled tags. The `manual` tag handles its own
    // cooldown above and uses ON CONFLICT to overwrite the previous manual
    // snapshot — manual is "the latest live read", not a permanent record.
    if (captureTag !== 'manual' && hasSnapshot(db, draft.id, captureTag)) continue;

    try {
      if (draft.platform === 'reddit') {
        await pollRedditDraft(db, draft, captureTag);
      } else if (draft.platform === 'x') {
        await pollXDraft(db, draft, captureTag);
      }
      outcome.polled += 1;
    } catch (error) {
      const reason = String(error).slice(0, 200);
      console.warn(`[presenceEngagement] poll ${draft.id} ${captureTag} failed: ${reason}`);
      outcome.failed.push({ id: draft.id, platform: draft.platform, reason });
    }
  }
  return outcome;
}
