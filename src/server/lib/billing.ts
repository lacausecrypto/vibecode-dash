/**
 * Billing attribution helpers — computes per-project cost share using time-weighted
 * daily distribution instead of a flat window-level split.
 *
 * Core idea: a subscription belongs to the days it covers. Within each day, its value
 * is split across the projects active that day proportionally to their token usage.
 * A project only created yesterday therefore gets only 1 day of subscription share,
 * not N days of the selected window.
 */

export type BillingCharge = {
  date: string;
  amountEur: number;
  plan: string;
  coverageDays?: number;
};

export type BillingHistory = {
  claude: BillingCharge[];
  codex: BillingCharge[];
};

type BillingSource = 'claude' | 'codex';

const DAY_SEC = 86_400;

function dateIsoToTs(iso: string): number {
  return Math.floor(new Date(`${iso}T00:00:00Z`).getTime() / 1000);
}

function chargeCoverage(
  charges: BillingCharge[],
  index: number,
): { startTs: number; endTs: number; coverageDays: number } {
  const c = charges[index];
  const startTs = dateIsoToTs(c.date);
  const explicit = c.coverageDays && c.coverageDays > 0 ? c.coverageDays : null;
  let endTs: number;
  if (explicit !== null) {
    endTs = startTs + explicit * DAY_SEC;
  } else {
    const next = charges[index + 1];
    if (next) {
      endTs = dateIsoToTs(next.date);
    } else {
      endTs = startTs + 31 * DAY_SEC;
    }
  }
  const coverageDays = Math.max(1, (endTs - startTs) / DAY_SEC);
  return { startTs, endTs, coverageDays };
}

/**
 * Returns the effective daily subscription rate (€/day) on a given day for a source.
 * If several charges overlap that day (shouldn't happen normally, but robust), they sum.
 */
export function dailyRateOnDate(
  charges: BillingCharge[],
  source: BillingSource,
  dateIso: string,
): number {
  if (!charges || charges.length === 0) {
    return 0;
  }
  const sorted = [...charges].sort((a, b) => a.date.localeCompare(b.date));
  const dayStart = dateIsoToTs(dateIso);
  const dayMid = dayStart + DAY_SEC / 2;
  let rate = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const { startTs, endTs, coverageDays } = chargeCoverage(sorted, i);
    if (dayMid >= startTs && dayMid < endTs) {
      rate += sorted[i].amountEur / coverageDays;
    }
  }
  // Suppress unused warning
  void source;
  return rate;
}

export type DailyTokenRow = {
  date: string; // YYYY-MM-DD
  projectKey: string;
  source: BillingSource;
  tokens: number;
};

export type ProjectAccrual = {
  accruedEur: number;
  firstSeenTs: number | null;
  lastSeenTs: number | null;
  activeDays: number;
};

/**
 * Time-weighted per-project cost attribution over [fromTs, toTs].
 *
 * For each (date, source), split that day's subscription rate among active projects
 * proportionally to their tokens on that day. Sum contributions per projectKey.
 * Also returns first/last active dates and active-day count for each project.
 */
export function computeProjectAccrual(
  dailyRows: DailyTokenRow[],
  history: BillingHistory | undefined,
  fromTs: number,
  toTs: number,
): Map<string, ProjectAccrual> {
  const result = new Map<string, ProjectAccrual>();
  const fromDate = new Date(fromTs * 1000).toISOString().slice(0, 10);
  const toDate = new Date(toTs * 1000).toISOString().slice(0, 10);

  // Group rows by (date, source)
  type DayBucket = {
    totalTokens: number;
    projects: Array<{ projectKey: string; tokens: number }>;
  };
  const byDaySource = new Map<string, DayBucket>(); // key = `${date}::${source}`

  for (const row of dailyRows) {
    if (row.date < fromDate || row.date > toDate) {
      continue;
    }
    if (row.tokens <= 0) {
      continue;
    }
    const key = `${row.date}::${row.source}`;
    let bucket = byDaySource.get(key);
    if (!bucket) {
      bucket = { totalTokens: 0, projects: [] };
      byDaySource.set(key, bucket);
    }
    bucket.totalTokens += row.tokens;
    bucket.projects.push({ projectKey: row.projectKey, tokens: row.tokens });

    // Track first/last seen + active days
    const ts = dateIsoToTs(row.date);
    const existing = result.get(row.projectKey);
    if (!existing) {
      result.set(row.projectKey, {
        accruedEur: 0,
        firstSeenTs: ts,
        lastSeenTs: ts,
        activeDays: 1,
      });
    } else {
      existing.firstSeenTs = Math.min(existing.firstSeenTs ?? ts, ts);
      existing.lastSeenTs = Math.max(existing.lastSeenTs ?? ts, ts);
      // activeDays incremented below per (date, projectKey) unique pair
    }
  }

  // Recompute activeDays per project (count distinct dates)
  const activeDateSet = new Map<string, Set<string>>();
  for (const row of dailyRows) {
    if (row.date < fromDate || row.date > toDate || row.tokens <= 0) {
      continue;
    }
    let set = activeDateSet.get(row.projectKey);
    if (!set) {
      set = new Set();
      activeDateSet.set(row.projectKey, set);
    }
    set.add(row.date);
  }
  for (const [projectKey, dates] of activeDateSet.entries()) {
    const p = result.get(projectKey);
    if (p) {
      p.activeDays = dates.size;
    }
  }

  // Distribute per-day-source subscription rate proportionally to tokens
  for (const [key, bucket] of byDaySource.entries()) {
    const [date, sourceStr] = key.split('::');
    const source = sourceStr as BillingSource;
    const charges = source === 'claude' ? history?.claude || [] : history?.codex || [];
    const rate = dailyRateOnDate(charges, source, date);
    if (rate <= 0 || bucket.totalTokens <= 0) {
      continue;
    }
    for (const p of bucket.projects) {
      const contribution = rate * (p.tokens / bucket.totalTokens);
      const existing = result.get(p.projectKey);
      if (existing) {
        existing.accruedEur += contribution;
      }
    }
  }

  return result;
}
