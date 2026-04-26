import { createHmac, randomBytes } from 'node:crypto';
import { keychain } from '../lib/keychain';

/**
 * X (Twitter) API v2 wrapper.
 *
 * Two auth surfaces, on purpose:
 *
 *   READ path — OAuth 2.0 App-Only Bearer Token (`x:bearer` in keychain).
 *   Used for /2/lists/:id/tweets, /2/users/:id/tweets, /2/tweets/search/recent,
 *   /2/tweets/:id (engagement polling). Single token, no signing, fast to set up.
 *
 *   WRITE path — OAuth 1.0a User Context (4-key flow). Required for
 *   POST /2/tweets because /2/tweets does NOT accept App-Only Bearer.
 *   The user generates the four keys directly in their developer portal
 *   (no callback, no PKCE, no refresh) and stores them in the keychain:
 *     x:consumer_key            (= API Key)
 *     x:consumer_secret         (= API Key Secret)
 *     x:access_token            (= Access Token)
 *     x:access_token_secret     (= Access Token Secret)
 *   We sign each request with HMAC-SHA1 over the canonical base string
 *   (RFC 5849 §3.4.1). OAuth 1.0a is officially supported on /2/tweets
 *   per X devcom; sunset will be pre-announced.
 *
 * PAYG strategy (see presence/docs): we funnel scans to minimize reads:
 *   1. List timeline (cheapest, highest signal/noise)
 *   2. Targeted topic search with `min_faves:N -is:retweet`
 *   3. Conversation thread fetch only for top-scored candidates
 * Each read against an endpoint counts as one against the user's PAYG cap;
 * the wrapper itself is stateless — cost accounting lives in presence_cost_ledger.
 */

const API_BASE = 'https://api.x.com/2';

async function loadBearer(): Promise<string> {
  try {
    return await keychain.get('x:bearer');
  } catch (error) {
    throw new Error(
      `X bearer missing in Keychain — connect via /presence settings (${String(error)})`,
    );
  }
}

async function loadUsername(): Promise<string | null> {
  try {
    return await keychain.get('x:username');
  } catch {
    return null;
  }
}

export async function xIsConnected(): Promise<boolean> {
  try {
    await loadBearer();
    return true;
  } catch {
    return false;
  }
}

export async function saveXCreds(input: { bearer: string; username?: string }): Promise<void> {
  await keychain.set('x:bearer', input.bearer);
  if (input.username) await keychain.set('x:username', input.username);
}

export async function deleteXCreds(): Promise<void> {
  await Promise.all([keychain.delete('x:bearer'), keychain.delete('x:username')]);
}

// ───────────────────────── Core request ─────────────────────────

async function xGet<T>(path: string, query: Record<string, string | number> = {}): Promise<T> {
  const bearer = await loadBearer();
  const url = new URL(API_BASE + path);
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${bearer}`,
      'User-Agent': 'vibecode-dash/presence-copilot',
    },
  });
  if (res.status === 429) {
    // X returns x-rate-limit-reset as epoch seconds. We surface a clean error;
    // scheduler handles backoff. Cost is NOT billed for 429s.
    const reset = res.headers.get('x-rate-limit-reset');
    throw new Error(`X 429 rate-limited (reset at ${reset ?? 'unknown'})`);
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`X GET ${path} failed (${res.status}): ${text.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

// ───────────────────────── Models ─────────────────────────

export type XTweetAuthor = {
  /** Display name (e.g. "Sam Altman"). Optional — falls back to handle. */
  name?: string;
  /** Followers count. Proxy for reach / influence. May be 0 on private/new accounts. */
  followers_count: number;
  /** Self-described bio. Used to detect CEO/founder/researcher signals
   *  ("CEO of X", "Co-founder", "ML researcher at Y"). */
  description?: string;
  /** Has a paid blue check OR legacy verification. Both are imperfect signals
   *  (paid Blue does NOT mean notable), but verified=false rules out a chunk
   *  of bot/throwaway accounts. */
  verified?: boolean;
  /** Returned by user.fields=verified_type when present: 'blue' | 'business' |
   *  'government' | 'none'. Lets the scorer distinguish paid Blue (weak signal)
   *  from business/government verifications (strong signal). */
  verified_type?: 'blue' | 'business' | 'government' | 'none';
};

export type XTweet = {
  id: string;
  text: string;
  author_id: string;
  author_username?: string;
  /** Author profile data attached when the API request includes
   *  `user.fields=public_metrics,verified,verified_type,description`.
   *  Same X API call, no additional read cost — see TWEET_FIELDS / USER_FIELDS. */
  author?: XTweetAuthor;
  created_at: string; // ISO
  lang?: string;
  public_metrics: {
    retweet_count: number;
    reply_count: number;
    like_count: number;
    quote_count: number;
    bookmark_count?: number;
    impression_count?: number;
  };
  conversation_id?: string;
  in_reply_to_user_id?: string;
  referenced_tweets?: Array<{ type: string; id: string }>;
};

type TweetResponse = {
  data: Array<{
    id: string;
    text: string;
    author_id: string;
    created_at: string;
    lang?: string;
    public_metrics?: XTweet['public_metrics'];
    conversation_id?: string;
    in_reply_to_user_id?: string;
    referenced_tweets?: Array<{ type: string; id: string }>;
  }>;
  includes?: {
    users?: Array<{
      id: string;
      username: string;
      name: string;
      description?: string;
      verified?: boolean;
      verified_type?: 'blue' | 'business' | 'government' | 'none';
      public_metrics?: {
        followers_count?: number;
        following_count?: number;
        tweet_count?: number;
        listed_count?: number;
      };
    }>;
  };
  meta?: {
    result_count: number;
    next_token?: string;
    newest_id?: string;
    oldest_id?: string;
  };
};

const TWEET_FIELDS =
  'id,text,author_id,created_at,lang,public_metrics,conversation_id,in_reply_to_user_id,referenced_tweets';
const USER_FIELDS = 'public_metrics,verified,verified_type,description';
const EXPANSIONS = 'author_id';

function mergeAuthors(res: TweetResponse): XTweet[] {
  // Build author map from `includes.users` — same response, zero extra cost.
  // Without USER_FIELDS the public_metrics/verified/description blocks are
  // missing, but the scorer falls back to safe defaults (followers=0,
  // verified=undefined). Authors absent from `includes` (rare, but the API
  // does it for protected accounts) end up with `author=undefined`.
  const authorMap = new Map<string, XTweetAuthor & { username: string }>();
  for (const u of res.includes?.users ?? []) {
    authorMap.set(u.id, {
      name: u.name,
      followers_count: u.public_metrics?.followers_count ?? 0,
      description: u.description,
      verified: u.verified,
      verified_type: u.verified_type,
      username: u.username,
    });
  }

  return (res.data ?? []).map((t) => {
    const a = authorMap.get(t.author_id);
    return {
      id: t.id,
      text: t.text,
      author_id: t.author_id,
      author_username: a?.username,
      author: a
        ? {
            name: a.name,
            followers_count: a.followers_count,
            description: a.description,
            verified: a.verified,
            verified_type: a.verified_type,
          }
        : undefined,
      created_at: t.created_at,
      lang: t.lang,
      public_metrics: t.public_metrics ?? {
        retweet_count: 0,
        reply_count: 0,
        like_count: 0,
        quote_count: 0,
      },
      conversation_id: t.conversation_id,
      in_reply_to_user_id: t.in_reply_to_user_id,
      referenced_tweets: t.referenced_tweets,
    };
  });
}

// ───────────────────────── Read endpoints ─────────────────────────

export async function getListTimeline(
  listId: string,
  opts: { maxResults?: number } = {},
): Promise<XTweet[]> {
  const res = await xGet<TweetResponse>(`/lists/${encodeURIComponent(listId)}/tweets`, {
    max_results: Math.min(100, Math.max(5, opts.maxResults ?? 50)),
    'tweet.fields': TWEET_FIELDS,
    'user.fields': USER_FIELDS,
    expansions: EXPANSIONS,
  });
  return mergeAuthors(res);
}

export async function getUserTimeline(
  userId: string,
  opts: { maxResults?: number } = {},
): Promise<XTweet[]> {
  const res = await xGet<TweetResponse>(`/users/${encodeURIComponent(userId)}/tweets`, {
    max_results: Math.min(100, Math.max(5, opts.maxResults ?? 20)),
    'tweet.fields': TWEET_FIELDS,
    'user.fields': USER_FIELDS,
    expansions: EXPANSIONS,
    exclude: 'retweets,replies',
  });
  return mergeAuthors(res);
}

export async function searchRecent(
  query: string,
  opts: { maxResults?: number } = {},
): Promise<XTweet[]> {
  const res = await xGet<TweetResponse>('/tweets/search/recent', {
    query,
    max_results: Math.min(100, Math.max(10, opts.maxResults ?? 20)),
    'tweet.fields': TWEET_FIELDS,
    'user.fields': USER_FIELDS,
    expansions: EXPANSIONS,
  });
  return mergeAuthors(res);
}

export async function getTweetById(id: string): Promise<XTweet | null> {
  try {
    const res = await xGet<{
      data?: TweetResponse['data'][number];
      includes?: TweetResponse['includes'];
    }>(`/tweets/${encodeURIComponent(id)}`, {
      'tweet.fields': TWEET_FIELDS,
      'user.fields': USER_FIELDS,
      expansions: EXPANSIONS,
    });
    if (!res.data) return null;
    return mergeAuthors({ data: [res.data], includes: res.includes } as TweetResponse)[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Public, no-auth path to fetch a tweet's engagement metrics. Hits the
 * syndication CDN that powers X's own `<blockquote class="twitter-tweet">`
 * embeds — same endpoint react-tweet, oembed renderers, and most blog
 * tooling rely on. Officially undocumented but widely used and tolerated.
 *
 * Returns a subset of `public_metrics` (favourite_count + conversation_count;
 * retweet_count and impressions are NOT exposed here). Good enough to track
 * "how did this post land" without spending Bearer reads ($0.017/poll).
 *
 * Token is computed from the tweet ID via the same formula react-tweet uses;
 * the CDN rejects requests without it.
 */
export type XPublicMetrics = {
  id: string;
  favorite_count: number;
  conversation_count: number;
  view_count: number | null;
  created_at: string | null;
  text: string;
  author_username: string | null;
};

function syndicationToken(id: string): string {
  // Source: vercel/react-tweet, MIT — kept verbatim because the formula is
  // what the CDN expects; deviations break with `403 Forbidden`.
  const n = Number(id);
  if (!Number.isFinite(n)) return '';
  return ((n / 1e15) * Math.PI).toString(6 ** 2).replace(/(0+|\.)/g, '');
}

export async function getTweetMetricsPublic(id: string): Promise<XPublicMetrics | null> {
  const token = syndicationToken(id);
  if (!token) return null;
  const url = `https://cdn.syndication.twimg.com/tweet-result?id=${encodeURIComponent(
    id,
  )}&token=${token}&lang=en`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: {
        // The CDN is open but checks for a normal browser-shaped UA; ours
        // works fine but a plain header avoids any future filtering.
        'User-Agent': 'vibecode-dash/presence-copilot',
      },
    });
  } catch (error) {
    throw new Error(`X syndication fetch failed: ${String(error)}`);
  }
  if (res.status === 404) return null; // tweet deleted or visibility-restricted
  if (!res.ok) {
    throw new Error(`X syndication GET failed (${res.status})`);
  }
  type Raw = {
    id_str?: string;
    favorite_count?: number;
    conversation_count?: number;
    view_count?: { count?: string } | number | null;
    created_at?: string;
    text?: string;
    user?: { screen_name?: string };
  };
  const raw = (await res.json().catch(() => null)) as Raw | null;
  if (!raw || !raw.id_str) return null;
  const view =
    typeof raw.view_count === 'object' && raw.view_count
      ? Number(raw.view_count.count ?? 0)
      : typeof raw.view_count === 'number'
        ? raw.view_count
        : null;
  return {
    id: String(raw.id_str),
    favorite_count: Number(raw.favorite_count ?? 0),
    conversation_count: Number(raw.conversation_count ?? 0),
    view_count: view !== null && Number.isFinite(view) ? view : null,
    created_at: raw.created_at ?? null,
    text: String(raw.text ?? ''),
    author_username: raw.user?.screen_name ?? null,
  };
}

/** Decide which path the X engagement poller will take for the next call. */
export async function xAccessMode(): Promise<'bearer' | 'public'> {
  return (await xIsConnected()) ? 'bearer' : 'public';
}

export async function xWhoami(): Promise<{ id: string; username: string; name: string } | null> {
  // /2/users/me requires user-context, NOT app-only bearer. We fall back to
  // the pasted username (if any) and just hit /by/username/:handle to validate.
  const username = await loadUsername();
  if (!username) return null;
  try {
    const res = await xGet<{ data?: { id: string; username: string; name: string } }>(
      `/users/by/username/${encodeURIComponent(username)}`,
    );
    return res.data ?? null;
  } catch {
    return null;
  }
}

/**
 * Validate X handles via the public oEmbed endpoint at
 * `publish.twitter.com/oembed?url=https://twitter.com/{handle}` :
 *
 *   - HTTP 200 + JSON   → handle exists (returns the timeline embed snippet)
 *   - HTTP 404 + HTML   → handle does not exist (the "Nothing to see here" page)
 *
 * The previous implementation used `cdn.syndication.twimg.com/widgets/
 * followbutton/info.json` but that endpoint was deprecated in 2024 and
 * now returns HTTP 200 with an empty body for ALL inputs (verified live).
 *
 * No Bearer required, no batching support, ~200 ms per request. We throttle
 * sequentially (250 ms between calls) to stay polite. With chunked input
 * the helper still presents a Map<lowerHandle, result> interface so the
 * dispatcher logic stays unchanged.
 */
export type XHandleValidation =
  | { status: 'valid' }
  | { status: 'not_found' }
  | { status: 'invalid_format'; details: string }
  | { status: 'error'; details: string };

const X_HANDLE_THROTTLE_MS = 250;

async function validateOneXHandle(handle: string): Promise<XHandleValidation> {
  const url = `https://publish.twitter.com/oembed?url=${encodeURIComponent(`https://twitter.com/${handle}`)}`;
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': 'vibecode-dash/x-validator' },
      // oEmbed is sometimes slow; cap so a hung request doesn't stall the
      // whole sweep.
      signal: AbortSignal.timeout(8000),
    });
  } catch (error) {
    return { status: 'error', details: String(error).slice(0, 200) };
  }
  if (res.status === 404) return { status: 'not_found' };
  if (!res.ok) return { status: 'error', details: `HTTP ${res.status}` };
  // Sanity-check: oEmbed returns JSON for valid handles. If we somehow get
  // HTML 200 (rare; usually the error page), treat as not_found.
  const ct = res.headers.get('content-type') || '';
  if (!ct.includes('json')) return { status: 'not_found' };
  return { status: 'valid' };
}

export async function validateXHandles(handles: string[]): Promise<Map<string, XHandleValidation>> {
  const out = new Map<string, XHandleValidation>();
  const normalized = new Map<string, string>(); // lower → canonical
  for (const raw of handles) {
    const clean = raw.replace(/^@/, '').trim();
    const lower = clean.toLowerCase();
    if (!clean) continue;
    if (out.has(lower)) continue;
    if (!/^[A-Za-z0-9_]{1,15}$/.test(clean)) {
      out.set(lower, {
        status: 'invalid_format',
        details: `X handles are 1-15 alphanumeric/underscore characters: "${raw}"`,
      });
      continue;
    }
    normalized.set(lower, clean);
  }

  const lowers = [...normalized.keys()];
  for (let i = 0; i < lowers.length; i++) {
    const lower = lowers[i];
    const canonical = normalized.get(lower) ?? lower;
    const result = await validateOneXHandle(canonical);
    out.set(lower, result);
    if (i < lowers.length - 1) {
      await new Promise((r) => setTimeout(r, X_HANDLE_THROTTLE_MS));
    }
  }
  return out;
}

export async function validateXHandle(handle: string): Promise<XHandleValidation> {
  const map = await validateXHandles([handle]);
  return (
    map.get(handle.replace(/^@/, '').toLowerCase()) ?? { status: 'error', details: 'no result' }
  );
}

/**
 * Extract every `from:handle` reference from an X topic query so the source
 * validator can check each handle individually. Pure keyword searches with
 * no from: clause return [] (structurally valid as long as the search
 * parses on X's side).
 */
export function extractFromHandles(query: string): string[] {
  const matches = query.matchAll(/\bfrom:([A-Za-z0-9_]{1,15})\b/gi);
  const set = new Set<string>();
  for (const m of matches) set.add(m[1]);
  return [...set];
}

/**
 * Build a conservative topic query.
 *
 * IMPORTANT — operator availability differs by API tier:
 *   - `lang:`, `is:retweet`, `is:reply`           → Basic and up
 *   - `min_faves:`, `min_retweets:`, `min_replies:` → Pro and up
 *
 * We default to Basic-tier compatible operators so the wrapper works on the
 * cheapest paid tier. Pass `minFaves` explicitly when the caller knows the
 * user is on Pro+ (the relevance scorer downstream takes care of noise on
 * Basic tier — costs a few more cheap Haiku scoring calls but no $ impact).
 */
export function buildTopicQuery(
  raw: string,
  opts: { lang?: string; minFaves?: number; excludeReplies?: boolean } = {},
): string {
  const parts: string[] = [];
  parts.push(`(${raw})`);
  parts.push('-is:retweet');
  if (opts.excludeReplies !== false) parts.push('-is:reply');
  parts.push(`lang:${opts.lang ?? 'en'}`);
  // Only emit min_faves if explicitly requested — this operator is Pro-only.
  if (opts.minFaves != null) parts.push(`min_faves:${opts.minFaves}`);
  return parts.join(' ');
}

// ───────────────────── OAuth 1.0a User Context (write) ─────────────────────

const X_OAUTH1_KEYCHAIN_KEYS = [
  'x:consumer_key',
  'x:consumer_secret',
  'x:access_token',
  'x:access_token_secret',
] as const;

type XOAuth1Keys = {
  consumerKey: string;
  consumerSecret: string;
  accessToken: string;
  accessTokenSecret: string;
};

async function loadOAuth1Keys(): Promise<XOAuth1Keys> {
  const [consumerKey, consumerSecret, accessToken, accessTokenSecret] = await Promise.all(
    X_OAUTH1_KEYCHAIN_KEYS.map((k) =>
      keychain.get(k).catch(() => {
        throw new Error(
          `X OAuth 1.0a key "${k}" missing from keychain — generate the 4 keys in https://developer.x.com keys-and-tokens tab and store them via /api/presence/x/save-write-creds`,
        );
      }),
    ),
  );
  return { consumerKey, consumerSecret, accessToken, accessTokenSecret };
}

/**
 * Whether all four OAuth 1.0a keys are present. Cheap probe used by the
 * UI to show a "Connect X for posting" call-to-action when missing.
 */
export async function xCanPost(): Promise<boolean> {
  try {
    await loadOAuth1Keys();
    return true;
  } catch {
    return false;
  }
}

/**
 * Persist the four OAuth 1.0a keys. Call from the UI after the user
 * pastes them from the developer portal. Bearer-only credentials
 * (`x:bearer`, `x:username`) stay independent — read and write paths
 * use distinct tokens and one can be set without the other.
 */
export async function saveXWriteCreds(input: XOAuth1Keys): Promise<void> {
  await Promise.all([
    keychain.set('x:consumer_key', input.consumerKey),
    keychain.set('x:consumer_secret', input.consumerSecret),
    keychain.set('x:access_token', input.accessToken),
    keychain.set('x:access_token_secret', input.accessTokenSecret),
  ]);
}

export async function deleteXWriteCreds(): Promise<void> {
  await Promise.all(X_OAUTH1_KEYCHAIN_KEYS.map((k) => keychain.delete(k)));
}

/**
 * RFC 3986 §2.1 percent-encoding. URLSearchParams + encodeURIComponent
 * are NOT 3986-strict (they leave `!*'()` alone); X's signature-base
 * comparison rejects those, so we patch them after.
 */
export function pctEncode(s: string): string {
  return encodeURIComponent(s).replace(
    /[!*'()]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

/**
 * Build the `Authorization: OAuth ...` header value for a request.
 *
 * `bodyParams` — only for `application/x-www-form-urlencoded` request
 * bodies, where parameters MUST be folded into the signature base string.
 * For JSON-body endpoints (POST /2/tweets), pass `undefined`: only the
 * oauth_* params are signed, per RFC 5849 §3.4.1.3.
 *
 * Exported for testability: the entire signature pipeline is pure given
 * a fixed timestamp + nonce, so unit tests verify it against canonical
 * vectors before any network code runs.
 */
export function buildOAuth1Header(opts: {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  url: string; // exact request URL WITHOUT query string
  queryParams?: Record<string, string>;
  bodyParams?: Record<string, string>;
  keys: XOAuth1Keys;
  // Test seam: pass deterministic values from unit tests.
  timestamp?: string;
  nonce?: string;
}): string {
  const oauth: Record<string, string> = {
    oauth_consumer_key: opts.keys.consumerKey,
    oauth_nonce: opts.nonce ?? randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: opts.timestamp ?? Math.floor(Date.now() / 1000).toString(),
    oauth_token: opts.keys.accessToken,
    oauth_version: '1.0',
  };

  // Signature base string = METHOD & pctEncode(URL) & pctEncode(sorted-params)
  // Params include: oauth_*, query string, AND form-body params (if any).
  const allParams: Record<string, string> = {
    ...oauth,
    ...(opts.queryParams ?? {}),
    ...(opts.bodyParams ?? {}),
  };
  const paramStr = Object.keys(allParams)
    .sort()
    .map((k) => `${pctEncode(k)}=${pctEncode(allParams[k])}`)
    .join('&');
  const baseString = [opts.method, pctEncode(opts.url), pctEncode(paramStr)].join('&');
  const signingKey = `${pctEncode(opts.keys.consumerSecret)}&${pctEncode(
    opts.keys.accessTokenSecret,
  )}`;
  oauth.oauth_signature = createHmac('sha1', signingKey).update(baseString).digest('base64');

  // Header serialization — only oauth_* in the header, query/body stay
  // in the actual request. Order alphabetical (X is permissive but it's
  // the convention).
  const headerFields = Object.keys(oauth)
    .sort()
    .map((k) => `${pctEncode(k)}="${pctEncode(oauth[k])}"`)
    .join(', ');
  return `OAuth ${headerFields}`;
}

export type XPostTweetResult = {
  id: string;
  text: string;
};

/**
 * POST /2/tweets with OAuth 1.0a User Context.
 *
 * `text` — required, ≤ 280 characters (X enforces; we don't validate
 * here so the caller surface gets the precise error message back).
 * `replyToId` — when set, posts as a reply to that tweet id.
 *
 * Throws on non-2xx with the response body sliced to 500 chars so the
 * audit log stays readable.
 */
export async function xPostTweet(
  text: string,
  opts: { replyToId?: string } = {},
): Promise<XPostTweetResult> {
  const keys = await loadOAuth1Keys();
  const url = `${API_BASE}/tweets`;
  const auth = buildOAuth1Header({ method: 'POST', url, keys });
  const body = opts.replyToId
    ? { text, reply: { in_reply_to_tweet_id: opts.replyToId } }
    : { text };

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: auth,
      'Content-Type': 'application/json',
      'User-Agent': 'vibecode-dash/presence-copilot',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`X POST /2/tweets failed (${res.status}): ${detail.slice(0, 500)}`);
  }
  const json = (await res.json()) as { data?: { id?: string; text?: string } };
  if (!json.data?.id) {
    throw new Error(`X POST /2/tweets returned no id: ${JSON.stringify(json).slice(0, 300)}`);
  }
  return { id: json.data.id, text: json.data.text ?? text };
}
