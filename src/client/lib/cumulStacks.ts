/**
 * Pure helpers for the per-project cumulative stacked-bars view of the
 * GitHub heatmap (Section: "Heatmap {year}", toggle "Courbe").
 *
 * Inputs: per-day per-repo counts (e.g. views, clones, npm downloads).
 * Outputs: month-grouped rows where each repo's column carries either the
 * raw period total OR the running cumulative-up-to-that-period total.
 *
 * Why a separate module:
 *   - The aggregation is non-trivial (sort by date, bucket by period,
 *     accumulate per-repo independently, fill missing months with the
 *     previous cumul to keep bars monotonic) and needs unit tests.
 *   - The chart component stays a pure renderer over the resulting array.
 *   - Other surfaces (CSV export, "compare repo" panels) can re-use the
 *     same aggregation without dragging Recharts in.
 */

export type StackedDailyRow = {
  /** YYYY-MM-DD */
  date: string;
  /** repo → count for that date. Repos missing for a day are treated as 0. */
  values: Record<string, number>;
};

export type StackedBucketRow = {
  /** Period anchor — first day of the month, or first day of the ISO week. */
  bucket: string;
  /**
   * Per-repo count for the bucket. In `cumulative: true` mode this is the
   * running sum from earliest data up to the END of the bucket. In
   * `cumulative: false` it's the per-bucket total only.
   */
  values: Record<string, number>;
  /** Sum across repos for this bucket (cumulative or per-bucket). */
  total: number;
};

export type GroupBy = 'day' | 'week' | 'biweekly' | 'month' | 'quarter';

/**
 * Bucket key from a YYYY-MM-DD date.
 *
 *   day      → the date itself
 *   week     → ISO Monday of that week
 *   biweekly → fortnightly windows anchored on the YEAR's first Monday-or-Jan-1.
 *              We use Jan 1 of the date's year as the epoch and step every
 *              14 days. Predictable, year-aligned, and stays stable when the
 *              user zooms a 12-month window in/out.
 *   month    → first of the month
 *   quarter  → first day of the quarter (Jan 1, Apr 1, Jul 1, Oct 1)
 *
 * Plain string + UTC date ops avoid timezone drift — DB dates are already
 * stored as YYYY-MM-DD UTC strings and we want bucketing to match exactly.
 */
export function bucketOf(date: string, groupBy: GroupBy): string {
  if (groupBy === 'day') return date;
  if (groupBy === 'month') return `${date.slice(0, 7)}-01`;
  if (groupBy === 'quarter') {
    const month = Number.parseInt(date.slice(5, 7), 10);
    // Math: month 1-3 → Q1 (Jan), 4-6 → Q2 (Apr), 7-9 → Q3 (Jul), 10-12 → Q4 (Oct)
    const qStartMonth = Math.floor((month - 1) / 3) * 3 + 1;
    return `${date.slice(0, 4)}-${String(qStartMonth).padStart(2, '0')}-01`;
  }
  if (groupBy === 'biweekly') {
    // Year-anchored 14-day windows. Compute days-since-Jan-1, floor to a
    // multiple of 14, add back. Starts at Jan 1, then Jan 15, Jan 29, etc.
    const year = Number.parseInt(date.slice(0, 4), 10);
    const epochUTC = Date.UTC(year, 0, 1);
    const targetUTC = new Date(`${date}T00:00:00Z`).getTime();
    const daysSinceEpoch = Math.floor((targetUTC - epochUTC) / 86_400_000);
    const bucketStart = Math.floor(daysSinceEpoch / 14) * 14;
    const bucketDate = new Date(epochUTC + bucketStart * 86_400_000);
    return bucketDate.toISOString().slice(0, 10);
  }
  // 'week': ISO Monday-anchored.
  const d = new Date(`${date}T00:00:00Z`);
  const isoDow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - isoDow);
  return d.toISOString().slice(0, 10);
}

/**
 * Enumerate all bucket keys between [from, to] inclusive — used to keep
 * the X axis dense even on months with 0 activity (otherwise Recharts
 * would draw the next bar adjacent to the last non-empty one and the
 * "Heatmap 2026" framing would silently lie about gaps).
 */
export function enumerateBuckets(fromDate: string, toDate: string, groupBy: GroupBy): string[] {
  if (fromDate > toDate) return [];
  const out: string[] = [];
  let cursor = bucketOf(fromDate, groupBy);
  const end = bucketOf(toDate, groupBy);
  // Safety bound: 365 buckets max for day, 52 for week, 12 for month — but
  // we cap at 1000 to defensively prevent an infinite loop on bad input.
  for (let i = 0; i < 1000 && cursor <= end; i++) {
    out.push(cursor);
    const d = new Date(`${cursor}T00:00:00Z`);
    if (groupBy === 'day') d.setUTCDate(d.getUTCDate() + 1);
    else if (groupBy === 'week') d.setUTCDate(d.getUTCDate() + 7);
    else if (groupBy === 'biweekly') d.setUTCDate(d.getUTCDate() + 14);
    else if (groupBy === 'quarter') d.setUTCMonth(d.getUTCMonth() + 3, 1);
    else {
      // 'month': roll to first-of-next-month (handles year wraparound).
      d.setUTCMonth(d.getUTCMonth() + 1, 1);
    }
    cursor = d.toISOString().slice(0, 10);
  }
  return out;
}

/**
 * Group daily per-repo rows into buckets and produce either per-bucket or
 * running-cumulative per-repo totals.
 *
 * `bucketsOverride` lets the caller force a denser X axis (e.g. all 12
 * months of the year even when only 4 have data). When omitted, the
 * output spans only buckets that contained at least one input row.
 *
 * In cumulative mode, missing buckets in the middle of the range carry
 * the PREVIOUS cumul forward (visually the bar stays at the same
 * height). This matches the natural reading of "running total" and
 * avoids the deceptive "drop to 0" you'd see if we just summed the
 * empty bucket.
 */
export function aggregateStacked(
  daily: StackedDailyRow[],
  opts: {
    groupBy: GroupBy;
    cumulative: boolean;
    bucketsOverride?: string[];
  },
): StackedBucketRow[] {
  if (daily.length === 0 && (!opts.bucketsOverride || opts.bucketsOverride.length === 0)) {
    return [];
  }

  const sorted = [...daily].sort((a, b) => a.date.localeCompare(b.date));

  // Per-bucket per-repo totals (the raw sums before cumulative rollup).
  const perBucket = new Map<string, Record<string, number>>();
  const repos = new Set<string>();

  for (const row of sorted) {
    const key = bucketOf(row.date, opts.groupBy);
    let bag = perBucket.get(key);
    if (!bag) {
      bag = {};
      perBucket.set(key, bag);
    }
    for (const [repo, count] of Object.entries(row.values)) {
      if (!Number.isFinite(count) || count === 0) continue;
      bag[repo] = (bag[repo] ?? 0) + count;
      repos.add(repo);
    }
  }

  // Decide which buckets to emit.
  const orderedBuckets = (() => {
    if (opts.bucketsOverride && opts.bucketsOverride.length > 0) {
      return [...opts.bucketsOverride].sort();
    }
    return [...perBucket.keys()].sort();
  })();

  if (orderedBuckets.length === 0) return [];

  // Rollup into the output array. In cumulative mode we keep a running
  // per-repo state; missing buckets carry it forward.
  const running: Record<string, number> = {};
  const out: StackedBucketRow[] = [];

  for (const bucket of orderedBuckets) {
    const bag = perBucket.get(bucket) ?? {};

    if (opts.cumulative) {
      // Add this bucket's per-repo deltas to the running state.
      for (const [repo, count] of Object.entries(bag)) {
        running[repo] = (running[repo] ?? 0) + count;
      }
      // Snapshot the running state into the output. Object.assign clones
      // so a later bucket can keep mutating `running` without overwriting
      // earlier entries already pushed.
      const snapshot: Record<string, number> = {};
      for (const repo of repos) {
        if ((running[repo] ?? 0) > 0) snapshot[repo] = running[repo];
      }
      const total = Object.values(snapshot).reduce((s, v) => s + v, 0);
      out.push({ bucket, values: snapshot, total });
    } else {
      // Per-bucket-only mode: emit raw bag (filtered to repos with > 0).
      const snapshot: Record<string, number> = {};
      for (const repo of repos) {
        const v = bag[repo] ?? 0;
        if (v > 0) snapshot[repo] = v;
      }
      const total = Object.values(snapshot).reduce((s, v) => s + v, 0);
      out.push({ bucket, values: snapshot, total });
    }
  }

  return out;
}

/**
 * Stable pseudo-random colour for a repo name. Same name → same colour
 * across renders so users can mentally map "this orange one is repo X".
 *
 * Hue spread is deterministic via the cheap djb2 hash — not crypto, just
 * enough to scatter neighbouring names. Saturation/lightness are fixed
 * so all repos read at the same visual weight.
 */
const HASH_PRIME = 5381;
const HASH_MULT = 33;

function djb2Hash(s: string): number {
  let h = HASH_PRIME;
  for (let i = 0; i < s.length; i++) h = (h * HASH_MULT + s.charCodeAt(i)) >>> 0;
  return h;
}

export type RepoColorScheme = 'github' | 'cyan' | 'amber' | 'magenta';

/**
 * Pick a deterministic hex colour for a repo name, biased toward the
 * scheme's hue family so the user's "this is the views chart" mental
 * model stays intact across the segments. Lightness varies with hash
 * so adjacent segments are distinguishable.
 *
 *   github  → green family   (hue 90..150)
 *   cyan    → blue family    (hue 180..220)
 *   amber   → warm family    (hue 25..55)
 *   magenta → pink family    (hue 300..340)
 */
export function repoColor(repo: string, scheme: RepoColorScheme): string {
  const h = djb2Hash(repo);
  const ranges: Record<RepoColorScheme, [number, number]> = {
    github: [90, 150],
    cyan: [180, 220],
    amber: [25, 55],
    magenta: [300, 340],
  };
  const [lo, hi] = ranges[scheme];
  const hue = lo + (h % (hi - lo));
  // Lightness 45-65 keeps text-on-bar legible without tipping into pastel.
  const lightness = 45 + (((h >> 8) & 0xff) % 21);
  return `hsl(${hue}, 70%, ${lightness}%)`;
}
