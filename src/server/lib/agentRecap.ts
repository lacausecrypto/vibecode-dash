import type { Database } from 'bun:sqlite';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

export type RecapLocale = 'fr' | 'en' | 'es';

/**
 * Quick-recap automation for the project-detail "Ask agent" button.
 *
 * Goal: when the user taps Ask agent on a project, we want to land them
 * inside a freshly-created agent session that's already streaming a
 * structured project recap from a randomly-picked recent model. No
 * intermediate UI, no manual prompt assembly.
 *
 * This module owns the data gathering + prompt assembly. The HTTP
 * endpoint in routes/agent.ts wires it up to session creation, and the
 * client hands off via sessionStorage so the agent route can auto-fire
 * the first message.
 */

export type RecapModel = {
  provider: 'claude' | 'codex';
  id: string;
};

/**
 * Curated subset of the catalog the random pick draws from. We
 * deliberately avoid older models (Opus 4.5, GPT-5.0/4o, o3 family) so
 * a Recap session always lands on something current and capable.
 *
 * Composition kept balanced 3 Claude / 3 Codex so the user can't tell
 * provider bias by feel — uniform pick over all 6 = 50/50 expected.
 */
export const RECENT_RECAP_MODELS: RecapModel[] = [
  { provider: 'claude', id: 'claude-opus-4-7' },
  { provider: 'claude', id: 'claude-sonnet-4-6' },
  { provider: 'claude', id: 'claude-haiku-4-5-20251001' },
  { provider: 'codex', id: 'gpt-5.5' },
  { provider: 'codex', id: 'gpt-5.4' },
  { provider: 'codex', id: 'gpt-5.3-codex' },
];

export function pickRandomRecapModel(): RecapModel {
  const idx = Math.floor(Math.random() * RECENT_RECAP_MODELS.length);
  // Defensive: Math.random() can in theory return exactly 1.0 in edge
  // cases (some legacy engines); Math.floor would then index out of
  // bounds. Clamp to last entry.
  return RECENT_RECAP_MODELS[Math.min(idx, RECENT_RECAP_MODELS.length - 1)];
}

type ProjectRow = {
  id: string;
  name: string;
  path: string;
  type: string;
  description: string | null;
  readme_path: string | null;
  health_score: number;
  last_modified: number;
  last_commit_at: number | null;
  git_branch: string | null;
  uncommitted: number;
  loc: number | null;
  languages_json: string | null;
};

type UsageAggregateRow = {
  source: 'claude' | 'codex';
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read: number;
  messages: number;
  sessions: number;
  cost_usd: number;
};

type CompetitorRow = {
  name: string;
  url: string | null;
  pitch: string | null;
};

export type ProjectRecapData = {
  project: ProjectRow;
  claudeUsage: UsageAggregateRow | null;
  codexUsage: UsageAggregateRow | null;
  competitors: CompetitorRow[];
  readmeExcerpt: string | null;
};

const RECAP_USAGE_DAYS = 90; // window the recap considers "recent" usage
const RECAP_README_CHARS = 600; // excerpt size — enough to convey project intent
const RECAP_TOP_COMPETITORS = 5; // surface up to 5 in the prompt

function isoDateNDaysAgo(n: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/**
 * Pulls everything the recap prompt needs in a single pass. All
 * sub-queries are best-effort: if the project has zero usage yet, no
 * competitors, or no README, the recap still works — the prompt template
 * tolerates nulls and the model just receives less data.
 */
export function gatherProjectRecapData(db: Database, projectId: string): ProjectRecapData | null {
  const project = db
    .query<ProjectRow, [string]>('SELECT * FROM projects WHERE id = ?')
    .get(projectId);
  if (!project) return null;

  const since = isoDateNDaysAgo(RECAP_USAGE_DAYS);
  const usageRows = db
    .query<UsageAggregateRow, [string, string]>(
      `SELECT
         source,
         COALESCE(SUM(total_tokens), 0)  AS total_tokens,
         COALESCE(SUM(input_tokens), 0)  AS input_tokens,
         COALESCE(SUM(output_tokens), 0) AS output_tokens,
         COALESCE(SUM(cache_read), 0)    AS cache_read,
         COALESCE(SUM(messages), 0)      AS messages,
         COALESCE(SUM(sessions), 0)      AS sessions,
         COALESCE(SUM(cost_usd), 0)      AS cost_usd
       FROM usage_daily_by_project
       WHERE project_id = ? AND date >= ?
       GROUP BY source`,
    )
    .all(projectId, since);

  const claudeUsage = usageRows.find((r) => r.source === 'claude') ?? null;
  const codexUsage = usageRows.find((r) => r.source === 'codex') ?? null;

  const competitors = db
    .query<CompetitorRow, [string, number]>(
      `SELECT name, url, pitch
         FROM competitors
         WHERE project_id = ?
         ORDER BY last_seen DESC, name ASC
         LIMIT ?`,
    )
    .all(projectId, RECAP_TOP_COMPETITORS);

  return {
    project,
    claudeUsage,
    codexUsage,
    competitors,
    readmeExcerpt: null, // populated async by gatherProjectRecapDataAsync below
  };
}

/**
 * Async wrapper that reads the README on top of the synchronous gather.
 * Kept separate because Bun's SQLite is sync-only and we don't want to
 * mix sync DB queries with async file IO inside one function — easier to
 * reason about ordering this way.
 */
export async function gatherProjectRecapDataAsync(
  db: Database,
  projectId: string,
): Promise<ProjectRecapData | null> {
  const data = gatherProjectRecapData(db, projectId);
  if (!data) return null;

  if (data.project.readme_path) {
    try {
      const path = resolve(data.project.path, data.project.readme_path);
      // Defensive: ensure the README is inside the project root before
      // reading. Prevents a maliciously-stored absolute path in the DB
      // from leaking unrelated files into the prompt.
      const projectRoot = resolve(data.project.path);
      if (path === projectRoot || path.startsWith(`${projectRoot}/`)) {
        const raw = await readFile(path, 'utf8');
        data.readmeExcerpt = raw.slice(0, RECAP_README_CHARS).trim() || null;
      }
    } catch {
      // README missing or unreadable — the prompt simply omits it.
    }
  }

  return data;
}

function relativeDays(ts: number | null, locale: RecapLocale): string {
  if (!ts) {
    return locale === 'en' ? 'never' : locale === 'es' ? 'nunca' : 'jamais';
  }
  const diffSec = Math.floor(Date.now() / 1000) - ts;
  const min = Math.max(1, Math.floor(diffSec / 60));
  const hr = Math.floor(diffSec / 3600);
  const day = Math.floor(diffSec / 86400);

  if (locale === 'en') {
    if (diffSec < 3600) return `${min} min ago`;
    if (diffSec < 86400) return `${hr} h ago`;
    return `${day} d ago`;
  }
  if (locale === 'es') {
    if (diffSec < 3600) return `hace ${min} min`;
    if (diffSec < 86400) return `hace ${hr} h`;
    return `hace ${day} d`;
  }
  // fr default
  if (diffSec < 3600) return `il y a ${min} min`;
  if (diffSec < 86400) return `il y a ${hr} h`;
  return `il y a ${day} j`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)} M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)} k`;
  return String(n);
}

function formatCost(usd: number): string {
  if (usd <= 0) return '$0';
  if (usd < 0.01) return '<$0.01';
  return `$${usd.toFixed(2)}`;
}

function parseLanguages(json: string | null): string {
  if (!json) return '—';
  try {
    const parsed = JSON.parse(json) as Record<string, number> | string[];
    if (Array.isArray(parsed)) return parsed.slice(0, 5).join(', ') || '—';
    const entries = Object.entries(parsed).sort((a, b) => b[1] - a[1]);
    return (
      entries
        .slice(0, 5)
        .map(([lang, share]) => {
          // share might be a percentage (0-100) or a ratio (0-1) — render
          // either form sensibly.
          if (share <= 1) return `${lang} ${(share * 100).toFixed(0)}%`;
          return `${lang} ${share.toFixed(0)}%`;
        })
        .join(', ') || '—'
    );
  } catch {
    return '—';
  }
}

/**
 * Per-locale label dictionary. Centralised here so the prompt template
 * function below stays a single body instead of three near-duplicates.
 *
 * Each entry maps directly to a section / line in buildRecapPrompt. The
 * brief instructions at the bottom (the 5-section deliverable spec) are
 * the single most important translation: they tell the agent which
 * language to *answer in* — mistranslating those would produce a French
 * response in an English UI session.
 */
type RecapStrings = {
  numberLocale: string; // BCP47 tag for toLocaleString
  title: (name: string) => string;
  metadata: string;
  pathLabel: string;
  typeLabel: string;
  gitBranchLabel: string;
  uncommittedSuffix: (n: number) => string;
  locLabel: string;
  langsLabel: string;
  healthLabel: string;
  lastCommitLabel: string;
  lastModifiedLabel: string;
  description: string;
  readmeExcerpt: string;
  llmConsumption: string;
  claudeNoActivity: string;
  codexNoActivity: string;
  claudeUsage: (
    totalTok: string,
    inTok: string,
    outTok: string,
    cacheTok: string,
    sessions: number,
    messages: number,
    cost: string,
  ) => string;
  codexUsage: (
    totalTok: string,
    inTok: string,
    outTok: string,
    sessions: number,
    turns: number,
    cost: string,
  ) => string;
  competitorsTitle: string;
  competitorsEmpty: string;
  whatIWant: string;
  brief: string;
  section1: string;
  section2: string;
  section3: string;
  section4: string;
  section5: string;
};

const RECAP_STRINGS: Record<RecapLocale, RecapStrings> = {
  fr: {
    numberLocale: 'fr-FR',
    title: (name) => `# Recap demandé sur le projet « ${name} »`,
    metadata: '## Métadonnées',
    pathLabel: '- **Path** :',
    typeLabel: '- **Type** :',
    gitBranchLabel: '- **Branche git** :',
    uncommittedSuffix: (n) => `${n} fichier(s) non-commités`,
    locLabel: '- **LoC** :',
    langsLabel: '- **Langages** :',
    healthLabel: '- **Health score** :',
    lastCommitLabel: '- **Dernier commit** :',
    lastModifiedLabel: '- **Dernière modif** :',
    description: '## Description',
    readmeExcerpt: '## Extrait README',
    llmConsumption: '## Consommation LLM (90 derniers jours)',
    claudeNoActivity: '- **Claude** : aucune activité enregistrée sur ce projet',
    codexNoActivity: '- **Codex** : aucune activité enregistrée sur ce projet',
    claudeUsage: (total, inT, outT, cache, ses, msg, cost) =>
      `- **Claude** : ${total} tokens (in ${inT} / out ${outT} / cache ${cache}) · ${ses} sessions · ${msg} messages · coût ${cost}`,
    codexUsage: (total, inT, outT, ses, turns, cost) =>
      `- **Codex** : ${total} tokens (in ${inT} / out ${outT}) · ${ses} sessions · ${turns} turns · coût ${cost}`,
    competitorsTitle: '## Concurrents identifiés (radar)',
    competitorsEmpty: 'Aucun concurrent enregistré pour ce projet.',
    whatIWant: '## Ce que je veux de toi',
    brief:
      'Tu as accès au repo via le `cwd` de cette session — lis les fichiers que tu juges utiles ' +
      '(README, package.json, src/, docs/, etc.). Réponds **en français**, concret, sans fioritures, ' +
      'avec les 5 sections suivantes :',
    section1:
      "1. **Recap synthétique** (3-4 lignes) : où en est ce projet aujourd'hui, points forts, points faibles.",
    section2:
      '2. **Conseil personnalisé** : compte tenu de ma consommation tokens ci-dessus et de ' +
      "l'état actuel du repo, quelles sont les **3 prochaines actions à prioriser** ? Ordonne-les.",
    section3:
      '3. **Analyse marché** : positionnement vs concurrents listés, niches à creuser, ' +
      'risques de saturation. Si la liste est vide, propose 2-3 concurrents probables que je devrais ajouter au radar.',
    section4:
      '4. **Audit technique éclair** : 3 hotspots (dette, sécurité, perf) que tu identifies en lisant le repo. ' +
      'Cite les fichiers et lignes précises.',
    section5:
      '5. **Verdict honnête** : `continuer` / `pivoter` / `abandonner` ? Justifie en 2-3 phrases ' +
      'sans complaisance.',
  },
  en: {
    numberLocale: 'en-US',
    title: (name) => `# Project recap requested for "${name}"`,
    metadata: '## Metadata',
    pathLabel: '- **Path**:',
    typeLabel: '- **Type**:',
    gitBranchLabel: '- **Git branch**:',
    uncommittedSuffix: (n) => `${n} uncommitted file(s)`,
    locLabel: '- **LoC**:',
    langsLabel: '- **Languages**:',
    healthLabel: '- **Health score**:',
    lastCommitLabel: '- **Last commit**:',
    lastModifiedLabel: '- **Last modified**:',
    description: '## Description',
    readmeExcerpt: '## README excerpt',
    llmConsumption: '## LLM consumption (last 90 days)',
    claudeNoActivity: '- **Claude**: no recorded activity on this project',
    codexNoActivity: '- **Codex**: no recorded activity on this project',
    claudeUsage: (total, inT, outT, cache, ses, msg, cost) =>
      `- **Claude**: ${total} tokens (in ${inT} / out ${outT} / cache ${cache}) · ${ses} sessions · ${msg} messages · cost ${cost}`,
    codexUsage: (total, inT, outT, ses, turns, cost) =>
      `- **Codex**: ${total} tokens (in ${inT} / out ${outT}) · ${ses} sessions · ${turns} turns · cost ${cost}`,
    competitorsTitle: '## Identified competitors (radar)',
    competitorsEmpty: 'No competitors recorded for this project.',
    whatIWant: '## What I want from you',
    brief:
      "You have access to the repo via this session's `cwd` — read whatever files you find useful " +
      '(README, package.json, src/, docs/, etc.). Reply **in English**, concrete, no fluff, ' +
      'with the following 5 sections:',
    section1:
      '1. **Synthetic recap** (3-4 lines): where this project stands today, strengths, weaknesses.',
    section2:
      '2. **Personalized advice**: given my token consumption above and the current state of the repo, ' +
      'what are the **3 next actions to prioritize**? Order them.',
    section3:
      '3. **Market analysis**: positioning vs listed competitors, niches to explore, ' +
      'saturation risks. If the list is empty, propose 2-3 likely competitors I should add to the radar.',
    section4:
      '4. **Quick technical audit**: 3 hotspots (debt, security, perf) you identify by reading the repo. ' +
      'Cite exact files and line numbers.',
    section5:
      '5. **Honest verdict**: `continue` / `pivot` / `abandon`? Justify in 2-3 sentences ' +
      'without sugar-coating.',
  },
  es: {
    numberLocale: 'es-ES',
    title: (name) => `# Recap solicitado para el proyecto «${name}»`,
    metadata: '## Metadatos',
    pathLabel: '- **Ruta**:',
    typeLabel: '- **Tipo**:',
    gitBranchLabel: '- **Rama git**:',
    uncommittedSuffix: (n) => `${n} archivo(s) sin commit`,
    locLabel: '- **LoC**:',
    langsLabel: '- **Lenguajes**:',
    healthLabel: '- **Health score**:',
    lastCommitLabel: '- **Último commit**:',
    lastModifiedLabel: '- **Última modificación**:',
    description: '## Descripción',
    readmeExcerpt: '## Extracto README',
    llmConsumption: '## Consumo LLM (últimos 90 días)',
    claudeNoActivity: '- **Claude**: ninguna actividad registrada en este proyecto',
    codexNoActivity: '- **Codex**: ninguna actividad registrada en este proyecto',
    claudeUsage: (total, inT, outT, cache, ses, msg, cost) =>
      `- **Claude**: ${total} tokens (in ${inT} / out ${outT} / cache ${cache}) · ${ses} sesiones · ${msg} mensajes · coste ${cost}`,
    codexUsage: (total, inT, outT, ses, turns, cost) =>
      `- **Codex**: ${total} tokens (in ${inT} / out ${outT}) · ${ses} sesiones · ${turns} turns · coste ${cost}`,
    competitorsTitle: '## Competidores identificados (radar)',
    competitorsEmpty: 'Ningún competidor registrado para este proyecto.',
    whatIWant: '## Lo que quiero de ti',
    brief:
      'Tienes acceso al repo vía el `cwd` de esta sesión — lee los archivos que consideres útiles ' +
      '(README, package.json, src/, docs/, etc.). Responde **en español**, concreto, sin adornos, ' +
      'con las 5 secciones siguientes:',
    section1:
      '1. **Recap sintético** (3-4 líneas): dónde está este proyecto hoy, puntos fuertes, puntos débiles.',
    section2:
      '2. **Consejo personalizado**: dado mi consumo de tokens arriba y el estado actual del repo, ' +
      '¿cuáles son las **3 próximas acciones a priorizar**? Ordénalas.',
    section3:
      '3. **Análisis de mercado**: posicionamiento vs competidores listados, nichos a explorar, ' +
      'riesgos de saturación. Si la lista está vacía, propón 2-3 competidores probables que debería añadir al radar.',
    section4:
      '4. **Auditoría técnica rápida**: 3 hotspots (deuda, seguridad, perf) que identifiques leyendo el repo. ' +
      'Cita los archivos y líneas exactas.',
    section5:
      '5. **Veredicto honesto**: `continuar` / `pivotar` / `abandonar`? Justifica en 2-3 frases ' +
      'sin complacencia.',
  },
};

/**
 * Builds the seed prompt sent as the first user message of the
 * auto-created session. Structured so the agent has all the data needed
 * for the 5 sections we ask in the trailing brief.
 *
 * The locale parameter selects from RECAP_STRINGS — critically, this
 * also drives which language the agent is instructed to *reply in*. We
 * never want a French session asking the model to reply in English (or
 * vice versa) because the persona injection downstream is locale-aware.
 */
export function buildRecapPrompt(data: ProjectRecapData, locale: RecapLocale): string {
  const { project, claudeUsage, codexUsage, competitors, readmeExcerpt } = data;
  const s = RECAP_STRINGS[locale];

  const lines: string[] = [];
  lines.push(s.title(project.name));
  lines.push('');
  lines.push(s.metadata);
  lines.push(`${s.pathLabel} \`${project.path}\``);
  lines.push(`${s.typeLabel} ${project.type || '—'}`);
  lines.push(
    `${s.gitBranchLabel} ${project.git_branch || '—'} · ${s.uncommittedSuffix(project.uncommitted)}`,
  );
  lines.push(
    `${s.locLabel} ${project.loc != null ? project.loc.toLocaleString(s.numberLocale) : '—'}`,
  );
  lines.push(`${s.langsLabel} ${parseLanguages(project.languages_json)}`);
  lines.push(`${s.healthLabel} ${project.health_score}/100`);
  lines.push(`${s.lastCommitLabel} ${relativeDays(project.last_commit_at, locale)}`);
  lines.push(`${s.lastModifiedLabel} ${relativeDays(project.last_modified, locale)}`);

  if (project.description) {
    lines.push('');
    lines.push(s.description);
    lines.push(project.description);
  }

  if (readmeExcerpt) {
    lines.push('');
    lines.push(s.readmeExcerpt);
    lines.push('```');
    lines.push(readmeExcerpt);
    lines.push('```');
  }

  lines.push('');
  lines.push(s.llmConsumption);
  if (claudeUsage && claudeUsage.total_tokens > 0) {
    lines.push(
      s.claudeUsage(
        formatTokens(claudeUsage.total_tokens),
        formatTokens(claudeUsage.input_tokens),
        formatTokens(claudeUsage.output_tokens),
        formatTokens(claudeUsage.cache_read),
        claudeUsage.sessions,
        claudeUsage.messages,
        formatCost(claudeUsage.cost_usd),
      ),
    );
  } else {
    lines.push(s.claudeNoActivity);
  }
  if (codexUsage && codexUsage.total_tokens > 0) {
    lines.push(
      s.codexUsage(
        formatTokens(codexUsage.total_tokens),
        formatTokens(codexUsage.input_tokens),
        formatTokens(codexUsage.output_tokens),
        codexUsage.sessions,
        codexUsage.messages,
        formatCost(codexUsage.cost_usd),
      ),
    );
  } else {
    lines.push(s.codexNoActivity);
  }

  lines.push('');
  lines.push(s.competitorsTitle);
  if (competitors.length === 0) {
    lines.push(s.competitorsEmpty);
  } else {
    for (const c of competitors) {
      const url = c.url ? ` — ${c.url}` : '';
      const pitch = c.pitch ? ` · ${c.pitch}` : '';
      lines.push(`- **${c.name}**${url}${pitch}`);
    }
  }

  lines.push('');
  lines.push('---');
  lines.push('');
  lines.push(s.whatIWant);
  lines.push('');
  lines.push(s.brief);
  lines.push('');
  lines.push(s.section1);
  lines.push(s.section2);
  lines.push(s.section3);
  lines.push(s.section4);
  lines.push(s.section5);

  return lines.join('\n');
}
