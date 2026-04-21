import type { Database } from 'bun:sqlite';

export type SyncKind = 'repos' | 'traffic' | 'heatmap' | 'npm' | 'github-all';
export type SyncTrigger = 'manual' | 'auto' | 'background';
export type SyncStatus = 'ok' | 'no-change' | 'partial' | 'error';

export type SyncLogEntry = {
  id: number;
  at: number;
  kind: SyncKind;
  trigger: SyncTrigger;
  status: SyncStatus;
  durationMs: number | null;
  summary: Record<string, unknown> | null;
};

const MAX_ROWS = 500;

export function recordSyncEvent(
  db: Database,
  input: {
    kind: SyncKind;
    trigger: SyncTrigger;
    status: SyncStatus;
    durationMs?: number | null;
    summary?: Record<string, unknown> | null;
    at?: number;
  },
): void {
  try {
    const at = input.at ?? Math.floor(Date.now() / 1000);
    const durationMs = input.durationMs ?? null;
    const summaryJson = input.summary ? JSON.stringify(input.summary) : null;

    db.query<unknown, [number, string, string, string, number | null, string | null]>(
      `INSERT INTO github_sync_log (at, kind, trigger, status, duration_ms, summary_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(at, input.kind, input.trigger, input.status, durationMs, summaryJson);

    const count =
      db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM github_sync_log').get()?.n ?? 0;
    if (count > MAX_ROWS) {
      const excess = count - MAX_ROWS;
      db.query<unknown, [number]>(
        `DELETE FROM github_sync_log
         WHERE id IN (SELECT id FROM github_sync_log ORDER BY id ASC LIMIT ?)`,
      ).run(excess);
    }
  } catch (error) {
    console.warn('[syncLog] record failed:', String(error));
  }
}

export function listSyncLog(db: Database, limit = 50): SyncLogEntry[] {
  const rows = db
    .query<
      {
        id: number;
        at: number;
        kind: string;
        trigger: string;
        status: string;
        duration_ms: number | null;
        summary_json: string | null;
      },
      [number]
    >(
      `SELECT id, at, kind, trigger, status, duration_ms, summary_json
       FROM github_sync_log ORDER BY id DESC LIMIT ?`,
    )
    .all(Math.max(1, Math.min(200, limit)));

  return rows.map((row) => ({
    id: row.id,
    at: row.at,
    kind: row.kind as SyncKind,
    trigger: row.trigger as SyncTrigger,
    status: row.status as SyncStatus,
    durationMs: row.duration_ms,
    summary: row.summary_json ? safeParse(row.summary_json) : null,
  }));
}

function safeParse(json: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
