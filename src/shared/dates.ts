/**
 * Centralised date utilities. The agent + dashboard run as a single local user
 * on their machine — "today" means "today in the user's local timezone", not
 * UTC. Keeping one helper ensures the answer is consistent across code paths
 * (prompt injection, archive filenames, session dates, SQL WHERE clauses).
 */

/** YYYY-MM-DD for the given Date in local TZ. */
export function toIsoDate(date: Date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** YYYY-MM-DD for today in local TZ. */
export function todayIso(): string {
  return toIsoDate(new Date());
}

/** YYYY-MM-DD shifted by N days (can be negative). */
export function isoDateShiftedDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return toIsoDate(d);
}

/** Unix seconds for the current moment. */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
