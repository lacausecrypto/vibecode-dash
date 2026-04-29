/**
 * Tiny pub/sub for the latest known LLM quota usage. Lets the Mascot react
 * to "Claude 5h is at 92%" without duplicating the fetch that
 * MenuUsageMini already runs every 60 s.
 *
 * Source of truth lives in MenuUsageMini, which calls `publishQuota()`
 * after every refresh. Subscribers (today: Mascot) get the latest snapshot
 * via `getQuotaSnapshot()` on subscribe (so they don't have to wait up
 * to 60 s for the next publish to learn the current state).
 *
 * Kept framework-agnostic for the same reason as activityBus.ts —
 * fetch helpers shouldn't have to know about React.
 */

export type ProviderName = 'claude' | 'codex';
export type QuotaSeverity = 'ok' | 'warn' | 'critical';

export type QuotaBar = {
  usedPercent: number;
  windowMinutes: number;
  resetsAt: number;
} | null;

export type QuotaProvider = {
  primary: QuotaBar; // 5h window typically
  secondary: QuotaBar; // 7d window typically
} | null;

export type QuotaSnapshot = {
  // Highest utilization across both providers and both windows (5h, 7d).
  // Drives the mascot's "worried" reactions — picks the worst signal so a
  // hot 5h Claude doesn't get masked by a calm 7d Codex.
  worstPercent: number;
  worstProvider: ProviderName | null;
  worstWindowMinutes: number | null;
  severity: QuotaSeverity;
  observedAt: number; // epoch ms — lets consumers age out stale snapshots
  // Raw per-provider bars — exposed so secondary consumers (the mobile
  // quickbar) can render the actual values without duplicating the fetch.
  claude: QuotaProvider;
  codex: QuotaProvider;
};

const WARN_THRESHOLD = 0.85;
const CRITICAL_THRESHOLD = 0.95;

let current: QuotaSnapshot = {
  worstPercent: 0,
  worstProvider: null,
  worstWindowMinutes: null,
  severity: 'ok',
  observedAt: 0,
  claude: null,
  codex: null,
};

type Listener = (snapshot: QuotaSnapshot) => void;
const listeners = new Set<Listener>();

export function getQuotaSnapshot(): QuotaSnapshot {
  return current;
}

export function subscribeQuota(fn: Listener): () => void {
  listeners.add(fn);
  // Immediate fan-out so subscribers get the current value without waiting
  // for the next publish. Skipped for the bootstrap state (observedAt=0)
  // where there's nothing meaningful to deliver yet.
  if (current.observedAt > 0) {
    try {
      fn(current);
    } catch (err) {
      console.warn('[quotaSignal] listener threw', err);
    }
  }
  return () => {
    listeners.delete(fn);
  };
}

type RawBar = { usedPercent: number; windowMinutes: number; resetsAt: number } | null;

type RawProvider = {
  primary: RawBar;
  secondary: RawBar;
  tertiary?: RawBar; // Claude has a 3rd window for sonnet sub-quota
} | null;

/**
 * Compute the worst non-reset bar across both providers and publish the
 * snapshot. We ignore bars whose window has already reset because the
 * stored % no longer reflects current usage.
 */
export function publishQuota(input: {
  claude: RawProvider;
  codex: RawProvider;
  at: number;
}): void {
  const nowSec = Math.floor(input.at / 1000);
  let worstPct = 0;
  let worstProv: ProviderName | null = null;
  let worstWin: number | null = null;

  const consider = (bar: RawBar, provider: ProviderName): void => {
    if (!bar) return;
    if (bar.resetsAt > 0 && nowSec >= bar.resetsAt) return; // window reset
    const pct = bar.usedPercent / 100;
    if (pct > worstPct) {
      worstPct = pct;
      worstProv = provider;
      worstWin = bar.windowMinutes;
    }
  };

  if (input.claude) {
    consider(input.claude.primary, 'claude');
    consider(input.claude.secondary, 'claude');
    consider(input.claude.tertiary ?? null, 'claude');
  }
  if (input.codex) {
    consider(input.codex.primary, 'codex');
    consider(input.codex.secondary, 'codex');
  }

  const severity: QuotaSeverity =
    worstPct >= CRITICAL_THRESHOLD ? 'critical' : worstPct >= WARN_THRESHOLD ? 'warn' : 'ok';

  current = {
    worstPercent: worstPct,
    worstProvider: worstProv,
    worstWindowMinutes: worstWin,
    severity,
    observedAt: input.at,
    claude: input.claude
      ? { primary: input.claude.primary, secondary: input.claude.secondary }
      : null,
    codex: input.codex
      ? { primary: input.codex.primary, secondary: input.codex.secondary }
      : null,
  };

  for (const fn of listeners) {
    try {
      fn(current);
    } catch (err) {
      console.warn('[quotaSignal] listener threw', err);
    }
  }
}
