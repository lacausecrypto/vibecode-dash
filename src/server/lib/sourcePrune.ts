import type { Database } from 'bun:sqlite';
import type { PresenceSourceRow } from './presence';
import type { SourceHealthMetrics } from './sourceHealth';

/**
 * Pack C — Auto-prune assistant.
 *
 * Surfaces sources flagged by Pack B's classifier as low-ROI (`dead`,
 * `stale`, or `noisy`) along with a human-readable rationale built from
 * the same metrics that drove the classification. The user picks one of
 * two decisions per card:
 *
 *   - Deactivate : flip `active = 0` immediately. The source stays in DB
 *     so its history is preserved; just no longer scanned.
 *   - Keep      : write `prune_dismissed_at = now`. The 7-day cooldown
 *     hides the suggestion until the next refresh window — gives the
 *     classifier time to gather new evidence.
 *
 * Pure deterministic — same metrics in, same suggestions out. No LLM.
 */

export const PRUNE_COOLDOWN_DAYS = 7;

export type PruneSuggestion = {
  source_id: string;
  platform: string;
  kind: string;
  identifier: string;
  label: string | null;
  health_status: 'dead' | 'stale' | 'noisy';
  /** Severity ranking, dead first. Used for UI sort. */
  severity: 1 | 2 | 3;
  rationale: string;
  metrics: SourceHealthMetrics | null;
};

export type PruneSuggestionList = {
  total: number;
  cooldown_days: number;
  suggestions: PruneSuggestion[];
};

const DAY = 86400;

/**
 * Build the human-readable rationale for a card. References real numbers
 * from health_metrics_json so the user understands WHY this source was
 * flagged, not just THAT it was.
 */
function buildRationale(
  health: 'dead' | 'stale' | 'noisy',
  m: SourceHealthMetrics | null,
  source: PresenceSourceRow,
): string {
  const parts: string[] = [];
  if (health === 'dead') {
    if (m?.validation_status === 'not_found' || m?.validation_status === 'banned') {
      parts.push(`Platform reports the source as ${m.validation_status}.`);
    } else if (m && m.last_scanned_at != null && m.drafts_30d === 0) {
      const ageDays = Math.round((Math.floor(Date.now() / 1000) - source.added_at) / DAY);
      parts.push(
        `Scanned recently (last ${Math.round(
          (Math.floor(Date.now() / 1000) - m.last_scanned_at) / 3600,
        )}h ago) but produced 0 candidates over 30 days. Source is ${ageDays}d old.`,
      );
    } else {
      parts.push('Confirmed dead by signal aggregation.');
    }
  } else if (health === 'stale') {
    if (m) {
      parts.push(
        `Had ${m.posted_30_60d} posted draft(s) in the 30-60 day window, ${m.posted_14d} in the last 14 days.`,
      );
    }
    parts.push('Lost steam, worth re-evaluating.');
  } else if (health === 'noisy') {
    if (m) {
      const editPct = m.avg_edit_ratio == null ? '—' : `${(m.avg_edit_ratio * 100).toFixed(0)}%`;
      parts.push(
        `${m.proposed_30d} proposed in 30 days but you rewrote ${editPct} of each draft on average. ${m.posted_30d} actually posted.`,
      );
    }
    parts.push('Either tighten the source query or deactivate.');
  }
  return parts.join(' ');
}

function severityFor(status: 'dead' | 'stale' | 'noisy'): 1 | 2 | 3 {
  switch (status) {
    case 'dead':
      return 1;
    case 'stale':
      return 2;
    case 'noisy':
      return 3;
  }
}

/**
 * Build the prune-suggestion list. Only includes ACTIVE sources (no point
 * suggesting to deactivate something already off) and excludes anything
 * the user has explicitly kept within the cooldown window.
 */
export function getPruneSuggestions(db: Database): PruneSuggestionList {
  const now = Math.floor(Date.now() / 1000);
  const cooldownCutoff = now - PRUNE_COOLDOWN_DAYS * DAY;

  const rows = db
    .query<PresenceSourceRow, [number]>(
      `SELECT * FROM presence_sources
        WHERE active = 1
          AND health_status IN ('dead', 'stale', 'noisy')
          AND (prune_dismissed_at IS NULL OR prune_dismissed_at < ?)
        ORDER BY
          CASE health_status WHEN 'dead' THEN 1 WHEN 'stale' THEN 2 WHEN 'noisy' THEN 3 ELSE 4 END,
          identifier`,
    )
    .all(cooldownCutoff);

  const suggestions: PruneSuggestion[] = rows
    .filter(
      (s): s is PresenceSourceRow & { health_status: 'dead' | 'stale' | 'noisy' } =>
        s.health_status === 'dead' || s.health_status === 'stale' || s.health_status === 'noisy',
    )
    .map((s) => {
      let metrics: SourceHealthMetrics | null = null;
      if (s.health_metrics_json) {
        try {
          metrics = JSON.parse(s.health_metrics_json) as SourceHealthMetrics;
        } catch {
          /* malformed — leave null */
        }
      }
      return {
        source_id: s.id,
        platform: s.platform,
        kind: s.kind,
        identifier: s.identifier,
        label: s.label,
        health_status: s.health_status,
        severity: severityFor(s.health_status),
        rationale: buildRationale(s.health_status, metrics, s),
        metrics,
      };
    });

  return {
    total: suggestions.length,
    cooldown_days: PRUNE_COOLDOWN_DAYS,
    suggestions,
  };
}

/**
 * "Keep, recompute next week" decision. Stamps the dismissal timestamp;
 * the suggestion endpoint hides this source until the cooldown elapses.
 */
export function dismissPruneSuggestion(db: Database, sourceId: string): boolean {
  const now = Math.floor(Date.now() / 1000);
  const res = db
    .query<unknown, [number, string]>(
      'UPDATE presence_sources SET prune_dismissed_at = ? WHERE id = ?',
    )
    .run(now, sourceId);
  return (res.changes ?? 0) > 0;
}
