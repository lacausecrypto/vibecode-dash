import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { getDataDir, getDbPath } from '../config';
import * as migration0001 from './migrations/0001_init';
import * as migration0002 from './migrations/0002_agent_memories';
import * as migration0003 from './migrations/0003_usage_daily_by_project';
import * as migration0004 from './migrations/0004_memory_decay';
import * as migration0005 from './migrations/0005_memory_integrity';
import * as migration0006 from './migrations/0006_radar';
import * as migration0007 from './migrations/0007_npm_downloads';
import * as migration0008 from './migrations/0008_npm_daily';
import * as migration0009 from './migrations/0009_health_breakdown';
import * as migration0010 from './migrations/0010_github_sync_log';
import * as migration0011 from './migrations/0011_drop_usage_by_project';
import * as migration0012 from './migrations/0012_reliability_cleanup';
import * as migration0013 from './migrations/0013_social_presence';
import * as migration0014 from './migrations/0014_source_validation';
import * as migration0015 from './migrations/0015_source_health';
import * as migration0016 from './migrations/0016_prune_cooldown';
import * as migration0017 from './migrations/0017_presence_publish_log';

type Migration = {
  version: number;
  sql: string;
};

const MIGRATIONS: Migration[] = [
  migration0001,
  migration0002,
  migration0003,
  migration0004,
  migration0005,
  migration0006,
  migration0007,
  migration0008,
  migration0009,
  migration0010,
  migration0011,
  migration0012,
  migration0013,
  migration0014,
  migration0015,
  migration0016,
  migration0017,
].sort((a, b) => a.version - b.version);

let dbInstance: Database | null = null;

export function getDb(): Database {
  if (dbInstance) {
    return dbInstance;
  }

  const dataDir = getDataDir();
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  dbInstance = new Database(getDbPath(), { create: true, strict: true });
  dbInstance.exec('PRAGMA journal_mode = WAL;');
  dbInstance.exec('PRAGMA foreign_keys = ON;');
  return dbInstance;
}

function getAppliedVersions(db: Database): Set<number> {
  const hasTable = db
    .query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
    )
    .get();

  if (!hasTable || hasTable.count === 0) {
    return new Set();
  }

  const rows = db.query<{ version: number }, []>('SELECT version FROM schema_migrations').all();
  return new Set(rows.map((row) => row.version));
}

export async function runMigrations(): Promise<void> {
  const db = getDb();
  const applied = getAppliedVersions(db);

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }

    const apply = db.transaction(() => {
      db.exec(migration.sql);
      db.query<unknown, [number, number]>(
        'INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)',
      ).run(migration.version, Math.floor(Date.now() / 1000));
    });

    apply();
  }

  const setVersion = db.query<unknown, [string, string]>(
    'INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)',
  );
  const latest = MIGRATIONS[MIGRATIONS.length - 1];
  if (latest) {
    setVersion.run('schema_version', String(latest.version));
  }
  setVersion.run('schema_migrated_at', String(Math.floor(Date.now() / 1000)));
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close(false);
    dbInstance = null;
  }
}
