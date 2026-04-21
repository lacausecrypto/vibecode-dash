import { loadSettings } from '../config';
import { getDb } from '../db';
import { syncGithubAll } from '../scanners/githubSync';
import { reindexObsidianVault } from '../scanners/obsidianScanner';
import { scanAllProjects } from '../scanners/projectScanner';
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
        await scanAllProjects(db, settings);
      },
    },
    {
      name: 'github_sync',
      intervalMs: settings.schedules.githubSyncMinutes * 60_000,
      run: async () => {
        await syncGithubAll(db, settings.github.username);
      },
    },
    {
      name: 'obsidian_reindex',
      intervalMs: settings.schedules.obsidianSyncMinutes * 60_000,
      run: async () => {
        await reindexObsidianVault(db, settings);
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
  ];

  for (const job of jobs) {
    const runOnce = guarded(job);
    setInterval(() => void runOnce(), job.intervalMs);
    setTimeout(() => void runOnce(), 0);
  }
}
