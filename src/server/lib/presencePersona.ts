import type { Database } from 'bun:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { type Settings, expandHomePath } from '../config';

/**
 * Persona auto-feed — closes the V3-era loop by reading edit signals from
 * the dashboard and writing a vault-side anti-patterns file the drafter
 * picks up on its next scan.
 *
 * Flow:
 *   1. The user edits a draft → we capture before/after snippets + an
 *      `edit_ratio` in the 'edited' event payload (presence.ts).
 *   2. This module aggregates those events: top n-grams the user removes
 *      systematically + drafts they rewrote heavily.
 *   3. We render them as `Persona/anti_patterns.md` in the vault, replacing
 *      whatever was there. The drafter (presenceContext.ts) reads that file
 *      and folds it into the system prompt, so future drafts dodge the
 *      same patterns without manual instruction.
 *
 * Triggered weekly by the scheduler (or on-demand from the UI). Operates
 * entirely on data the system already collects — no extra LLM calls.
 */

const PERSONA_FILE = 'Persona/anti_patterns.md';
const TOP_NGRAMS_LIMIT = 25;
const TOP_HEAVY_EDITS_LIMIT = 8;
const STOP = new Set([
  'the',
  'a',
  'an',
  'is',
  'it',
  'of',
  'to',
  'in',
  'on',
  'and',
  'or',
  'but',
  'for',
  'with',
  'as',
  'at',
  'by',
  'be',
  'are',
  'was',
  'were',
  'this',
  'that',
  'i',
  'you',
  'we',
  'they',
  'he',
  'she',
  'my',
  'your',
  'our',
]);

type EditEventPayload = {
  before_snippet?: string;
  after_snippet?: string;
  edit_ratio?: number;
};

export type PersonaRefreshOutcome = {
  ok: boolean;
  path: string | null;
  ngrams_count: number;
  heavy_edits_count: number;
  reason?: string;
};

function aggregateNgrams(events: EditEventPayload[]): Array<{ ngram: string; n: number }> {
  const counter = new Map<string, number>();
  for (const ev of events) {
    const before = (ev.before_snippet || '').toLowerCase();
    const after = (ev.after_snippet || '').toLowerCase();
    if (!before || !after) continue;
    const beforeTokens = before.match(/\b[a-z']+\b/g) || [];
    const afterSet = new Set(after.match(/\b[a-z']+\b/g) || []);
    for (let i = 0; i < beforeTokens.length - 1; i++) {
      for (const len of [2, 3]) {
        if (i + len > beforeTokens.length) continue;
        const slice = beforeTokens.slice(i, i + len);
        if (slice.some((t) => STOP.has(t) || t.length < 3)) continue;
        if (!slice.every((t) => !afterSet.has(t))) continue;
        const ngram = slice.join(' ');
        counter.set(ngram, (counter.get(ngram) || 0) + 1);
      }
    }
  }
  return [...counter.entries()]
    .filter(([, n]) => n >= 2)
    .sort(([a, an], [b, bn]) => bn - an || a.localeCompare(b))
    .slice(0, TOP_NGRAMS_LIMIT)
    .map(([ngram, n]) => ({ ngram, n }));
}

function pickHeavyEdits(
  events: EditEventPayload[],
): Array<{ before: string; after: string; ratio: number }> {
  return events
    .filter((e) => (e.edit_ratio ?? 0) >= 0.4 && e.before_snippet && e.after_snippet)
    .map((e) => ({
      before: (e.before_snippet || '').slice(0, 200),
      after: (e.after_snippet || '').slice(0, 200),
      ratio: e.edit_ratio ?? 0,
    }))
    .sort((a, b) => b.ratio - a.ratio)
    .slice(0, TOP_HEAVY_EDITS_LIMIT);
}

function renderMarkdown(
  ngrams: Array<{ ngram: string; n: number }>,
  heavy: Array<{ before: string; after: string; ratio: number }>,
  windowDays: number,
): string {
  const generatedAt = new Date().toISOString();
  const header = [
    '---',
    'type: persona',
    'subtype: anti-patterns',
    `updated: ${generatedAt}`,
    'generator: vibecode-dash presence',
    'collab_reviewed: false',
    '---',
    '',
    '# Anti-patterns auto-extracted from your draft edits',
    '',
    `Generated from the last ${windowDays} days of your draft revisions in the Presence Copilot. The drafter picks this file up automatically and dodges these patterns on future drafts.`,
    '',
  ].join('\n');

  const ngramSection =
    ngrams.length > 0
      ? [
          '## Phrases you systematically remove',
          '',
          'Avoid these in drafts (ranked by frequency):',
          '',
          ...ngrams.map((g, i) => `${i + 1}. \`${g.ngram}\` — removed ${g.n}×`),
          '',
        ].join('\n')
      : '';

  const heavySection =
    heavy.length > 0
      ? [
          '## Heavy rewrites (drafts you reshaped 40%+)',
          '',
          'Examples of patterns the drafter got wrong. The "after" column is your style — match it.',
          '',
          ...heavy.flatMap((h, i) => [
            `### Edit ${i + 1} (${Math.round(h.ratio * 100)}% rewritten)`,
            '',
            `**Drafter wrote:** ${h.before}`,
            '',
            `**You corrected to:** ${h.after}`,
            '',
          ]),
        ].join('\n')
      : '';

  const empty =
    ngrams.length === 0 && heavy.length === 0
      ? '_Not enough edit data yet. Keep editing drafts and this file will fill up._\n'
      : '';

  return [header, ngramSection, heavySection, empty].filter((s) => s.length > 0).join('\n');
}

/**
 * Read recent 'edited' events, derive the anti-pattern signals, and write
 * `Persona/anti_patterns.md` to the vault. Idempotent — safe to call from
 * a cron tick and from a manual UI trigger.
 */
export async function refreshPersonaAntiPatterns(
  db: Database,
  settings: Settings,
  windowDays = 30,
): Promise<PersonaRefreshOutcome> {
  if (!settings.paths.vaultPath) {
    return {
      ok: false,
      path: null,
      ngrams_count: 0,
      heavy_edits_count: 0,
      reason: 'no_vault_path_configured',
    };
  }
  const since = Math.floor(Date.now() / 1000) - windowDays * 86400;

  const rows = db
    .query<{ payload_json: string | null }, [number]>(
      `SELECT payload_json FROM presence_draft_events
        WHERE event_type = 'edited' AND at >= ?
        ORDER BY at DESC
        LIMIT 1000`,
    )
    .all(since);

  const payloads: EditEventPayload[] = [];
  for (const row of rows) {
    if (!row.payload_json) continue;
    try {
      payloads.push(JSON.parse(row.payload_json) as EditEventPayload);
    } catch {
      // Malformed payload — skip silently. The aggregator handles missing
      // before/after snippets gracefully (just zero contribution).
    }
  }

  const ngrams = aggregateNgrams(payloads);
  const heavy = pickHeavyEdits(payloads);
  const md = renderMarkdown(ngrams, heavy, windowDays);

  const vaultRoot = resolve(expandHomePath(settings.paths.vaultPath));
  const filePath = resolve(vaultRoot, PERSONA_FILE);
  // Defensive: containment check so a malformed vault path can't write
  // outside its own root via path traversal.
  if (!filePath.startsWith(`${vaultRoot}/`) && filePath !== vaultRoot) {
    return {
      ok: false,
      path: null,
      ngrams_count: ngrams.length,
      heavy_edits_count: heavy.length,
      reason: 'path_outside_vault',
    };
  }

  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, md, 'utf8');

  return {
    ok: true,
    path: PERSONA_FILE,
    ngrams_count: ngrams.length,
    heavy_edits_count: heavy.length,
  };
}

/**
 * Read the anti-patterns file content if present; returns null if absent
 * (first run, no edits yet). Used by the drafter context builder.
 */
export async function loadPersonaAntiPatterns(settings: Settings): Promise<string | null> {
  if (!settings.paths.vaultPath) return null;
  try {
    const vaultRoot = resolve(expandHomePath(settings.paths.vaultPath));
    const filePath = join(vaultRoot, PERSONA_FILE);
    const raw = await readFile(filePath, 'utf8');
    // Strip frontmatter (between two `---` lines) so the LLM sees just the
    // useful prose. Cheap + tolerant of missing frontmatter.
    return raw.replace(/^---[\s\S]*?---\n*/, '').trim() || null;
  } catch {
    return null;
  }
}
