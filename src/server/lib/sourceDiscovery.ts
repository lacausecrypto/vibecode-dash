import type { Database } from 'bun:sqlite';
import { getSubredditDescription } from '../wrappers/redditApi';
import { extractFromHandles } from '../wrappers/xApi';
import type { PresenceSourceRow } from './presence';

/**
 * Pack D — Graph-based source discovery.
 *
 * Reddit: each active subreddit's sidebar (about.json description +
 * widgets.json community-list) lists related communities. We aggregate
 * `r/foo` mentions across every active reddit source, dedupe against
 * what's already in DB, and rank by frequency. Sub mentioned by 3 of
 * your sources outranks one mentioned by 1.
 *
 * X: no equivalent free graph endpoint, but we can do co-citation: any
 * `@handle` that shows up across multiple recent high-score drafts
 * (that we've actually engaged with) is a candidate worth following
 * directly. Pulled from `presence_drafts.thread_snapshot_json`.
 *
 * Cost: zero. Reddit hits the same /about.json + /widgets.json endpoints
 * we use elsewhere; X reads only from local DB. The discovery pass is
 * throttled (200 ms between Reddit calls) to stay polite on public APIs.
 */

const STOP_HANDLES = new Set([
  // X system / internal / generic — never useful as a "follow this"
  'x',
  'twitter',
  'support',
  'twittersupport',
  'verified',
  'help',
  // Reddit internal (in case the regex slips into a reddit context)
  'reddit',
  'admin',
]);

export type DiscoverySuggestion = {
  platform: 'reddit' | 'x';
  /** Suggested kind: `subreddit` for reddit, `x_user` for X. */
  kind: 'subreddit' | 'x_user';
  /** Canonical identifier (sub name or @handle without @). */
  identifier: string;
  /** How many distinct existing sources / drafts surfaced this candidate. */
  count: number;
  /** Names of the existing sources or draft excerpts that mentioned it. */
  evidence: string[];
};

export type DiscoveryResult = {
  platform: 'reddit' | 'x';
  scanned: number;
  total: number;
  suggestions: DiscoverySuggestion[];
};

const REDDIT_THROTTLE_MS = 200;
const REDDIT_MAX_PER_SOURCE = 20;
const X_MIN_DRAFT_SCORE = 0.5;
const X_MAX_DRAFTS = 200;

function normalizeSlug(s: string): string {
  return s.toLowerCase().trim();
}

/**
 * Walk the `description` markdown for r/foo mentions. Reddit subs frequently
 * link to siblings as `[r/foo](...)`, `r/foo`, or `/r/foo`; the regex
 * captures all three. Word boundary anchors prevent matching strings like
 * `mr/important` or `our/team`.
 */
function extractSubredditMentions(text: string): string[] {
  const out: string[] = [];
  const re = /(?:^|[^A-Za-z0-9_])\/?r\/([A-Za-z0-9_]{3,21})\b/g;
  let m: RegExpExecArray | null;
  m = re.exec(text);
  while (m !== null) {
    out.push(m[1]);
    m = re.exec(text);
  }
  return out;
}

/**
 * Pull related-subreddit suggestions from every active reddit source.
 * Existing sources (active or not) are excluded from the result so we
 * never propose what you already track.
 */
export async function discoverRedditRelated(db: Database): Promise<DiscoveryResult> {
  const sources = db
    .query<PresenceSourceRow, []>(
      `SELECT * FROM presence_sources
        WHERE platform = 'reddit' AND kind = 'subreddit' AND active = 1`,
    )
    .all();

  // Existing identifiers (any state) so we don't re-suggest.
  const existing = new Set(
    db
      .query<{ identifier: string }, []>(
        `SELECT identifier FROM presence_sources WHERE platform = 'reddit' AND kind = 'subreddit'`,
      )
      .all()
      .map((r) => normalizeSlug(r.identifier)),
  );

  // Tally: subSlug → { count, evidence: Set of source labels that mentioned it }
  const tally = new Map<string, { count: number; evidence: Set<string> }>();

  for (let i = 0; i < sources.length; i++) {
    const s = sources[i];
    const payload = await getSubredditDescription(s.identifier);
    if (!payload) continue;

    // Merge description-extracted + widget-listed candidates, dedupe per
    // source so a sub mentioned 5x in a single description still counts as 1.
    const fromDesc = extractSubredditMentions(payload.description);
    const seen = new Set<string>();
    for (const slug of [...fromDesc, ...payload.widget_communities]) {
      const key = normalizeSlug(slug);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      if (existing.has(key)) continue;
      // Don't suggest the source's own identifier.
      if (key === normalizeSlug(s.identifier)) continue;

      const entry = tally.get(key) ?? { count: 0, evidence: new Set<string>() };
      entry.count += 1;
      entry.evidence.add(s.label || `r/${s.identifier}`);
      tally.set(key, entry);
    }

    if (i < sources.length - 1) {
      await new Promise((r) => setTimeout(r, REDDIT_THROTTLE_MS));
    }
  }

  const suggestions: DiscoverySuggestion[] = [...tally.entries()]
    .map(([identifier, v]) => ({
      platform: 'reddit' as const,
      kind: 'subreddit' as const,
      identifier,
      count: v.count,
      evidence: [...v.evidence].slice(0, 5),
    }))
    .sort((a, b) => b.count - a.count || a.identifier.localeCompare(b.identifier))
    .slice(0, REDDIT_MAX_PER_SOURCE * 5);

  return {
    platform: 'reddit',
    scanned: sources.length,
    total: suggestions.length,
    suggestions,
  };
}

/**
 * Co-citation discovery for X: scans recent high-score drafts for `@handle`
 * mentions in the thread snapshot, filters out handles already covered
 * by any active X source (whether x_user or x_topic with from: clauses),
 * and ranks by occurrence frequency.
 */
export function discoverXCoCited(db: Database): DiscoveryResult {
  const sinceSec = Math.floor(Date.now() / 1000) - 30 * 86400;

  // Build the "already covered" set from every X source's identifier:
  //   - x_user: identifier IS the handle.
  //   - x_topic: parse all `from:foo` operands.
  //   - x_list: nothing extractable.
  const xSources = db
    .query<{ kind: string; identifier: string }, []>(
      `SELECT kind, identifier FROM presence_sources WHERE platform = 'x'`,
    )
    .all();
  const covered = new Set<string>();
  for (const s of xSources) {
    if (s.kind === 'x_user') {
      covered.add(s.identifier.toLowerCase().replace(/^@/, ''));
    } else if (s.kind === 'x_topic') {
      for (const h of extractFromHandles(s.identifier)) {
        covered.add(h.toLowerCase());
      }
    }
  }

  // Pull recent drafts. We look at proposed/posted/viewed since dismissed
  // (ignored/rejected) drafts shouldn't influence what we discover.
  const drafts = db
    .query<{ id: string; thread_snapshot_json: string; relevance_score: number }, [number, number]>(
      `SELECT id, thread_snapshot_json, relevance_score
         FROM presence_drafts
        WHERE platform = 'x'
          AND created_at >= ?
          AND relevance_score >= ?
          AND status IN ('proposed','viewed','posted')
        ORDER BY relevance_score DESC
        LIMIT ${X_MAX_DRAFTS}`,
    )
    .all(sinceSec, X_MIN_DRAFT_SCORE);

  const tally = new Map<string, { count: number; evidence: Set<string> }>();
  // Match `@handle` with the same X handle constraints (1-15 alnum/underscore)
  // and a leading non-word boundary so we don't grab the middle of an email.
  const re = /(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_]{1,15})\b/g;

  for (const d of drafts) {
    const text = d.thread_snapshot_json || '';
    let m: RegExpExecArray | null = re.exec(text);
    const seen = new Set<string>();
    while (m !== null) {
      const handle = m[1].toLowerCase();
      if (handle && !seen.has(handle)) {
        seen.add(handle);
        if (!covered.has(handle) && !STOP_HANDLES.has(handle)) {
          const entry = tally.get(handle) ?? { count: 0, evidence: new Set<string>() };
          entry.count += 1;
          // Keep a draft id for the UI to link back to. Truncated for safety.
          entry.evidence.add(d.id.slice(0, 8));
          tally.set(handle, entry);
        }
      }
      m = re.exec(text);
    }
    re.lastIndex = 0;
  }

  // Require at least 2 distinct drafts before we propose — single-mention
  // handles are noise.
  const suggestions: DiscoverySuggestion[] = [...tally.entries()]
    .filter(([, v]) => v.count >= 2)
    .map(([identifier, v]) => ({
      platform: 'x' as const,
      kind: 'x_user' as const,
      identifier,
      count: v.count,
      evidence: [...v.evidence].slice(0, 5),
    }))
    .sort((a, b) => b.count - a.count || a.identifier.localeCompare(b.identifier))
    .slice(0, 50);

  return {
    platform: 'x',
    scanned: drafts.length,
    total: suggestions.length,
    suggestions,
  };
}
