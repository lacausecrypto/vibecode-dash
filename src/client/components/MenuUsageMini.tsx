import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, apiGet } from '../lib/api';
import { useTranslation } from '../lib/i18n';
import { publishQuota } from '../lib/quotaSignal';

type RateBar = { usedPercent: number; windowMinutes: number; resetsAt: number } | null;

type ClaudeRateLimitsResp = {
  rateLimits: {
    primary: RateBar;
    secondary: RateBar;
    tertiary: RateBar;
    planType: string | null;
    observedAt: number;
  } | null;
};

type CodexRateLimitsResp = {
  rateLimits: {
    primary: RateBar;
    secondary: RateBar;
    planType: string | null;
    observedAt: number;
  } | null;
  source?: 'live_oauth' | 'jsonl_fallback';
};

type ProviderState = {
  primary: RateBar;
  secondary: RateBar;
  observedAt: number | null;
  stale: boolean;
};

const REFRESH_MS = 60_000;

// Jan-1-2026 range keeps the server's JSONL fallback window wide enough that
// we always pick up the latest token_count snapshot even if the user hasn't
// run Codex for a few days.
function usageFrom(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 30);
  return d.toISOString();
}

function toneFor(percent: number): 'ok' | 'warn' | 'danger' {
  if (percent >= 85) return 'danger';
  if (percent >= 60) return 'warn';
  return 'ok';
}

function MiniBar({
  label,
  rate,
  accent,
  observedAt,
}: {
  label: string;
  rate: RateBar;
  accent: 'cyan' | 'amber';
  observedAt: number | null;
}) {
  const { t } = useTranslation();

  if (!rate) {
    return (
      <div className="flex items-center justify-between gap-2 py-0.5">
        <span className="text-[10px] text-[var(--text-dim)]">{label}</span>
        <span className="num text-[10px] text-[var(--text-faint)]">n/a</span>
      </div>
    );
  }

  const clamped = Math.max(0, Math.min(100, rate.usedPercent));
  const nowSec = Math.floor(Date.now() / 1000);
  const windowReset = rate.resetsAt > 0 && nowSec >= rate.resetsAt;
  const tone = toneFor(clamped);
  const barColor = windowReset
    ? 'bg-[var(--surface-2)]'
    : tone === 'danger'
      ? 'bg-[#ff453a]'
      : tone === 'warn'
        ? 'bg-[#ffd60a]'
        : accent === 'cyan'
          ? 'bg-[#64d2ff]'
          : 'bg-[#ffd60a]';
  const valueColor = windowReset
    ? 'text-[var(--text-faint)] line-through'
    : tone === 'danger'
      ? 'text-[#ff453a]'
      : tone === 'warn'
        ? 'text-[#ffd60a]'
        : accent === 'cyan'
          ? 'text-[#64d2ff]'
          : 'text-[#ffd60a]';

  const observedLabel = observedAt ? new Date(observedAt * 1000).toLocaleString() : null;
  const resetsLabel = rate.resetsAt ? new Date(rate.resetsAt * 1000).toLocaleString() : null;
  const titleParts: string[] = [];
  if (observedLabel) titleParts.push(`${t('menuUsage.observed')} ${observedLabel}`);
  if (resetsLabel) titleParts.push(`${t('menuUsage.resets')} ${resetsLabel}`);

  return (
    <div
      className="flex flex-col gap-1 py-1"
      title={titleParts.length > 0 ? titleParts.join(' · ') : undefined}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-[10px] text-[var(--text-dim)]">{label}</span>
        <span className={`num text-[10.5px] font-medium tabular-nums ${valueColor}`}>
          {rate.usedPercent.toFixed(1)}%
        </span>
      </div>
      <div className="h-[3px] rounded bg-[var(--surface-2)]">
        <div
          className={`h-[3px] rounded ${barColor}`}
          style={{ width: `${clamped}%`, opacity: windowReset ? 0.3 : 1 }}
        />
      </div>
    </div>
  );
}

function ProviderBlock({
  name,
  accent,
  state,
  loading,
}: {
  name: string;
  accent: 'cyan' | 'amber';
  state: ProviderState | null;
  loading: boolean;
}) {
  const { t } = useTranslation();
  const dot = accent === 'cyan' ? 'bg-[#64d2ff]' : 'bg-[#ffd60a]';

  return (
    <div className="flex flex-col">
      <div className="mb-0.5 flex items-center gap-1.5">
        <span className={`h-1.5 w-1.5 rounded-full ${dot}`} aria-hidden="true" />
        <span className="text-[10.5px] font-medium tracking-tight text-[var(--text)]">{name}</span>
        {state?.stale ? (
          <span className="text-[9px] text-[var(--text-faint)]">· {t('menuUsage.stale')}</span>
        ) : null}
      </div>
      {!state && !loading ? (
        <div className="py-0.5 text-[10px] text-[var(--text-faint)]">
          {t('menuUsage.unavailable')}
        </div>
      ) : (
        <div className="flex flex-col gap-0.5">
          <MiniBar
            label={t('menuUsage.window5h')}
            rate={state?.primary ?? null}
            accent={accent}
            observedAt={state?.observedAt ?? null}
          />
          <MiniBar
            label={t('menuUsage.window7d')}
            rate={state?.secondary ?? null}
            accent={accent}
            observedAt={state?.observedAt ?? null}
          />
        </div>
      )}
    </div>
  );
}

export function MenuUsageMini() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [claude, setClaude] = useState<ProviderState | null>(null);
  const [codex, setCodex] = useState<ProviderState | null>(null);
  const [loading, setLoading] = useState(true);
  const [lastRefresh, setLastRefresh] = useState<number | null>(null);
  const cancelRef = useRef(false);
  // Scheduled boundary-refresh: fires right after the earliest window
  // crosses its resetsAt, so the bar flips from "just reset" → fresh value
  // without waiting for the next 60 s tick.
  const resetTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async ({ force = false }: { force?: boolean } = {}) => {
    setLoading(true);
    const from = usageFrom();
    const now = Math.floor(Date.now() / 1000);
    const qs = force ? '?force=1' : '';

    // Fetch both in parallel, but don't let one failure kill the other.
    const [claudeRes, codexRes] = await Promise.allSettled([
      apiGet<ClaudeRateLimitsResp>(`/api/usage/claude/rate-limits${qs}`),
      apiGet<CodexRateLimitsResp>(
        `/api/usage/codex/rate-limits?from=${from}${force ? '&force=1' : ''}`,
      ),
    ]);

    if (cancelRef.current) return;

    let nextClaude: ProviderState | null = null;
    let nextCodex: ProviderState | null = null;

    if (claudeRes.status === 'fulfilled' && claudeRes.value.rateLimits) {
      const rl = claudeRes.value.rateLimits;
      nextClaude = {
        primary: rl.primary,
        secondary: rl.secondary,
        observedAt: rl.observedAt,
        stale: false,
      };
    } else if (claudeRes.status === 'rejected' && !(claudeRes.reason instanceof ApiError)) {
      // Treat 401 (no api key configured) and actual errors identically at
      // this UI layer — the menu shouldn't scream about auth issues, /settings
      // is the right place for that.
      console.warn('[menu/usage] claude fetch failed', claudeRes.reason);
    }

    if (codexRes.status === 'fulfilled' && codexRes.value.rateLimits) {
      const rl = codexRes.value.rateLimits;
      nextCodex = {
        primary: rl.primary,
        secondary: rl.secondary,
        observedAt: rl.observedAt,
        // JSONL fallback = user hasn't run Codex recently, so values may be old.
        stale: codexRes.value.source === 'jsonl_fallback',
      };
    } else if (codexRes.status === 'rejected' && !(codexRes.reason instanceof ApiError)) {
      console.warn('[menu/usage] codex fetch failed', codexRes.reason);
    }

    setClaude(nextClaude);
    setCodex(nextCodex);

    // Broadcast to any other consumer (today: the Mascot tamagotchi) so a
    // quota crossing 85/95% drives a single source of truth instead of
    // every component duplicating the rate-limits poll.
    publishQuota({
      claude: nextClaude ? { primary: nextClaude.primary, secondary: nextClaude.secondary } : null,
      codex: nextCodex ? { primary: nextCodex.primary, secondary: nextCodex.secondary } : null,
      at: Date.now(),
    });

    // Schedule an auto-refresh right after the earliest window reset we can
    // see. +5 s buffer so the server has a moment to propagate the fresh
    // numbers before we ask again. Previous timer is cleared on every call.
    if (resetTimerRef.current) {
      clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }
    const upcoming = [
      nextClaude?.primary,
      nextClaude?.secondary,
      nextCodex?.primary,
      nextCodex?.secondary,
    ]
      .map((r) => r?.resetsAt ?? 0)
      .filter((ts) => ts > now);
    if (upcoming.length > 0) {
      const nextReset = Math.min(...upcoming);
      const delayMs = Math.max(0, (nextReset - now) * 1000 + 5_000);
      // Cap the scheduled delay at 24 h to avoid React warnings and guard
      // against unlikely resetsAt values far in the future.
      const safeDelay = Math.min(delayMs, 24 * 60 * 60 * 1000);
      resetTimerRef.current = setTimeout(() => {
        if (!cancelRef.current) void refresh({ force: true });
      }, safeDelay);
    }

    setLastRefresh(now);
    setLoading(false);
  }, []);

  useEffect(() => {
    cancelRef.current = false;
    void refresh();
    const id = setInterval(() => void refresh(), REFRESH_MS);
    return () => {
      cancelRef.current = true;
      clearInterval(id);
      if (resetTimerRef.current) {
        clearTimeout(resetTimerRef.current);
        resetTimerRef.current = null;
      }
    };
  }, [refresh]);

  const hasAnyData = !!claude || !!codex;
  const refreshLabel = lastRefresh
    ? new Date(lastRefresh * 1000).toLocaleTimeString()
    : t('menuUsage.never');

  return (
    <section
      className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-2 text-[var(--text)]"
      aria-label={t('menuUsage.title')}
    >
      <div className="mb-1.5 flex items-center justify-between">
        <button
          type="button"
          onClick={() => navigate('/usage')}
          className="text-[10px] font-semibold uppercase tracking-[0.08em] text-[var(--text-dim)] transition-colors hover:text-[var(--text)]"
          aria-label={t('menuUsage.openUsage')}
        >
          {t('menuUsage.title')}
        </button>
        <button
          type="button"
          // Manual refresh forces a cache bypass server-side. Auto-refresh
          // (interval + scheduled boundary) leaves it off so we stay within
          // the Anthropic TTL and don't spam the rate limit.
          onClick={() => void refresh({ force: true })}
          disabled={loading}
          className="inline-flex h-4 w-4 items-center justify-center rounded text-[var(--text-faint)] transition-colors hover:text-[var(--text)] disabled:opacity-60"
          aria-label={t('menuUsage.refresh')}
          title={`${t('menuUsage.lastRefresh')} ${refreshLabel}`}
        >
          <svg
            viewBox="0 0 16 16"
            width="10"
            height="10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={loading ? 'animate-spin' : ''}
            aria-hidden="true"
          >
            <path d="M13.5 8a5.5 5.5 0 1 1-1.61-3.89" />
            <path d="M13.5 2.5v3h-3" />
          </svg>
        </button>
      </div>

      {!hasAnyData && !loading ? (
        <div className="py-1 text-[10px] text-[var(--text-faint)]">
          {t('menuUsage.unavailable')}
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <ProviderBlock name="Claude" accent="cyan" state={claude} loading={loading} />
          <ProviderBlock name="Codex" accent="amber" state={codex} loading={loading} />
        </div>
      )}
    </section>
  );
}
