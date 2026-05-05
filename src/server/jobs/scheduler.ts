import { loadSettings } from '../config';
import { getDb } from '../db';
import { refreshNpmDownloads } from '../lib/npmDownloads';
import { refreshAllPackageDownloads } from '../lib/packageDownloads';
import { expireStaleDrafts } from '../lib/presence';
import { refreshPersonaAntiPatterns } from '../lib/presencePersona';
import { refreshAllSourceHealth } from '../lib/sourceHealth';
import { syncGithubAll } from '../scanners/githubSync';
import { reindexObsidianVault } from '../scanners/obsidianScanner';
import { scanAllProjects } from '../scanners/projectScanner';
import { getCodexLiveRateLimits } from '../wrappers/codexOauth';
import { pollPresenceEngagement } from './presenceEngagement';
import { runPresencePublish } from './presencePublish';
import { runPresenceScan } from './presenceScan';
import { syncUsageByProject } from './usageByProjectSync';
import { syncUsageDaily } from './usageSync';

let started = false;

type Job = {
  name: string;
  intervalMs: number;
  run: () => Promise<void>;
};

const MAX_BACKOFF_MS = 60 * 60 * 1000;
const BASE_BACKOFF_MS = 30_000;

function guarded(job: Job): () => Promise<void> {
  let running = false;
  let consecutiveFailures = 0;
  let nextAllowedAt = 0;

  return async () => {
    if (running) {
      return;
    }
    const now = Date.now();
    if (now < nextAllowedAt) {
      return;
    }
    running = true;
    try {
      await job.run();
      consecutiveFailures = 0;
      nextAllowedAt = 0;
    } catch (error) {
      consecutiveFailures += 1;
      const backoff = Math.min(BASE_BACKOFF_MS * 2 ** (consecutiveFailures - 1), MAX_BACKOFF_MS);
      nextAllowedAt = Date.now() + backoff;
      console.warn(
        `[scheduler] ${job.name} failed (attempt ${consecutiveFailures}, next retry in ${Math.round(backoff / 1000)}s)`,
        error,
      );
    } finally {
      running = false;
    }
  };
}

export async function startScheduler(): Promise<void> {
  if (started) {
    return;
  }
  started = true;

  const settings = await loadSettings();
  const db = getDb();

  const jobs: Job[] = [
    {
      name: 'project_rescan',
      intervalMs: settings.schedules.projectRescanMinutes * 60_000,
      run: async () => {
        const live = await loadSettings();
        await scanAllProjects(db, live);
      },
    },
    {
      name: 'github_sync',
      intervalMs: settings.schedules.githubSyncMinutes * 60_000,
      run: async () => {
        const live = await loadSettings();
        await syncGithubAll(db, live.github.username);
      },
    },
    {
      // npm download sync — run on a 6 h cadence. The registry refreshes
      // its /downloads/range data ~once per day (UTC), so polling more
      // often is wasted bandwidth; less often delays the cumul chart.
      // Writes `last_npm_sync` in kv so the GitHub page sync bar shows
      // the freshness pill the same way it does for heatmap/repos/traffic.
      name: 'npm_sync',
      intervalMs: 6 * 60 * 60 * 1000,
      run: async () => {
        await refreshNpmDownloads({ db, force: false });
        db.query('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
          'last_npm_sync',
          String(Math.floor(Date.now() / 1000)),
        );
      },
    },
    {
      // Multi-registry download sync (PyPI, crates.io, RubyGems) for
      // every GitHub repo that's also a scanned local project. Each
      // adapter detects whether the project is published on its registry
      // by sniffing the local manifest (pyproject.toml / Cargo.toml /
      // *.gemspec) — projects not published to a registry are
      // memoised as "not_found" so they don't get re-checked every tick.
      // Same 6 h cadence as npm — public registry APIs are gentle but
      // there's no point hitting them more often than they update.
      name: 'package_downloads_sync',
      intervalMs: 6 * 60 * 60 * 1000,
      run: async () => {
        // Re-read settings each tick so alias edits take effect on the
        // next sync without a server restart. displayAliases bridges
        // GitHub repo names to local project paths when the user has
        // renamed a folder or split repo/local naming (e.g. local
        // `Dashboard` ↔ GitHub `vibecode-dash`).
        const live = await loadSettings();
        await refreshAllPackageDownloads({
          db,
          force: false,
          displayAliases: live.displayAliases,
        });
      },
    },
    {
      name: 'obsidian_reindex',
      intervalMs: settings.schedules.obsidianSyncMinutes * 60_000,
      run: async () => {
        const live = await loadSettings();
        await reindexObsidianVault(db, live);
      },
    },
    {
      name: 'usage_sync',
      intervalMs: settings.schedules.usageSyncMinutes * 60_000,
      run: async () => {
        await syncUsageDaily(db, 35);
      },
    },
    {
      name: 'usage_by_project_sync',
      intervalMs: Math.max(15, settings.schedules.usageSyncMinutes) * 60_000,
      run: async () => {
        await syncUsageByProject(db, { windowDays: 95 });
      },
    },
    {
      // Keep the Codex rate-limits cache warm so the dashboard always has a
      // < 2 min old reading without the user having to hit the page. Matches
      // the Codex CLI's own polling cadence (~60 s when active). Silently
      // skips when no auth.json is present; the route falls back to the
      // JSONL snapshot in that case.
      name: 'codex_rate_limits_refresh',
      intervalMs: 120_000,
      run: async () => {
        await getCodexLiveRateLimits();
      },
    },
    {
      // Sweep the drafts feed: anything still 'proposed' past its
      // freshness_expires_at becomes 'expired'. Kept as its own job (not
      // bundled with the scanner) so expiry still happens if the scanner
      // is disabled via connection removal, and so the /presence page never
      // shows drafts past their optimal window.
      name: 'presence_expire_stale',
      intervalMs: Math.max(5, settings.schedules.presenceScanMinutes) * 60_000,
      run: async () => {
        expireStaleDrafts(db);
      },
    },
    {
      // Scan all active presence sources, dispatched per platform. Gated on
      // `presence.autoScanEnabled` (default off) so the user has to opt in
      // explicitly via the Settings UI. We re-load settings each tick so
      // toggling the flag takes effect on the next interval without a
      // server restart.
      name: 'presence_scan',
      intervalMs: settings.schedules.presenceScanMinutes * 60_000,
      run: async () => {
        const live = await loadSettings();
        if (!live.presence?.autoScanEnabled) return;
        await runPresenceScan(db, live);
      },
    },
    {
      // Snapshot engagement metrics. INDEPENDENT of auto-scan because:
      //   - Reddit polls are free in both modes (public permalink.json or
      //     authenticated /api/info — no PAYG charge either way).
      //   - X polls are free via the syndication CDN fallback when no
      //     Bearer is set; if Bearer IS set, ~$0.017 per due-but-not-yet-
      //     snapshotted draft (rare event, capped to 3 polls per posted
      //     draft total at t+1h / t+24h / t+7d).
      // The user who turns auto-scan off still wants engagement on their
      // posted drafts. Gated on its own `engagementPollEnabled` flag (default
      // true) so the user can fully disable background activity if they want.
      name: 'presence_engagement_poll',
      intervalMs: settings.schedules.presenceEngagementPollMinutes * 60_000,
      run: async () => {
        const live = await loadSettings();
        if (live.presence?.engagementPollEnabled === false) return;
        await pollPresenceEngagement(db);
      },
    },
    {
      // Daily: classify each source into a health band (Pack B). Pure SQL +
      // TS, no external calls, runs in <100 ms even with hundreds of sources.
      // Always on — health insight is useful regardless of auto-scan toggle.
      name: 'presence_health_refresh',
      intervalMs: 24 * 60 * 60 * 1000, // 24 h
      run: async () => {
        refreshAllSourceHealth(db);
      },
    },
    {
      // Weekly: rebuild Persona/anti_patterns.md in the vault from recent
      // edit signals. Always runs (independent of auto-scan toggle) —
      // anti-patterns are derived from data the user has already edited
      // manually, so refreshing them costs nothing externally and keeps
      // the drafter's voice aligned with the user's actual rewrites.
      name: 'presence_persona_refresh',
      intervalMs: 7 * 24 * 60 * 60 * 1000, // 7 days
      run: async () => {
        const live = await loadSettings();
        await refreshPersonaAntiPatterns(db, live);
      },
    },
    {
      // Auto-publish worker. Tick every 60 s; the worker itself returns
      // immediately when settings.presence.publishMode === 'off' (default)
      // so the cycle is essentially free until the user opts in. The 60 s
      // cadence is short enough that approved drafts inside the time
      // window go out within a minute, and the per-platform daily caps
      // + per-source cooldowns are checked on every tick so nothing
      // races even if the user approves a backlog at once.
      name: 'presence_publish',
      intervalMs: 60_000,
      run: async () => {
        const live = await loadSettings();
        if (live.presence?.publishMode === 'off') return;
        await runPresencePublish(db, live);
      },
    },
  ];

  for (const job of jobs) {
    const runOnce = guarded(job);
    setInterval(() => void runOnce(), job.intervalMs);
    setTimeout(() => void runOnce(), 0);
  }
}
