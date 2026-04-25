import type { Database } from 'bun:sqlite';
import type { Settings } from '../config';
import { type PersonaSnapshot, type VaultMatch, loadPersona, searchVault } from './memory';
import { loadPersonaAntiPatterns } from './presencePersona';

/**
 * Context builder for the Presence Copilot drafter.
 *
 * Assembles three signal sources the model needs to produce an authentic
 * draft in the user's voice:
 *
 *   1. Persona — identity + values from the Obsidian vault (Karpathy LLM OS
 *      Persona/ folder). This is what makes the draft sound like _them_, not
 *      generic LLM output. Missing persona is a soft error — we warn and
 *      continue so the rest of the pipeline can still work.
 *
 *   2. Vault matches — top-K notes from FTS5 matching the candidate thread's
 *      topic. Cited in the draft rationale ("inspired by note X") so the user
 *      sees which of their own past writing is being leveraged. Also gives
 *      the model something real to stand on when it defends a position.
 *
 *   3. Radar insights — if the candidate topic overlaps a pending radar
 *      insight (market_gap / overlap / vault_echo), we surface it: the user's
 *      own competitor/project observations become evergreen material for
 *      social commentary.
 *
 * Output is a single formatted context block (markdown) ready to inject in
 * the Claude CLI prompt. We deliberately cap total length so the prompt
 * stays cheap and focused.
 */

const MAX_PERSONA_CHARS = 3000;
const MAX_VAULT_SNIPPETS = 5;
const MAX_RADAR_INSIGHTS = 3;
const MAX_CONTEXT_CHARS = 12_000; // soft cap; we warn past this

export type RadarInsightRef = {
  id: string;
  type: string; // market_gap | overlap | vault_echo
  title: string;
  body: string | null;
};

export type PresenceContext = {
  persona: PersonaSnapshot;
  vaultMatches: VaultMatch[];
  /** Subset of vaultMatches that passed the relevance gate (BM25 + token overlap). */
  vaultMatchesIncluded: VaultMatch[];
  radarInsights: RadarInsightRef[];
  antiPatterns: string | null;
  contextBlock: string; // formatted for prompt injection
  tokensEstimate: number;
};

/**
 * Conservative gate on vault inclusion. The previous always-include behaviour
 * led the drafter to cite irrelevant notes ("[[Concepts/foo]]" tossed into a
 * post about something else), so we now require BOTH:
 *   - A strong BM25 score (FTS5 ranks lower = better; bm25 < -3 is a robust
 *     match in our corpus, anything weaker is keyword noise).
 *   - At least one meaningful token from the note title also appearing in
 *     the candidate topic text (sanity check that the LLM-side connection
 *     is plausible, not just a stop-word collision).
 *
 * Returns the filtered subset that's actually worth surfacing to the model.
 */
function filterRelevantVaultMatches(matches: VaultMatch[], topicText: string): VaultMatch[] {
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
    'your',
    'yours',
    'we',
    'us',
    'our',
    'ours',
    'they',
    'them',
    'their',
    'theirs',
    'me',
    'my',
    'mine',
    'he',
    'she',
    'his',
    'her',
    'hers',
    'how',
    'what',
    'why',
    'when',
    'where',
    'who',
    'which',
    'if',
    'then',
    'than',
    'so',
    'do',
    'does',
    'did',
    'has',
    'have',
    'had',
    'will',
    'would',
    'should',
    'could',
    'can',
    'may',
    'might',
    'must',
    'index',
    'template',
    'note',
    'notes',
    'auto',
    'extracted',
    'draft',
    'edits',
  ]);
  const topicTokens = new Set(
    (topicText.toLowerCase().match(/\b[a-z][a-z0-9_-]{2,}\b/g) || []).filter((t) => !STOP.has(t)),
  );
  return matches.filter((m) => {
    if (m.score >= -3) return false; // weak match
    const titleTokens = (m.title.toLowerCase().match(/\b[a-z][a-z0-9_-]{2,}\b/g) || []).filter(
      (t) => !STOP.has(t),
    );
    const overlap = titleTokens.some((t) => topicTokens.has(t));
    return overlap;
  });
}

function truncate(input: string, maxChars: number): string {
  if (input.length <= maxChars) return input;
  return `${input.slice(0, maxChars)}\n… [truncated]`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Query radar insights whose title/body contains terms from `topic`. Cheap
 * LIKE-based filter — we don't need FTS on a handful of insights. Only
 * returns `pending` insights so the user hasn't already dismissed them.
 */
function findRelevantInsights(db: Database, topic: string): RadarInsightRef[] {
  const terms = topic
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 4)
    .slice(0, 5);
  if (terms.length === 0) return [];

  const likeClauses = terms.map(() => '(LOWER(title) LIKE ? OR LOWER(body) LIKE ?)').join(' OR ');
  const params: string[] = [];
  for (const term of terms) {
    params.push(`%${term}%`, `%${term}%`);
  }
  try {
    return db
      .query<{ id: string; type: string; title: string; body: string | null }, typeof params>(
        `SELECT id, type, title, body FROM insights
          WHERE status = 'pending' AND (${likeClauses})
          ORDER BY created_at DESC
          LIMIT ${MAX_RADAR_INSIGHTS}`,
      )
      .all(...params);
  } catch {
    return [];
  }
}

/**
 * Build the context block for a candidate thread. `topicText` should be the
 * concatenation of thread title + first chunk of body — enough to seed the
 * FTS query and insight lookup.
 */
export async function buildPresenceContext(opts: {
  db: Database;
  settings: Settings;
  topicText: string;
}): Promise<PresenceContext> {
  const [persona, antiPatterns] = await Promise.all([
    loadPersona(opts.settings),
    loadPersonaAntiPatterns(opts.settings),
  ]);
  const vaultMatchesAll = opts.topicText
    ? searchVault(opts.db, opts.topicText, MAX_VAULT_SNIPPETS)
    : [];
  const vaultMatchesIncluded = filterRelevantVaultMatches(vaultMatchesAll, opts.topicText);
  const radarInsights = findRelevantInsights(opts.db, opts.topicText);

  const personaBlock = [
    persona.identity ? `### Identity\n${truncate(persona.identity, MAX_PERSONA_CHARS)}` : null,
    persona.values ? `### Values\n${truncate(persona.values, MAX_PERSONA_CHARS)}` : null,
  ]
    .filter(Boolean)
    .join('\n\n');

  // Anti-patterns block: derived from the user's actual edits via
  // refreshPersonaAntiPatterns. Folding it in here means the drafter dodges
  // these patterns without any prompt-engineering change on our side.
  const antiBlock = antiPatterns
    ? `### Anti-patterns (avoid these, derived from your past edits)\n${truncate(antiPatterns, 2500)}`
    : '';

  // Vault is now CONDITIONAL. Only included when the relevance gate passes,
  // and even then with a strong "cite ONLY if directly supports a claim"
  // notice so the drafter doesn't sprinkle [[Vault/foo]] tags into posts
  // where the connection is tangential.
  const vaultBlock =
    vaultMatchesIncluded.length === 0
      ? ''
      : [
          '### Vault notes (use ONLY if a claim in your draft directly references this material; do NOT cite for vibes)',
          ...vaultMatchesIncluded.map((m) => `- **[[${m.path}]]** ${m.title}\n  ${m.snippet}`),
        ].join('\n');

  const radarBlock =
    radarInsights.length === 0
      ? ''
      : `### Active radar insights\n${radarInsights
          .map((i) => `- [${i.type}] **${i.title}**${i.body ? `\n  ${truncate(i.body, 400)}` : ''}`)
          .join('\n')}`;

  const parts = [personaBlock, antiBlock, vaultBlock, radarBlock].filter((s) => s.length > 0);
  let contextBlock =
    parts.length > 0 ? parts.join('\n\n---\n\n') : '(no persona/vault/radar available)';
  if (contextBlock.length > MAX_CONTEXT_CHARS) {
    contextBlock = `${contextBlock.slice(0, MAX_CONTEXT_CHARS)}\n… [truncated]`;
  }

  return {
    persona,
    vaultMatches: vaultMatchesAll,
    vaultMatchesIncluded,
    radarInsights,
    antiPatterns,
    contextBlock,
    tokensEstimate: estimateTokens(contextBlock),
  };
}
