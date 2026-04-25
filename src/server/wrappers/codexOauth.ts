/**
 * Live rate-limits poller for Codex CLI.
 *
 * Source: `GET https://chatgpt.com/backend-api/wham/usage` with the OAuth
 * bearer token Codex stores in `~/.codex/auth.json`. This is the exact same
 * endpoint the CLI hits (every ~60 s when a session is active) to render its
 * `/status` panel — the numbers match chatgpt.com.
 *
 * Why we need this on top of the JSONL-embedded `rate_limits` block:
 *   The JSONL value only refreshes when the user runs Codex (each
 *   `token_count` event piggy-backs the current limits). If the dashboard is
 *   open on a day without Codex activity, the JSONL snapshot is stale and
 *   may even describe a window that has already reset. Hitting the OAuth
 *   endpoint directly gives us live data independent of CLI activity.
 *
 * We deliberately do NOT implement the OAuth refresh flow — that's the CLI's
 * job. If the token is expired (401), the user reruns `codex login`.
 */

import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { CodexRateLimitsRow } from './codexJsonlParser';

type AuthFile = {
  tokens?: {
    access_token?: string;
    account_id?: string;
  };
};

const AUTH_PATH = join(homedir(), '.codex', 'auth.json');
const BASE_URL = 'https://chatgpt.com/backend-api';
const ENDPOINT = `${BASE_URL}/wham/usage`;
const TTL_MS = 60_000;
const FETCH_TIMEOUT_MS = 8_000;

type CacheEntry = {
  at: number;
  value: CodexRateLimitsRow | null;
  error: string | null;
};

let cache: CacheEntry | null = null;
let inflight: Promise<CacheEntry> | null = null;

async function readAuthTokens(): Promise<{
  accessToken: string;
  accountId: string;
} | null> {
  try {
    const raw = await readFile(AUTH_PATH, 'utf8');
    const parsed = JSON.parse(raw) as AuthFile;
    const accessToken = parsed.tokens?.access_token;
    const accountId = parsed.tokens?.account_id;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      return null;
    }
    if (typeof accountId !== 'string' || accountId.length === 0) {
      return null;
    }
    return { accessToken, accountId };
  } catch {
    return null;
  }
}

function coerceBar(
  value: unknown,
): { usedPercent: number; windowMinutes: number; resetsAt: number } | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const usedPercent = Number(record.used_percent);
  // Accept both legacy (`window_minutes`, `resets_at`) and current
  // (`limit_window_seconds`, `reset_at`) field names — ChatGPT's payload
  // renamed these at some point and we'd rather be liberal on input.
  const rawWindowMin = Number(record.window_minutes);
  const rawWindowSec = Number(record.limit_window_seconds);
  const windowMinutes = Number.isFinite(rawWindowMin)
    ? rawWindowMin
    : Number.isFinite(rawWindowSec)
      ? rawWindowSec / 60
      : Number.NaN;
  const rawResets = Number(record.resets_at);
  const rawResetAt = Number(record.reset_at);
  const resetsAt = Number.isFinite(rawResets)
    ? rawResets
    : Number.isFinite(rawResetAt)
      ? rawResetAt
      : Number.NaN;
  if (
    !Number.isFinite(usedPercent) ||
    !Number.isFinite(windowMinutes) ||
    !Number.isFinite(resetsAt)
  ) {
    return null;
  }
  return { usedPercent, windowMinutes, resetsAt };
}

/**
 * Parse defensively: the /wham/usage payload has been observed as either
 *   - a top-level snapshot (primary/secondary/plan_type)
 *   - a wrapper with `rate_limit: RateLimitSnapshot[]`
 * We accept both. When the array form is returned, prefer the snapshot
 * whose `limit_id === 'codex'` — matches what the CLI does client-side.
 */
function payloadToRow(payload: unknown, observedAt: number): CodexRateLimitsRow | null {
  if (!payload || typeof payload !== 'object') return null;
  const root = payload as Record<string, unknown>;

  // Three shapes observed over time — try each until one yields bars:
  //   A) root.rate_limit = { primary_window, secondary_window }  (current)
  //   B) root.rate_limit = [{ limit_id, primary, secondary }]     (array legacy)
  //   C) root = { primary, secondary, plan_type }                 (flat legacy)
  // Additional sibling `additional_rate_limits[]` is ignored — it exposes
  // per-feature quotas (GPT-5.3-Codex-Spark etc.) that don't mirror the
  // single "session / week" bars users see in /status.
  const rateLimitRaw = root.rate_limit;

  const candidates: Record<string, unknown>[] = [];

  if (rateLimitRaw && typeof rateLimitRaw === 'object' && !Array.isArray(rateLimitRaw)) {
    candidates.push(rateLimitRaw as Record<string, unknown>);
  }

  const listCandidate =
    (Array.isArray(rateLimitRaw) ? rateLimitRaw : null) ??
    (Array.isArray(root.rate_limits) ? (root.rate_limits as unknown[]) : null);
  if (listCandidate && listCandidate.length > 0) {
    const codex = listCandidate.find(
      (s) => s && typeof s === 'object' && (s as Record<string, unknown>).limit_id === 'codex',
    );
    candidates.push((codex || listCandidate[0]) as Record<string, unknown>);
  }

  candidates.push(root);

  for (const snap of candidates) {
    const primary = coerceBar(snap.primary_window ?? snap.primary);
    const secondary = coerceBar(snap.secondary_window ?? snap.secondary);
    if (primary || secondary) {
      const planTypeRaw = snap.plan_type ?? root.plan_type;
      const planType = typeof planTypeRaw === 'string' ? planTypeRaw : null;
      return { primary, secondary, planType, observedAt };
    }
  }
  return null;
}

async function fetchLive(): Promise<CacheEntry> {
  const tokens = await readAuthTokens();
  const at = Date.now();
  if (!tokens) {
    return { at, value: null, error: 'no_auth_file' };
  }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(ENDPOINT, {
      headers: {
        authorization: `Bearer ${tokens.accessToken}`,
        'chatgpt-account-id': tokens.accountId,
        'user-agent': 'vibecode-dash',
        accept: 'application/json',
      },
      signal: ctrl.signal,
    });
    if (!res.ok) {
      // 401 → token expired, user reruns `codex login`.
      // 403 / 429 → policy / rate limit; we still report the failure but
      // don't retry aggressively (TTL-gated).
      return { at, value: null, error: `http_${res.status}` };
    }
    const payload = (await res.json()) as unknown;
    const observedAtSec = Math.floor(at / 1000);
    const row = payloadToRow(payload, observedAtSec);
    if (!row) {
      return { at, value: null, error: 'bad_shape' };
    }
    return { at, value: row, error: null };
  } catch (error) {
    return { at, value: null, error: String(error) };
  } finally {
    clearTimeout(timer);
  }
}

export type CodexLiveRateLimitsResult = {
  value: CodexRateLimitsRow | null;
  error: string | null;
  /** Milliseconds since the value was captured (0 if from fresh fetch). */
  ageMs: number;
  /** True if the returned value was served from the in-memory cache. */
  cached: boolean;
};

/**
 * Fetch the live rate-limits snapshot, TTL-cached to ~60 s so the route can
 * be called on every page load without spamming chatgpt.com. Concurrent
 * callers share the in-flight promise.
 */
export async function getCodexLiveRateLimits(
  opts: { force?: boolean } = {},
): Promise<CodexLiveRateLimitsResult> {
  const now = Date.now();
  // Manual refresh button sets `force`, which bypasses the 60 s TTL. Codex
  // has no documented rate limit on this endpoint so we don't need an
  // equivalent of Claude's backoff — if the user mashes refresh, they get
  // a fresh fetch every time.
  if (!opts.force && cache && now - cache.at < TTL_MS) {
    return {
      value: cache.value,
      error: cache.error,
      ageMs: now - cache.at,
      cached: true,
    };
  }
  if (inflight) {
    const entry = await inflight;
    return {
      value: entry.value,
      error: entry.error,
      ageMs: Date.now() - entry.at,
      cached: true,
    };
  }
  inflight = fetchLive()
    .then((entry) => {
      cache = entry;
      return entry;
    })
    .finally(() => {
      inflight = null;
    });
  const entry = await inflight;
  return {
    value: entry.value,
    error: entry.error,
    ageMs: Date.now() - entry.at,
    cached: false,
  };
}

/**
 * For the background poller — returns whatever is cached without triggering
 * a new fetch. Used to decide if we need to refresh.
 */
export function peekCodexLiveRateLimits(): CacheEntry | null {
  return cache;
}

/** Test helper. */
export function __resetCodexOauthCache(): void {
  cache = null;
  inflight = null;
}
