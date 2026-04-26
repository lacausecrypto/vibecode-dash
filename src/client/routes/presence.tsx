import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Button, Card, Chip, Empty, ErrorBanner, Section, Segmented, Stat } from '../components/ui';
import { trackTask } from '../lib/activityBus';
import { apiDelete, apiGet, apiPatch, apiPost } from '../lib/api';
import { useTranslation } from '../lib/i18n';

// ────────────────────────── Types ──────────────────────────

type Platform = 'reddit' | 'x';
type SourceKind = 'subreddit' | 'reddit_user' | 'x_list' | 'x_user' | 'x_topic';
type DraftStatus =
  | 'proposed'
  | 'viewed'
  | 'approved'
  | 'posted'
  | 'expired'
  | 'ignored'
  | 'rejected';
type DraftFormat = 'comment' | 'reply' | 'post' | 'quote';

type TopSource = {
  source_id: string;
  label: string | null;
  platform: string;
  kind: string;
  identifier: string;
  posted: number;
  proposed: number;
  post_rate: number;
};

type FeedSummary = {
  proposed: number;
  proposed_unviewed: number;
  dying_within_1h: number;
  dying_within_24h: number;
  top_source: TopSource | null;
};

type SourceHealthStatus =
  | 'never_scanned'
  | 'unscored'
  | 'pristine'
  | 'workhorse'
  | 'noisy'
  | 'stale'
  | 'dead';

type SourceHealthMetrics = {
  drafts_30d: number;
  posted_30d: number;
  posted_14d: number;
  posted_30_60d: number;
  proposed_30d: number;
  avg_edit_ratio: number | null;
  last_scanned_at: number | null;
  validation_status: string | null;
};

type SourceRow = {
  id: string;
  platform: Platform;
  kind: SourceKind;
  identifier: string;
  label: string | null;
  weight: number;
  freshness_ttl_minutes: number;
  active: number;
  last_since_id: string | null;
  last_scanned_at: number | null;
  last_scan_status: string | null;
  added_at: number;
  validation_status: string | null;
  validated_at: number | null;
  health_status: SourceHealthStatus | null;
  health_snapshot_at: number | null;
  health_metrics_json: string | null;
};

type DraftRow = {
  id: string;
  platform: Platform;
  source_id: string | null;
  external_thread_id: string | null;
  external_thread_url: string | null;
  thread_snapshot_json: string;
  format: DraftFormat;
  relevance_score: number;
  freshness_expires_at: number;
  draft_body: string;
  draft_rationale: string | null;
  vault_citations_json: string | null;
  radar_insight_ids_json: string | null;
  image_plan_json: string | null;
  status: DraftStatus;
  posted_external_id: string | null;
  posted_external_url: string | null;
  posted_at: number | null;
  created_at: number;
  viewed_at: number | null;
  decided_at: number | null;
};

type ConnectionRow = {
  platform: Platform;
  account_handle: string | null;
  keychain_ref: string | null;
  scopes_json: string | null;
  connected_at: number | null;
  last_refresh_at: number | null;
};

type ConnectStatus = {
  reddit: boolean;
  x: boolean;
  openrouter: boolean;
};

type ScanSourceOutcome = {
  source_id: string;
  candidates_seen: number;
  scored: number;
  drafts_created: number;
  skipped_duplicate: number;
  skipped_low_score: number;
  skipped_no_draft: number;
  cost_usd?: number;
  reads?: number;
  error?: string;
};

type ScanOutcome = {
  reddit: ScanSourceOutcome[];
  x: ScanSourceOutcome[];
  started_at: number;
  finished_at: number;
  total_drafts_created: number;
  total_cost_usd: number;
  /** Sources skipped because still inside their freshness TTL window. */
  skipped_ttl?: number;
  /** True when the daily $ budget cap aborted the scan before any source ran. */
  budget_exceeded?: boolean;
};

type ScanJobStatus = 'pending' | 'running' | 'done' | 'failed';

type ScanJob = {
  id: string;
  status: ScanJobStatus;
  enqueued_at: number;
  started_at: number | null;
  finished_at: number | null;
  outcome: ScanOutcome | null;
  error: string | null;
};

type ImagePlan = {
  kind: 'none' | 'diagram' | 'illustration' | 'photo';
  prompt?: string | null;
  mermaid?: string | null;
  model?: string | null;
  url?: string | null;
  b64?: string | null;
  cost_usd?: number;
  reason?: string;
  /** True when the plan came from the auto-classifier (no image generated yet). */
  suggested?: boolean;
};

type DrafterProvider = 'claude' | 'codex';

type DrafterConfig = {
  drafterProvider: DrafterProvider;
  scorerModel: string;
  drafterModel: string;
};

type MergedModelLite = { id: string; label: string };

type DrafterConfigResponse = {
  config: DrafterConfig;
  catalog: Record<DrafterProvider, MergedModelLite[]>;
};

type FunnelRow = {
  platform: string;
  proposed: number;
  viewed: number;
  approved: number;
  posted: number;
  expired: number;
  ignored: number;
  rejected: number;
};

type CostBucketRow = { bucket: string; total_usd: number };
type CostServiceRow = {
  service: string;
  operation: string;
  calls: number;
  total_usd: number;
};
type SourceRoiRow = {
  source_id: string | null;
  label: string | null;
  platform: string | null;
  kind: string | null;
  identifier: string | null;
  proposed: number;
  posted: number;
  expired: number;
  ignored_rejected: number;
  post_rate: number | null;
};
type EngagementSummaryRow = {
  platform: string;
  tag: string;
  samples: number;
  avg_likes: number | null;
  avg_replies: number | null;
  avg_reposts: number | null;
  avg_impressions: number | null;
  avg_ratio: number | null;
};
type HeatmapCell = { hour: number; weekday: number; n: number };
type EditHotspotRow = { ngram: string; occurrences: number };

type RadarEngagementRow = {
  insight_type: string;
  drafts_posted: number;
  avg_likes: number | null;
  avg_replies: number | null;
};

type FormatEngagementRow = {
  format: string;
  proposed: number;
  posted: number;
  post_rate: number | null;
  avg_likes: number | null;
  avg_replies: number | null;
};

type ScoreBandRow = {
  band: string;
  total: number;
  posted: number;
  expired: number;
  ignored: number;
  post_rate: number | null;
};

type DayOfWeekRow = {
  weekday: number;
  posted: number;
  avg_likes: number | null;
};

type TranslationStatsRow = {
  lang: string;
  generated: number;
  saved: number;
  discarded: number;
  acceptance_rate: number | null;
};

type LatestEngagementRow = {
  draft_id: string;
  platform: string;
  draft_body_preview: string;
  posted_external_url: string | null;
  posted_at: number;
  snapshot_tag: string;
  snapshot_at: number;
  likes: number | null;
  replies: number | null;
  reposts: number | null;
  impressions: number | null;
};

type OverviewStats = {
  funnel: FunnelRow[];
  cost_by_day: CostBucketRow[];
  cost_by_service: CostServiceRow[];
  source_roi: SourceRoiRow[];
  engagement: EngagementSummaryRow[];
  latest_engagement: LatestEngagementRow[];
  posted_heatmap: HeatmapCell[];
  expired_heatmap: HeatmapCell[];
  edit_hotspots: EditHotspotRow[];
  radar_engagement: RadarEngagementRow[];
  format_engagement: FormatEngagementRow[];
  score_bands: ScoreBandRow[];
  dow_posting: DayOfWeekRow[];
  translations: TranslationStatsRow[];
  totals: {
    drafts_total: number;
    drafts_posted: number;
    cost_total_usd: number;
    cost_per_posted_usd: number | null;
    sub_leverage_usd: number;
    avg_edit_ratio: number | null;
  };
};

// ────────────────────────── Helpers ──────────────────────────

type TabId = 'feed' | 'sources' | 'stats' | 'settings';
type PlatformFilter = 'all' | Platform;
type FeedFilter = 'proposed' | 'viewed' | 'posted' | 'expired' | 'archived';

const FEED_STATUS_MAP: Record<FeedFilter, DraftStatus[]> = {
  proposed: ['proposed'],
  viewed: ['viewed'],
  posted: ['approved', 'posted'],
  expired: ['expired'],
  archived: ['ignored', 'rejected'],
};

const PLATFORM_CHIP_TONE: Record<Platform, 'accent' | 'warn' | 'success' | 'neutral'> = {
  reddit: 'warn',
  x: 'accent',
};

/**
 * Brand marks for the supported platforms. Inline SVG so they ship in the
 * bundle (no extra HTTP round-trip), color-correct on light/dark themes,
 * and crisp at any size.
 */
function PlatformIcon({
  platform,
  size = 14,
  withLabel = false,
}: {
  platform: Platform;
  size?: number;
  withLabel?: boolean;
}) {
  const icon =
    platform === 'reddit' ? (
      <svg
        width={size}
        height={size}
        viewBox="0 0 20 20"
        aria-label="Reddit"
        role="img"
        style={{ display: 'inline-block', verticalAlign: 'text-bottom' }}
      >
        <circle cx="10" cy="10" r="10" fill="#FF4500" />
        <path
          d="M16.6 9.5a1.7 1.7 0 0 0-2.85-1.21 8.4 8.4 0 0 0-3.95-.95l.7-3.07 2.16.45a1.2 1.2 0 1 0 .15-.94l-2.7-.56-.92 4.13a8.4 8.4 0 0 0-3.93.96 1.7 1.7 0 1 0-1.86 2.79 3 3 0 0 0-.06.6c0 2.32 2.62 4.2 5.84 4.2s5.84-1.88 5.84-4.2a3 3 0 0 0-.06-.6 1.7 1.7 0 0 0 .65-1.6Z"
          fill="white"
        />
        <ellipse cx="7.7" cy="11.1" rx=".95" ry="1.1" fill="#FF4500" />
        <ellipse cx="12.3" cy="11.1" rx=".95" ry="1.1" fill="#FF4500" />
        <path
          d="M12.3 13.2c-.5.45-1.35.7-2.3.7s-1.8-.25-2.3-.7"
          stroke="#FF4500"
          strokeWidth="0.65"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    ) : (
      <svg
        width={size}
        height={size}
        viewBox="0 0 20 20"
        aria-label="X"
        role="img"
        style={{ display: 'inline-block', verticalAlign: 'text-bottom' }}
      >
        <rect width="20" height="20" rx="3" fill="#000" />
        <path
          d="M13.4 4.4h2.06l-4.5 5.14L16.27 16h-4.14l-3.24-4.24L4.97 16H2.9l4.81-5.5L2.7 4.4h4.24l2.93 3.87Zm-.72 10.34h1.14L6.4 5.58H5.18Z"
          fill="#fff"
        />
      </svg>
    );

  if (!withLabel) return icon;
  return (
    <span className="inline-flex items-center gap-1">
      {icon}
      <span>{platform === 'reddit' ? 'Reddit' : 'X'}</span>
    </span>
  );
}

function parseJsonArray(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function parseThreadSnapshot(raw: string): {
  title?: string;
  body?: string;
  author?: string;
  score?: number;
} {
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch {
    return {};
  }
}

function parseImagePlan(raw: string | null): ImagePlan | null {
  if (!raw) return null;
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? (obj as ImagePlan) : null;
  } catch {
    return null;
  }
}

function formatError(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

function relativeFromSeconds(deltaSec: number): string {
  if (deltaSec <= 0) return '0m';
  if (deltaSec < 60) return `${deltaSec}s`;
  if (deltaSec < 3600) return `${Math.floor(deltaSec / 60)}m`;
  if (deltaSec < 86400) return `${Math.floor(deltaSec / 3600)}h`;
  return `${Math.floor(deltaSec / 86400)}d`;
}

function relativeTime(ts: number | null): string {
  if (!ts) return '—';
  const delta = Math.floor(Date.now() / 1000) - ts;
  return relativeFromSeconds(Math.abs(delta));
}

function freshnessLabel(expiresAt: number): { label: string; tone: 'accent' | 'warn' | 'danger' } {
  const delta = expiresAt - Math.floor(Date.now() / 1000);
  if (delta <= 0) return { label: 'expired', tone: 'danger' };
  const rel = relativeFromSeconds(delta);
  if (delta < 1800) return { label: `${rel} left`, tone: 'danger' };
  if (delta < 7200) return { label: `${rel} left`, tone: 'warn' };
  return { label: `${rel} left`, tone: 'accent' };
}

// ────────────────────────── Route ──────────────────────────

export default function PresenceRoute() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<TabId>('feed');
  const [platformFilter, setPlatformFilter] = useState<PlatformFilter>('all');
  const [feedFilter, setFeedFilter] = useState<FeedFilter>('proposed');
  const [sources, setSources] = useState<SourceRow[]>([]);
  const [drafts, setDrafts] = useState<DraftRow[]>([]);
  const [feedSummary, setFeedSummary] = useState<FeedSummary | null>(null);
  const [stats, setStats] = useState<OverviewStats | null>(null);
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [connectStatus, setConnectStatus] = useState<ConnectStatus>({
    reddit: false,
    x: false,
    openrouter: false,
  });
  const [statsWindow, setStatsWindow] = useState<7 | 30 | 90>(30);
  const [scanBusy, setScanBusy] = useState(false);
  const [lastScan, setLastScan] = useState<ScanOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // Bulk-select state for the feed: a Set of draft ids the user has ticked.
  // Reset whenever the platform/feed filter changes so we don't carry stale
  // selections into a different view.
  const [selectedDraftIds, setSelectedDraftIds] = useState<Set<string>>(() => new Set());
  // Advanced filters (collapsed UI). Score range + source restriction +
  // creation date range. Applied client-side on the loaded `drafts` array
  // (200-row cap means filtering in memory is trivial).
  const [filterMinScore, setFilterMinScore] = useState(0);
  const [filterMaxScore, setFilterMaxScore] = useState(1);
  const [filterSourceId, setFilterSourceId] = useState<string>('');
  const [filterDaysBack, setFilterDaysBack] = useState<number>(0); // 0 = no limit
  const [filtersOpen, setFiltersOpen] = useState(false);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2800);
  }, []);

  const loadFeed = useCallback(async () => {
    try {
      const platform = platformFilter === 'all' ? '' : `&platform=${platformFilter}`;
      const statuses = FEED_STATUS_MAP[feedFilter].join(',');
      // Two parallel reads: drafts + feed-summary (for the top-source chip).
      // Feed-summary is a tiny aggregate (< 5 ms) so the parallel cost is
      // negligible vs the drafts query, and the chip refreshes whenever
      // the user runs a scan or transitions a draft.
      const [rows, summary] = await Promise.all([
        apiGet<DraftRow[]>(`/api/presence/drafts?status=${statuses}${platform}&limit=200`),
        apiGet<FeedSummary>('/api/presence/feed-summary'),
      ]);
      setDrafts(rows);
      setFeedSummary(summary);
      setError(null);
    } catch (e) {
      setError(formatError(e));
    }
  }, [platformFilter, feedFilter]);

  const loadSources = useCallback(async () => {
    try {
      const rows = await apiGet<SourceRow[]>('/api/presence/sources');
      setSources(rows);
      setError(null);
    } catch (e) {
      setError(formatError(e));
    }
  }, []);

  const loadStats = useCallback(async (window: 7 | 30 | 90) => {
    try {
      const s = await apiGet<OverviewStats>(`/api/presence/stats?windowDays=${window}`);
      setStats(s);
      setError(null);
    } catch (e) {
      setError(formatError(e));
    }
  }, []);

  const loadConnections = useCallback(async () => {
    try {
      const [rows, status] = await Promise.all([
        apiGet<ConnectionRow[]>('/api/presence/connections'),
        apiGet<ConnectStatus>('/api/presence/connect/status'),
      ]);
      setConnections(rows);
      setConnectStatus(status);
      setError(null);
    } catch (e) {
      setError(formatError(e));
    }
  }, []);

  const loadStatus = useCallback(async () => {
    try {
      const status = await apiGet<ConnectStatus>('/api/presence/connect/status');
      setConnectStatus(status);
    } catch {
      /* non-fatal */
    }
  }, []);

  useEffect(() => {
    if (tab === 'feed') void loadFeed();
    if (tab === 'sources') void loadSources();
    if (tab === 'stats') void loadStats(statsWindow);
    if (tab === 'settings') void loadConnections();
  }, [tab, loadFeed, loadSources, loadStats, loadConnections, statsWindow]);

  // Preload sources (for badge count) + connection status (for scan gating).
  useEffect(() => {
    void loadSources();
    void loadStatus();
  }, [loadSources, loadStatus]);

  const activeSourcesCount = useMemo(() => sources.filter((s) => s.active).length, [sources]);

  // ──── Draft actions ────

  const handleTransition = useCallback(
    async (
      id: string,
      status: DraftStatus,
      extra?: { posted_external_url?: string; posted_external_id?: string },
    ) => {
      try {
        await apiPost(`/api/presence/drafts/${id}/transition`, { status, ...extra });
        await loadFeed();
        showToast(t(`presence.feed.toast.${status}`));
      } catch (e) {
        setError(formatError(e));
      }
    },
    [loadFeed, showToast, t],
  );

  /**
   * Capture the URL of where the user actually posted the draft when they
   * mark it as 'posted'. The URL is parsed for the platform-native id (Reddit
   * permalink → t1_/t3_ fullname; X URL → tweet id) so the engagement poller
   * has what it needs at t+1h / t+24h / t+7d.
   */
  /**
   * "Assist mode" for Reddit (and as a generic fallback). Reddit has been
   * gating new OAuth scripts behind Devvit, which doesn't fit our use case
   * (Devvit apps run inside Reddit's infrastructure, not standalone), so
   * we offer a friction-light alternative:
   *
   *   1. Copy the draft body to the clipboard.
   *   2. Open the original thread (or a submit page for top-level posts)
   *      in a new tab — the user is already logged in there.
   *   3. They paste, click Reply/Post, copy the resulting URL.
   *   4. Prompt for that URL → transition draft to posted (with id parsed
   *      out so the engagement poller picks it up).
   *
   * No Reddit OAuth required. Works for users who never get past Devvit's
   * onboarding maze and still want the engagement loop closed.
   */
  const handleAssistedPost = useCallback(
    async (draft: DraftRow) => {
      // Copy text first; if clipboard fails we still open the URL with a notice.
      let copied = false;
      try {
        await navigator.clipboard.writeText(draft.draft_body);
        copied = true;
      } catch {
        copied = false;
      }

      // If the draft has a generated image, save it as a PNG file the user
      // can drag into the post composer. We can't put both text AND image
      // into the clipboard reliably across browsers (Cmd+V only fires one
      // payload), so the cleanest split is: text → clipboard, image → file.
      // The user pastes the text into the body field, then drags the saved
      // file onto the composer (Reddit/X both accept drop).
      let imageDownloaded = false;
      try {
        const planRaw = draft.image_plan_json;
        if (planRaw) {
          const plan = JSON.parse(planRaw) as { b64?: string | null; url?: string | null };
          if (plan.b64) {
            // Decode base64 → Blob → temporary download link.
            const binary = atob(plan.b64);
            const bytes = new Uint8Array(binary.length);
            for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
            const blob = new Blob([bytes], { type: 'image/png' });
            const url = URL.createObjectURL(blob);
            const link = document.createElement('a');
            link.href = url;
            link.download = `presence-${draft.id.slice(0, 8)}.png`;
            document.body.appendChild(link);
            link.click();
            document.body.removeChild(link);
            // Defer revoke so the browser actually triggers the download.
            setTimeout(() => URL.revokeObjectURL(url), 4000);
            imageDownloaded = true;
          } else if (plan.url) {
            // External URL (rare; usually we have b64). Open it in a new tab
            // so the user can right-click → Save image. Less smooth than the
            // direct download path but at least the image is reachable.
            window.open(plan.url, '_blank', 'noopener,noreferrer');
            imageDownloaded = true;
          }
        }
      } catch {
        // Bad image_plan_json or atob/Blob failure — skip silently. Text
        // copy + URL open still work, and the user can manually fetch the
        // image from the draft card.
      }

      // Pick the best URL to open. Reddit comments → original thread URL
      // with the `#comments` fragment so the page scrolls past the OP and
      // lands near the reply input. Top-level posts → /r/sub/submit pre-
      // filled with title+text (these URL params DO work). X → intent/tweet
      // pre-filled.
      //
      // assistKind is set in parallel because Reddit comments have NO URL
      // mechanism for pre-filling the comment textarea — body lives in
      // clipboard only. The toast message switches on this so the user
      // knows whether to expect a pre-filled composer or a Cmd+V step.
      let openUrl = '';
      let assistKind: 'reddit_comment' | 'reddit_self_post' | 'x_intent' | null = null;
      if (draft.platform === 'reddit') {
        if (draft.external_thread_url) {
          // Comment on existing thread. Append #comments so the browser
          // scrolls past the OP. Skip if the URL already has a fragment.
          openUrl = draft.external_thread_url.includes('#')
            ? draft.external_thread_url
            : `${draft.external_thread_url}#comments`;
          assistKind = 'reddit_comment';
        } else {
          // Top-level post. Try to derive subreddit from snapshot.
          let sub: string | undefined;
          try {
            const snap = JSON.parse(draft.thread_snapshot_json) as { subreddit?: string };
            sub = snap.subreddit;
          } catch {
            /* malformed */
          }
          if (sub) {
            const params = new URLSearchParams({
              title: draft.draft_body.split('\n')[0].slice(0, 300),
              text: draft.draft_body,
              type: 'text',
            });
            openUrl = `https://www.reddit.com/r/${sub}/submit?${params.toString()}`;
            assistKind = 'reddit_self_post';
          }
        }
      } else if (draft.platform === 'x') {
        const params = new URLSearchParams({ text: draft.draft_body });
        openUrl = `https://x.com/intent/tweet?${params.toString()}`;
        assistKind = 'x_intent';
      }

      if (!openUrl) {
        showToast(t('presence.feed.assist.noUrlAvailable'));
        return;
      }
      window.open(openUrl, '_blank', 'noopener,noreferrer');

      // Compose toast message. Reddit comments are special: NO pre-fill
      // possible (Reddit has no URL param for the comment textarea), only
      // clipboard. Other kinds DO pre-fill the composer.
      let toastKey: string;
      if (assistKind === 'reddit_comment') {
        toastKey = copied
          ? imageDownloaded
            ? 'presence.feed.assist.redditCommentWithImage'
            : 'presence.feed.assist.redditComment'
          : 'presence.feed.assist.redditCommentNoCopy';
      } else {
        // self-post / x intent: composer IS pre-filled
        toastKey = imageDownloaded
          ? copied
            ? 'presence.feed.assist.copiedOpenedWithImage'
            : 'presence.feed.assist.openedWithImageNoCopy'
          : copied
            ? 'presence.feed.assist.copiedAndOpened'
            : 'presence.feed.assist.openedNoCopy';
      }
      showToast(t(toastKey, { platform: draft.platform }));

      // Slight delay before prompting for URL so the new tab has time to
      // visually appear, feels less abrupt than firing the prompt
      // simultaneously with the window.open call.
      setTimeout(() => {
        void handleMarkPostedRef.current?.(draft);
      }, 600);
    },
    [showToast, t],
  );

  // Forward-ref to handleMarkPosted so handleAssistedPost can call it
  // without a circular dependency in the useCallback chain. Set below
  // once handleMarkPosted is defined.
  const handleMarkPostedRef = useRef<((d: DraftRow) => Promise<void>) | null>(null);

  const handleMarkPosted = useCallback(
    async (draft: DraftRow) => {
      const platformLabel = draft.platform === 'reddit' ? 'Reddit comment/post' : 'X tweet';
      const url = window.prompt(t('presence.feed.posted.askUrl', { platform: platformLabel }));
      if (url === null) return; // user cancelled
      const trimmed = url.trim();
      const extra: { posted_external_url?: string; posted_external_id?: string } = {};
      if (trimmed.length > 0) {
        extra.posted_external_url = trimmed;
        // Best-effort id extraction so the poller can use the auth path too.
        if (draft.platform === 'x') {
          const m = trimmed.match(/status\/(\d+)/);
          if (m) extra.posted_external_id = m[1];
        } else if (draft.platform === 'reddit') {
          const m = trimmed.match(/comments\/([a-z0-9]+)(?:\/[^/]*\/([a-z0-9]+))?/i);
          if (m) extra.posted_external_id = m[2] ? `t1_${m[2]}` : `t3_${m[1]}`;
        }
      }
      await handleTransition(draft.id, 'posted', extra);
    },
    [handleTransition, t],
  );

  // Wire the ref now that handleMarkPosted exists. The ref pattern dodges
  // a forward-reference cycle between handleAssistedPost and handleMarkPosted.
  useEffect(() => {
    handleMarkPostedRef.current = handleMarkPosted;
  }, [handleMarkPosted]);

  /**
   * Auto-publish path: transitions the draft to `approved` (which the
   * presencePublish worker reads as "user greenlit, please post via API")
   * and immediately fires /publish-now so the user gets feedback within
   * a second instead of waiting up to 60 s for the next scheduler tick.
   *
   * Only meaningful for X drafts — Reddit drafts in `approved` get logged
   * as `reddit_handed_off` by the worker (no API path, deeplink-only).
   * The button is exposed on X cards specifically so the UX stays
   * unambiguous: this is the "let the dashboard post for you" path.
   *
   * Failure surfaces verbatim from the worker outcome: missing OAuth keys,
   * rate cap, cooldown, duplicate, X 4xx — each is a discrete `decision`
   * row in presence_publish_log the user can read in Settings → Logs.
   */
  const handleAutoPublish = useCallback(
    async (draft: DraftRow) => {
      try {
        // 1. Move to `approved`. transitionDraft is idempotent at the
        //    SQL level; calling it on an already-approved draft is a no-op
        //    on status (decided_at COALESCE-protected).
        await apiPost(`/api/presence/drafts/${draft.id}/transition`, { status: 'approved' });

        // 2. Trigger one immediate worker pass instead of waiting for the
        //    60 s tick. The worker walks ALL approved drafts, but only
        //    this draft is fresh — pre-existing approved drafts that hit
        //    the rails (cap, window, cooldown) get re-evaluated too which
        //    is the right behavior (their gates may have lifted).
        const outcome = await apiPost<{
          considered: number;
          published: number;
          reddit_handed_off: number;
          skipped: number;
          failed: number;
          decisions: Array<{
            draft_id: string;
            decision: string;
            reason: string | null;
          }>;
        }>('/api/presence/publish-now', {});

        // 3. Find this draft's specific decision in the outcome so the
        //    toast matches what the worker actually did to THIS card.
        //    (Other approved drafts processed in the same pass aren't
        //    relevant to the user who clicked Auto-post on one card.)
        const mine = outcome.decisions.find((d) => d.draft_id === draft.id);
        if (!mine) {
          showToast(
            t('presence.feed.autoPublish.queued', {
              platform: draft.platform === 'x' ? 'X' : 'Reddit',
            }),
          );
        } else if (mine.decision === 'published') {
          showToast(t('presence.feed.autoPublish.published'));
        } else if (mine.decision === 'reddit_handed_off') {
          showToast(t('presence.feed.autoPublish.redditHandedOff'));
        } else if (mine.decision === 'failed') {
          setError(`${t('presence.feed.autoPublish.failed')}: ${mine.reason ?? '(no detail)'}`);
        } else {
          // skipped_window / skipped_rate_cap / skipped_cooldown /
          // skipped_duplicate / dry_run — surface the reason verbatim.
          showToast(
            t('presence.feed.autoPublish.skipped', {
              decision: mine.decision,
              reason: mine.reason ?? '',
            }),
          );
        }

        await loadFeed();
      } catch (e) {
        setError(formatError(e));
      }
    },
    [loadFeed, showToast, t],
  );

  const handleSaveDraft = useCallback(
    async (id: string, draft_body: string) => {
      try {
        await apiPatch(`/api/presence/drafts/${id}`, { draft_body });
        await loadFeed();
        showToast(t('presence.feed.toast.saved'));
      } catch (e) {
        setError(formatError(e));
      }
    },
    [loadFeed, showToast, t],
  );

  const handleTranslate = useCallback(
    async (id: string, target_lang: 'fr' | 'en' | 'es'): Promise<string | null> => {
      try {
        const res = await apiPost<{ translated: string }>(`/api/presence/drafts/${id}/translate`, {
          target_lang,
        });
        return res.translated;
      } catch (e) {
        setError(formatError(e));
        return null;
      }
    },
    [],
  );

  /**
   * Fire-and-forget telemetry: when the user commits a translation we log
   * `translation_saved`, when they swap back to original or change tab we
   * log `translation_discarded`. Feeds the stats acceptance-rate chart.
   */
  const recordTranslationOutcome = useCallback(
    async (id: string, lang: 'fr' | 'en' | 'es', outcome: 'saved' | 'discarded') => {
      try {
        await apiPost(`/api/presence/drafts/${id}/translation-event`, {
          outcome: outcome === 'saved' ? 'translation_saved' : 'translation_discarded',
          lang,
        });
      } catch {
        /* swallow — telemetry shouldn't break UX */
      }
    },
    [],
  );

  const handleExpireNow = useCallback(async () => {
    try {
      const res = await apiPost<{ expired: number }>('/api/presence/expire', {});
      showToast(t('presence.feed.toast.expireRun', { n: res.expired }));
      await loadFeed();
    } catch (e) {
      setError(formatError(e));
    }
  }, [loadFeed, showToast, t]);

  const handleDeleteDraft = useCallback(
    async (id: string) => {
      try {
        await apiDelete(`/api/presence/drafts/${id}`);
        await loadFeed();
        showToast(t('presence.feed.toast.deleted'));
      } catch (e) {
        setError(formatError(e));
      }
    },
    [loadFeed, showToast, t],
  );

  const toggleDraftSelected = useCallback((id: string) => {
    setSelectedDraftIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Reset selection whenever the visible bucket changes — a draft selected
  // in "proposed" doesn't make sense to keep in "archived".
  useEffect(() => {
    setSelectedDraftIds(new Set());
  }, []);

  const handleBulkTransition = useCallback(
    async (status: DraftStatus) => {
      const ids = [...selectedDraftIds];
      if (ids.length === 0) return;
      try {
        const res = await apiPost<{ changed: number }>('/api/presence/drafts/bulk-transition', {
          ids,
          status,
        });
        showToast(t('presence.feed.toast.bulkApplied', { n: res.changed, status }));
        setSelectedDraftIds(new Set());
        await loadFeed();
      } catch (e) {
        setError(formatError(e));
      }
    },
    [selectedDraftIds, loadFeed, showToast, t],
  );

  const handleBulkApplyByThreshold = useCallback(
    async (ids: string[], status: DraftStatus) => {
      if (ids.length === 0) return;
      try {
        const res = await apiPost<{ changed: number }>('/api/presence/drafts/bulk-transition', {
          ids,
          status,
        });
        showToast(t('presence.feed.toast.bulkApplied', { n: res.changed, status }));
        await loadFeed();
      } catch (e) {
        setError(formatError(e));
      }
    },
    [loadFeed, showToast, t],
  );

  const handleBulkDelete = useCallback(async () => {
    const ids = [...selectedDraftIds];
    if (ids.length === 0) return;
    if (!window.confirm(t('presence.feed.confirmBulkDelete', { n: ids.length }))) return;
    try {
      await Promise.all(ids.map((id) => apiDelete(`/api/presence/drafts/${id}`)));
      showToast(t('presence.feed.toast.bulkDeleted', { n: ids.length }));
      setSelectedDraftIds(new Set());
      await loadFeed();
    } catch (e) {
      setError(formatError(e));
    }
  }, [selectedDraftIds, loadFeed, showToast, t]);

  // Apply the advanced filters to the loaded drafts. Pure derivation so it
  // recomputes only when one of the inputs changes.
  const visibleDrafts = useMemo(() => {
    const cutoff = filterDaysBack > 0 ? Math.floor(Date.now() / 1000) - filterDaysBack * 86400 : 0;
    return drafts.filter((d) => {
      if (d.relevance_score < filterMinScore || d.relevance_score > filterMaxScore) return false;
      if (filterSourceId && d.source_id !== filterSourceId) return false;
      if (cutoff > 0 && d.created_at < cutoff) return false;
      return true;
    });
  }, [drafts, filterMinScore, filterMaxScore, filterSourceId, filterDaysBack]);

  const handleWipeArchived = useCallback(async () => {
    if (!window.confirm(t('presence.feed.confirmWipe'))) return;
    try {
      const res = await apiDelete<{ removed: number }>(
        '/api/presence/drafts?statuses=expired,ignored,rejected',
      );
      showToast(t('presence.feed.toast.wiped', { n: res.removed }));
      await loadFeed();
    } catch (e) {
      setError(formatError(e));
    }
  }, [loadFeed, showToast, t]);

  const handleScanNow = useCallback(
    async (opts: { platform?: Platform; source_id?: string } = {}) => {
      if (scanBusy) return;
      setScanBusy(true);
      // Wrap the whole job (POST + poll loop) in a tracked task so the
      // sidebar Mascot pins on `sweeping` for the full 3-min scan instead
      // of flashing briefly on each individual poll. Path is the kickoff
      // endpoint — the classifier matches /scan → sweeping.
      try {
        await trackTask('/api/presence/scan-now', async () => {
          // Async scan: POST returns 202 + job_id, then we poll status until
          // it's terminal (done | failed). The server walks Reddit + X for up
          // to several minutes; the polling cadence stays cheap (one tiny GET
          // every 3 s) and lets us refresh the feed mid-scan when drafts land.
          const enqueued = await apiPost<{ job_id: string; status: ScanJobStatus }>(
            '/api/presence/scan-now',
            opts,
          );
          showToast(t('presence.scan.toastEnqueued'));

          let job: ScanJob | null = null;
          let lastDraftRefreshAt = 0;
          for (let i = 0; i < 240; i += 1) {
            // 240 polls × 3s = 12 min hard cap. Long enough for any realistic
            // multi-source scan, short enough to bail if the worker hangs.
            await new Promise((r) => setTimeout(r, 3_000));
            job = await apiGet<ScanJob>(`/api/presence/scan-jobs/${enqueued.job_id}`);

            // Refresh the visible feed every ~10 s while scanning so new drafts
            // pop in as they're persisted, instead of all-at-once at the end.
            if (job.status === 'running' && Date.now() - lastDraftRefreshAt > 10_000) {
              void loadFeed();
              lastDraftRefreshAt = Date.now();
            }
            if (job.status === 'done' || job.status === 'failed') break;
          }

          if (!job || job.status === 'failed') {
            setError(job?.error ?? 'scan_timeout');
          } else if (job.status === 'done' && job.outcome) {
            setLastScan(job.outcome);
            // Distinguish three terminal cases so the user understands what
            // happened. Otherwise "0 drafts created" reads as a silent failure
            // when in fact the budget cap or TTL gate intentionally blocked work.
            if (job.outcome.budget_exceeded) {
              // Refresh budget config so the toast/error has the live numbers.
              const cfg = await apiGet<{ todaySpendUsd: number; dailyBudgetUsd: number }>(
                '/api/presence/scheduler-config',
              ).catch(() => null);
              setError(
                t('presence.scan.budgetExceeded', {
                  spent: (cfg?.todaySpendUsd ?? 0).toFixed(4),
                  cap: (cfg?.dailyBudgetUsd ?? 0).toFixed(2),
                }),
              );
            } else if (
              job.outcome.total_drafts_created === 0 &&
              (job.outcome.skipped_ttl ?? 0) > 0
            ) {
              showToast(t('presence.scan.toastTtlSkipped', { n: job.outcome.skipped_ttl ?? 0 }));
            } else {
              showToast(
                t('presence.scan.toastDone', {
                  n: job.outcome.total_drafts_created,
                  cost: job.outcome.total_cost_usd.toFixed(4),
                }),
              );
            }
          }
          await Promise.all([loadFeed(), loadSources()]);
        });
      } catch (e) {
        setError(formatError(e));
      } finally {
        setScanBusy(false);
      }
    },
    [scanBusy, showToast, loadFeed, loadSources, t],
  );

  const handleGenerateImage = useCallback(
    async (draftId: string, kind?: 'diagram' | 'illustration' | 'photo', prompt?: string) => {
      try {
        const payload: Record<string, unknown> = {};
        if (kind) payload.kind = kind;
        if (prompt && prompt.trim().length >= 5) payload.prompt = prompt.trim();
        const res = await apiPost<{ kind: string; reason?: string }>(
          `/api/presence/drafts/${draftId}/image`,
          payload,
        );
        if (res.kind === 'none') {
          showToast(t('presence.feed.toast.imageSkipped', { reason: res.reason ?? '' }));
        } else {
          showToast(t('presence.feed.toast.imageGenerated', { kind: res.kind }));
        }
        await loadFeed();
      } catch (e) {
        setError(formatError(e));
      }
    },
    [loadFeed, showToast, t],
  );

  return (
    <div className="flex flex-col gap-4">
      {/* ────── Header ────── */}
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3">
        <div className="flex items-center gap-3">
          <span className="text-[15px] font-semibold tracking-tight text-[var(--text)]">
            {t('presence.title')}
          </span>
          <span className="text-[11px] text-[var(--text-dim)]">{t('presence.subtitle')}</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Segmented
            value={platformFilter}
            options={[
              { value: 'all' as PlatformFilter, label: t('presence.platform.all') },
              {
                value: 'reddit' as PlatformFilter,
                label: <PlatformIcon platform="reddit" size={13} withLabel />,
              },
              {
                value: 'x' as PlatformFilter,
                label: <PlatformIcon platform="x" size={13} withLabel />,
              },
            ]}
            onChange={setPlatformFilter}
          />
          <Button
            tone="primary"
            onClick={() =>
              void handleScanNow(platformFilter === 'all' ? {} : { platform: platformFilter })
            }
            disabled={scanBusy}
            className="!py-1 !text-[12px]"
            title={t('presence.scan.buttonTitle')}
          >
            {scanBusy ? t('presence.scan.busy') : t('presence.scan.button')}
          </Button>
        </div>
      </header>

      {lastScan ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-1.5 text-[11px] text-[var(--text-dim)]">
          <Chip tone="success">
            {t('presence.scan.resultChip', {
              n: lastScan.total_drafts_created,
              seconds: lastScan.finished_at - lastScan.started_at,
            })}
          </Chip>
          <span>
            Reddit: {lastScan.reddit.reduce((n, o) => n + o.drafts_created, 0)}/
            {lastScan.reddit.reduce((n, o) => n + o.candidates_seen, 0)}
          </span>
          <span>
            X: {lastScan.x.reduce((n, o) => n + o.drafts_created, 0)}/
            {lastScan.x.reduce((n, o) => n + o.candidates_seen, 0)} · $
            {lastScan.total_cost_usd.toFixed(4)}
          </span>
        </div>
      ) : null}

      {/* ────── Error / toast ────── */}
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      {toast ? (
        <output className="block rounded-[var(--radius-sm)] border border-[rgba(48,209,88,0.35)] bg-[rgba(48,209,88,0.08)] px-3 py-1.5 text-[12px] text-[var(--text)]">
          {toast}
        </output>
      ) : null}

      {/* ────── Tabs ────── */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2">
        <Segmented
          value={tab}
          options={[
            { value: 'feed' as TabId, label: t('presence.tabs.feed') },
            {
              value: 'sources' as TabId,
              label: `${t('presence.tabs.sources')} · ${activeSourcesCount}`,
            },
            { value: 'stats' as TabId, label: t('presence.tabs.stats') },
            { value: 'settings' as TabId, label: t('presence.tabs.settings') },
          ]}
          onChange={setTab}
        />
        {tab === 'feed' ? (
          <div className="flex items-center gap-2">
            <Segmented
              value={feedFilter}
              options={[
                { value: 'proposed' as FeedFilter, label: t('presence.feed.filter.proposed') },
                { value: 'viewed' as FeedFilter, label: t('presence.feed.filter.viewed') },
                { value: 'posted' as FeedFilter, label: t('presence.feed.filter.posted') },
                { value: 'expired' as FeedFilter, label: t('presence.feed.filter.expired') },
                { value: 'archived' as FeedFilter, label: t('presence.feed.filter.archived') },
              ]}
              onChange={setFeedFilter}
            />
            <Button
              tone="ghost"
              onClick={() => void handleExpireNow()}
              className="!py-1 !text-[11px]"
            >
              {t('presence.feed.runExpire')}
            </Button>
            <Button
              tone="ghost"
              onClick={() => void handleWipeArchived()}
              className="!py-1 !text-[11px]"
              title={t('presence.feed.wipeArchivedTitle')}
            >
              {t('presence.feed.wipeArchived')}
            </Button>
          </div>
        ) : null}
      </div>

      {/* ────── Body ────── */}
      {tab === 'feed' ? (
        <FeedView
          drafts={visibleDrafts}
          totalDrafts={drafts.length}
          topSource={feedSummary?.top_source ?? null}
          sources={sources}
          filter={feedFilter}
          openrouterReady={connectStatus.openrouter}
          selectedIds={selectedDraftIds}
          onToggleSelect={toggleDraftSelected}
          onBulkTransition={handleBulkTransition}
          onBulkDelete={handleBulkDelete}
          onClearSelection={() => setSelectedDraftIds(new Set())}
          onBulkApplyByThreshold={(ids, status) => void handleBulkApplyByThreshold(ids, status)}
          onMarkPosted={handleMarkPosted}
          onAssistedPost={handleAssistedPost}
          onAutoPublish={handleAutoPublish}
          filterMinScore={filterMinScore}
          filterMaxScore={filterMaxScore}
          filterSourceId={filterSourceId}
          filterDaysBack={filterDaysBack}
          filtersOpen={filtersOpen}
          onSetFilterScore={(min, max) => {
            setFilterMinScore(min);
            setFilterMaxScore(max);
          }}
          onSetFilterSource={setFilterSourceId}
          onSetFilterDaysBack={setFilterDaysBack}
          onToggleFilters={() => setFiltersOpen((v) => !v)}
          onTransition={handleTransition}
          onSave={handleSaveDraft}
          onTranslate={handleTranslate}
          onTranslationOutcome={recordTranslationOutcome}
          onGenerateImage={handleGenerateImage}
          onDelete={handleDeleteDraft}
          t={t}
        />
      ) : null}

      {tab === 'sources' ? (
        <SourcesView
          sources={sources}
          platformFilter={platformFilter}
          scanBusy={scanBusy}
          connectStatus={connectStatus}
          onScan={(src) => void handleScanNow({ source_id: src.id })}
          onChange={() => void loadSources()}
          onError={(e) => setError(formatError(e))}
          t={t}
        />
      ) : null}

      {tab === 'stats' ? (
        <StatsView
          stats={stats}
          window={statsWindow}
          onWindowChange={(w) => {
            setStatsWindow(w);
            void loadStats(w);
          }}
          onError={(e) => setError(formatError(e))}
          onToast={showToast}
          onReload={() => void loadStats(statsWindow)}
          t={t}
        />
      ) : null}

      {tab === 'settings' ? (
        <SettingsView
          connections={connections}
          connectStatus={connectStatus}
          onReload={() => void loadConnections()}
          onError={(e) => setError(formatError(e))}
          onToast={showToast}
          t={t}
        />
      ) : null}
    </div>
  );
}

type Translator = (key: string, vars?: Record<string, string | number>) => string;

// ─────────────────────────────────────────────────────────────────
// Feed
// ─────────────────────────────────────────────────────────────────

function FeedView({
  drafts,
  totalDrafts,
  topSource,
  sources,
  filter,
  openrouterReady,
  selectedIds,
  onToggleSelect,
  onBulkTransition,
  onBulkDelete,
  onClearSelection,
  onBulkApplyByThreshold,
  onMarkPosted,
  onAssistedPost,
  onAutoPublish,
  onTranslate,
  onTranslationOutcome,
  filterMinScore,
  filterMaxScore,
  filterSourceId,
  filterDaysBack,
  filtersOpen,
  onSetFilterScore,
  onSetFilterSource,
  onSetFilterDaysBack,
  onToggleFilters,
  onTransition,
  onSave,
  onGenerateImage,
  onDelete,
  t,
}: {
  drafts: DraftRow[];
  totalDrafts: number;
  topSource: TopSource | null;
  sources: SourceRow[];
  filter: FeedFilter;
  openrouterReady: boolean;
  selectedIds: Set<string>;
  onToggleSelect: (id: string) => void;
  onBulkTransition: (status: DraftStatus) => void;
  onBulkDelete: () => void;
  onClearSelection: () => void;
  onBulkApplyByThreshold: (ids: string[], status: DraftStatus) => void;
  onMarkPosted: (draft: DraftRow) => void;
  onAssistedPost: (draft: DraftRow) => void;
  onAutoPublish: (draft: DraftRow) => void;
  filterMinScore: number;
  filterMaxScore: number;
  filterSourceId: string;
  filterDaysBack: number;
  filtersOpen: boolean;
  onSetFilterScore: (min: number, max: number) => void;
  onSetFilterSource: (id: string) => void;
  onSetFilterDaysBack: (days: number) => void;
  onToggleFilters: () => void;
  onTransition: (id: string, status: DraftStatus) => void;
  onSave: (id: string, body: string) => Promise<void>;
  onTranslate: (id: string, lang: 'fr' | 'en' | 'es') => Promise<string | null>;
  onTranslationOutcome: (
    id: string,
    lang: 'fr' | 'en' | 'es',
    outcome: 'saved' | 'discarded',
  ) => void;
  onGenerateImage: (
    id: string,
    kind?: 'diagram' | 'illustration' | 'photo',
    prompt?: string,
  ) => void;
  onDelete: (id: string) => void;
  t: Translator;
}) {
  const sourceById = new Map(sources.map((s) => [s.id, s]));
  const filteredCount = drafts.length;
  const filtersActive =
    filterMinScore > 0 || filterMaxScore < 1 || filterSourceId !== '' || filterDaysBack > 0;

  return (
    <div className="flex flex-col gap-3">
      {/* Filter toggle + summary line + top-source ROI chip */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-[var(--text-mute)]">
        <div className="flex flex-wrap items-center gap-2">
          <span>
            {filtersActive
              ? t('presence.feed.filteredCount', { shown: filteredCount, total: totalDrafts })
              : t('presence.feed.totalCount', { total: totalDrafts })}
          </span>
          {topSource ? (
            <Chip tone="success">
              🏆{' '}
              {topSource.platform === 'reddit'
                ? `r/${topSource.identifier}`
                : (topSource.label ?? topSource.identifier)}
              {' · '}
              {(topSource.post_rate * 100).toFixed(0)}% {t('presence.feed.topSource.postRate')} (
              {topSource.posted}/{topSource.proposed})
            </Chip>
          ) : null}
        </div>
        <Button tone="ghost" onClick={onToggleFilters} className="!py-1 !text-[11px]">
          {filtersOpen ? t('presence.feed.filtersHide') : t('presence.feed.filtersShow')}
        </Button>
      </div>

      {filtersOpen ? (
        <FeedFiltersBar
          sources={sources}
          filterMinScore={filterMinScore}
          filterMaxScore={filterMaxScore}
          filterSourceId={filterSourceId}
          filterDaysBack={filterDaysBack}
          onSetFilterScore={onSetFilterScore}
          onSetFilterSource={onSetFilterSource}
          onSetFilterDaysBack={onSetFilterDaysBack}
          t={t}
        />
      ) : null}

      {/* Bulk action floating bar (sticky to top of feed when scrolling) */}
      {selectedIds.size > 0 ? (
        <BulkActionBar
          count={selectedIds.size}
          onApprove={() => onBulkTransition('posted')}
          onIgnore={() => onBulkTransition('ignored')}
          onReject={() => onBulkTransition('rejected')}
          onDelete={onBulkDelete}
          onClear={onClearSelection}
          t={t}
        />
      ) : // C1 — quick bulk-action by score threshold. Only renders when there
      // are at least a few proposed drafts to act on; otherwise it'd be
      // a noisy empty bar. Matches against the currently-loaded `drafts`
      // (200-row API cap, plenty for one-shot triage).
      drafts.filter((d) => d.status === 'proposed').length >= 3 ? (
        <BulkByThresholdBar
          drafts={drafts}
          onApply={(ids, status) => onBulkApplyByThreshold(ids, status)}
          t={t}
        />
      ) : null}

      {drafts.length === 0 ? (
        <Section
          title={t('presence.feed.emptyTitle', { filter: t(`presence.feed.filter.${filter}`) })}
        >
          <Empty>
            {filtersActive
              ? t('presence.feed.emptyFiltered')
              : sources.length === 0
                ? t('presence.feed.emptyNoSources')
                : t('presence.feed.emptyWithSources')}
          </Empty>
        </Section>
      ) : (
        drafts.map((d) => (
          <DraftCard
            key={d.id}
            draft={d}
            source={d.source_id ? sourceById.get(d.source_id) || null : null}
            openrouterReady={openrouterReady}
            isSelected={selectedIds.has(d.id)}
            onToggleSelect={() => onToggleSelect(d.id)}
            onTransition={onTransition}
            onMarkPosted={onMarkPosted}
            onAssistedPost={onAssistedPost}
            onAutoPublish={onAutoPublish}
            onSave={onSave}
            onTranslate={onTranslate}
            onTranslationOutcome={onTranslationOutcome}
            onGenerateImage={onGenerateImage}
            onDelete={onDelete}
            t={t}
          />
        ))
      )}
    </div>
  );
}

/**
 * Bulk action by score threshold. Renders only when there are 3+ proposed
 * drafts loaded. The user picks a min score, sees the count of matches,
 * and clicks an action that fires the existing bulk-transition endpoint
 * with the matched IDs.
 */
function BulkByThresholdBar({
  drafts,
  onApply,
  t,
}: {
  drafts: DraftRow[];
  onApply: (ids: string[], status: DraftStatus) => void;
  t: Translator;
}) {
  const [minScore, setMinScore] = useState(0.85);
  const matched = useMemo(
    () =>
      drafts
        .filter((d) => d.status === 'proposed' && d.relevance_score >= minScore)
        .map((d) => d.id),
    [drafts, minScore],
  );

  function fire(status: DraftStatus) {
    if (matched.length === 0) return;
    if (
      !window.confirm(
        t('presence.feed.thresholdBulk.confirm', {
          n: matched.length,
          score: (minScore * 100).toFixed(0),
          status,
        }),
      )
    ) {
      return;
    }
    onApply(matched, status);
  }

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-[11px] text-[var(--text-mute)]">
      <span>{t('presence.feed.thresholdBulk.label')}</span>
      <span className="num text-[var(--text)]">≥ {(minScore * 100).toFixed(0)}%</span>
      <input
        type="range"
        min={50}
        max={100}
        value={minScore * 100}
        onChange={(e) => setMinScore(Number(e.target.value) / 100)}
        className="w-32"
        aria-label={t('presence.feed.thresholdBulk.label')}
      />
      <Chip tone={matched.length > 0 ? 'accent' : 'neutral'}>
        {t('presence.feed.thresholdBulk.matchCount', { n: matched.length })}
      </Chip>
      <div className="ml-auto flex items-center gap-1">
        <Button
          tone="primary"
          onClick={() => fire('posted')}
          disabled={matched.length === 0}
          className="!py-1 !text-[11px]"
        >
          {t('presence.feed.bulk.approve')}
        </Button>
        <Button
          tone="ghost"
          onClick={() => fire('ignored')}
          disabled={matched.length === 0}
          className="!py-1 !text-[11px]"
        >
          {t('presence.feed.bulk.ignore')}
        </Button>
        <Button
          tone="ghost"
          onClick={() => fire('rejected')}
          disabled={matched.length === 0}
          className="!py-1 !text-[11px]"
        >
          {t('presence.feed.bulk.reject')}
        </Button>
      </div>
    </div>
  );
}

function BulkActionBar({
  count,
  onApprove,
  onIgnore,
  onReject,
  onDelete,
  onClear,
  t,
}: {
  count: number;
  onApprove: () => void;
  onIgnore: () => void;
  onReject: () => void;
  onDelete: () => void;
  onClear: () => void;
  t: Translator;
}) {
  return (
    <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius-sm)] border border-[var(--accent)] bg-[var(--surface-1)] px-3 py-2 text-[12px] shadow-md">
      <span className="font-medium text-[var(--text)]">
        {t('presence.feed.bulkSelected', { n: count })}
      </span>
      <div className="flex items-center gap-1">
        <Button tone="primary" onClick={onApprove} className="!py-1 !text-[11px]">
          {t('presence.feed.bulk.approve')}
        </Button>
        <Button tone="ghost" onClick={onIgnore} className="!py-1 !text-[11px]">
          {t('presence.feed.bulk.ignore')}
        </Button>
        <Button tone="ghost" onClick={onReject} className="!py-1 !text-[11px]">
          {t('presence.feed.bulk.reject')}
        </Button>
        <Button tone="ghost" onClick={onDelete} className="!py-1 !text-[11px]">
          {t('presence.feed.bulk.delete')}
        </Button>
        <Button tone="ghost" onClick={onClear} className="!py-1 !text-[11px]">
          {t('common.cancel')}
        </Button>
      </div>
    </div>
  );
}

function FeedFiltersBar({
  sources,
  filterMinScore,
  filterMaxScore,
  filterSourceId,
  filterDaysBack,
  onSetFilterScore,
  onSetFilterSource,
  onSetFilterDaysBack,
  t,
}: {
  sources: SourceRow[];
  filterMinScore: number;
  filterMaxScore: number;
  filterSourceId: string;
  filterDaysBack: number;
  onSetFilterScore: (min: number, max: number) => void;
  onSetFilterSource: (id: string) => void;
  onSetFilterDaysBack: (days: number) => void;
  t: Translator;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-3 md:grid-cols-3">
      <label className="flex flex-col gap-1 text-[11px] text-[var(--text-dim)]">
        <span>
          {t('presence.feed.filters.score')}: {(filterMinScore * 100).toFixed(0)}%–
          {(filterMaxScore * 100).toFixed(0)}%
        </span>
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={0}
            max={100}
            value={filterMinScore * 100}
            onChange={(e) => onSetFilterScore(Number(e.target.value) / 100, filterMaxScore)}
            className="flex-1"
          />
          <input
            type="range"
            min={0}
            max={100}
            value={filterMaxScore * 100}
            onChange={(e) => onSetFilterScore(filterMinScore, Number(e.target.value) / 100)}
            className="flex-1"
          />
        </div>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-[var(--text-dim)]">
        <span>{t('presence.feed.filters.source')}</span>
        <select
          value={filterSourceId}
          onChange={(e) => onSetFilterSource(e.target.value)}
          className="!py-1 !text-[12px]"
        >
          <option value="">{t('presence.feed.filters.allSources')}</option>
          {sources.map((s) => (
            <option key={s.id} value={s.id}>
              {s.platform} · {s.label || s.identifier}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-[11px] text-[var(--text-dim)]">
        <span>{t('presence.feed.filters.daysBack')}</span>
        <select
          value={filterDaysBack}
          onChange={(e) => onSetFilterDaysBack(Number(e.target.value))}
          className="!py-1 !text-[12px]"
        >
          <option value={0}>{t('presence.feed.filters.daysAll')}</option>
          <option value={1}>1d</option>
          <option value={3}>3d</option>
          <option value={7}>7d</option>
          <option value={14}>14d</option>
          <option value={30}>30d</option>
        </select>
      </label>
    </div>
  );
}

function DraftCard({
  draft,
  source,
  openrouterReady,
  isSelected,
  onToggleSelect,
  onTransition,
  onMarkPosted,
  onAssistedPost,
  onAutoPublish,
  onSave,
  onTranslate,
  onTranslationOutcome,
  onGenerateImage,
  onDelete,
  t,
}: {
  draft: DraftRow;
  source: SourceRow | null;
  openrouterReady: boolean;
  isSelected: boolean;
  onToggleSelect: () => void;
  onTransition: (
    id: string,
    status: DraftStatus,
    extra?: { posted_external_url?: string; posted_external_id?: string },
  ) => void;
  onMarkPosted: (draft: DraftRow) => void;
  onAssistedPost: (draft: DraftRow) => void;
  onAutoPublish: (draft: DraftRow) => void;
  onSave: (id: string, body: string) => Promise<void>;
  onTranslate: (id: string, lang: 'fr' | 'en' | 'es') => Promise<string | null>;
  onTranslationOutcome: (
    id: string,
    lang: 'fr' | 'en' | 'es',
    outcome: 'saved' | 'discarded',
  ) => void;
  onGenerateImage: (
    id: string,
    kind?: 'diagram' | 'illustration' | 'photo',
    prompt?: string,
  ) => void;
  onDelete: (id: string) => void;
  t: Translator;
}) {
  const [editing, setEditing] = useState(false);
  const [editBody, setEditBody] = useState(draft.draft_body);
  const [saving, setSaving] = useState(false);
  // Inline translation: instead of stacking a preview block under the body
  // (which used to nearly double card height), we swap the body view in
  // place. `viewLang` controls which version is rendered. `translations`
  // caches loaded variants so re-clicking a tab is instant. The "Save as
  // body" affordance only shows when the user is viewing a translation
  // they haven't committed yet.
  type TranslationLang = 'fr' | 'en' | 'es';
  const [viewLang, setViewLang] = useState<'original' | TranslationLang>('original');
  const [translations, setTranslations] = useState<Map<TranslationLang, string>>(() => new Map());
  const [translatingTo, setTranslatingTo] = useState<TranslationLang | null>(null);

  async function selectLang(lang: 'original' | TranslationLang) {
    // Track discard whenever the user leaves a translation view without
    // committing — feeds the acceptance rate stat per language.
    if (viewLang !== 'original' && lang !== viewLang) {
      onTranslationOutcome(draft.id, viewLang, 'discarded');
    }
    if (lang === 'original') {
      setViewLang('original');
      return;
    }
    if (translations.has(lang)) {
      setViewLang(lang);
      return;
    }
    if (translatingTo) return;
    setTranslatingTo(lang);
    try {
      const text = await onTranslate(draft.id, lang);
      if (text) {
        setTranslations((prev) => new Map(prev).set(lang, text));
        setViewLang(lang);
      }
    } finally {
      setTranslatingTo(null);
    }
  }

  // Body the user currently sees (original or a cached translation).
  const visibleBody =
    viewLang === 'original' ? draft.draft_body : (translations.get(viewLang) ?? draft.draft_body);
  const isTranslated = viewLang !== 'original';

  async function commitTranslation() {
    if (!isTranslated) return;
    const text = translations.get(viewLang);
    if (!text) return;
    onTranslationOutcome(draft.id, viewLang, 'saved');
    await onSave(draft.id, text);
    // After committing, the original IS now this translation. Reset state
    // so the user lands back on the (newly committed) "original" view.
    setTranslations(new Map());
    setViewLang('original');
  }

  useEffect(() => {
    setEditBody(draft.draft_body);
  }, [draft.draft_body]);

  const snapshot = parseThreadSnapshot(draft.thread_snapshot_json);
  const citations = parseJsonArray(draft.vault_citations_json);
  const imagePlan = parseImagePlan(draft.image_plan_json);
  const freshness = freshnessLabel(draft.freshness_expires_at);
  const sourceLabel = source
    ? source.label || `${source.kind}:${source.identifier}`
    : t('presence.feed.unknownSource');

  async function handleSaveClick() {
    setSaving(true);
    try {
      await onSave(draft.id, editBody);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="!p-3">
      <header className="mb-2 flex flex-wrap items-center gap-2 text-[11px]">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={onToggleSelect}
          className="cursor-pointer"
          aria-label={t('presence.feed.bulkSelectAria')}
          title={t('presence.feed.bulkSelectAria')}
        />
        <Chip tone={PLATFORM_CHIP_TONE[draft.platform]}>
          <PlatformIcon platform={draft.platform} size={12} />
        </Chip>
        <Chip tone="neutral">{draft.format}</Chip>
        <Chip tone={draft.relevance_score >= 0.75 ? 'success' : 'neutral'}>
          {t('presence.feed.score', { n: (draft.relevance_score * 100).toFixed(0) })}
        </Chip>
        <Chip tone={freshness.tone === 'danger' ? 'warn' : 'accent'}>{freshness.label}</Chip>
        <span className="text-[var(--text-dim)]">{sourceLabel}</span>
        {draft.external_thread_url ? (
          <a
            href={draft.external_thread_url}
            target="_blank"
            rel="noreferrer noopener"
            className="text-[var(--accent)] hover:underline"
          >
            {t('presence.feed.openThread')} ↗
          </a>
        ) : null}
        <span className="ml-auto text-[10px] text-[var(--text-faint)]">
          {relativeTime(draft.created_at)}
        </span>
        <button
          type="button"
          onClick={() => {
            if (window.confirm(t('presence.feed.confirmDeleteDraft'))) onDelete(draft.id);
          }}
          className="-mr-1 flex h-5 w-5 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[14px] leading-none text-[var(--text-faint)] hover:bg-[rgba(255,69,58,0.12)] hover:text-[var(--danger)]"
          aria-label={t('common.delete')}
          title={t('presence.feed.deleteDraftTitle')}
        >
          ×
        </button>
      </header>

      {snapshot.title || snapshot.author ? (
        <div className="mb-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-1.5 text-[11px] text-[var(--text-mute)]">
          {snapshot.author ? (
            <span className="font-medium text-[var(--text)]">@{snapshot.author}</span>
          ) : null}
          {snapshot.title ? <span className="ml-1.5">{snapshot.title}</span> : null}
        </div>
      ) : null}

      {/* Language tabs: shown only in non-edit mode. Translation lazy-loads
          on first click; subsequent clicks are instant. The "Save" pill on
          the right commits the visible translation as the new draft body. */}
      {!editing ? (
        <div className="mb-1.5 flex flex-wrap items-center gap-1 text-[10px]">
          {(['original', 'fr', 'en', 'es'] as const).map((lang) => {
            const active = viewLang === lang;
            const cached = lang !== 'original' && translations.has(lang);
            const busy = translatingTo === lang;
            return (
              <button
                key={lang}
                type="button"
                onClick={() => void selectLang(lang)}
                disabled={busy || (translatingTo !== null && lang !== 'original')}
                className={`rounded-[var(--radius-sm)] px-1.5 py-0.5 ${
                  active
                    ? 'bg-[var(--accent)] text-black'
                    : 'bg-[var(--surface-2)] text-[var(--text-mute)] hover:bg-[var(--surface-3)]'
                }`}
                title={
                  lang === 'original'
                    ? t('presence.feed.translate.original')
                    : t('presence.feed.translate.title', { lang: lang.toUpperCase() })
                }
              >
                {lang === 'original' ? 'OG' : lang.toUpperCase()}
                {busy ? '…' : cached && !active ? '·' : ''}
              </button>
            );
          })}
          {isTranslated ? (
            <button
              type="button"
              onClick={() => void commitTranslation()}
              className="ml-2 rounded-[var(--radius-sm)] bg-[var(--surface-2)] px-1.5 py-0.5 text-[var(--accent)] hover:bg-[var(--surface-3)]"
              title={t('presence.feed.translate.useTitle')}
            >
              {t('presence.feed.translate.useShort')}
            </button>
          ) : null}
        </div>
      ) : null}

      {editing ? (
        <textarea
          value={editBody}
          onChange={(e) => setEditBody(e.target.value)}
          className="w-full min-h-[120px] text-[12px] !py-2"
          rows={Math.max(4, editBody.split('\n').length + 1)}
        />
      ) : (
        <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-[var(--text)]">
          {visibleBody}
        </p>
      )}

      {draft.draft_rationale ? (
        <p className="mt-2 text-[11px] italic text-[var(--text-dim)]">{draft.draft_rationale}</p>
      ) : null}

      {citations.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1 text-[11px]">
          {citations.map((c) => (
            <Chip key={c} tone="neutral" title={c}>
              [[{c}]]
            </Chip>
          ))}
        </div>
      ) : null}

      {imagePlan ? (
        <ImagePlanBlock
          plan={imagePlan}
          draftId={draft.id}
          openrouterReady={openrouterReady}
          onGenerate={(id, kind, prompt) => onGenerateImage(id, kind, prompt)}
          t={t}
        />
      ) : null}

      <footer className="mt-3 flex flex-wrap items-center justify-end gap-1 border-t border-[var(--border)] pt-2">
        {draft.status === 'proposed' || draft.status === 'viewed' ? (
          <>
            {editing ? (
              <>
                <Button
                  tone="primary"
                  onClick={() => void handleSaveClick()}
                  disabled={saving}
                  className="!py-1 !text-[11px]"
                >
                  {saving ? t('common.saving') : t('common.save')}
                </Button>
                <Button
                  tone="ghost"
                  onClick={() => {
                    setEditing(false);
                    setEditBody(draft.draft_body);
                  }}
                  className="!py-1 !text-[11px]"
                >
                  {t('common.cancel')}
                </Button>
              </>
            ) : (
              <Button tone="ghost" onClick={() => setEditing(true)} className="!py-1 !text-[11px]">
                {t('presence.feed.actions.edit')}
              </Button>
            )}
            <Button
              tone="ghost"
              onClick={() => onGenerateImage(draft.id)}
              disabled={!openrouterReady}
              className="!py-1 !text-[11px]"
              title={
                openrouterReady
                  ? t('presence.feed.actions.imageTitle')
                  : t('presence.feed.actions.imageNeedsKey')
              }
            >
              {imagePlan?.url || imagePlan?.b64
                ? t('presence.feed.actions.imageRegen')
                : t('presence.feed.actions.image')}
            </Button>
            {/* Assist mode: copy body + open thread/intent in new tab,
                then prompt URL on return. Reddit-friendly fallback when
                /prefs/apps OAuth isn't available, also useful for X
                without OAuth 1.0a setup. Always rendered. */}
            <Button
              tone="ghost"
              onClick={() => onAssistedPost(draft)}
              className="!py-1 !text-[11px]"
              title={t('presence.feed.actions.assistTitle', {
                platform: draft.platform === 'reddit' ? 'Reddit' : 'X',
              })}
            >
              {t('presence.feed.actions.assist')}
            </Button>
            {/* Auto-publish (X only). Transitions the draft to `approved`
                and immediately fires /publish-now. The presencePublish
                worker calls xPostTweet() via the OAuth 1.0a creds the
                user already saved in Settings. Reddit drafts don't get
                this button because Reddit has no auth-free posting API
                — the deeplink path via "Ouvrir & copier" is the only
                ToS-compliant route there. */}
            {draft.platform === 'x' ? (
              <Button
                tone="primary"
                onClick={() => onAutoPublish(draft)}
                className="!py-1 !text-[11px]"
                title={t('presence.feed.actions.autoPublishTitle')}
              >
                {t('presence.feed.actions.autoPublish')}
              </Button>
            ) : null}
            <Button
              tone="ghost"
              onClick={() => onMarkPosted(draft)}
              className="!py-1 !text-[11px]"
              title={t('presence.feed.actions.markPostedTitle')}
            >
              {t('presence.feed.actions.markPosted')}
            </Button>
            <Button
              tone="ghost"
              onClick={() => onTransition(draft.id, 'ignored')}
              className="!py-1 !text-[11px]"
            >
              {t('presence.feed.actions.ignore')}
            </Button>
            <Button
              tone="ghost"
              onClick={() => onTransition(draft.id, 'rejected')}
              className="!py-1 !text-[11px]"
            >
              {t('presence.feed.actions.reject')}
            </Button>
          </>
        ) : (
          <span className="text-[11px] text-[var(--text-dim)]">
            {t('presence.feed.terminalStatus', { status: draft.status })}
          </span>
        )}
      </footer>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────────
// Sources
// ─────────────────────────────────────────────────────────────────

function ImagePlanBlock({
  plan,
  draftId,
  openrouterReady,
  onGenerate,
  t,
}: {
  plan: ImagePlan;
  draftId: string;
  openrouterReady: boolean;
  onGenerate: (id: string, kind: 'diagram' | 'illustration' | 'photo', prompt: string) => void;
  t: Translator;
}) {
  if (plan.kind === 'none') return null;
  const hasImage = Boolean(plan.url || plan.b64 || (plan.kind === 'diagram' && plan.mermaid));
  // Suggestion mode: classifier proposed a kind+prompt at scan time but no
  // image is generated yet. Show editable prompt + 1-click generate button.
  const isSuggestion = plan.suggested === true && !hasImage;

  const [editedPrompt, setEditedPrompt] = useState<string>(plan.prompt ?? '');
  useEffect(() => {
    setEditedPrompt(plan.prompt ?? '');
  }, [plan.prompt]);

  return (
    <div className="mt-3 flex flex-col gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-2.5">
      <div className="flex items-center gap-2 text-[11px] text-[var(--text-dim)]">
        <Chip tone={isSuggestion ? 'warn' : 'accent'}>
          {isSuggestion ? `${t('presence.feed.imageSuggested')} · ${plan.kind}` : plan.kind}
        </Chip>
        {plan.model ? <span>{plan.model}</span> : null}
        {plan.cost_usd != null ? <span>${plan.cost_usd.toFixed(4)}</span> : null}
      </div>

      {isSuggestion && plan.kind !== 'diagram' ? (
        <>
          <textarea
            value={editedPrompt}
            onChange={(e) => setEditedPrompt(e.target.value)}
            placeholder={t('presence.feed.imagePromptPlaceholder')}
            className="w-full min-h-[60px] !py-2 text-[11px]"
            rows={3}
          />
          <div className="flex items-center justify-end gap-2">
            <Button
              tone="primary"
              onClick={() =>
                onGenerate(
                  draftId,
                  plan.kind as 'illustration' | 'photo',
                  editedPrompt.trim() || (plan.prompt ?? ''),
                )
              }
              disabled={!openrouterReady || editedPrompt.trim().length < 5}
              className="!py-1 !text-[11px]"
              title={
                openrouterReady
                  ? t('presence.feed.imageGenerateTitle')
                  : t('presence.feed.actions.imageNeedsKey')
              }
            >
              {t('presence.feed.imageGenerate')}
            </Button>
          </div>
        </>
      ) : null}

      {plan.kind === 'diagram' && plan.mermaid ? (
        <pre className="overflow-x-auto rounded-[var(--radius-sm)] bg-[var(--surface-3)] p-2 text-[11px] text-[var(--text)]">
          {plan.mermaid}
        </pre>
      ) : null}
      {plan.url ? (
        <img
          src={plan.url}
          alt={t('presence.feed.imageAlt')}
          className="max-h-[260px] rounded-[var(--radius-sm)] border border-[var(--border)] object-contain"
        />
      ) : null}
      {plan.b64 ? (
        <img
          src={`data:image/png;base64,${plan.b64}`}
          alt={t('presence.feed.imageAlt')}
          className="max-h-[260px] rounded-[var(--radius-sm)] border border-[var(--border)] object-contain"
        />
      ) : null}
      {plan.prompt && !isSuggestion ? (
        <p className="text-[11px] italic text-[var(--text-faint)]">{plan.prompt}</p>
      ) : null}
    </div>
  );
}

/**
 * Compact health-band chip with hover tooltip containing the raw metrics.
 * Tone bands: green for performers, neutral for fresh, warn for noisy/stale,
 * danger for dead. The tooltip shows the JSON metrics so the user can
 * eyeball "why is this stale?" without leaving the table.
 */
function SourceHealthBadge({ source, t }: { source: SourceRow; t: Translator }) {
  const status = source.health_status;
  if (!status) {
    return <span className="text-[10px] text-[var(--text-faint)]">—</span>;
  }
  const tone: 'success' | 'accent' | 'neutral' | 'warn' | 'danger' = (() => {
    switch (status) {
      case 'workhorse':
        return 'success';
      case 'pristine':
        return 'accent';
      case 'noisy':
      case 'stale':
        return 'warn';
      case 'dead':
        return 'danger';
      default:
        return 'neutral';
    }
  })();

  // Tooltip body assembled from health_metrics_json so the user sees the
  // signal that drove the band without opening a separate panel.
  let tip = t(`presence.sources.health.${status}`);
  try {
    if (source.health_metrics_json) {
      const m = JSON.parse(source.health_metrics_json) as SourceHealthMetrics;
      const bits = [
        `posted_30d=${m.posted_30d}`,
        `proposed_30d=${m.proposed_30d}`,
        m.avg_edit_ratio != null ? `edit_ratio=${m.avg_edit_ratio.toFixed(2)}` : null,
        m.last_scanned_at
          ? `last_scan=${new Date(m.last_scanned_at * 1000).toISOString().slice(0, 16)}`
          : null,
      ].filter(Boolean);
      tip += `\n${bits.join(' · ')}`;
    }
  } catch {
    // metrics JSON malformed — keep the plain label as tooltip
  }
  return (
    <span title={tip}>
      <Chip tone={tone}>{status}</Chip>
    </span>
  );
}

function SourcesView({
  sources,
  platformFilter,
  scanBusy,
  connectStatus,
  onScan,
  onChange,
  onError,
  t,
}: {
  sources: SourceRow[];
  platformFilter: PlatformFilter;
  scanBusy: boolean;
  connectStatus: ConnectStatus;
  onScan: (src: SourceRow) => void;
  onChange: () => void;
  onError: (e: unknown) => void;
  t: Translator;
}) {
  // Health filter — narrows the visible list to a single ROI band so the
  // user can sweep "show me the dead ones" + bulk-deactivate, etc. 'all'
  // (default) shows every band.
  const [healthFilter, setHealthFilter] = useState<SourceHealthStatus | 'all' | 'no_status'>('all');
  const [healthRefreshing, setHealthRefreshing] = useState(false);

  // Discovery suggestions (Pack D) — graph-based candidates pulled either
  // from existing reddit sidebars or from co-cited X handles in recent
  // high-score drafts. Lazy-fetched per platform; one click adds the
  // source (with Pack A validation enforced server-side).
  type DiscoverySuggestion = {
    platform: 'reddit' | 'x';
    kind: 'subreddit' | 'x_user';
    identifier: string;
    count: number;
    evidence: string[];
  };
  const [discoverPlatform, setDiscoverPlatform] = useState<'reddit' | 'x'>('reddit');
  const [discoverList, setDiscoverList] = useState<DiscoverySuggestion[] | null>(null);
  const [discoverScanned, setDiscoverScanned] = useState(0);
  const [discoverBusy, setDiscoverBusy] = useState(false);
  const [discoverAdding, setDiscoverAdding] = useState<string | null>(null);

  async function runDiscovery(platform: 'reddit' | 'x') {
    if (discoverBusy) return;
    setDiscoverBusy(true);
    setDiscoverPlatform(platform);
    try {
      const res = await apiGet<{
        scanned: number;
        total: number;
        suggestions: DiscoverySuggestion[];
      }>(`/api/presence/sources/discover-related?platform=${platform}`);
      setDiscoverList(res.suggestions);
      setDiscoverScanned(res.scanned);
    } catch (e) {
      onError(e);
    } finally {
      setDiscoverBusy(false);
    }
  }

  async function addDiscovered(s: DiscoverySuggestion) {
    if (discoverAdding) return;
    setDiscoverAdding(s.identifier);
    try {
      await apiPost('/api/presence/sources', {
        platform: s.platform,
        kind: s.kind,
        identifier: s.identifier,
        label: null,
        freshness_ttl_minutes: s.platform === 'reddit' ? 360 : 240,
      });
      // Drop the added one from the list locally; no full refetch needed.
      setDiscoverList((prev) => (prev ? prev.filter((p) => p.identifier !== s.identifier) : prev));
      onChange();
    } catch (e) {
      onError(e);
    } finally {
      setDiscoverAdding(null);
    }
  }

  // Prune suggestions (Pack C) — cards listing dead/stale/noisy active
  // sources with rationale. Lazy-fetched on first reveal; refreshed after
  // each Deactivate/Keep so the list shrinks as the user processes it.
  type PruneSuggestion = {
    source_id: string;
    platform: string;
    kind: string;
    identifier: string;
    label: string | null;
    health_status: 'dead' | 'stale' | 'noisy';
    severity: number;
    rationale: string;
    metrics: SourceHealthMetrics | null;
  };
  const [pruneOpen, setPruneOpen] = useState(false);
  const [pruneList, setPruneList] = useState<PruneSuggestion[] | null>(null);
  const [pruneBusy, setPruneBusy] = useState<string | null>(null);

  async function loadPruneSuggestions() {
    try {
      const res = await apiGet<{ total: number; suggestions: PruneSuggestion[] }>(
        '/api/presence/sources/prune-suggestions',
      );
      setPruneList(res.suggestions);
    } catch (e) {
      onError(e);
    }
  }

  async function handlePruneToggle() {
    const next = !pruneOpen;
    setPruneOpen(next);
    if (next && pruneList === null) {
      await loadPruneSuggestions();
    }
  }

  async function handlePruneDeactivate(s: PruneSuggestion) {
    if (pruneBusy) return;
    setPruneBusy(s.source_id);
    try {
      await apiPatch(`/api/presence/sources/${s.source_id}`, { active: false });
      onChange();
      await loadPruneSuggestions();
    } catch (e) {
      onError(e);
    } finally {
      setPruneBusy(null);
    }
  }

  async function handlePruneKeep(s: PruneSuggestion) {
    if (pruneBusy) return;
    setPruneBusy(s.source_id);
    try {
      await apiPost(`/api/presence/sources/${s.source_id}/keep`, {});
      await loadPruneSuggestions();
    } catch (e) {
      onError(e);
    } finally {
      setPruneBusy(null);
    }
  }

  const filtered = useMemo(() => {
    let rows = sources;
    if (platformFilter !== 'all') rows = rows.filter((s) => s.platform === platformFilter);
    if (healthFilter === 'no_status') {
      rows = rows.filter((s) => s.health_status == null);
    } else if (healthFilter !== 'all') {
      rows = rows.filter((s) => s.health_status === healthFilter);
    }
    return rows;
  }, [sources, platformFilter, healthFilter]);

  async function handleRefreshHealth() {
    if (healthRefreshing) return;
    setHealthRefreshing(true);
    try {
      const res = await apiPost<{
        total: number;
        by_status: Record<SourceHealthStatus, number>;
      }>('/api/presence/sources/refresh-health', {});
      onChange();
      // Toast piped through onError as a non-error informational message.
      onError(
        new Error(
          `${res.total} sources reclassed. ` +
            `workhorse=${res.by_status.workhorse} pristine=${res.by_status.pristine} ` +
            `noisy=${res.by_status.noisy} stale=${res.by_status.stale} dead=${res.by_status.dead}`,
        ),
      );
    } catch (e) {
      onError(e);
    } finally {
      setHealthRefreshing(false);
    }
  }

  const [platform, setPlatform] = useState<Platform>('reddit');
  const [kind, setKind] = useState<SourceKind>('subreddit');
  const [identifier, setIdentifier] = useState('');
  const [label, setLabel] = useState('');
  const [ttl, setTtl] = useState(240);
  const [submitting, setSubmitting] = useState(false);
  // Dry-run preview state. The Preview button calls a non-persisting endpoint
  // that scores + drafts ~4 candidates from the would-be source. Lets the
  // user check quality before committing the source row.
  type PreviewSample = {
    score: number;
    rationale: string;
    draft_body: string;
    format: string;
    source_url?: string | null;
  };
  const [previewing, setPreviewing] = useState(false);
  const [preview, setPreview] = useState<PreviewSample[] | null>(null);

  async function handlePreview() {
    if (!identifier.trim() || previewing) return;
    setPreview(null);
    setPreviewing(true);
    try {
      const res = await apiPost<{ samples: PreviewSample[] }>('/api/presence/sources/preview', {
        platform,
        kind,
        identifier: identifier.trim(),
        label: label.trim() || null,
        freshness_ttl_minutes: ttl,
      });
      setPreview(res.samples);
    } catch (e) {
      onError(e);
    } finally {
      setPreviewing(false);
    }
  }

  async function handleAdd(event: React.FormEvent) {
    event.preventDefault();
    if (!identifier.trim()) return;
    setSubmitting(true);
    try {
      await apiPost('/api/presence/sources', {
        platform,
        kind,
        identifier: identifier.trim(),
        label: label.trim() || null,
        freshness_ttl_minutes: ttl,
      });
      setIdentifier('');
      setLabel('');
      setPreview(null);
      onChange();
    } catch (e) {
      onError(e);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleToggleActive(s: SourceRow) {
    try {
      await apiPatch(`/api/presence/sources/${s.id}`, { active: !s.active });
      onChange();
    } catch (e) {
      onError(e);
    }
  }

  async function handleDelete(s: SourceRow) {
    if (!window.confirm(t('presence.sources.confirmDelete', { id: s.identifier }))) return;
    try {
      await apiDelete(`/api/presence/sources/${s.id}`);
      onChange();
    } catch (e) {
      onError(e);
    }
  }

  const kindsForPlatform: SourceKind[] =
    platform === 'reddit' ? ['subreddit', 'reddit_user'] : ['x_list', 'x_user', 'x_topic'];

  return (
    <div className="flex flex-col gap-4">
      <Section title={t('presence.sources.addTitle')} meta={t('presence.sources.addHint')}>
        <form
          onSubmit={handleAdd}
          className="grid grid-cols-1 gap-2 md:grid-cols-[120px_140px_minmax(160px,1fr)_minmax(160px,1fr)_80px_auto]"
        >
          <select
            value={platform}
            onChange={(e) => {
              const next = e.target.value as Platform;
              setPlatform(next);
              setKind(next === 'reddit' ? 'subreddit' : 'x_list');
            }}
            className="!py-1 !text-[12px]"
          >
            <option value="reddit">Reddit</option>
            <option value="x">X</option>
          </select>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as SourceKind)}
            className="!py-1 !text-[12px]"
          >
            {kindsForPlatform.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <input
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder={t('presence.sources.identifierPlaceholder')}
            className="!py-1 !text-[12px]"
            required
          />
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={t('presence.sources.labelPlaceholder')}
            className="!py-1 !text-[12px]"
          />
          <input
            type="number"
            min={5}
            max={20160}
            value={ttl}
            onChange={(e) => setTtl(Number.parseInt(e.target.value, 10) || 240)}
            title={t('presence.sources.ttlTitle')}
            className="!py-1 !text-[12px]"
          />
          <div className="flex gap-1">
            <Button
              tone="ghost"
              type="button"
              onClick={() => void handlePreview()}
              disabled={previewing || !identifier.trim()}
              className="!py-1 !text-[12px]"
              title={t('presence.sources.previewTitle')}
            >
              {previewing ? t('presence.sources.previewBusy') : t('presence.sources.preview')}
            </Button>
            <Button
              tone="primary"
              type="submit"
              disabled={submitting}
              className="!py-1 !text-[12px]"
            >
              {submitting ? t('common.saving') : t('common.add')}
            </Button>
          </div>
        </form>

        {preview ? (
          <div className="mt-3 flex flex-col gap-2 rounded-[var(--radius-sm)] border border-[var(--accent)] bg-[var(--surface-2)] p-3">
            <div className="flex items-center justify-between text-[11px] text-[var(--text-dim)]">
              <span>{t('presence.sources.previewLabel', { n: preview.length })}</span>
              <button
                type="button"
                onClick={() => setPreview(null)}
                className="text-[var(--text-faint)] hover:text-[var(--text)]"
              >
                ×
              </button>
            </div>
            {preview.length === 0 ? (
              <span className="text-[11px] text-[var(--text-faint)]">
                {t('presence.sources.previewEmpty')}
              </span>
            ) : (
              preview.map((s, i) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: preview list is stable per render
                  key={`p${i}`}
                  className="rounded-[var(--radius-sm)] bg-[var(--surface-1)] p-2 text-[11px]"
                >
                  <div className="mb-1 flex items-center gap-2 text-[10px] text-[var(--text-dim)]">
                    <Chip tone={s.score >= 0.75 ? 'success' : s.score >= 0.5 ? 'neutral' : 'warn'}>
                      {(s.score * 100).toFixed(0)}%
                    </Chip>
                    <span>{s.format}</span>
                    {s.source_url ? (
                      <a
                        href={s.source_url}
                        target="_blank"
                        rel="noreferrer noopener"
                        className="text-[var(--accent)] hover:underline"
                      >
                        thread ↗
                      </a>
                    ) : null}
                  </div>
                  {s.draft_body ? (
                    <p className="whitespace-pre-wrap text-[var(--text)]">{s.draft_body}</p>
                  ) : (
                    <p className="italic text-[var(--text-faint)]">
                      {t('presence.sources.previewBelowThreshold', { reason: s.rationale })}
                    </p>
                  )}
                </div>
              ))
            )}
          </div>
        ) : null}
      </Section>

      {/* Pack D — graph-based discovery. Two buttons (Reddit / X) trigger
          the corresponding endpoint; results render as cards with 1-click
          Add. Adding routes through POST /sources which Pack A validates
          server-side (refuses dead handles). */}
      <Section
        title={t('presence.sources.discover.title')}
        meta={t('presence.sources.discover.meta')}
        action={
          <div className="flex items-center gap-1">
            <Button
              tone="ghost"
              onClick={() => void runDiscovery('reddit')}
              disabled={discoverBusy}
              className="!py-1 !text-[11px]"
              title={t('presence.sources.discover.redditTitle')}
            >
              {discoverBusy && discoverPlatform === 'reddit'
                ? '…'
                : t('presence.sources.discover.redditButton')}
            </Button>
            <Button
              tone="ghost"
              onClick={() => void runDiscovery('x')}
              disabled={discoverBusy}
              className="!py-1 !text-[11px]"
              title={t('presence.sources.discover.xTitle')}
            >
              {discoverBusy && discoverPlatform === 'x'
                ? '…'
                : t('presence.sources.discover.xButton')}
            </Button>
          </div>
        }
      >
        {discoverList === null ? (
          <p className="text-[11px] text-[var(--text-faint)]">
            {t('presence.sources.discover.idle')}
          </p>
        ) : discoverList.length === 0 ? (
          <Empty>
            {t('presence.sources.discover.empty', {
              platform: discoverPlatform,
              scanned: discoverScanned,
            })}
          </Empty>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-[11px] text-[var(--text-faint)]">
              {t('presence.sources.discover.summary', {
                count: discoverList.length,
                platform: discoverPlatform,
                scanned: discoverScanned,
              })}
            </p>
            {discoverList.map((s) => {
              const display = s.platform === 'reddit' ? `r/${s.identifier}` : `@${s.identifier}`;
              const adding = discoverAdding === s.identifier;
              return (
                <div
                  key={`${s.platform}-${s.identifier}`}
                  className="flex flex-wrap items-center gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-2.5 text-[12px]"
                >
                  <Chip tone={PLATFORM_CHIP_TONE[s.platform as Platform]}>
                    <PlatformIcon platform={s.platform as Platform} size={12} />
                  </Chip>
                  <span className="font-medium text-[var(--text)]">{display}</span>
                  <Chip tone="accent">×{s.count}</Chip>
                  <span className="text-[11px] text-[var(--text-mute)]">
                    {s.platform === 'reddit'
                      ? t('presence.sources.discover.redditEvidence', {
                          sources: s.evidence.join(', '),
                        })
                      : t('presence.sources.discover.xEvidence', {
                          drafts: s.evidence.join(', '),
                        })}
                  </span>
                  <div className="ml-auto">
                    <Button
                      tone="primary"
                      onClick={() => void addDiscovered(s)}
                      disabled={adding}
                      className="!py-1 !text-[11px]"
                      title={t('presence.sources.discover.addTitle')}
                    >
                      {adding ? '…' : t('presence.sources.discover.add')}
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>

      {/* Pack C — prune assistant. Collapsed by default; expanding fetches
          the suggestion list and renders one card per flagged source. */}
      <Section
        title={t('presence.sources.prune.title')}
        meta={t('presence.sources.prune.meta')}
        action={
          <Button
            tone="ghost"
            onClick={() => void handlePruneToggle()}
            className="!py-1 !text-[11px]"
            title={t('presence.sources.prune.toggleTitle')}
          >
            {pruneOpen ? t('presence.sources.prune.hide') : t('presence.sources.prune.show')}
          </Button>
        }
      >
        {pruneOpen ? (
          pruneList === null ? (
            <Empty>{t('common.loading')}</Empty>
          ) : pruneList.length === 0 ? (
            <Empty>{t('presence.sources.prune.empty')}</Empty>
          ) : (
            <div className="flex flex-col gap-2">
              <p className="text-[11px] text-[var(--text-faint)]">
                {t('presence.sources.prune.hint')}
              </p>
              {pruneList.map((s) => {
                const tone =
                  s.health_status === 'dead'
                    ? 'danger'
                    : s.health_status === 'stale'
                      ? 'warn'
                      : 'warn';
                const busy = pruneBusy === s.source_id;
                return (
                  <div
                    key={s.source_id}
                    className="flex flex-col gap-1.5 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] p-3"
                  >
                    <div className="flex items-center gap-2 text-[11px]">
                      <Chip tone={PLATFORM_CHIP_TONE[s.platform as Platform]}>
                        <PlatformIcon platform={s.platform as Platform} size={12} />
                      </Chip>
                      <Chip tone={tone}>{s.health_status}</Chip>
                      <span className="text-[var(--text)] font-medium">
                        {s.label || s.identifier}
                      </span>
                      {s.label ? (
                        <span className="text-[var(--text-faint)]">{s.identifier}</span>
                      ) : null}
                    </div>
                    <p className="text-[12px] text-[var(--text-mute)]">{s.rationale}</p>
                    <div className="flex items-center justify-end gap-1.5 pt-1">
                      <Button
                        tone="ghost"
                        onClick={() => void handlePruneKeep(s)}
                        disabled={busy}
                        className="!py-1 !text-[11px]"
                        title={t('presence.sources.prune.keepTitle')}
                      >
                        {busy ? '…' : t('presence.sources.prune.keep')}
                      </Button>
                      <Button
                        tone="primary"
                        onClick={() => void handlePruneDeactivate(s)}
                        disabled={busy}
                        className="!py-1 !text-[11px]"
                        title={t('presence.sources.prune.deactivateTitle')}
                      >
                        {busy ? '…' : t('presence.sources.prune.deactivate')}
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>
          )
        ) : null}
      </Section>

      <Section
        title={t('presence.sources.listTitle', { n: filtered.length })}
        action={
          <div className="flex items-center gap-2">
            <select
              value={healthFilter}
              onChange={(e) =>
                setHealthFilter(e.target.value as SourceHealthStatus | 'all' | 'no_status')
              }
              className="!py-1 !text-[11px]"
              aria-label={t('presence.sources.healthFilter.label')}
              title={t('presence.sources.healthFilter.label')}
            >
              <option value="all">{t('presence.sources.healthFilter.all')}</option>
              <option value="workhorse">{t('presence.sources.healthFilter.workhorse')}</option>
              <option value="pristine">{t('presence.sources.healthFilter.pristine')}</option>
              <option value="unscored">{t('presence.sources.healthFilter.unscored')}</option>
              <option value="never_scanned">
                {t('presence.sources.healthFilter.never_scanned')}
              </option>
              <option value="noisy">{t('presence.sources.healthFilter.noisy')}</option>
              <option value="stale">{t('presence.sources.healthFilter.stale')}</option>
              <option value="dead">{t('presence.sources.healthFilter.dead')}</option>
              <option value="no_status">{t('presence.sources.healthFilter.no_status')}</option>
            </select>
            <Button
              tone="ghost"
              onClick={() => void handleRefreshHealth()}
              disabled={healthRefreshing}
              className="!py-1 !text-[11px]"
              title={t('presence.sources.refreshHealthTitle')}
            >
              {healthRefreshing ? '…' : t('presence.sources.refreshHealth')}
            </Button>
          </div>
        }
      >
        {filtered.length === 0 ? (
          <Empty>{t('presence.sources.emptyList')}</Empty>
        ) : (
          <div className="overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--border)]">
            <table className="w-full border-collapse text-[12px]">
              <thead>
                <tr className="bg-[var(--surface-2)] text-[var(--text-mute)]">
                  <th className="px-2 py-1.5 text-left font-medium">
                    {t('presence.sources.col.platform')}
                  </th>
                  <th className="px-2 py-1.5 text-left font-medium">
                    {t('presence.sources.col.kind')}
                  </th>
                  <th className="px-2 py-1.5 text-left font-medium">
                    {t('presence.sources.col.identifier')}
                  </th>
                  <th className="px-2 py-1.5 text-left font-medium">
                    {t('presence.sources.col.label')}
                  </th>
                  <th className="px-2 py-1.5 text-left font-medium">
                    {t('presence.sources.col.health')}
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    {t('presence.sources.col.ttl')}
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    {t('presence.sources.col.lastScan')}
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium">
                    {t('presence.sources.col.active')}
                  </th>
                  <th className="px-2 py-1.5 text-right font-medium" />
                  <th className="px-2 py-1.5 text-right font-medium" />
                </tr>
              </thead>
              <tbody>
                {filtered.map((s) => {
                  // Reddit always scannable (public .json fallback); X needs Bearer.
                  const connected = s.platform === 'reddit' ? true : connectStatus.x;
                  return (
                    <tr key={s.id} className="border-t border-[var(--border)]">
                      <td className="px-2 py-1.5">
                        <Chip tone={PLATFORM_CHIP_TONE[s.platform]}>
                          <PlatformIcon platform={s.platform} size={12} />
                        </Chip>
                      </td>
                      <td className="px-2 py-1.5 text-[var(--text-mute)]">{s.kind}</td>
                      <td className="px-2 py-1.5 text-[var(--text)]">{s.identifier}</td>
                      <td className="px-2 py-1.5 text-[var(--text-dim)]">{s.label || '—'}</td>
                      <td className="px-2 py-1.5">
                        <SourceHealthBadge source={s} t={t} />
                      </td>
                      <td className="px-2 py-1.5 text-right num text-[var(--text-mute)]">
                        {s.freshness_ttl_minutes}m
                      </td>
                      <td
                        className="px-2 py-1.5 text-right num text-[var(--text-faint)]"
                        title={s.last_scan_status ?? ''}
                      >
                        {s.last_scanned_at ? relativeTime(s.last_scanned_at) : '—'}
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <button
                          type="button"
                          onClick={() => void handleToggleActive(s)}
                          className={`rounded-[var(--radius-sm)] px-2 py-0.5 text-[11px] ${
                            s.active
                              ? 'bg-[rgba(48,209,88,0.12)] text-[#30d158]'
                              : 'bg-[var(--surface-2)] text-[var(--text-faint)]'
                          }`}
                        >
                          {s.active ? t('presence.sources.on') : t('presence.sources.off')}
                        </button>
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <button
                          type="button"
                          onClick={() => onScan(s)}
                          disabled={scanBusy || !connected}
                          className="rounded-[var(--radius-sm)] px-2 py-0.5 text-[11px] text-[var(--accent)] disabled:opacity-40"
                          title={
                            connected
                              ? t('presence.sources.scanTitle')
                              : t('presence.sources.notConnected')
                          }
                        >
                          {t('presence.sources.scan')}
                        </button>
                      </td>
                      <td className="px-2 py-1.5 text-right">
                        <button
                          type="button"
                          onClick={() => void handleDelete(s)}
                          className="text-[var(--text-faint)] hover:text-[var(--danger)]"
                          aria-label={t('common.delete')}
                        >
                          ×
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Section>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Stats
// ─────────────────────────────────────────────────────────────────

/**
 * Render a clean, human-friendly source name from a (possibly partial)
 * source row. Drafts may outlive their source (deletion), so the LEFT JOIN
 * in getSourceRoi can return null platform/kind/identifier — handle that
 * gracefully instead of dumping "?:?". Long X topic queries are truncated
 * to a short prefix for readability; the full identifier still shows in
 * the title attribute on hover.
 */
function formatSourceName(row: {
  label: string | null;
  platform: string | null;
  kind: string | null;
  identifier: string | null;
}): { display: string; full: string; tag: string | null } {
  const tag = row.platform ?? null;
  if (!row.platform && !row.identifier) {
    return { display: '— deleted source', full: 'deleted source', tag };
  }
  if (row.label) {
    return { display: row.label, full: row.label, tag };
  }
  if (row.platform === 'reddit' && row.kind === 'subreddit' && row.identifier) {
    return { display: `r/${row.identifier}`, full: `r/${row.identifier}`, tag: null };
  }
  if (row.platform === 'x' && row.identifier) {
    const id = row.identifier;
    const display = id.length > 40 ? `"${id.slice(0, 38)}…"` : `"${id}"`;
    return { display, full: id, tag };
  }
  return {
    display: row.identifier ?? '?',
    full: `${row.kind ?? '?'}:${row.identifier ?? '?'}`,
    tag,
  };
}

/**
 * Manual engagement poll trigger button. Surfaces in the Stats view header
 * because that's where the user is looking when they want fresh numbers.
 * Calls the new /engagement-poll-now endpoint and toasts the polled count.
 */
function PollEngagementButton({
  onError,
  onToast,
  onPolled,
  t,
}: {
  onError: (e: unknown) => void;
  onToast: (msg: string) => void;
  onPolled: () => void;
  t: Translator;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Button
      tone="ghost"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          // The endpoint defaults to force=true for manual clicks. The
          // response now includes pending (drafts whose first window has
          // not opened) and failed arrays so we can surface concrete next
          // steps instead of just "0 polled".
          const res = await apiPost<{
            polled: number;
            pending: Array<{ id: string; minutes_until: number; next_tag: string }>;
            failed: Array<{ id: string; reason: string }>;
          }>('/api/presence/engagement-poll-now', { force: true });

          const parts: string[] = [];
          if (res.polled > 0) {
            parts.push(t('presence.stats.engagement.pollDone', { n: res.polled }));
          }
          if (res.pending.length > 0) {
            // Show the soonest ETA so the user knows when to come back.
            const soonest = res.pending.reduce((m, p) =>
              p.minutes_until < m.minutes_until ? p : m,
            );
            parts.push(
              t('presence.stats.engagement.pollPending', {
                n: res.pending.length,
                tag: soonest.next_tag,
                mins: soonest.minutes_until,
              }),
            );
          }
          if (res.failed.length > 0) {
            parts.push(t('presence.stats.engagement.pollFailed', { n: res.failed.length }));
          }
          if (parts.length === 0) {
            parts.push(t('presence.stats.engagement.pollNoCandidates'));
          }
          onToast(parts.join(' · '));
          onPolled();
        } catch (e) {
          onError(e);
        } finally {
          setBusy(false);
        }
      }}
      className="!py-1 !text-[11px]"
      title={t('presence.stats.engagement.pollNowTitle')}
    >
      {busy ? '…' : t('presence.stats.engagement.pollNow')}
    </Button>
  );
}

function StatsView({
  stats,
  window,
  onWindowChange,
  onError,
  onToast,
  onReload,
  t,
}: {
  stats: OverviewStats | null;
  window: 7 | 30 | 90;
  onWindowChange: (w: 7 | 30 | 90) => void;
  onError: (e: unknown) => void;
  onToast: (msg: string) => void;
  onReload: () => void;
  t: Translator;
}) {
  // Collapse state for the heavy "patterns" panels (heatmaps + hotspots +
  // radar + aggregate engagement). Default closed because they're useful
  // for retrospection but not for the at-a-glance dashboard above. The
  // posting rhythm heatmap stays open by default when there's data —
  // it's the most visual signal and the user expects to see it.
  const [showPatterns, setShowPatterns] = useState(false);
  const [showAllSources, setShowAllSources] = useState(false);

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-end">
        <Segmented
          value={String(window)}
          options={[
            { value: '7', label: '7d' },
            { value: '30', label: '30d' },
            { value: '90', label: '90d' },
          ]}
          onChange={(v) => onWindowChange(Number(v) as 7 | 30 | 90)}
        />
      </div>

      {!stats ? (
        <Empty>{t('common.loading')}</Empty>
      ) : (
        <>
          {/* Hero strip: 4 KPI cards. The 6-card grid had labels longer
              than the values and felt scattered. Each card now bundles a
              primary number + secondary hint underneath. drafts_total
              moves into the Posted card as denominator; sub_leverage and
              avg_edit_ratio stay because they answer "is this profitable"
              and "is the drafter learning my voice". */}
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <StatHero
              label={t('presence.stats.totals.posted')}
              value={String(stats.totals.drafts_posted)}
              hint={
                stats.totals.drafts_total > 0
                  ? t('presence.stats.totals.postedHint', {
                      total: stats.totals.drafts_total,
                      pct:
                        stats.totals.drafts_total > 0
                          ? Math.round(
                              (stats.totals.drafts_posted / stats.totals.drafts_total) * 100,
                            )
                          : 0,
                    })
                  : t('presence.stats.totals.postedNone')
              }
              tone={stats.totals.drafts_posted > 0 ? 'success' : undefined}
            />
            <StatHero
              label={t('presence.stats.totals.costTotal')}
              value={`$${stats.totals.cost_total_usd.toFixed(2)}`}
              hint={
                stats.totals.cost_per_posted_usd == null
                  ? t('presence.stats.totals.costPostedHintNone')
                  : t('presence.stats.totals.costPostedHint', {
                      cost: stats.totals.cost_per_posted_usd.toFixed(3),
                    })
              }
              tone={stats.totals.cost_total_usd > 0 ? 'accent' : undefined}
            />
            <StatHero
              label={t('presence.stats.totals.subLeverage')}
              value={`$${stats.totals.sub_leverage_usd.toFixed(2)}`}
              hint={t('presence.stats.totals.subLeverageHint')}
              tone={stats.totals.sub_leverage_usd > 0 ? 'success' : undefined}
            />
            <StatHero
              label={t('presence.stats.totals.avgEditRatio')}
              value={
                stats.totals.avg_edit_ratio == null
                  ? '—'
                  : `${(stats.totals.avg_edit_ratio * 100).toFixed(0)}%`
              }
              hint={t('presence.stats.totals.avgEditRatioHint')}
              tone={
                stats.totals.avg_edit_ratio == null
                  ? undefined
                  : stats.totals.avg_edit_ratio > 0.4
                    ? 'warn'
                    : 'success'
              }
            />
          </div>

          {/* Funnel + Cost in 2 columns. Both have a chart that already
              communicates everything; the redundant breakdown tables are
              removed (they duplicated what the bars showed). The cost
              section now stacks day-trend + service-breakdown into one
              compact column. */}
          <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
            <Section
              title={t('presence.stats.funnel.title')}
              meta={t('presence.stats.funnel.meta')}
            >
              {stats.funnel.length === 0 ? (
                <Empty>{t('presence.stats.funnel.empty')}</Empty>
              ) : (
                <FunnelBars rows={stats.funnel} />
              )}
            </Section>
            <Section title={t('presence.stats.cost.title')} meta={t('presence.stats.cost.meta')}>
              {stats.cost_by_service.length === 0 ? (
                <Empty>{t('presence.stats.cost.empty')}</Empty>
              ) : (
                <div className="flex flex-col gap-3">
                  {stats.cost_by_day.length > 0 ? <CostByDayBars rows={stats.cost_by_day} /> : null}
                  <ServiceCostBars rows={stats.cost_by_service} />
                </div>
              )}
            </Section>
          </div>

          {/* Source ROI compact: top 8 sources by posted_then_rate, with an
              expand toggle for the rest. The previous full table was too
              wide to scan visually; the compact bar+pct layout keeps it
              readable at a glance. */}
          {stats.source_roi.length > 0 ? (
            <Section
              title={t('presence.stats.roi.title')}
              meta={t('presence.stats.roi.meta')}
              action={
                stats.source_roi.length > 8 ? (
                  <Button
                    tone="ghost"
                    onClick={() => setShowAllSources((v) => !v)}
                    className="!py-1 !text-[11px]"
                  >
                    {showAllSources
                      ? t('presence.stats.roi.collapse')
                      : t('presence.stats.roi.expand', { n: stats.source_roi.length - 8 })}
                  </Button>
                ) : null
              }
            >
              <SourceRoiCompact
                rows={stats.source_roi}
                limit={showAllSources ? Number.POSITIVE_INFINITY : 8}
                t={t}
              />
            </Section>
          ) : null}

          {/* Latest live engagement per draft (already enriched in the
              previous refactor). Shown after Source ROI because the user
              flow is "see which sources work → see what got posted". */}
          {stats.latest_engagement.length > 0 ? (
            <Section
              title={t('presence.stats.latestEngagement.title')}
              meta={t('presence.stats.latestEngagement.meta')}
              action={
                <PollEngagementButton
                  onError={onError}
                  onToast={onToast}
                  onPolled={onReload}
                  t={t}
                />
              }
            >
              <LatestEngagementTable rows={stats.latest_engagement} t={t} />
            </Section>
          ) : null}

          {/* Single collapsible bucket for the heavy retrospective panels.
              Heatmaps + edit hotspots + radar engagement + aggregate
              engagement are great for a weekly review but irrelevant for
              the at-a-glance dashboard. Default closed; one click expands
              everything that has data. Empty panels stay hidden inside. */}
          {stats.posted_heatmap.length > 0 ||
          stats.expired_heatmap.length > 0 ||
          stats.edit_hotspots.length > 0 ||
          stats.radar_engagement.length > 0 ||
          stats.engagement.length > 0 ||
          stats.format_engagement.length > 0 ||
          stats.score_bands.length > 0 ||
          stats.dow_posting.length > 0 ||
          stats.translations.length > 0 ? (
            <Section
              title={t('presence.stats.patterns.title')}
              meta={t('presence.stats.patterns.meta')}
              action={
                <Button
                  tone="ghost"
                  onClick={() => setShowPatterns((v) => !v)}
                  className="!py-1 !text-[11px]"
                >
                  {showPatterns
                    ? t('presence.stats.patterns.collapse')
                    : t('presence.stats.patterns.expand')}
                </Button>
              }
            >
              {showPatterns ? <PatternsGrid stats={stats} t={t} /> : null}
            </Section>
          ) : null}
        </>
      )}
    </div>
  );
}

/**
 * 24×7 heatmap (hour × weekday) for posted/expired drafts. Sparse cells
 * filled into a dense grid; intensity follows linear normalization on max.
 */
/**
 * Smart heatmap container: shows a compact "top hours" list when the dataset
 * is sparse (≤ 4 distinct cells), otherwise the full 7×24 grid. The list
 * form is far more actionable for early users — a near-empty grid hides
 * what little signal exists behind whitespace.
 */
function HeatmapSection({
  cells,
  accent,
  t,
}: {
  cells: HeatmapCell[];
  accent: string;
  t: Translator;
}) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const sparse = cells.length <= 4;
  if (sparse) {
    const ordered = [...cells].sort((a, b) => b.n - a.n).slice(0, 5);
    return (
      <div className="flex flex-col gap-1">
        <p className="text-[11px] text-[var(--text-faint)]">
          {t('presence.stats.heatmap.sparseHint')}
        </p>
        {ordered.map((c) => (
          <div key={`${c.weekday}-${c.hour}`} className="flex items-center gap-2 text-[12px]">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ backgroundColor: accent }}
            />
            <span className="num text-[var(--text)]">
              {days[c.weekday]} {String(c.hour).padStart(2, '0')}:00
            </span>
            <span className="num text-[var(--text-mute)]">×{c.n}</span>
          </div>
        ))}
      </div>
    );
  }
  return <HourWeekdayHeatmap cells={cells} accent={accent} />;
}

/**
 * Patterns & retrospection grid. Replaces the old vertical-stack of full-
 * width sub-sections with a dense 2-column responsive grid where each tile
 * is self-contained. Tiles render only when they have data, so an empty
 * dataset (no posts yet, no edits, etc) collapses gracefully.
 *
 * The grid bundles 9 retrospective signals organised by what they answer:
 *
 *   ┌──────────────────────────────┬──────────────────────────────┐
 *   │ Posting rhythm (heatmap)     │ Day-of-week posting          │
 *   ├──────────────────────────────┼──────────────────────────────┤
 *   │ Format breakdown             │ Score-band calibration       │
 *   ├──────────────────────────────┼──────────────────────────────┤
 *   │ Edit hotspots                │ Translation acceptance       │
 *   ├──────────────────────────────┼──────────────────────────────┤
 *   │ Radar engagement             │ Engagement aggregate         │
 *   ├──────────────────────────────┼──────────────────────────────┤
 *   │ Expired heatmap (if any)     │                              │
 *   └──────────────────────────────┴──────────────────────────────┘
 */
function PatternsGrid({
  stats,
  t,
}: {
  stats: OverviewStats;
  t: Translator;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
      {stats.posted_heatmap.length > 0 ? (
        <PatternTile
          title={t('presence.stats.heatmap.postedTitle')}
          meta={t('presence.stats.heatmap.postedMeta')}
        >
          <HeatmapSection cells={stats.posted_heatmap} accent="#30d158" t={t} />
        </PatternTile>
      ) : null}
      {stats.dow_posting.length > 0 ? (
        <PatternTile title={t('presence.stats.dow.title')} meta={t('presence.stats.dow.meta')}>
          <DayOfWeekBars rows={stats.dow_posting} t={t} />
        </PatternTile>
      ) : null}
      {stats.format_engagement.length > 0 ? (
        <PatternTile
          title={t('presence.stats.formatEngagement.title')}
          meta={t('presence.stats.formatEngagement.meta')}
        >
          <FormatEngagementTable rows={stats.format_engagement} t={t} />
        </PatternTile>
      ) : null}
      {stats.score_bands.length > 0 ? (
        <PatternTile
          title={t('presence.stats.scoreBands.title')}
          meta={t('presence.stats.scoreBands.meta')}
        >
          <ScoreBandsTable rows={stats.score_bands} t={t} />
        </PatternTile>
      ) : null}
      {stats.edit_hotspots.length > 0 ? (
        <PatternTile
          title={t('presence.stats.editHotspots.title')}
          meta={t('presence.stats.editHotspots.meta')}
        >
          <EditHotspots rows={stats.edit_hotspots} />
        </PatternTile>
      ) : null}
      {stats.translations.length > 0 ? (
        <PatternTile
          title={t('presence.stats.translations.title')}
          meta={t('presence.stats.translations.meta')}
        >
          <TranslationStatsTable rows={stats.translations} t={t} />
        </PatternTile>
      ) : null}
      {stats.radar_engagement.length > 0 ? (
        <PatternTile
          title={t('presence.stats.radarEngagement.title')}
          meta={t('presence.stats.radarEngagement.meta')}
        >
          <RadarEngagementTable rows={stats.radar_engagement} t={t} />
        </PatternTile>
      ) : null}
      {stats.engagement.length > 0 ? (
        <PatternTile
          title={t('presence.stats.engagement.title')}
          meta={t('presence.stats.engagement.meta')}
        >
          <EngagementAggregateTable rows={stats.engagement} t={t} />
        </PatternTile>
      ) : null}
      {stats.expired_heatmap.length > 0 ? (
        <PatternTile
          title={t('presence.stats.heatmap.expiredTitle')}
          meta={t('presence.stats.heatmap.expiredMeta')}
        >
          <HeatmapSection cells={stats.expired_heatmap} accent="#ff9f0a" t={t} />
        </PatternTile>
      ) : null}
    </div>
  );
}

function PatternTile({
  title,
  meta,
  children,
}: {
  title: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] p-3">
      <div>
        <h3 className="text-[12px] font-medium text-[var(--text)]">{title}</h3>
        {meta ? <p className="text-[10px] text-[var(--text-faint)] mt-0.5">{meta}</p> : null}
      </div>
      <div>{children}</div>
    </div>
  );
}

/**
 * Day-of-week bar chart. Sun=0..Sat=6; bar height = posted count, tooltip
 * shows avg likes for that day. The user immediately spots "I post Friday
 * but Monday performs 2× better".
 */
function DayOfWeekBars({ rows, t }: { rows: DayOfWeekRow[]; t: Translator }) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dense = new Array(7).fill(0).map((_, i) => {
    const found = rows.find((r) => r.weekday === i);
    return {
      weekday: i,
      posted: found?.posted ?? 0,
      avg_likes: found?.avg_likes ?? null,
    };
  });
  const max = Math.max(1, ...dense.map((d) => d.posted));
  return (
    <div className="flex items-end justify-between gap-1 h-24 mt-1">
      {dense.map((d) => {
        const heightPct = (d.posted / max) * 100;
        return (
          <div
            key={d.weekday}
            className="flex flex-col items-center justify-end flex-1 gap-1"
            title={t('presence.stats.dow.tooltip', {
              day: days[d.weekday],
              posted: d.posted,
              avgLikes: d.avg_likes ?? '—',
            })}
          >
            <span className="text-[10px] num text-[var(--text-mute)]">
              {d.posted > 0 ? d.posted : ''}
            </span>
            <div
              className="w-full rounded-t-[2px] bg-[var(--accent)]"
              style={{ height: `${heightPct}%`, minHeight: d.posted > 0 ? '2px' : '0' }}
            />
            <span className="text-[10px] text-[var(--text-faint)]">{days[d.weekday]}</span>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Format engagement breakdown — comments / replies / posts / quotes with
 * post-rate + avg likes/replies. Shows whether one format consistently
 * outperforms the others (e.g., long-form posts vs short replies).
 */
function FormatEngagementTable({
  rows,
  t,
}: {
  rows: FormatEngagementRow[];
  t: Translator;
}) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--border)]">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="bg-[var(--surface-2)] text-[var(--text-mute)]">
            <th className="px-2 py-1.5 text-left font-medium">
              {t('presence.stats.formatEngagement.col.format')}
            </th>
            <th className="px-2 py-1.5 text-right font-medium">
              {t('presence.stats.formatEngagement.col.proposed')}
            </th>
            <th className="px-2 py-1.5 text-right font-medium">
              {t('presence.stats.formatEngagement.col.posted')}
            </th>
            <th className="px-2 py-1.5 text-right font-medium">
              {t('presence.stats.formatEngagement.col.postRate')}
            </th>
            <th className="px-2 py-1.5 text-right font-medium">
              {t('presence.stats.formatEngagement.col.avgLikes')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.format} className="border-t border-[var(--border)]">
              <td className="px-2 py-1.5">
                <Chip tone="accent">{r.format}</Chip>
              </td>
              <td className="px-2 py-1.5 text-right num text-[var(--text-mute)]">{r.proposed}</td>
              <td className="px-2 py-1.5 text-right num text-[#30d158]">{r.posted || '—'}</td>
              <td className="px-2 py-1.5 text-right num text-[var(--text)]">
                {r.post_rate == null ? '—' : `${(r.post_rate * 100).toFixed(0)}%`}
              </td>
              <td className="px-2 py-1.5 text-right num text-[var(--text)]">
                {r.avg_likes ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Score-band calibration. A well-calibrated scorer has post_rate climbing
 * monotonically across bands (more confident → more often posted). Bands
 * highlighted when post_rate inverts the expected order.
 */
function ScoreBandsTable({ rows, t }: { rows: ScoreBandRow[]; t: Translator }) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--border)]">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="bg-[var(--surface-2)] text-[var(--text-mute)]">
            <th className="px-2 py-1.5 text-left font-medium">
              {t('presence.stats.scoreBands.col.band')}
            </th>
            <th className="px-2 py-1.5 text-right font-medium">
              {t('presence.stats.scoreBands.col.total')}
            </th>
            <th className="px-2 py-1.5 text-right font-medium">
              {t('presence.stats.scoreBands.col.posted')}
            </th>
            <th className="px-2 py-1.5 text-right font-medium">
              {t('presence.stats.scoreBands.col.expired')}
            </th>
            <th className="px-2 py-1.5 text-right font-medium">
              {t('presence.stats.scoreBands.col.postRate')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const ratePct = r.post_rate == null ? null : r.post_rate * 100;
            const tone =
              ratePct == null
                ? undefined
                : ratePct >= 50
                  ? 'text-[#30d158]'
                  : ratePct >= 20
                    ? 'text-[#ff9f0a]'
                    : 'text-[#ff453a]';
            return (
              <tr key={r.band} className="border-t border-[var(--border)]">
                <td className="px-2 py-1.5 num text-[var(--text)]">{r.band}</td>
                <td className="px-2 py-1.5 text-right num text-[var(--text-mute)]">{r.total}</td>
                <td className="px-2 py-1.5 text-right num text-[#30d158]">{r.posted || '—'}</td>
                <td className="px-2 py-1.5 text-right num text-[var(--text-faint)]">
                  {r.expired || '—'}
                </td>
                <td className={`px-2 py-1.5 text-right num ${tone ?? 'text-[var(--text-mute)]'}`}>
                  {ratePct == null ? '—' : `${ratePct.toFixed(0)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Translation acceptance per language. A language with low acceptance
 * rate (e.g. FR 25%) signals the translator prompt needs tightening for
 * that target.
 */
function TranslationStatsTable({
  rows,
  t,
}: {
  rows: TranslationStatsRow[];
  t: Translator;
}) {
  return (
    <div className="overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--border)]">
      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="bg-[var(--surface-2)] text-[var(--text-mute)]">
            <th className="px-2 py-1.5 text-left font-medium">
              {t('presence.stats.translations.col.lang')}
            </th>
            <th className="px-2 py-1.5 text-right font-medium">
              {t('presence.stats.translations.col.generated')}
            </th>
            <th className="px-2 py-1.5 text-right font-medium">
              {t('presence.stats.translations.col.saved')}
            </th>
            <th className="px-2 py-1.5 text-right font-medium">
              {t('presence.stats.translations.col.discarded')}
            </th>
            <th className="px-2 py-1.5 text-right font-medium">
              {t('presence.stats.translations.col.acceptance')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const ratePct = r.acceptance_rate == null ? null : r.acceptance_rate * 100;
            const tone =
              ratePct == null
                ? undefined
                : ratePct >= 60
                  ? 'text-[#30d158]'
                  : ratePct >= 30
                    ? 'text-[#ff9f0a]'
                    : 'text-[#ff453a]';
            return (
              <tr key={r.lang} className="border-t border-[var(--border)]">
                <td className="px-2 py-1.5">
                  <Chip tone="accent">{r.lang.toUpperCase()}</Chip>
                </td>
                <td className="px-2 py-1.5 text-right num text-[var(--text-mute)]">
                  {r.generated}
                </td>
                <td className="px-2 py-1.5 text-right num text-[#30d158]">{r.saved || '—'}</td>
                <td className="px-2 py-1.5 text-right num text-[var(--text-faint)]">
                  {r.discarded || '—'}
                </td>
                <td className={`px-2 py-1.5 text-right num ${tone ?? 'text-[var(--text-mute)]'}`}>
                  {ratePct == null ? '—' : `${ratePct.toFixed(0)}%`}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Compact KPI tile for the Stats hero strip. Differs from the generic
 * `Stat` component by allowing the hint to wrap onto its own line and by
 * using a tighter padding profile suited to dashboard summary cards.
 * The 4-card grid replaced a 6-card layout that scattered visual weight.
 */
function StatHero({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: 'success' | 'accent' | 'warn' | 'danger';
}) {
  const valueColor =
    tone === 'success'
      ? 'text-[#30d158]'
      : tone === 'accent'
        ? 'text-[var(--accent)]'
        : tone === 'warn'
          ? 'text-[#ff9f0a]'
          : tone === 'danger'
            ? 'text-[#ff453a]'
            : 'text-[var(--text)]';
  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] p-3">
      <div className="text-[10px] uppercase tracking-wide text-[var(--text-mute)]">{label}</div>
      <div className={`mt-1 text-[20px] font-semibold leading-tight num ${valueColor}`}>
        {value}
      </div>
      {hint ? <div className="mt-1 text-[11px] text-[var(--text-faint)]">{hint}</div> : null}
    </div>
  );
}

/**
 * Compact source ROI listing. Replaces the wide 5-column table that took
 * a full screen to show what's effectively two numbers per source (post
 * rate + count). Each row is a single line: name + counts + colored bar.
 * Limit prop lets the parent show top N or all.
 */
function SourceRoiCompact({
  rows,
  limit,
  t,
}: {
  rows: SourceRoiRow[];
  limit: number;
  t: Translator;
}) {
  const sorted = useMemo(
    () =>
      [...rows].sort((a, b) => {
        if (b.posted !== a.posted) return b.posted - a.posted;
        return (b.post_rate ?? 0) - (a.post_rate ?? 0);
      }),
    [rows],
  );
  const visible = sorted.slice(0, limit);
  return (
    <div className="flex flex-col gap-1">
      {visible.map((row) => {
        const name = formatSourceName(row);
        const ratePct = row.post_rate == null ? null : row.post_rate * 100;
        const barColor =
          ratePct == null
            ? 'var(--surface-3)'
            : ratePct >= 50
              ? '#30d158'
              : ratePct >= 20
                ? '#ff9f0a'
                : '#ff453a';
        return (
          <div
            key={row.source_id ?? `${row.platform}-${row.identifier}`}
            className="flex items-center gap-3 rounded-[var(--radius-sm)] px-2 py-1.5 hover:bg-[var(--surface-2)]/40 text-[12px]"
          >
            <div className="flex items-center gap-2 min-w-0 flex-1">
              <span
                className="truncate text-[var(--text)]"
                title={name.full}
                style={{ maxWidth: '320px' }}
              >
                {name.display}
              </span>
              {name.tag ? (
                <span className="text-[10px] text-[var(--text-faint)] flex-shrink-0">
                  {name.tag}
                </span>
              ) : null}
            </div>
            <div className="num text-[11px] text-[var(--text-mute)] w-20 text-right">
              {row.posted}/{row.proposed}
            </div>
            <div className="flex items-center gap-2 w-32">
              <div className="h-1.5 flex-1 overflow-hidden rounded-[var(--radius-sm)] bg-[var(--surface-2)]">
                {ratePct != null ? (
                  <div
                    className="h-full"
                    style={{
                      width: `${Math.min(100, ratePct)}%`,
                      backgroundColor: barColor,
                    }}
                  />
                ) : null}
              </div>
              <span className="num text-[11px] w-10 text-right text-[var(--text)]">
                {ratePct == null ? '—' : `${ratePct.toFixed(0)}%`}
              </span>
            </div>
          </div>
        );
      })}
      {limit < sorted.length ? (
        <p className="text-[10px] text-[var(--text-faint)] mt-1">
          {t('presence.stats.roi.collapsedHint', {
            shown: visible.length,
            total: sorted.length,
          })}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Engagement aggregate table — averages across the canonical t+1h/t+24h/
 * t+7d snapshots. Lives inside the Patterns collapsible because it's
 * retrospective data, not actionable at-a-glance. Hides reposts/impressions
 * cols when no row has those values (Reddit-only periods).
 */
function EngagementAggregateTable({
  rows,
  t,
}: {
  rows: EngagementSummaryRow[];
  t: Translator;
}) {
  const showReposts = rows.some((r) => r.avg_reposts != null);
  const showImpressions = rows.some((r) => r.avg_impressions != null);
  return (
    <div className="overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--border)]">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="bg-[var(--surface-2)] text-[var(--text-mute)]">
            <th className="px-2 py-1.5 text-left font-medium">
              {t('presence.stats.engagement.col.platform')}
            </th>
            <th className="px-2 py-1.5 text-left font-medium">
              {t('presence.stats.engagement.col.tag')}
            </th>
            <th className="px-2 py-1.5 text-right font-medium">
              {t('presence.stats.engagement.col.samples')}
            </th>
            <th className="px-2 py-1.5 text-right font-medium">
              {t('presence.stats.engagement.col.avgLikes')}
            </th>
            <th className="px-2 py-1.5 text-right font-medium">
              {t('presence.stats.engagement.col.avgReplies')}
            </th>
            {showReposts ? (
              <th className="px-2 py-1.5 text-right font-medium">
                {t('presence.stats.engagement.col.avgReposts')}
              </th>
            ) : null}
            {showImpressions ? (
              <th className="px-2 py-1.5 text-right font-medium">
                {t('presence.stats.engagement.col.avgImpressions')}
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={`${row.platform}-${row.tag}`} className="border-t border-[var(--border)]">
              <td className="px-2 py-1.5">{row.platform}</td>
              <td className="px-2 py-1.5 text-[var(--text-mute)]">{row.tag}</td>
              <td className="px-2 py-1.5 text-right num text-[var(--text-mute)]">{row.samples}</td>
              <td className="px-2 py-1.5 text-right num text-[var(--text)]">
                {row.avg_likes ?? '—'}
              </td>
              <td className="px-2 py-1.5 text-right num text-[var(--text)]">
                {row.avg_replies ?? '—'}
              </td>
              {showReposts ? (
                <td className="px-2 py-1.5 text-right num text-[var(--text)]">
                  {row.avg_reposts ?? '—'}
                </td>
              ) : null}
              {showImpressions ? (
                <td className="px-2 py-1.5 text-right num text-[var(--text)]">
                  {row.avg_impressions ?? '—'}
                </td>
              ) : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function HourWeekdayHeatmap({ cells, accent }: { cells: HeatmapCell[]; accent: string }) {
  if (cells.length === 0) {
    return (
      <Empty>
        <span className="text-[var(--text-faint)]">no data yet</span>
      </Empty>
    );
  }
  const max = cells.reduce((m, c) => Math.max(m, c.n), 1);
  const grid: number[][] = Array.from({ length: 7 }, () => new Array(24).fill(0));
  for (const c of cells) {
    if (c.weekday >= 0 && c.weekday < 7 && c.hour >= 0 && c.hour < 24) {
      grid[c.weekday][c.hour] = c.n;
    }
  }
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

  return (
    <div className="overflow-x-auto">
      <table className="border-collapse text-[10px]">
        <thead>
          <tr>
            <th className="px-1.5 py-0.5 text-left font-normal text-[var(--text-faint)]" />
            {Array.from({ length: 24 }).map((_, h) => (
              <th
                // biome-ignore lint/suspicious/noArrayIndexKey: hour columns are stable 0-23
                key={`h${h}`}
                className="px-0 py-0.5 text-center font-normal text-[var(--text-faint)]"
                style={{ minWidth: '14px' }}
              >
                {h % 3 === 0 ? h : ''}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {grid.map((row, w) => (
            <tr key={days[w]}>
              <td className="pr-2 text-[var(--text-mute)]">{days[w]}</td>
              {row.map((n, h) => {
                const intensity = n / max;
                const bg =
                  n === 0
                    ? 'var(--surface-2)'
                    : `color-mix(in oklab, ${accent} ${Math.round(intensity * 80 + 15)}%, transparent)`;
                return (
                  <td
                    // biome-ignore lint/suspicious/noArrayIndexKey: cell is stable per (weekday, hour)
                    key={`${w}-${h}`}
                    className="border border-[var(--border)] text-center text-[10px] text-[var(--text)]"
                    style={{ backgroundColor: bg, width: '14px', height: '14px' }}
                    title={`${days[w]} ${String(h).padStart(2, '0')}:00 — ${n}`}
                  >
                    {n > 0 ? n : ''}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Engagement breakdown per radar insight type. The drafter records which
 * radar insights were in context when generating each draft; this table
 * joins those records with engagement snapshots from posted drafts to show
 * which insight categories drive the strongest engagement.
 *
 * Use this to decide which radar inferences to lean into when building
 * presence — e.g., "drafts referencing market_gap insights average 3.2×
 * more likes than vault_echo, push more of those to feed".
 */
function RadarEngagementTable({
  rows,
  t,
}: {
  rows: RadarEngagementRow[];
  t: Translator;
}) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[11px]">
        <thead>
          <tr className="text-left text-[var(--text-faint)]">
            <th className="px-2 py-1 font-normal">
              {t('presence.stats.radarEngagement.col.type')}
            </th>
            <th className="px-2 py-1 text-right font-normal">
              {t('presence.stats.radarEngagement.col.posted')}
            </th>
            <th className="px-2 py-1 text-right font-normal">
              {t('presence.stats.radarEngagement.col.avgLikes')}
            </th>
            <th className="px-2 py-1 text-right font-normal">
              {t('presence.stats.radarEngagement.col.avgReplies')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.insight_type} className="border-t border-[var(--border)]">
              <td className="px-2 py-1.5">
                <Chip tone="accent">{r.insight_type}</Chip>
              </td>
              <td className="px-2 py-1.5 text-right num text-[var(--text)]">{r.drafts_posted}</td>
              <td className="px-2 py-1.5 text-right num text-[var(--text)]">
                {r.avg_likes ?? '—'}
              </td>
              <td className="px-2 py-1.5 text-right num text-[var(--text)]">
                {r.avg_replies ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Top n-grams the user removes when editing — anti-pattern signals worth
 * folding into the persona's forbidden-phrases list.
 */
/**
 * Per-draft latest engagement read. Each row shows enough context to
 * identify the draft (body preview + when posted) and how fresh the data
 * is (snapshot age vs post age — they differ as soon as the auto-poller
 * fires t+1h / t+24h / t+7d). Sorted newest post first.
 *
 * Key design choices:
 *   - Body preview, not generic "tweet ↗", so the user spots the post
 *     instantly. Truncated with full text in the title attribute.
 *   - Two distinct ages: "posted Xh ago" (under the body) and "polled Ym
 *     ago" (next to the tag). Cleared up the "everything says now" issue
 *     when the user just hit Poll now.
 *   - Platform-aware metric cells: Reddit doesn't have reposts /
 *     impressions, so those cells get dimmed instead of showing a misleading
 *     "—" the user might read as "we failed to fetch".
 *   - The headline metric (likes) gets visual weight; zero values fade.
 */
function LatestEngagementTable({
  rows,
  t,
}: {
  rows: LatestEngagementRow[];
  t: Translator;
}) {
  function relativeAge(unix: number): string {
    const diff = Math.round((Date.now() / 1000 - unix) / 60);
    if (diff < 1) return 'now';
    if (diff < 60) return `${diff}m`;
    if (diff < 1440) return `${Math.round(diff / 60)}h`;
    return `${Math.round(diff / 1440)}d`;
  }

  function metricCell(value: number | null, applies: boolean, isPrimary = false) {
    if (!applies) {
      return <span className="text-[10px] text-[var(--text-faint)]">·</span>;
    }
    if (value == null) return <span className="text-[var(--text-faint)]">—</span>;
    if (value === 0) {
      return <span className="num text-[var(--text-faint)]">0</span>;
    }
    return (
      <span
        className={`num ${isPrimary ? 'text-[var(--text)] font-semibold' : 'text-[var(--text)]'}`}
      >
        {value.toLocaleString()}
      </span>
    );
  }

  return (
    <div className="overflow-x-auto rounded-[var(--radius-sm)] border border-[var(--border)]">
      <table className="w-full border-collapse text-[12px]">
        <thead>
          <tr className="bg-[var(--surface-2)] text-[var(--text-mute)]">
            <th className="px-3 py-2 text-left font-medium">
              {t('presence.stats.latestEngagement.col.draft')}
            </th>
            <th className="px-2 py-2 text-left font-medium">
              {t('presence.stats.latestEngagement.col.tag')}
            </th>
            <th className="px-2 py-2 text-right font-medium">
              {t('presence.stats.latestEngagement.col.likes')}
            </th>
            <th className="px-2 py-2 text-right font-medium">
              {t('presence.stats.latestEngagement.col.replies')}
            </th>
            <th className="px-2 py-2 text-right font-medium">
              {t('presence.stats.latestEngagement.col.reposts')}
            </th>
            <th className="px-2 py-2 text-right font-medium">
              {t('presence.stats.latestEngagement.col.impressions')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const isX = row.platform === 'x';
            const platformIcon = isX ? '𝕏' : 'r/';
            const platformTone: 'accent' | 'warn' = isX ? 'accent' : 'warn';
            const tagTone: 'success' | 'accent' | 'warn' =
              row.snapshot_tag === 'manual'
                ? 'warn'
                : row.snapshot_tag === 't+7d'
                  ? 'success'
                  : 'accent';
            return (
              <tr
                key={`${row.draft_id}-${row.snapshot_at}`}
                className="border-t border-[var(--border)] hover:bg-[var(--surface-2)]/50 transition-colors"
              >
                <td className="px-3 py-2 max-w-[420px]">
                  <div className="flex items-start gap-2">
                    <Chip tone={platformTone}>{platformIcon}</Chip>
                    <div className="flex-1 min-w-0">
                      <p
                        className="truncate text-[12px] text-[var(--text)] leading-snug"
                        title={row.draft_body_preview}
                      >
                        {row.draft_body_preview || '(no body)'}
                      </p>
                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-[var(--text-faint)]">
                        <span>
                          {t('presence.stats.latestEngagement.postedAgo', {
                            age: relativeAge(row.posted_at),
                          })}
                        </span>
                        {row.posted_external_url ? (
                          <>
                            <span>·</span>
                            <a
                              href={row.posted_external_url}
                              target="_blank"
                              rel="noreferrer noopener"
                              className="text-[var(--accent)] hover:underline"
                              title={row.posted_external_url}
                            >
                              {t('presence.stats.latestEngagement.openLink')}
                            </a>
                          </>
                        ) : null}
                      </div>
                    </div>
                  </div>
                </td>
                <td className="px-2 py-2 align-top">
                  <div className="flex flex-col items-start gap-1">
                    <Chip tone={tagTone}>{row.snapshot_tag}</Chip>
                    <span className="text-[10px] text-[var(--text-faint)]">
                      {t('presence.stats.latestEngagement.polledAgo', {
                        age: relativeAge(row.snapshot_at),
                      })}
                    </span>
                  </div>
                </td>
                <td className="px-2 py-2 text-right align-top">
                  {metricCell(row.likes, true, true)}
                </td>
                <td className="px-2 py-2 text-right align-top">{metricCell(row.replies, true)}</td>
                <td className="px-2 py-2 text-right align-top">{metricCell(row.reposts, isX)}</td>
                <td className="px-2 py-2 text-right align-top">
                  {metricCell(row.impressions, isX)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function EditHotspots({ rows }: { rows: EditHotspotRow[] }) {
  const max = rows.reduce((m, r) => Math.max(m, r.occurrences), 1);
  return (
    <div className="flex flex-col gap-1">
      {rows.map((r) => (
        <div key={r.ngram} className="flex items-center gap-2 text-[12px]">
          <span className="w-44 shrink-0 truncate text-[var(--text)]">{r.ngram}</span>
          <div className="h-2 flex-1 overflow-hidden rounded-[var(--radius-sm)] bg-[var(--surface-2)]">
            <div
              className="h-full bg-[var(--danger)] opacity-70"
              style={{ width: `${(r.occurrences / max) * 100}%` }}
            />
          </div>
          <span className="num w-8 shrink-0 text-right text-[var(--text-mute)]">
            ×{r.occurrences}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────

function SettingsView({
  connections,
  connectStatus,
  onReload,
  onError,
  onToast,
  t,
}: {
  connections: ConnectionRow[];
  connectStatus: ConnectStatus;
  onReload: () => void;
  onError: (e: unknown) => void;
  onToast: (msg: string) => void;
  t: Translator;
}) {
  const byPlatform = new Map(connections.map((c) => [c.platform, c]));

  return (
    <div className="flex flex-col gap-4">
      <Section
        title={t('presence.settings.scheduler.title')}
        meta={t('presence.settings.scheduler.meta')}
      >
        <SchedulerConfigForm onError={onError} onToast={onToast} t={t} />
      </Section>

      <Section
        title={t('presence.settings.drafter.title')}
        meta={t('presence.settings.drafter.meta')}
      >
        <DrafterConfigForm onError={onError} onToast={onToast} t={t} />
      </Section>

      <Section
        title={t('presence.settings.persona.title')}
        meta={t('presence.settings.persona.meta')}
      >
        <PersonaRefreshButton onError={onError} onToast={onToast} t={t} />
      </Section>

      <Section
        title={t('presence.settings.openrouter.title')}
        meta={t('presence.settings.openrouter.meta')}
      >
        <OpenrouterConnect
          connected={connectStatus.openrouter}
          onReload={onReload}
          onError={onError}
          onToast={onToast}
          t={t}
        />
      </Section>

      <Section
        title={t('presence.settings.reddit.title')}
        meta={t('presence.settings.reddit.meta')}
      >
        <RedditConnect
          connected={connectStatus.reddit}
          row={byPlatform.get('reddit') ?? null}
          onReload={onReload}
          onError={onError}
          onToast={onToast}
          t={t}
        />
      </Section>

      <Section title={t('presence.settings.x.title')} meta={t('presence.settings.x.meta')}>
        <XConnect
          connected={connectStatus.x}
          row={byPlatform.get('x') ?? null}
          onReload={onReload}
          onError={onError}
          onToast={onToast}
          t={t}
        />
      </Section>

      <Section
        title={t('presence.settings.xWrite.title')}
        meta={t('presence.settings.xWrite.meta')}
      >
        <XWriteConnect onError={onError} onToast={onToast} t={t} />
      </Section>
    </div>
  );
}

type ConnectProps = {
  onReload: () => void;
  onError: (e: unknown) => void;
  onToast: (msg: string) => void;
  t: Translator;
};

type SchedulerConfig = {
  autoScanEnabled: boolean;
  scanIntervalMinutes: number;
  engagementPollIntervalMinutes: number;
  dailyBudgetUsd: number;
  todaySpendUsd?: number;
  engagementPollEnabled: boolean;
};

/**
 * Manual trigger for the persona anti-patterns refresh. Aggregates the
 * user's recent draft edits into Persona/anti_patterns.md in their vault,
 * then the drafter automatically picks the file up on the next scan.
 * Also runs on a weekly cron — this button is for impatience.
 */
function PersonaRefreshButton({
  onError,
  onToast,
  t,
}: {
  onError: (e: unknown) => void;
  onToast: (msg: string) => void;
  t: Translator;
}) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{
    ngrams: number;
    heavy: number;
    path: string | null;
  } | null>(null);

  async function handleRefresh() {
    setBusy(true);
    try {
      const res = await apiPost<{
        ok: boolean;
        path: string | null;
        ngrams_count: number;
        heavy_edits_count: number;
        reason?: string;
      }>('/api/presence/persona/refresh', {});
      if (!res.ok) {
        onError(new Error(res.reason ?? 'persona_refresh_failed'));
        return;
      }
      setLast({ ngrams: res.ngrams_count, heavy: res.heavy_edits_count, path: res.path });
      onToast(
        t('presence.settings.persona.toast', {
          ngrams: res.ngrams_count,
          heavy: res.heavy_edits_count,
        }),
      );
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          tone="primary"
          onClick={handleRefresh}
          disabled={busy}
          className="!py-1 !text-[12px]"
        >
          {busy ? t('presence.settings.persona.busy') : t('presence.settings.persona.refresh')}
        </Button>
        {last ? (
          <span className="text-[11px] text-[var(--text-dim)]">
            {t('presence.settings.persona.lastResult', {
              ngrams: last.ngrams,
              heavy: last.heavy,
              path: last.path ?? '?',
            })}
          </span>
        ) : null}
      </div>
      <p className="text-[11px] text-[var(--text-dim)]">{t('presence.settings.persona.hint')}</p>
    </div>
  );
}

function SchedulerConfigForm({
  onError,
  onToast,
  t,
}: {
  onError: (e: unknown) => void;
  onToast: (msg: string) => void;
  t: Translator;
}) {
  const [data, setData] = useState<SchedulerConfig | null>(null);
  const [savedCadence, setSavedCadence] = useState<{ scan: number; poll: number } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void apiGet<SchedulerConfig>('/api/presence/scheduler-config')
      .then((r) => {
        setData(r);
        setSavedCadence({
          scan: r.scanIntervalMinutes,
          poll: r.engagementPollIntervalMinutes,
        });
      })
      .catch(onError);
  }, [onError]);

  if (!data || !savedCadence) {
    return <Empty>{t('common.loading')}</Empty>;
  }

  // Cadence change requires server restart; we surface a hint when the
  // user touched the inputs but hasn't restarted yet (compared to the
  // values we loaded on mount).
  const cadenceDirty =
    data.scanIntervalMinutes !== savedCadence.scan ||
    data.engagementPollIntervalMinutes !== savedCadence.poll;

  async function persist(patch: Partial<SchedulerConfig>) {
    if (!data) return;
    const next = { ...data, ...patch };
    setData(next);
    setSaving(true);
    try {
      const res = await apiPost<SchedulerConfig & { ok: true }>(
        '/api/presence/scheduler-config',
        next,
      );
      setSavedCadence({
        scan: res.scanIntervalMinutes,
        poll: res.engagementPollIntervalMinutes,
      });
      onToast(t('presence.settings.saved'));
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-3 text-[13px]">
        <input
          type="checkbox"
          checked={data.autoScanEnabled}
          onChange={(e) => void persist({ autoScanEnabled: e.target.checked })}
          disabled={saving}
          className="cursor-pointer"
        />
        <span className="text-[var(--text)]">{t('presence.settings.scheduler.toggleLabel')}</span>
        <Chip tone={data.autoScanEnabled ? 'success' : 'neutral'}>
          {data.autoScanEnabled
            ? t('presence.settings.scheduler.statusOn')
            : t('presence.settings.scheduler.statusOff')}
        </Chip>
      </label>
      <p className="text-[11px] text-[var(--text-dim)]">
        {data.autoScanEnabled
          ? t('presence.settings.scheduler.hintOn')
          : t('presence.settings.scheduler.hintOff')}
      </p>

      {/* Engagement polling — independent of auto-scan because it's
          essentially free (Reddit public + X syndication CDN), and the user
          who turned auto-scan off to save money still wants their posted
          drafts tracked. */}
      <label className="flex items-center gap-3 text-[13px] mt-2">
        <input
          type="checkbox"
          checked={data.engagementPollEnabled}
          onChange={(e) => void persist({ engagementPollEnabled: e.target.checked })}
          disabled={saving}
          className="cursor-pointer"
        />
        <span className="text-[var(--text)]">
          {t('presence.settings.scheduler.engagementToggleLabel')}
        </span>
        <Chip tone={data.engagementPollEnabled ? 'success' : 'neutral'}>
          {data.engagementPollEnabled
            ? t('presence.settings.scheduler.engagementStatusOn')
            : t('presence.settings.scheduler.engagementStatusOff')}
        </Chip>
      </label>
      <p className="text-[11px] text-[var(--text-dim)]">
        {t('presence.settings.scheduler.engagementHint')}
      </p>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="text-[var(--text-dim)]">
            {t('presence.settings.scheduler.scanCadence')}
          </span>
          <input
            type="number"
            min={5}
            max={1440}
            value={data.scanIntervalMinutes}
            onChange={(e) =>
              setData({ ...data, scanIntervalMinutes: Number(e.target.value) || 45 })
            }
            onBlur={() =>
              data.scanIntervalMinutes !== savedCadence.scan &&
              void persist({ scanIntervalMinutes: data.scanIntervalMinutes })
            }
            className="!py-1 !text-[12px]"
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="text-[var(--text-dim)]">
            {t('presence.settings.scheduler.pollCadence')}
          </span>
          <input
            type="number"
            min={15}
            max={1440}
            value={data.engagementPollIntervalMinutes}
            onChange={(e) =>
              setData({
                ...data,
                engagementPollIntervalMinutes: Number(e.target.value) || 60,
              })
            }
            onBlur={() =>
              data.engagementPollIntervalMinutes !== savedCadence.poll &&
              void persist({
                engagementPollIntervalMinutes: data.engagementPollIntervalMinutes,
              })
            }
            className="!py-1 !text-[12px]"
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="text-[var(--text-dim)]">
            {t('presence.settings.scheduler.budgetCap')}
            {data.todaySpendUsd != null ? (
              <span
                className={`ml-2 num text-[10px] ${
                  data.dailyBudgetUsd > 0 && data.todaySpendUsd >= data.dailyBudgetUsd * 0.8
                    ? 'text-[var(--warn)]'
                    : 'text-[var(--text-faint)]'
                }`}
              >
                ${data.todaySpendUsd.toFixed(4)} {t('presence.settings.scheduler.budgetSpentToday')}
              </span>
            ) : null}
          </span>
          <input
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={data.dailyBudgetUsd}
            onChange={(e) => setData({ ...data, dailyBudgetUsd: Number(e.target.value) || 0 })}
            onBlur={() => void persist({ dailyBudgetUsd: data.dailyBudgetUsd })}
            className="!py-1 !text-[12px]"
            title={t('presence.settings.scheduler.budgetTitle')}
          />
        </label>
      </div>

      {cadenceDirty ? (
        <p className="text-[11px] text-[var(--warn)]">
          {t('presence.settings.scheduler.restartHint')}
        </p>
      ) : null}
    </div>
  );
}

function DrafterConfigForm({
  onError,
  onToast,
  t,
}: {
  onError: (e: unknown) => void;
  onToast: (msg: string) => void;
  t: Translator;
}) {
  const [data, setData] = useState<DrafterConfigResponse | null>(null);
  const [draft, setDraft] = useState<DrafterConfig | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void apiGet<DrafterConfigResponse>('/api/presence/drafter-config')
      .then((r) => {
        setData(r);
        setDraft(r.config);
      })
      .catch(onError);
  }, [onError]);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    try {
      await apiPost('/api/presence/drafter-config', draft);
      onToast(t('presence.settings.saved'));
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  }

  if (!data || !draft) {
    return <Empty>{t('common.loading')}</Empty>;
  }

  const modelList = data.catalog[draft.drafterProvider] ?? [];
  const modelOptions =
    modelList.length > 0
      ? modelList.map((m) => ({ value: m.id, label: m.label }))
      : [
          { value: draft.scorerModel, label: draft.scorerModel },
          { value: draft.drafterModel, label: draft.drafterModel },
        ];

  return (
    <form
      onSubmit={handleSave}
      className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(120px,200px)_minmax(160px,1fr)_minmax(160px,1fr)_auto]"
    >
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-[var(--text-dim)]">
          {t('presence.settings.drafter.provider')}
        </span>
        <select
          value={draft.drafterProvider}
          onChange={(e) =>
            setDraft({ ...draft, drafterProvider: e.target.value as DrafterProvider })
          }
          className="!py-1 !text-[12px]"
        >
          <option value="claude">Claude CLI</option>
          <option value="codex">Codex CLI</option>
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-[var(--text-dim)]">
          {t('presence.settings.drafter.scorerModel')}
        </span>
        <select
          value={draft.scorerModel}
          onChange={(e) => setDraft({ ...draft, scorerModel: e.target.value })}
          className="!py-1 !text-[12px]"
        >
          {modelOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-[var(--text-dim)]">
          {t('presence.settings.drafter.drafterModel')}
        </span>
        <select
          value={draft.drafterModel}
          onChange={(e) => setDraft({ ...draft, drafterModel: e.target.value })}
          className="!py-1 !text-[12px]"
        >
          {modelOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-end">
        <Button tone="primary" type="submit" disabled={saving} className="!py-1 !text-[12px]">
          {saving ? t('common.saving') : t('presence.settings.save')}
        </Button>
      </div>
    </form>
  );
}

function OpenrouterConnect({
  connected,
  onReload,
  onError,
  onToast,
  t,
}: ConnectProps & { connected: boolean }) {
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!apiKey.trim()) return;
    setBusy(true);
    try {
      await apiPost('/api/presence/connect/openrouter', { apiKey: apiKey.trim() });
      setApiKey('');
      onToast(t('presence.settings.saved'));
      onReload();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    if (!window.confirm(t('presence.settings.disconnectConfirm'))) return;
    try {
      await apiDelete('/api/presence/connect/openrouter');
      onToast(t('presence.settings.disconnected'));
      onReload();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[12px]">
        <Chip tone={connected ? 'success' : 'neutral'}>
          {connected
            ? t('presence.settings.connections.connected')
            : t('presence.settings.connections.disconnected')}
        </Chip>
        {connected ? (
          <Button tone="ghost" onClick={handleDisconnect} className="!py-1 !text-[11px]">
            {t('presence.settings.disconnect')}
          </Button>
        ) : null}
      </div>
      <form onSubmit={handleSave} className="flex gap-2">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t('presence.settings.openrouter.keyPlaceholder')}
          className="!py-1 !text-[12px] flex-1"
        />
        <Button tone="primary" type="submit" disabled={busy} className="!py-1 !text-[12px]">
          {busy ? t('common.saving') : t('presence.settings.save')}
        </Button>
      </form>
    </div>
  );
}

function RedditConnect({
  connected,
  row,
  onReload,
  onError,
  onToast,
  t,
}: ConnectProps & { connected: boolean; row: ConnectionRow | null }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!clientId.trim() || !clientSecret.trim() || !username.trim() || !password.trim()) {
      // Surface validation instead of silent
      // no-op so the user understands why their click did nothing.
      onError(new Error(t('presence.settings.reddit.validationAllRequired')));
      return;
    }
    setBusy(true);
    try {
      await apiPost('/api/presence/connect/reddit', {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        username: username.trim(),
        password,
      });
      setClientId('');
      setClientSecret('');
      setUsername('');
      setPassword('');
      onToast(t('presence.settings.reddit.connected'));
      onReload();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    if (!window.confirm(t('presence.settings.disconnectConfirm'))) return;
    try {
      await apiDelete('/api/presence/connect/reddit');
      onToast(t('presence.settings.disconnected'));
      onReload();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[12px]">
        <Chip tone={connected ? 'success' : 'accent'}>
          {connected
            ? t('presence.settings.connections.connected')
            : t('presence.settings.reddit.publicMode')}
        </Chip>
        {row?.account_handle ? (
          <span className="text-[var(--text-mute)]">u/{row.account_handle}</span>
        ) : null}
        {connected ? (
          <Button tone="ghost" onClick={handleDisconnect} className="!py-1 !text-[11px]">
            {t('presence.settings.disconnect')}
          </Button>
        ) : null}
      </div>
      <p className="text-[11px] text-[var(--text-dim)]">
        {t('presence.settings.reddit.publicHint')}
      </p>
      <form onSubmit={handleSave} className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <input
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder={t('presence.settings.reddit.clientIdPlaceholder')}
          className="!py-1 !text-[12px]"
        />
        <input
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder={t('presence.settings.reddit.clientSecretPlaceholder')}
          className="!py-1 !text-[12px]"
        />
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t('presence.settings.reddit.usernamePlaceholder')}
          className="!py-1 !text-[12px]"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('presence.settings.reddit.passwordPlaceholder')}
          className="!py-1 !text-[12px]"
        />
        <div className="md:col-span-2 flex justify-end">
          <Button tone="primary" type="submit" disabled={busy} className="!py-1 !text-[12px]">
            {busy ? t('common.saving') : t('presence.settings.reddit.connect')}
          </Button>
        </div>
      </form>
    </div>
  );
}

function XConnect({
  connected,
  row,
  onReload,
  onError,
  onToast,
  t,
}: ConnectProps & { connected: boolean; row: ConnectionRow | null }) {
  const [bearer, setBearer] = useState('');
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (bearer.trim().length < 10) return;
    setBusy(true);
    try {
      await apiPost('/api/presence/connect/x', {
        bearer: bearer.trim(),
        username: username.trim() || undefined,
      });
      setBearer('');
      setUsername('');
      onToast(t('presence.settings.x.connected'));
      onReload();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    if (!window.confirm(t('presence.settings.disconnectConfirm'))) return;
    try {
      await apiDelete('/api/presence/connect/x');
      onToast(t('presence.settings.disconnected'));
      onReload();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[12px]">
        <Chip tone={connected ? 'success' : 'neutral'}>
          {connected
            ? t('presence.settings.connections.connected')
            : t('presence.settings.connections.disconnected')}
        </Chip>
        {row?.account_handle ? (
          <span className="text-[var(--text-mute)]">@{row.account_handle}</span>
        ) : null}
        {connected ? (
          <Button tone="ghost" onClick={handleDisconnect} className="!py-1 !text-[11px]">
            {t('presence.settings.disconnect')}
          </Button>
        ) : null}
      </div>
      <form onSubmit={handleSave} className="grid grid-cols-1 gap-2 md:grid-cols-[2fr_1fr_auto]">
        <input
          type="password"
          value={bearer}
          onChange={(e) => setBearer(e.target.value)}
          placeholder={t('presence.settings.x.bearerPlaceholder')}
          className="!py-1 !text-[12px]"
        />
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t('presence.settings.x.usernamePlaceholder')}
          className="!py-1 !text-[12px]"
        />
        <Button tone="primary" type="submit" disabled={busy} className="!py-1 !text-[12px]">
          {busy ? t('common.saving') : t('presence.settings.x.connect')}
        </Button>
      </form>
    </div>
  );
}

/**
 * The four OAuth 1.0a User-Context keys for posting to X. Independent of
 * the read Bearer (which scans timelines / polls engagement) — either can
 * be set without the other. Generated in one click in the developer
 * portal under "Keys and tokens" → "Authentication Tokens" → "Generate".
 *
 * Wired against /api/presence/x/save-write-creds (POST) and
 * /api/presence/x/write-creds (DELETE). The connected badge polls
 * /api/presence/x/can-post on mount + after any save/delete so the UI
 * reflects keychain reality, not just the form state.
 */
function XWriteConnect({
  onError,
  onToast,
  t,
}: {
  onError: (e: unknown) => void;
  onToast: (msg: string) => void;
  t: Translator;
}) {
  const [canPost, setCanPost] = useState<boolean | null>(null);
  const [consumerKey, setConsumerKey] = useState('');
  const [consumerSecret, setConsumerSecret] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [accessTokenSecret, setAccessTokenSecret] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await apiGet<{ canPost: boolean }>('/api/presence/x/can-post');
      setCanPost(res.canPost);
    } catch (e) {
      onError(e);
      setCanPost(false);
    }
  }, [onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (
      consumerKey.trim().length < 8 ||
      consumerSecret.trim().length < 8 ||
      accessToken.trim().length < 8 ||
      accessTokenSecret.trim().length < 8
    ) {
      onError(new Error(t('presence.settings.xWrite.validationAllRequired')));
      return;
    }
    setBusy(true);
    try {
      await apiPost('/api/presence/x/save-write-creds', {
        consumerKey: consumerKey.trim(),
        consumerSecret: consumerSecret.trim(),
        accessToken: accessToken.trim(),
        accessTokenSecret: accessTokenSecret.trim(),
      });
      // Wipe the form on success so the secrets don't linger in DOM.
      setConsumerKey('');
      setConsumerSecret('');
      setAccessToken('');
      setAccessTokenSecret('');
      onToast(t('presence.settings.xWrite.connected'));
      await refresh();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    if (!window.confirm(t('presence.settings.disconnectConfirm'))) return;
    try {
      await apiDelete('/api/presence/x/write-creds');
      onToast(t('presence.settings.disconnected'));
      await refresh();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[12px]">
        <Chip tone={canPost ? 'success' : 'neutral'}>
          {canPost === null
            ? t('common.loading')
            : canPost
              ? t('presence.settings.connections.connected')
              : t('presence.settings.connections.disconnected')}
        </Chip>
        {canPost ? (
          <Button tone="ghost" onClick={handleDisconnect} className="!py-1 !text-[11px]">
            {t('presence.settings.disconnect')}
          </Button>
        ) : null}
      </div>
      <form onSubmit={handleSave} className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <input
          type="password"
          value={consumerKey}
          onChange={(e) => setConsumerKey(e.target.value)}
          placeholder={t('presence.settings.xWrite.consumerKeyPlaceholder')}
          className="!py-1 !text-[12px]"
          autoComplete="off"
        />
        <input
          type="password"
          value={consumerSecret}
          onChange={(e) => setConsumerSecret(e.target.value)}
          placeholder={t('presence.settings.xWrite.consumerSecretPlaceholder')}
          className="!py-1 !text-[12px]"
          autoComplete="off"
        />
        <input
          type="password"
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
          placeholder={t('presence.settings.xWrite.accessTokenPlaceholder')}
          className="!py-1 !text-[12px]"
          autoComplete="off"
        />
        <input
          type="password"
          value={accessTokenSecret}
          onChange={(e) => setAccessTokenSecret(e.target.value)}
          placeholder={t('presence.settings.xWrite.accessTokenSecretPlaceholder')}
          className="!py-1 !text-[12px]"
          autoComplete="off"
        />
        <div className="md:col-span-2 flex justify-end">
          <Button tone="primary" type="submit" disabled={busy} className="!py-1 !text-[12px]">
            {busy ? t('common.saving') : t('presence.settings.xWrite.connect')}
          </Button>
        </div>
      </form>
      <p className="text-[11px] text-[var(--text-faint)]">{t('presence.settings.xWrite.howto')}</p>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────
// Stats charts — pure SVG, no extra deps
// ─────────────────────────────────────────────────────────────────

/**
 * Per-platform stacked horizontal bar of the lifecycle funnel. Each row is
 * one platform (or "all"); each segment is a status colored by tone. Width
 * is proportional to the row's total drafts so platforms with more activity
 * get a wider bar — making the visual ratio of posted/expired/etc immediate.
 */
function FunnelBars({ rows }: { rows: FunnelRow[] }) {
  const segments: { key: keyof FunnelRow; color: string; label: string }[] = [
    { key: 'posted', color: '#30d158', label: 'posted' },
    { key: 'approved', color: '#64d2ff', label: 'approved' },
    { key: 'viewed', color: '#5e9ed6', label: 'viewed' },
    { key: 'proposed', color: '#9aa1b3', label: 'proposed' },
    { key: 'expired', color: '#ff9f0a', label: 'expired' },
    { key: 'ignored', color: '#6e6e73', label: 'ignored' },
    { key: 'rejected', color: '#ff453a', label: 'rejected' },
  ];
  const grandMax = rows.reduce((m, r) => {
    const total = segments.reduce((s, seg) => s + (r[seg.key] as number), 0);
    return Math.max(m, total);
  }, 0);

  return (
    <div className="flex flex-col gap-2">
      {rows.map((r) => {
        const total = segments.reduce((s, seg) => s + (r[seg.key] as number), 0);
        const widthPct = grandMax > 0 ? (total / grandMax) * 100 : 0;
        return (
          <div key={r.platform} className="flex items-center gap-3">
            <span className="w-14 shrink-0 text-[11px] font-medium text-[var(--text)]">
              {r.platform}
            </span>
            <div className="flex flex-1 items-center gap-2">
              <div
                className="flex h-4 overflow-hidden rounded-[var(--radius-sm)] bg-[var(--surface-2)]"
                style={{ width: `${Math.max(8, widthPct)}%` }}
                title={`${total} drafts`}
              >
                {total === 0
                  ? null
                  : segments.map((seg) => {
                      const v = r[seg.key] as number;
                      if (v === 0) return null;
                      const pct = (v / total) * 100;
                      return (
                        <div
                          key={seg.label}
                          style={{ width: `${pct}%`, backgroundColor: seg.color }}
                          title={`${seg.label}: ${v}`}
                        />
                      );
                    })}
              </div>
              <span className="num text-[11px] text-[var(--text-mute)]">{total}</span>
            </div>
          </div>
        );
      })}
      <div className="mt-1 flex flex-wrap gap-3 text-[10px] text-[var(--text-dim)]">
        {segments.map((seg) => (
          <span key={seg.label} className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 rounded-sm"
              style={{ backgroundColor: seg.color }}
            />
            {seg.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/**
 * Daily cost time series. SVG bars, viewBox preserveAspectRatio so the chart
 * scales to container width without re-laying out at each paint.
 */
function CostByDayBars({ rows }: { rows: CostBucketRow[] }) {
  if (rows.length === 0) return null;
  const max = rows.reduce((m, r) => Math.max(m, r.total_usd), 0);
  const viewW = Math.max(rows.length, 1);
  const viewH = 40;
  const barW = 0.85;
  const barOffset = (1 - barW) / 2;
  const total = rows.reduce((s, r) => s + r.total_usd, 0);
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-baseline justify-between gap-2">
        <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
          $ / day
        </span>
        <span className="num text-[11px] text-[var(--text-mute)]">total ${total.toFixed(4)}</span>
      </div>
      <svg
        viewBox={`0 0 ${viewW} ${viewH}`}
        preserveAspectRatio="none"
        className="h-[40px] w-full"
        aria-hidden="true"
      >
        {rows.map((r, i) => {
          const h = max > 0 ? (r.total_usd / max) * viewH : 0;
          return (
            <rect
              key={r.bucket}
              x={i + barOffset}
              y={viewH - h}
              width={barW}
              height={h}
              fill="var(--accent)"
              opacity={0.85}
            >
              <title>{`${r.bucket}: $${r.total_usd.toFixed(4)}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] text-[var(--text-faint)]">
        <span>{rows[0]?.bucket}</span>
        <span>{rows[rows.length - 1]?.bucket}</span>
      </div>
    </div>
  );
}

/**
 * Horizontal bars for cost by service+operation, sorted by total. Useful at
 * a glance to see whether scoring or drafting dominates spend, and which
 * service eats the budget.
 */
function ServiceCostBars({ rows }: { rows: CostServiceRow[] }) {
  const max = rows.reduce((m, r) => Math.max(m, r.total_usd), 0);
  return (
    <div className="mb-3 flex flex-col gap-1.5">
      {rows.map((r) => {
        const widthPct = max > 0 ? (r.total_usd / max) * 100 : 0;
        return (
          <div key={`${r.service}-${r.operation}`} className="flex items-center gap-2 text-[11px]">
            <span className="w-32 shrink-0 truncate text-[var(--text-mute)]">
              {r.service}/{r.operation}
            </span>
            <div className="flex flex-1 items-center gap-2">
              <div className="h-3 flex-1 overflow-hidden rounded-[var(--radius-sm)] bg-[var(--surface-2)]">
                <div
                  className="h-full bg-[var(--accent)] opacity-80"
                  style={{ width: `${widthPct}%` }}
                  title={`$${r.total_usd.toFixed(4)} (${r.calls} calls)`}
                />
              </div>
              <span className="num w-20 shrink-0 text-right text-[var(--text)]">
                ${r.total_usd.toFixed(4)}
              </span>
              <span className="num w-10 shrink-0 text-right text-[var(--text-faint)]">
                ×{r.calls}
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
}
