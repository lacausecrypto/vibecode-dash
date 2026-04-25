import type { Database } from 'bun:sqlite';
import type { Settings } from '../config';
import type { PresencePlatform } from '../lib/presence';
import { type PresenceScanOutcome, runPresenceScan } from './presenceScan';

/**
 * In-memory job registry for long-running presence operations.
 *
 * The HTTP scan-now path used to block the request for 5+ minutes while the
 * scanner walked candidates and called the Claude CLI. Clients (curl, the
 * dashboard fetch) timeout at 60-300 s, leaving the request orphaned even
 * though the server kept working — confusing and untestable. The async
 * pattern is straightforward: enqueue → return 202 with a job id → poll a
 * status endpoint → consume outcome when done.
 *
 * Persistence: jobs live in memory only. They're ephemeral (dashboard is a
 * single-process Bun server, no horizontal scaling) and survive crashes
 * isn't a property worth chasing — the user can just re-run a scan. We GC
 * after 1 h or when the registry exceeds 50 entries.
 */

export type ScanJobStatus = 'pending' | 'running' | 'done' | 'failed';

export type ScanJobRecord = {
  id: string;
  status: ScanJobStatus;
  enqueued_at: number;
  started_at: number | null;
  finished_at: number | null;
  opts: { onlyPlatform?: PresencePlatform; onlySourceId?: string; bypassTtl?: boolean };
  outcome: PresenceScanOutcome | null;
  error: string | null;
};

const MAX_JOBS = 50;
const MAX_AGE_MS = 60 * 60 * 1000;

const jobs = new Map<string, ScanJobRecord>();

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

function gc(): void {
  const cutoff = Date.now() - MAX_AGE_MS;
  // Drop anything older than the cutoff (terminal or not — orphaned 'running'
  // jobs from a server restart get cleaned too).
  for (const [id, job] of jobs) {
    const ts = (job.finished_at ?? job.enqueued_at) * 1000;
    if (ts < cutoff) jobs.delete(id);
  }
  // Hard cap: if still over limit, drop oldest finished first, oldest pending last.
  if (jobs.size > MAX_JOBS) {
    const sorted = [...jobs.values()].sort((a, b) => {
      const aTerm = a.status === 'done' || a.status === 'failed' ? 0 : 1;
      const bTerm = b.status === 'done' || b.status === 'failed' ? 0 : 1;
      if (aTerm !== bTerm) return aTerm - bTerm;
      return a.enqueued_at - b.enqueued_at;
    });
    for (let i = 0; i < sorted.length - MAX_JOBS; i++) {
      jobs.delete(sorted[i].id);
    }
  }
}

export function enqueueScan(
  db: Database,
  settings: Settings,
  opts: { onlyPlatform?: PresencePlatform; onlySourceId?: string; bypassTtl?: boolean } = {},
): ScanJobRecord {
  gc();
  const id = crypto.randomUUID();
  const job: ScanJobRecord = {
    id,
    status: 'pending',
    enqueued_at: nowSec(),
    started_at: null,
    finished_at: null,
    opts,
    outcome: null,
    error: null,
  };
  jobs.set(id, job);

  // Fire-and-forget: the scan runs in the background. We don't await it here
  // — the caller has already gotten the job id back. Any throw becomes a
  // 'failed' job state, surfaced via the GET endpoint.
  void (async () => {
    job.status = 'running';
    job.started_at = nowSec();
    try {
      job.outcome = await runPresenceScan(db, settings, opts);
      job.status = 'done';
    } catch (error) {
      job.error = String(error).slice(0, 500);
      job.status = 'failed';
      console.warn(`[presenceJobs] scan ${id} failed:`, error);
    } finally {
      job.finished_at = nowSec();
    }
  })();

  return job;
}

export function getJob(id: string): ScanJobRecord | null {
  return jobs.get(id) ?? null;
}

export function listRecentJobs(limit = 20): ScanJobRecord[] {
  return [...jobs.values()]
    .sort((a, b) => b.enqueued_at - a.enqueued_at)
    .slice(0, Math.max(1, Math.min(MAX_JOBS, limit)));
}
