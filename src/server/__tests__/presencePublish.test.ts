import { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import type { Settings } from '../config';
import {
  dailyCapHit,
  inCooldown,
  isRecentDuplicate,
  isWithinPublishWindow,
  listPublishLog,
  recordManualPublish,
  runPresencePublish,
} from '../jobs/presencePublish';

/**
 * Worker-rail tests. We build an in-memory SQLite with the bare minimum
 * schema — `presence_drafts` + `presence_publish_log` — so the rails can
 * be exercised without booting the full migration chain.
 */

function makeDb(): Database {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE presence_drafts (
      id TEXT PRIMARY KEY,
      platform TEXT NOT NULL,
      source_id TEXT NOT NULL,
      external_thread_id TEXT,
      external_thread_url TEXT,
      thread_snapshot_json TEXT NOT NULL DEFAULT '{}',
      format TEXT NOT NULL,
      relevance_score REAL NOT NULL,
      freshness_expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      viewed_at INTEGER,
      decided_at INTEGER,
      posted_at INTEGER,
      draft_body TEXT NOT NULL,
      draft_rationale TEXT,
      vault_citations_json TEXT NOT NULL DEFAULT '[]',
      radar_insight_ids_json TEXT NOT NULL DEFAULT '[]',
      image_plan_json TEXT,
      status TEXT NOT NULL DEFAULT 'proposed',
      posted_external_id TEXT,
      posted_external_url TEXT
    );
    CREATE TABLE presence_publish_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      draft_id TEXT,
      decision TEXT NOT NULL,
      reason TEXT,
      platform_post_id TEXT,
      at INTEGER NOT NULL
    );
  `);
  return db;
}

function insertDraft(
  db: Database,
  over: Partial<{
    id: string;
    platform: string;
    source_id: string;
    status: string;
    draft_body: string;
    posted_at: number | null;
    created_at: number;
  }> = {},
): string {
  const id = over.id ?? `d_${Math.random().toString(36).slice(2, 10)}`;
  const now = Math.floor(Date.now() / 1000);
  db.exec(
    `INSERT INTO presence_drafts
       (id, platform, source_id, external_thread_id, external_thread_url, thread_snapshot_json,
        format, relevance_score, freshness_expires_at, created_at, status, draft_body, posted_at)
     VALUES ('${id}', '${over.platform ?? 'x'}', '${over.source_id ?? 'src1'}',
             'tweet1', null, '{}',
             'reply', 0.85, ${now + 3600}, ${over.created_at ?? now},
             '${over.status ?? 'approved'}',
             ${JSON.stringify(over.draft_body ?? 'Hello from the test')},
             ${over.posted_at ?? 'NULL'})`,
  );
  return id;
}

function defaultSettings(over: Partial<Settings['presence']> = {}): Settings {
  // Build a Settings-shaped object with the fields the worker reads. We
  // narrow the type via cast since we don't need the rest of the schema
  // for these unit tests — running the full Zod validator against a
  // partial doesn't add coverage here.
  const presence = {
    drafterProvider: 'claude',
    scorerModel: 'claude-haiku-4-5-20251001',
    drafterModel: 'claude-sonnet-4-6',
    xReadCostUsd: 0.017,
    autoScanEnabled: false,
    dailyBudgetUsd: 0.5,
    engagementPollEnabled: true,
    highValueAuthorHandles: [],
    publishMode: 'live',
    maxPostsPerDayX: 10,
    maxPostsPerDayReddit: 5,
    publishWindowStartHour: 0,
    publishWindowEndHour: 24,
    publishDays: [0, 1, 2, 3, 4, 5, 6],
    publishCooldownPerSourceHours: 0,
    publishJitterMinutes: 0,
    ...over,
  };
  return { presence } as unknown as Settings;
}

// ─── Window gate ───

describe('isWithinPublishWindow', () => {
  const settings = defaultSettings({
    publishDays: [1, 2, 3, 4, 5],
    publishWindowStartHour: 9,
    publishWindowEndHour: 17,
  });

  test('accepts a Wednesday at 14:00', () => {
    const wed14 = new Date('2026-04-01T14:00:00Z'); // Wed
    // Mock the local hour by going through Date#getHours which respects
    // the runtime TZ — for CI we just construct a local-time Date.
    const local = new Date(wed14.getFullYear(), wed14.getMonth(), wed14.getDate(), 14, 0, 0);
    const out = isWithinPublishWindow(settings, local);
    expect(out.ok).toBe(true);
  });

  test('rejects Saturday in the window', () => {
    const sat14 = new Date(2026, 3, 4, 14, 0, 0); // Apr 4 2026 = Saturday local
    const out = isWithinPublishWindow(settings, sat14);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('publishDays');
  });

  test('rejects 8 AM on a weekday', () => {
    const mon8 = new Date(2026, 3, 6, 8, 30, 0); // Mon Apr 6 2026
    const out = isWithinPublishWindow(settings, mon8);
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toContain('outside window');
  });

  test('rejects 17:00 exactly (end is exclusive)', () => {
    const mon17 = new Date(2026, 3, 6, 17, 0, 0);
    const out = isWithinPublishWindow(settings, mon17);
    expect(out.ok).toBe(false);
  });

  test('accepts 9:00 exactly (start is inclusive)', () => {
    const mon9 = new Date(2026, 3, 6, 9, 0, 0);
    const out = isWithinPublishWindow(settings, mon9);
    expect(out.ok).toBe(true);
  });
});

// ─── Daily cap ───

describe('dailyCapHit', () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  test('returns hit=false when no posts today', () => {
    const out = dailyCapHit(db, 'x', 5);
    expect(out.hit).toBe(false);
    expect(out.postedToday).toBe(0);
  });

  test('counts only same-platform posts', () => {
    insertDraft(db, {
      platform: 'x',
      status: 'posted',
      posted_at: Math.floor(Date.now() / 1000),
    });
    insertDraft(db, {
      platform: 'reddit',
      status: 'posted',
      posted_at: Math.floor(Date.now() / 1000),
    });
    expect(dailyCapHit(db, 'x', 5).postedToday).toBe(1);
    expect(dailyCapHit(db, 'reddit', 5).postedToday).toBe(1);
  });

  test('returns hit=true when cap reached', () => {
    const now = Math.floor(Date.now() / 1000);
    for (let i = 0; i < 3; i++) {
      insertDraft(db, { platform: 'x', status: 'posted', posted_at: now });
    }
    expect(dailyCapHit(db, 'x', 3).hit).toBe(true);
    expect(dailyCapHit(db, 'x', 4).hit).toBe(false);
  });

  test('cap=0 means hit=true (publishing disabled for this platform)', () => {
    expect(dailyCapHit(db, 'x', 0).hit).toBe(true);
  });

  test('ignores posts older than today midnight', () => {
    const yesterday = Math.floor(Date.now() / 1000) - 25 * 3600;
    insertDraft(db, { platform: 'x', status: 'posted', posted_at: yesterday });
    expect(dailyCapHit(db, 'x', 1).postedToday).toBe(0);
  });
});

// ─── Cooldown ───

describe('inCooldown', () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  test('returns false when cooldown is 0', () => {
    expect(inCooldown(db, 'src1', 0).in_cooldown).toBe(false);
  });

  test('returns true when same source posted within window', () => {
    const recent = Math.floor(Date.now() / 1000) - 600; // 10 min ago
    insertDraft(db, {
      platform: 'x',
      source_id: 'src1',
      status: 'posted',
      posted_at: recent,
    });
    const out = inCooldown(db, 'src1', 24);
    expect(out.in_cooldown).toBe(true);
    expect(out.last_posted_at).toBe(recent);
  });

  test('returns false when same source posted before window', () => {
    const old = Math.floor(Date.now() / 1000) - 25 * 3600; // 25h ago
    insertDraft(db, {
      platform: 'x',
      source_id: 'src1',
      status: 'posted',
      posted_at: old,
    });
    expect(inCooldown(db, 'src1', 24).in_cooldown).toBe(false);
  });

  test('does not consider OTHER sources', () => {
    const recent = Math.floor(Date.now() / 1000) - 600;
    insertDraft(db, {
      platform: 'x',
      source_id: 'src2',
      status: 'posted',
      posted_at: recent,
    });
    expect(inCooldown(db, 'src1', 24).in_cooldown).toBe(false);
  });
});

// ─── Duplicate detection ───

describe('isRecentDuplicate', () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  test('returns false on empty DB', () => {
    expect(isRecentDuplicate(db, 'hello world')).toBe(false);
  });

  test('matches identical body posted recently', () => {
    insertDraft(db, {
      platform: 'x',
      status: 'posted',
      draft_body: 'A reasonable take.',
      posted_at: Math.floor(Date.now() / 1000) - 3600,
    });
    expect(isRecentDuplicate(db, 'A reasonable take.')).toBe(true);
  });

  test('normalizes whitespace before comparison', () => {
    insertDraft(db, {
      platform: 'x',
      status: 'posted',
      draft_body: 'A reasonable take.',
      posted_at: Math.floor(Date.now() / 1000) - 3600,
    });
    expect(isRecentDuplicate(db, '  A   reasonable\ttake.  ')).toBe(true);
  });

  test('does not match a draft posted >7 days ago', () => {
    insertDraft(db, {
      platform: 'x',
      status: 'posted',
      draft_body: 'Old hat.',
      posted_at: Math.floor(Date.now() / 1000) - 8 * 24 * 3600,
    });
    expect(isRecentDuplicate(db, 'Old hat.')).toBe(false);
  });

  test('does not match unposted drafts (status=approved)', () => {
    insertDraft(db, {
      platform: 'x',
      status: 'approved',
      draft_body: 'Different status.',
      posted_at: null,
    });
    expect(isRecentDuplicate(db, 'Different status.')).toBe(false);
  });
});

// ─── Worker integration ───

describe('runPresencePublish — full pipeline (no network)', () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  test('publishMode=off short-circuits with zero considered', async () => {
    insertDraft(db, { platform: 'x', status: 'approved' });
    const out = await runPresencePublish(db, defaultSettings({ publishMode: 'off' }), {
      skipNetwork: true,
    });
    expect(out.considered).toBe(0);
    expect(out.published).toBe(0);
  });

  test('logs dry_run for X drafts in dry_run mode', async () => {
    const id = insertDraft(db, { platform: 'x', status: 'approved' });
    const out = await runPresencePublish(db, defaultSettings({ publishMode: 'dry_run' }), {
      skipNetwork: true,
    });
    expect(out.considered).toBe(1);
    expect(out.published).toBe(0); // dry_run is "skipped" in worker outcome counters
    const log = listPublishLog(db, { draftId: id });
    expect(log.length).toBe(1);
    expect(log[0].decision).toBe('dry_run');
  });

  test('reddit drafts hand off (no network) regardless of publishMode=live', async () => {
    const id = insertDraft(db, { platform: 'reddit', status: 'approved' });
    const out = await runPresencePublish(db, defaultSettings({ publishMode: 'live' }), {
      skipNetwork: true,
    });
    expect(out.reddit_handed_off).toBe(1);
    const log = listPublishLog(db, { draftId: id });
    expect(log[0].decision).toBe('reddit_handed_off');
  });

  test('skipped_rate_cap fires when cap=0 for X', async () => {
    const id = insertDraft(db, { platform: 'x', status: 'approved' });
    const out = await runPresencePublish(
      db,
      defaultSettings({ publishMode: 'live', maxPostsPerDayX: 0 }),
      { skipNetwork: true },
    );
    expect(out.skipped).toBe(1);
    const log = listPublishLog(db, { draftId: id });
    expect(log[0].decision).toBe('skipped_rate_cap');
  });

  test('skipped_cooldown fires when same source recently posted', async () => {
    const recent = Math.floor(Date.now() / 1000) - 60;
    insertDraft(db, {
      id: 'd_already_posted',
      platform: 'x',
      source_id: 'src1',
      status: 'posted',
      posted_at: recent,
    });
    const id = insertDraft(db, { platform: 'x', source_id: 'src1', status: 'approved' });
    const out = await runPresencePublish(
      db,
      defaultSettings({ publishMode: 'live', publishCooldownPerSourceHours: 24 }),
      { skipNetwork: true },
    );
    expect(out.skipped).toBe(1);
    const log = listPublishLog(db, { draftId: id });
    expect(log[0].decision).toBe('skipped_cooldown');
  });

  test('skipped_duplicate fires when same body already posted', async () => {
    insertDraft(db, {
      id: 'd_already',
      platform: 'x',
      source_id: 'src9',
      status: 'posted',
      draft_body: 'Identical body.',
      posted_at: Math.floor(Date.now() / 1000) - 3600,
    });
    const id = insertDraft(db, {
      platform: 'x',
      source_id: 'src1',
      status: 'approved',
      draft_body: 'Identical body.',
    });
    const out = await runPresencePublish(db, defaultSettings({ publishMode: 'live' }), {
      skipNetwork: true,
    });
    expect(out.skipped).toBe(1);
    const log = listPublishLog(db, { draftId: id });
    expect(log[0].decision).toBe('skipped_duplicate');
  });

  test('skipped_window fires (one row, no per-draft spam) when out of hours', async () => {
    insertDraft(db, { platform: 'x', status: 'approved' });
    insertDraft(db, { platform: 'x', source_id: 'src2', status: 'approved' });
    const out = await runPresencePublish(
      db,
      defaultSettings({
        publishMode: 'live',
        // Tiny window in the past so we definitely fall outside
        publishWindowStartHour: 0,
        publishWindowEndHour: 1,
        publishDays: [(new Date().getDay() + 3) % 7], // not today
      }),
      { skipNetwork: true },
    );
    // Both drafts marked skipped, but only ONE log row
    expect(out.skipped).toBe(2);
    expect(out.considered).toBe(2);
    const log = listPublishLog(db);
    const windowRows = log.filter((r) => r.decision === 'skipped_window');
    expect(windowRows.length).toBe(1);
  });

  test('reaches publish stage with skipNetwork=true (rails passed)', async () => {
    const id = insertDraft(db, { platform: 'x', source_id: 'src1', status: 'approved' });
    const out = await runPresencePublish(db, defaultSettings({ publishMode: 'live' }), {
      skipNetwork: true,
    });
    expect(out.published).toBe(1);
    expect(out.decisions[0].draft_id).toBe(id);
    expect(out.decisions[0].decision).toBe('published');
  });
});

// ─── recordManualPublish ───

describe('recordManualPublish', () => {
  let db: Database;
  beforeEach(() => {
    db = makeDb();
  });
  afterEach(() => {
    db.close();
  });

  test('writes a published row with platform_post_id', () => {
    recordManualPublish(db, 'd1', 't3_abc', 'user clicked');
    const log = listPublishLog(db, { draftId: 'd1' });
    expect(log.length).toBe(1);
    expect(log[0].decision).toBe('published');
    expect(log[0].platform_post_id).toBe('t3_abc');
  });
});
