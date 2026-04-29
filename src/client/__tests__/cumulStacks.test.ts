import { describe, expect, test } from 'bun:test';
import { aggregateStacked, bucketOf, enumerateBuckets, repoColor } from '../lib/cumulStacks';

describe('bucketOf', () => {
  test('day mode returns the input date unchanged', () => {
    expect(bucketOf('2026-04-15', 'day')).toBe('2026-04-15');
  });

  test('month mode anchors to the first of the month', () => {
    expect(bucketOf('2026-04-15', 'month')).toBe('2026-04-01');
    expect(bucketOf('2026-04-01', 'month')).toBe('2026-04-01');
    expect(bucketOf('2026-12-31', 'month')).toBe('2026-12-01');
  });

  test('week mode anchors to ISO Monday', () => {
    // 2026-04-26 is a Sunday → ISO week starts Monday 2026-04-20
    expect(bucketOf('2026-04-26', 'week')).toBe('2026-04-20');
    // 2026-04-20 itself is Monday → identity
    expect(bucketOf('2026-04-20', 'week')).toBe('2026-04-20');
    // 2026-04-21 (Tuesday) → still Monday 2026-04-20
    expect(bucketOf('2026-04-21', 'week')).toBe('2026-04-20');
  });

  test('quarter mode anchors to first day of the quarter', () => {
    expect(bucketOf('2026-01-15', 'quarter')).toBe('2026-01-01'); // Q1
    expect(bucketOf('2026-03-31', 'quarter')).toBe('2026-01-01'); // Q1 end
    expect(bucketOf('2026-04-01', 'quarter')).toBe('2026-04-01'); // Q2 start
    expect(bucketOf('2026-06-30', 'quarter')).toBe('2026-04-01'); // Q2 end
    expect(bucketOf('2026-07-15', 'quarter')).toBe('2026-07-01'); // Q3
    expect(bucketOf('2026-12-31', 'quarter')).toBe('2026-10-01'); // Q4
  });

  test('biweekly mode steps in 14-day windows from year-start epoch', () => {
    expect(bucketOf('2026-01-01', 'biweekly')).toBe('2026-01-01'); // window 0
    expect(bucketOf('2026-01-14', 'biweekly')).toBe('2026-01-01'); // last day of window 0
    expect(bucketOf('2026-01-15', 'biweekly')).toBe('2026-01-15'); // window 1 starts
    expect(bucketOf('2026-01-28', 'biweekly')).toBe('2026-01-15'); // window 1 end
    expect(bucketOf('2026-01-29', 'biweekly')).toBe('2026-01-29'); // window 2
  });

  test('biweekly stays year-aligned across years', () => {
    // 2025 epoch is independent of 2026 epoch.
    expect(bucketOf('2025-01-01', 'biweekly')).toBe('2025-01-01');
    // 2025 has 365 days → day 364 (Dec 31) = floor(364/14)*14 = 364 → bucket
    // is Dec 31 itself (a 1-day-long window because the year ends mid-stride).
    expect(bucketOf('2025-12-31', 'biweekly')).toBe('2025-12-31');
    // The 27th window of 2025 covers Dec 17 → Dec 30.
    expect(bucketOf('2025-12-17', 'biweekly')).toBe('2025-12-17');
    expect(bucketOf('2025-12-30', 'biweekly')).toBe('2025-12-17');
    expect(bucketOf('2026-01-01', 'biweekly')).toBe('2026-01-01'); // resets epoch
  });
});

describe('enumerateBuckets', () => {
  test('lists every month between two dates inclusive', () => {
    const months = enumerateBuckets('2026-01-15', '2026-04-10', 'month');
    expect(months).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']);
  });

  test('handles year wraparound', () => {
    const months = enumerateBuckets('2025-11-15', '2026-02-10', 'month');
    expect(months).toEqual(['2025-11-01', '2025-12-01', '2026-01-01', '2026-02-01']);
  });

  test('returns single bucket when from and to are in the same month', () => {
    expect(enumerateBuckets('2026-04-05', '2026-04-25', 'month')).toEqual(['2026-04-01']);
  });

  test('returns empty array when from > to', () => {
    expect(enumerateBuckets('2026-05-01', '2026-04-01', 'month')).toEqual([]);
  });

  test('week mode steps 7 days', () => {
    const weeks = enumerateBuckets('2026-04-01', '2026-04-22', 'week');
    // 2026-04-01 is a Wed → bucket is 2026-03-30 (Mon).
    expect(weeks[0]).toBe('2026-03-30');
    expect(weeks).toContain('2026-04-06');
    expect(weeks).toContain('2026-04-13');
    expect(weeks).toContain('2026-04-20');
  });

  test('biweekly mode steps 14 days', () => {
    const out = enumerateBuckets('2026-01-01', '2026-03-15', 'biweekly');
    expect(out).toEqual([
      '2026-01-01',
      '2026-01-15',
      '2026-01-29',
      '2026-02-12',
      '2026-02-26',
      '2026-03-12',
    ]);
  });

  test('quarter mode emits four anchors for a full year', () => {
    const out = enumerateBuckets('2026-01-01', '2026-12-31', 'quarter');
    expect(out).toEqual(['2026-01-01', '2026-04-01', '2026-07-01', '2026-10-01']);
  });

  test('quarter mode crosses years cleanly', () => {
    const out = enumerateBuckets('2025-11-01', '2026-05-01', 'quarter');
    expect(out).toEqual(['2025-10-01', '2026-01-01', '2026-04-01']);
  });
});

describe('aggregateStacked — non-cumulative', () => {
  test('sums per-repo per-month from daily input', () => {
    const out = aggregateStacked(
      [
        { date: '2026-04-01', values: { repoA: 10, repoB: 5 } },
        { date: '2026-04-15', values: { repoA: 7 } },
        { date: '2026-05-03', values: { repoA: 1, repoB: 3 } },
      ],
      { groupBy: 'month', cumulative: false },
    );
    expect(out).toEqual([
      { bucket: '2026-04-01', values: { repoA: 17, repoB: 5 }, total: 22 },
      { bucket: '2026-05-01', values: { repoA: 1, repoB: 3 }, total: 4 },
    ]);
  });

  test('drops zero-count entries from the output map', () => {
    const out = aggregateStacked([{ date: '2026-04-01', values: { repoA: 5, repoB: 0 } }], {
      groupBy: 'month',
      cumulative: false,
    });
    expect(out[0].values).toEqual({ repoA: 5 });
  });

  test('returns [] on empty input without override', () => {
    expect(aggregateStacked([], { groupBy: 'month', cumulative: false })).toEqual([]);
  });
});

describe('aggregateStacked — cumulative', () => {
  test('produces a monotonically non-decreasing per-repo running sum', () => {
    const out = aggregateStacked(
      [
        { date: '2026-01-15', values: { repoA: 10 } },
        { date: '2026-02-10', values: { repoA: 5, repoB: 8 } },
        { date: '2026-04-01', values: { repoB: 2 } },
      ],
      { groupBy: 'month', cumulative: true },
    );
    expect(out).toEqual([
      { bucket: '2026-01-01', values: { repoA: 10 }, total: 10 },
      { bucket: '2026-02-01', values: { repoA: 15, repoB: 8 }, total: 23 },
      // April: nothing for repoA, so its running stays at 15. repoB +2 → 10.
      { bucket: '2026-04-01', values: { repoA: 15, repoB: 10 }, total: 25 },
    ]);
  });

  test('carries previous cumul forward through empty middle months when override is provided', () => {
    const out = aggregateStacked(
      [
        { date: '2026-01-10', values: { repoA: 4 } },
        { date: '2026-04-10', values: { repoA: 1 } },
      ],
      {
        groupBy: 'month',
        cumulative: true,
        bucketsOverride: enumerateBuckets('2026-01-01', '2026-04-30', 'month'),
      },
    );
    // Feb + Mar should carry the 4 forward.
    expect(out.map((r) => r.values.repoA ?? 0)).toEqual([4, 4, 4, 5]);
  });

  test('total per bucket equals sum across repos in that bucket', () => {
    const out = aggregateStacked(
      [
        { date: '2026-04-05', values: { repoA: 10, repoB: 20, repoC: 5 } },
        { date: '2026-05-12', values: { repoA: 3, repoC: 7 } },
      ],
      { groupBy: 'month', cumulative: true },
    );
    for (const row of out) {
      const sum = Object.values(row.values).reduce((s, v) => s + v, 0);
      expect(row.total).toBe(sum);
    }
  });

  test('respects bucketsOverride: extends to a wider X axis even when no data', () => {
    const out = aggregateStacked([{ date: '2026-04-15', values: { repoA: 5 } }], {
      groupBy: 'month',
      cumulative: true,
      bucketsOverride: enumerateBuckets('2026-01-01', '2026-06-30', 'month'),
    });
    // 6 months emitted; first 3 have empty values map (running sum is 0).
    expect(out.length).toBe(6);
    expect(out[0].values).toEqual({});
    expect(out[0].total).toBe(0);
    expect(out[3].values).toEqual({ repoA: 5 });
    // After April, May + June carry forward.
    expect(out[4].values).toEqual({ repoA: 5 });
    expect(out[5].values).toEqual({ repoA: 5 });
  });
});

describe('repoColor', () => {
  test('same input yields same output (deterministic)', () => {
    expect(repoColor('foo', 'github')).toBe(repoColor('foo', 'github'));
  });

  test('different inputs yield different colours (collision-tolerant)', () => {
    const colors = new Set<string>();
    for (const r of ['repo-a', 'repo-b', 'repo-c', 'repo-d', 'repo-e', 'repo-f']) {
      colors.add(repoColor(r, 'github'));
    }
    // 6 inputs into a continuous hue range — collisions are statistically
    // possible but rare; demand at least 4 distinct colors.
    expect(colors.size).toBeGreaterThanOrEqual(4);
  });

  test('different schemes shift the hue family', () => {
    const greens = Array.from({ length: 8 }, (_, i) => repoColor(`r${i}`, 'github'));
    const cyans = Array.from({ length: 8 }, (_, i) => repoColor(`r${i}`, 'cyan'));
    // No overlap between the two scheme outputs, since their hue ranges
    // don't intersect.
    for (const g of greens) {
      expect(cyans).not.toContain(g);
    }
  });

  test('returns a parseable hsl() string', () => {
    expect(repoColor('foo', 'amber')).toMatch(/^hsl\(\d+, 70%, \d+%\)$/);
  });
});
