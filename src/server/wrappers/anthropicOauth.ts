/**
 * Reads the real rate-limit utilizations Anthropic exposes to Claude Code.
 *
 * Source: `GET https://api.anthropic.com/api/oauth/usage` with the OAuth
 * bearer token that Claude Code stores in the macOS keychain under service
 * "Claude Code-credentials". This is the exact same endpoint the CLI hits
 * when rendering its `/status` / usage panel — the numbers match claude.ai.
 *
 * Previous implementation derived a fake "limit" from `ccusage blocks`
 * (historical max of any past 5h block), which has no relation to the real
 * plan quota. The OAuth endpoint returns percentages directly.
 */

export type OauthUsageBar = {
  utilization: number;
  resets_at: string | null;
} | null;

export type OauthUsage = {
  five_hour: OauthUsageBar;
  seven_day: OauthUsageBar;
  seven_day_opus: OauthUsageBar;
  seven_day_sonnet: OauthUsageBar;
  // Other fields the API returns but we don't surface (seven_day_cowork,
  // extra_usage, etc.) are ignored.
};

type KeychainPayload = {
  claudeAiOauth?: {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
  };
};

const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const BASE_URL = 'https://api.anthropic.com';
// Claude quotas don't move in seconds; 2 min cache is plenty and keeps the
// dashboard well clear of Anthropic's rate limit on /api/oauth/usage. The
// previous 30 s triggered 429s when the client auto-refreshes every 60 s
// across two tabs (or after a HMR reload).
const TTL_MS = 120_000;
const FETCH_TIMEOUT_MS = 8_000;
// On 429 we back off longer than the normal TTL so we don't drill Anthropic
// while rate-limited. Last-known value (if any) is returned in the mean
// time instead of `null`, so the UI keeps showing the most recent snapshot
// flagged as stale rather than "indisponible".
const RATE_LIMIT_BACKOFF_MS = 5 * 60_000;

type CacheEntry = {
  at: number;
  value: OauthUsage | null;
  backoffUntil: number;
};
let cache: CacheEntry | null = null;
let inflight: Promise<OauthUsage | null> | null = null;

async function readKeychainToken(): Promise<string | null> {
  const proc = Bun.spawn(['security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  if (code !== 0) {
    return null;
  }
  const raw = out.trim();
  try {
    const parsed = JSON.parse(raw) as KeychainPayload;
    const token = parsed.claudeAiOauth?.accessToken;
    return typeof token === 'string' && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

type FetchResult =
  | { kind: 'ok'; value: OauthUsage }
  | { kind: 'rate-limited'; retryAfterMs: number }
  | { kind: 'error' };

async function fetchUsage(): Promise<FetchResult> {
  const token = await readKeychainToken();
  if (!token) {
    return { kind: 'error' };
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(`${BASE_URL}/api/oauth/usage`, {
      headers: {
        authorization: `Bearer ${token}`,
        // Required beta header the CLI sends with OAuth — without it the
        // endpoint returns 401.
        'anthropic-beta': 'oauth-2025-04-20',
        'content-type': 'application/json',
      },
      signal: ctrl.signal,
    });
    if (res.status === 429) {
      // Respect Retry-After if provided (seconds per RFC 7231); otherwise
      // fall back to the hard backoff constant.
      const header = res.headers.get('retry-after');
      const secs = header ? Number.parseInt(header, 10) : Number.NaN;
      const retryAfterMs = Number.isFinite(secs) && secs > 0 ? secs * 1000 : RATE_LIMIT_BACKOFF_MS;
      console.warn(
        `[anthropicOauth] /api/oauth/usage -> 429, backing off ${Math.round(retryAfterMs / 1000)}s`,
      );
      return { kind: 'rate-limited', retryAfterMs };
    }
    if (!res.ok) {
      console.warn(`[anthropicOauth] /api/oauth/usage -> ${res.status}`);
      return { kind: 'error' };
    }
    const value = (await res.json()) as OauthUsage;
    return { kind: 'ok', value };
  } catch (error) {
    console.warn('[anthropicOauth] fetch failed', error);
    return { kind: 'error' };
  } finally {
    clearTimeout(timer);
  }
}

export async function getOauthUsage(opts: { force?: boolean } = {}): Promise<OauthUsage | null> {
  const now = Date.now();
  // `force` bypasses the soft TTL cache (e.g. manual refresh button) but
  // NEVER bypasses the 429 backoff — we don't let the user provoke rate
  // limits at Anthropic's side.
  if (!opts.force && cache && now - cache.at < TTL_MS) {
    return cache.value;
  }
  if (cache && now < cache.backoffUntil) {
    // Inside the 429 backoff window: don't re-hit Anthropic (would just 429
    // again and extend the ban). Return last-known if we have one, else
    // null — the UI renders "indisponible" and the client's own 60 s poll
    // eventually crosses the backoff boundary and tries again.
    return cache.value;
  }
  if (inflight) {
    return inflight;
  }
  inflight = (async () => {
    try {
      const result = await fetchUsage();
      if (result.kind === 'ok') {
        cache = { at: Date.now(), value: result.value, backoffUntil: 0 };
        return result.value;
      }
      if (result.kind === 'rate-limited') {
        // Keep last-known value and extend backoffUntil; don't clobber
        // `at` so the next fresh fetch still happens when backoff expires.
        cache = {
          at: cache?.at ?? 0,
          value: cache?.value ?? null,
          backoffUntil: Date.now() + result.retryAfterMs,
        };
        return cache.value;
      }
      // Hard error: cache the null but briefly so a transient outage doesn't
      // lock us out. Next client refresh (60s later) will re-try.
      cache = { at: Date.now(), value: cache?.value ?? null, backoffUntil: 0 };
      return cache.value;
    } finally {
      inflight = null;
    }
  })();
  return inflight;
}
