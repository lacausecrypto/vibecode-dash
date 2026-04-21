import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let originalCwd: string;
let tmpDir: string;

beforeAll(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), 'vibecode-dash-test-'));
  mkdirSync(join(tmpDir, 'data'), { recursive: true });
  process.chdir(tmpDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('runMigrations', () => {
  test('creates schema_migrations and records versions', async () => {
    // Import lazily after chdir so getDb picks up temp data dir.
    const { runMigrations, closeDb } = await import(`../db?cache=${Date.now()}`);
    await runMigrations();

    const db = new Database(join(tmpDir, 'data', 'db.sqlite'), { readonly: true });
    const rows = db
      .query<{ version: number }, []>('SELECT version FROM schema_migrations ORDER BY version')
      .all();
    db.close(false);

    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0].version).toBe(1);
    closeDb();
  });

  test('is idempotent (second run does not duplicate)', async () => {
    const { runMigrations, closeDb } = await import(`../db?cache=${Date.now()}`);
    await runMigrations();

    const db1 = new Database(join(tmpDir, 'data', 'db.sqlite'), { readonly: true });
    const first = db1
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM schema_migrations')
      .get();
    db1.close(false);

    await runMigrations();
    closeDb();

    const db2 = new Database(join(tmpDir, 'data', 'db.sqlite'), { readonly: true });
    const second = db2
      .query<{ count: number }, []>('SELECT COUNT(*) AS count FROM schema_migrations')
      .get();
    db2.close(false);

    expect(first?.count).toBeGreaterThanOrEqual(1);
    expect(second?.count).toBe(first?.count ?? 0);
    expect(existsSync(join(tmpDir, 'data', 'db.sqlite'))).toBe(true);
  });
});
