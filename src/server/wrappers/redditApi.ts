import { keychain } from '../lib/keychain';

/**
 * Reddit API wrapper — script-type OAuth2 flow.
 *
 * Why script-type and not installed/web app: it's the only flow designed for a
 * single user running their own app. No redirect dance, no 2-legged refresh
 * drama. User registers an app at https://www.reddit.com/prefs/apps (type
 * "script"), gets a client_id + client_secret pair, and we trade their
 * username+password for a short-lived access token. Tokens last 1 h; we cache
 * in-memory with a 60 s safety margin.
 *
 * Credential storage: the 4 required fields live in macOS Keychain under
 * `vibecode-dash`, account prefix `reddit:`:
 *   reddit:client_id      → app's client_id (Reddit calls it "personal use script")
 *   reddit:client_secret  → app's secret
 *   reddit:username       → the Reddit username
 *   reddit:password       → the account password (or app password if 2FA)
 *
 * Rate limit: Reddit gives authenticated OAuth clients 100 QPM (queries per
 * minute, burst-averaged). We don't enforce a global semaphore because our
 * scanner cadence is far below that, but we surface rate-limit headers so the
 * scheduler's backoff catches 429s naturally.
 */

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const API_BASE = 'https://oauth.reddit.com';
const PUBLIC_BASE = 'https://www.reddit.com';
const USER_AGENT = 'vibecode-dash:presence-copilot:v1 (by /u/vibecode-dash)';

/**
 * Public-read fallback. When the user hasn't (or can't) configure script-type
 * OAuth creds, listings still work via the public `.json` endpoints. They
 * return the same payload shape as the authenticated endpoints, just rate-
 * limited (~10 req/min unauth) and missing a few fields like vote ratio when
 * the author has opted out. Engagement polling on the user's own posts still
 * needs OAuth (private metrics aren't exposed publicly), so we keep both
 * paths and route per-call based on `redditIsConnected()`.
 */

type RedditCreds = {
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
};

let cachedToken: { token: string; expiresAt: number } | null = null;

async function loadCreds(): Promise<RedditCreds> {
  try {
    const [clientId, clientSecret, username, password] = await Promise.all([
      keychain.get('reddit:client_id'),
      keychain.get('reddit:client_secret'),
      keychain.get('reddit:username'),
      keychain.get('reddit:password'),
    ]);
    return { clientId, clientSecret, username, password };
  } catch (error) {
    throw new Error(
      `Reddit credentials missing in Keychain — connect via /presence settings first (${String(error)})`,
    );
  }
}

async function fetchAccessToken(): Promise<string> {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) {
    return cachedToken.token;
  }
  const creds = await loadCreds();
  const basic = Buffer.from(`${creds.clientId}:${creds.clientSecret}`).toString('base64');
  const body = new URLSearchParams({
    grant_type: 'password',
    username: creds.username,
    password: creds.password,
  });
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Reddit token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number; error?: string };
  if (!json.access_token) {
    throw new Error(`Reddit token response missing access_token: ${json.error ?? 'unknown'}`);
  }
  const ttlSec = Number(json.expires_in ?? 3600);
  cachedToken = {
    token: json.access_token,
    expiresAt: Date.now() + ttlSec * 1000,
  };
  return json.access_token;
}

export async function redditIsConnected(): Promise<boolean> {
  try {
    await loadCreds();
    return true;
  } catch {
    return false;
  }
}

export async function saveRedditCreds(creds: RedditCreds): Promise<void> {
  await Promise.all([
    keychain.set('reddit:client_id', creds.clientId),
    keychain.set('reddit:client_secret', creds.clientSecret),
    keychain.set('reddit:username', creds.username),
    keychain.set('reddit:password', creds.password),
  ]);
  cachedToken = null; // force next fetch to use the new creds
}

export async function deleteRedditCreds(): Promise<void> {
  await Promise.all([
    keychain.delete('reddit:client_id'),
    keychain.delete('reddit:client_secret'),
    keychain.delete('reddit:username'),
    keychain.delete('reddit:password'),
  ]);
  cachedToken = null;
}

export async function redditWhoami(): Promise<{
  name: string;
  link_karma: number;
  comment_karma: number;
}> {
  const row = await redditGet<{ name: string; link_karma: number; comment_karma: number }>(
    '/api/v1/me',
    {},
    { requireAuth: true },
  );
  return row;
}

// ───────────────────────── Core request ─────────────────────────

async function redditAuthGet<T>(
  path: string,
  query: Record<string, string | number> = {},
): Promise<T> {
  const token = await fetchAccessToken();
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': USER_AGENT,
    },
  });
  if (res.status === 429) {
    throw new Error('Reddit 429 rate-limited — scheduler backoff will retry');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Reddit GET ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/**
 * Unauthenticated read against the public `.json` endpoints. Used when the
 * user hasn't configured OAuth creds. Reddit caps unauth callers at ~10
 * req/min per IP — listings on a few subreddits stay well under that.
 */
async function redditPublicGet<T>(
  path: string,
  query: Record<string, string | number> = {},
): Promise<T> {
  const url = new URL(`${PUBLIC_BASE + path}.json`);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), {
    headers: { 'User-Agent': USER_AGENT },
  });
  if (res.status === 429) {
    throw new Error('Reddit (public) 429 rate-limited — try again later');
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Reddit public GET ${path} failed (${res.status}): ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

/**
 * Smart dispatcher: prefer authenticated when creds are present (richer
 * data, higher rate limit), fall back to public reads otherwise. The
 * `requireAuth` flag forces the auth path for endpoints that have no
 * public equivalent (e.g. /api/v1/me, private user metrics).
 */
async function redditGet<T>(
  path: string,
  query: Record<string, string | number> = {},
  opts: { requireAuth?: boolean } = {},
): Promise<T> {
  const authed = await redditIsConnected();
  if (authed) return redditAuthGet<T>(path, query);
  if (opts.requireAuth) {
    throw new Error('Reddit not connected — this endpoint requires OAuth');
  }
  return redditPublicGet<T>(path, query);
}

export async function redditAccessMode(): Promise<'oauth' | 'public'> {
  return (await redditIsConnected()) ? 'oauth' : 'public';
}

// ───────────────────────── Listing models ─────────────────────────

export type RedditPost = {
  id: string; // t3_xxx base36
  name: string; // with `t3_` prefix
  subreddit: string;
  author: string;
  title: string;
  selftext: string;
  url: string;
  permalink: string; // relative, prepend https://reddit.com
  score: number;
  upvote_ratio: number;
  num_comments: number;
  created_utc: number;
  link_flair_text: string | null;
  over_18: boolean;
  stickied: boolean;
};

export type RedditComment = {
  id: string;
  author: string;
  body: string;
  score: number;
  created_utc: number;
  permalink: string;
  /**
   * Direct reply count on this comment, derived from the `replies` Listing
   * in the public permalink JSON. Reddit doesn't expose a `num_replies`
   * field directly — when the comment has no replies, the API returns
   * `replies: ""` (empty string instead of an empty Listing). When there
   * are replies, `replies.data.children.length` gives the count of
   * top-level direct replies (not the full subtree depth).
   *
   * Note: only filled by `fetchPermalinkPublic` (the public scrape path).
   * The OAuth-authenticated `/api/info` endpoint doesn't return the
   * replies subtree, so callers using the auth path get null here.
   */
  reply_count?: number | null;
};

type ListingResponse<T> = {
  data: {
    after: string | null;
    before: string | null;
    children: Array<{ kind: string; data: T }>;
  };
};

function mapPost(raw: Record<string, unknown>): RedditPost {
  return {
    id: String(raw.id ?? ''),
    name: String(raw.name ?? ''),
    subreddit: String(raw.subreddit ?? ''),
    author: String(raw.author ?? ''),
    title: String(raw.title ?? ''),
    selftext: String(raw.selftext ?? ''),
    url: String(raw.url ?? ''),
    permalink: String(raw.permalink ?? ''),
    score: Number(raw.score ?? 0),
    upvote_ratio: Number(raw.upvote_ratio ?? 0),
    num_comments: Number(raw.num_comments ?? 0),
    created_utc: Number(raw.created_utc ?? 0),
    link_flair_text: raw.link_flair_text == null ? null : String(raw.link_flair_text),
    over_18: Boolean(raw.over_18),
    stickied: Boolean(raw.stickied),
  };
}

export async function listSubredditHot(
  sub: string,
  opts: { limit?: number; before?: string | null } = {},
): Promise<{ posts: RedditPost[]; after: string | null }> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
  const query: Record<string, string | number> = { limit };
  if (opts.before) query.before = opts.before;
  const res = await redditGet<ListingResponse<Record<string, unknown>>>(
    `/r/${encodeURIComponent(sub)}/hot`,
    query,
  );
  const posts = (res.data?.children ?? [])
    .map((c) => mapPost(c.data))
    .filter((p) => !p.stickied && !p.over_18);
  return { posts, after: res.data?.after ?? null };
}

export async function listSubredditNew(
  sub: string,
  opts: { limit?: number; before?: string | null } = {},
): Promise<{ posts: RedditPost[]; after: string | null }> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
  const query: Record<string, string | number> = { limit };
  if (opts.before) query.before = opts.before;
  const res = await redditGet<ListingResponse<Record<string, unknown>>>(
    `/r/${encodeURIComponent(sub)}/new`,
    query,
  );
  const posts = (res.data?.children ?? [])
    .map((c) => mapPost(c.data))
    .filter((p) => !p.stickied && !p.over_18);
  return { posts, after: res.data?.after ?? null };
}

export async function listUserSubmitted(
  username: string,
  opts: { limit?: number } = {},
): Promise<RedditPost[]> {
  const limit = Math.min(100, Math.max(1, opts.limit ?? 25));
  const res = await redditGet<ListingResponse<Record<string, unknown>>>(
    `/user/${encodeURIComponent(username)}/submitted`,
    { limit },
  );
  return (res.data?.children ?? []).map((c) => mapPost(c.data));
}

// ───────────────────────── Engagement metrics ─────────────────────────

/**
 * Look up a previously-posted item by its permalink or thing id (t1_* comment
 * or t3_* post). Returns the latest score + reply count so the engagement
 * poller can snapshot it at t+1h / t+24h / t+7d.
 *
 * The `/api/info?id=t3_xxx,t1_yyy` endpoint supports both types in one call
 * and returns empty `children` for deleted items — we expose that as null.
 */
export async function fetchThingById(
  fullname: string,
): Promise<
  | { kind: 'post'; post: RedditPost }
  | { kind: 'comment'; comment: RedditComment & { link_title?: string } }
  | null
> {
  // /api/info works unauth too — public exposure of public posts/comments.
  const res = await redditGet<ListingResponse<Record<string, unknown>>>('/api/info', {
    id: fullname,
  });
  const child = res.data?.children?.[0];
  if (!child) return null;
  if (child.kind === 't3') {
    return { kind: 'post', post: mapPost(child.data) };
  }
  if (child.kind === 't1') {
    const raw = child.data;
    return {
      kind: 'comment',
      comment: {
        id: String(raw.id ?? ''),
        author: String(raw.author ?? ''),
        body: String(raw.body ?? ''),
        score: Number(raw.score ?? 0),
        created_utc: Number(raw.created_utc ?? 0),
        permalink: String(raw.permalink ?? ''),
      },
    };
  }
  return null;
}

/**
 * Public scrape of a Reddit permalink. Used by the engagement poller when
 * the user hasn't configured OAuth — the JSON variant of the permalink URL
 * returns the post + comment tree as plain JSON, with score, num_comments,
 * upvote_ratio etc. all readable. Rate limit ≈ 10 req/min unauth, well
 * within scope for ~3 snapshots per posted draft.
 *
 * Returns the same shape as `fetchThingById` so the poller can treat both
 * sources interchangeably. Resolves null if the permalink is malformed,
 * the post was deleted, or the public endpoint blocked the request.
 */
export async function fetchPermalinkPublic(
  permalink: string,
): Promise<
  { kind: 'post'; post: RedditPost } | { kind: 'comment'; comment: RedditComment } | null
> {
  // Reddit's public JSON variant: append `.json` to any permalink URL.
  // CRITICAL: strip the query string BEFORE appending `.json`, otherwise
  // a share-link URL like `…/comment/abc/?utm_source=share&…&utm_content=
  // share_button` becomes `…/?utm_source=…share_button.json` which Reddit
  // returns 404 for. Also drop any trailing fragment for the same reason.
  const cleanPath = permalink
    .replace(/^https?:\/\/[^/]+/, '')
    .replace(/[?#].*$/, '')
    .replace(/\/$/, '');
  const url = `${PUBLIC_BASE}${cleanPath}.json`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  } catch (error) {
    throw new Error(`Reddit public permalink fetch failed: ${String(error)}`);
  }
  if (res.status === 429) throw new Error('Reddit (public) 429 rate-limited');
  if (!res.ok) return null;

  // Permalink JSON is a 2-element array: [postListing, commentListing].
  // For a post-only permalink, [0] is the post; for a comment permalink,
  // [1].data.children[0] is the targeted comment.
  const body = (await res.json().catch(() => null)) as Array<
    ListingResponse<Record<string, unknown>>
  > | null;
  if (!Array.isArray(body) || body.length === 0) return null;

  // Distinguish post-only vs comment permalink by the URL shape: if the path
  // ends with /<commentid>/ (>4 chars), it's a comment.
  const parts = cleanPath.split('/').filter(Boolean);
  const ci = parts.indexOf('comments');
  const isComment = ci > -1 && parts.length >= ci + 4 && parts[ci + 3].length >= 4;

  if (isComment) {
    const commentChild = body[1]?.data?.children?.[0];
    if (!commentChild || commentChild.kind !== 't1') return null;
    const raw = commentChild.data;
    // Reddit returns `replies: ""` (empty string) when the comment has no
    // direct replies, OR a Listing object with children. Anything else =
    // null (we couldn't infer). The count is the direct depth-1 reply
    // count, not the full subtree size — that's what most users mean by
    // "how many replies on my comment" anyway.
    let reply_count: number | null = null;
    const replies = (raw as { replies?: unknown }).replies;
    if (replies === '' || replies === null || replies == null) {
      reply_count = 0;
    } else if (
      typeof replies === 'object' &&
      replies !== null &&
      'data' in replies &&
      typeof (replies as { data?: unknown }).data === 'object'
    ) {
      const data = (replies as { data: { children?: unknown } }).data;
      if (Array.isArray(data.children)) {
        // Children include `more` markers (for "load more comments") that
        // aren't real replies; count only `t1` (real comments).
        reply_count = data.children.filter(
          (c: unknown): c is { kind: string } =>
            typeof c === 'object' && c !== null && (c as { kind?: unknown }).kind === 't1',
        ).length;
      }
    }
    return {
      kind: 'comment',
      comment: {
        id: String(raw.id ?? ''),
        author: String(raw.author ?? ''),
        body: String(raw.body ?? ''),
        score: Number(raw.score ?? 0),
        created_utc: Number(raw.created_utc ?? 0),
        permalink: String(raw.permalink ?? ''),
        reply_count,
      },
    };
  }

  const postChild = body[0]?.data?.children?.[0];
  if (!postChild || postChild.kind !== 't3') return null;
  return { kind: 'post', post: mapPost(postChild.data) };
}

/**
 * Lightweight existence + state check for a subreddit. Hits the public
 * `/r/{name}/about.json` endpoint which works without auth, returns ~3 KB
 * of metadata for public subs, a 404 for non-existent ones, a 403 for
 * banned ones, and a `reason: private` payload for private subs.
 *
 * Used at POST /sources time to refuse dead/non-existent subs upfront, and
 * by the validate-all sweeper to flip already-broken sources to inactive.
 *
 * Cost: zero. Rate limit: shared with public reads (~10 req/min unauth).
 */
export type SubredditValidation =
  | { status: 'valid'; subscribers: number; over_18: boolean; quarantine: boolean }
  | { status: 'not_found' }
  | { status: 'private' }
  | { status: 'banned' }
  | { status: 'invalid_format'; details: string }
  | { status: 'error'; details: string };

export async function validateSubreddit(name: string): Promise<SubredditValidation> {
  // Strip leading 'r/' or '/r/' the user may have pasted, normalise case
  // (Reddit slugs are case-insensitive; we keep the canonical form
  // returned by the API for display).
  const slug = name.replace(/^\/?r\//i, '').trim();
  if (!slug || !/^[A-Za-z0-9_]{1,21}$/.test(slug)) {
    return {
      status: 'invalid_format',
      details: `Reddit subs are 1-21 alphanumeric/underscore characters: "${name}"`,
    };
  }
  const url = `${PUBLIC_BASE}/r/${slug}/about.json`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  } catch (error) {
    return { status: 'error', details: String(error).slice(0, 200) };
  }
  if (res.status === 404) return { status: 'not_found' };
  if (res.status === 403) return { status: 'banned' };
  if (res.status === 429) return { status: 'error', details: 'rate-limited' };
  if (!res.ok) {
    return { status: 'error', details: `HTTP ${res.status}` };
  }
  const json = (await res.json().catch(() => null)) as {
    kind?: string;
    data?: { subscribers?: number; over18?: boolean; quarantine?: boolean };
    reason?: string;
  } | null;
  if (!json) return { status: 'error', details: 'malformed JSON' };
  // Reddit returns 200 with a `reason: private` body for private subs.
  if (json.reason === 'private') return { status: 'private' };
  if (json.reason === 'banned') return { status: 'banned' };
  // Listing kind 'Listing' (with no children) means the slug doesn't exist
  // even though Reddit returns 200. Detect it by absence of subreddit data.
  if (!json.data || typeof json.data.subscribers !== 'number') {
    return { status: 'not_found' };
  }
  return {
    status: 'valid',
    subscribers: json.data.subscribers,
    over_18: Boolean(json.data.over18),
    quarantine: Boolean(json.data.quarantine),
  };
}

/**
 * Pull the textual sidebar description for a subreddit so the discovery
 * pass can scan it for `r/foo` cross-references. Reddit exposes the
 * sidebar in two complementary places:
 *
 *   - `/about.json` → `data.description` (raw markdown). Most subs
 *     link to siblings/relatives here as `[r/foo](/r/foo)` or just `r/foo`.
 *   - `/api/widgets.json` → returns structured sidebar widgets including
 *     `community-list` (curated relatives) and `id-card` widgets. Richer
 *     when the sub maintains it; many older subs ignore the widget UI.
 *
 * We pull both and merge. Returns `null` if the sub doesn't exist or the
 * fetch fails — the caller (discovery) just skips it.
 */
export type SubredditDescriptionPayload = {
  description: string; // raw markdown from about.json
  widget_communities: string[]; // sub slugs from community-list widgets
};

export async function getSubredditDescription(
  name: string,
): Promise<SubredditDescriptionPayload | null> {
  const slug = name.replace(/^\/?r\//i, '').trim();
  if (!slug || !/^[A-Za-z0-9_]{1,21}$/.test(slug)) return null;

  // /about.json — for the description markdown.
  let description = '';
  try {
    const aboutRes = await fetch(`${PUBLIC_BASE}/r/${slug}/about.json`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (aboutRes.ok) {
      const j = (await aboutRes.json().catch(() => null)) as {
        data?: { description?: string };
      } | null;
      description = j?.data?.description || '';
    }
  } catch {
    /* network error → empty description, widgets pass may still succeed */
  }

  // /api/widgets.json — for community-list widgets (structured related subs).
  // Note: this endpoint requires the `?subreddit=...` shape via the OAuth
  // path; the public route is `/r/{name}/widgets.json` (yes, no /api/).
  // Many subs still return 404 on the public version, that's fine.
  const widget_communities: string[] = [];
  try {
    const wRes = await fetch(`${PUBLIC_BASE}/r/${slug}/widgets.json`, {
      headers: { 'User-Agent': USER_AGENT },
    });
    if (wRes.ok) {
      type WidgetData = {
        items?: { kind?: string; subreddit?: string; name?: string }[];
        kind?: string;
      };
      const wJson = (await wRes.json().catch(() => null)) as {
        items?: Record<string, WidgetData>;
      } | null;
      const items = wJson?.items ?? {};
      for (const w of Object.values(items)) {
        if (w.kind === 'community-list' && Array.isArray(w.items)) {
          for (const it of w.items) {
            const subName = (it.subreddit || it.name || '').toString();
            if (subName && /^[A-Za-z0-9_]{1,21}$/.test(subName)) {
              widget_communities.push(subName);
            }
          }
        }
      }
    }
  } catch {
    /* widgets pass failed → keep description-only */
  }

  return { description, widget_communities };
}

/**
 * Validate that a Reddit username exists. Same idea as validateSubreddit
 * against `/user/{name}/about.json`.
 */
export async function validateRedditUser(name: string): Promise<{
  status: 'valid' | 'not_found' | 'banned' | 'invalid_format' | 'error';
  details?: string;
}> {
  const slug = name.replace(/^u\//i, '').trim();
  if (!slug || !/^[A-Za-z0-9_-]{1,20}$/.test(slug)) {
    return {
      status: 'invalid_format',
      details: `Reddit usernames are 1-20 alphanumeric/underscore/dash characters: "${name}"`,
    };
  }
  const url = `${PUBLIC_BASE}/user/${slug}/about.json`;
  let res: Response;
  try {
    res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });
  } catch (error) {
    return { status: 'error', details: String(error).slice(0, 200) };
  }
  if (res.status === 404) return { status: 'not_found' };
  if (res.status === 403) return { status: 'banned' };
  if (!res.ok) return { status: 'error', details: `HTTP ${res.status}` };
  const json = (await res.json().catch(() => null)) as { data?: { id?: string } } | null;
  if (!json?.data?.id) return { status: 'not_found' };
  return { status: 'valid' };
}

/**
 * Parse a Reddit permalink like `/r/SubName/comments/postid/slug/commentid/`
 * back into a `t1_` or `t3_` fullname. Returns null if the URL is malformed.
 */
export function permalinkToFullname(permalink: string): string | null {
  const path = permalink.replace(/^https?:\/\/[^/]+/, '').replace(/\/$/, '');
  const parts = path.split('/').filter(Boolean);
  // Shape: r / sub / comments / postid / slug [ / commentid ]
  const ci = parts.indexOf('comments');
  if (ci < 0 || ci + 1 >= parts.length) return null;
  const postId = parts[ci + 1];
  const commentId = parts[ci + 3] ?? null;
  if (commentId && commentId.length >= 4) return `t1_${commentId}`;
  if (postId) return `t3_${postId}`;
  return null;
}
