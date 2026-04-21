import type { Database } from 'bun:sqlite';
import { ccusageDaily } from '../wrappers/ccusage';

function yyyymmdd(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

export async function syncUsageDaily(db: Database, days = 30): Promise<number> {
  const now = new Date();
  const from = new Date(now);
  from.setUTCDate(from.getUTCDate() - days);

  const rows = await ccusageDaily(yyyymmdd(from), yyyymmdd(now));
  const upsert = db.query(`
    INSERT INTO usage_daily (
      date, input_tokens, output_tokens, cache_create, cache_read,
      cost_usd, models_json, source, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      input_tokens = excluded.input_tokens,
      output_tokens = excluded.output_tokens,
      cache_create = excluded.cache_create,
      cache_read = excluded.cache_read,
      cost_usd = excluded.cost_usd,
      source = excluded.source,
      synced_at = excluded.synced_at
  `);

  const syncedAt = Math.floor(Date.now() / 1000);
  let count = 0;

  for (const row of rows) {
    upsert.run(
      String(row.date || ''),
      Number(row.inputTokens || 0),
      Number(row.outputTokens || 0),
      Number(row.cacheCreationTokens || 0),
      Number(row.cacheReadTokens || 0),
      Number(row.totalCost || 0),
      '{}',
      'claude-code',
      syncedAt,
    );
    count += 1;
  }

  db.query('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
    'last_usage_sync',
    String(syncedAt),
  );

  return count;
}
