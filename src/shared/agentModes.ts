/**
 * Agent modes — shared between client (UI + persistence) and server (prompt
 * assembly + tool policy + memory pass bias). Keep this file pure: no Node or
 * browser APIs.
 *
 * Locale strategy: structural fields (id, icon, tone, toolPolicy,
 * permissionMode, bashAllowlist, memoryBias.defaultScope) are shared across
 * all locales. Text content (label, hint, systemAddendum, userWrap markdown
 * headers, memoryBias.focus, starters) is stored per-locale and resolved via
 * `getAgentMode(id, locale)` / `getStarterPrompts(locale)`. The FR version is
 * authoritative; EN/ES are faithful translations preserving the same
 * anti-filler, direct voice.
 */

export type AgentMode = 'chat' | 'plan' | 'learn' | 'reflect';
export type Locale = 'fr' | 'en' | 'es';

/**
 * Tool policies map to Claude CLI `--tools` flag:
 *   - all       → full agentic (can edit, write, run arbitrary bash)
 *   - read-only → file-inspection + dashboard curl. No Edit / Write / Task.
 *   - none      → `--tools ""`, pure reasoning from the injected context.
 */
export type ToolPolicy = 'all' | 'read-only' | 'none';

/** List of Claude tool names exposed when policy = 'read-only'. */
export const READ_ONLY_TOOL_SET = ['Read', 'Glob', 'Grep', 'WebFetch', 'WebSearch'] as const;

/**
 * Explicit permission flag per mode. Previously inferred from toolPolicy
 * ("not none → skip-permissions"), which coupled two decisions and silently
 * auto-approved any tool invocation.
 *
 *   - 'skip'    → --dangerously-skip-permissions (Claude) / --dangerously-bypass-approvals-and-sandbox (Codex)
 *   - 'default' → prompt on every tool invocation (will hang in -p mode, not usable)
 *   - 'plan'    → Claude's --permission-mode=plan: model may only PLAN, never EXECUTE
 *
 * For a local dashboard with a trusted single user, 'skip' is the only viable
 * option for the `all` policy. Read-only / none modes are safe by construction
 * (they can't write).
 */
export type PermissionMode = 'skip' | 'plan';

export type MemoryBias = {
  /** What kinds of facts the memory-pass should prioritise after this mode. */
  focus: string[];
  /** Suggested scope default if the model doesn't specify one. */
  defaultScope: 'global' | 'project' | 'session';
};

export type AgentModeConfig = {
  id: AgentMode;
  label: string;
  /** Short tagline shown next to the segmented control. */
  hint: string;
  /** One-character icon used in chips and message footers. Plain text, no emoji fallbacks. */
  icon: string;
  /** Colour token used by the UI chip. Maps to existing `Chip` tones. */
  tone: 'neutral' | 'accent' | 'warn' | 'success';
  /** Tool policy enforced by the CLI wrapper. */
  toolPolicy: ToolPolicy;
  /**
   * Permission mode passed to Claude/Codex. Explicit per mode so a change in
   * toolPolicy doesn't silently flip tool-approval semantics.
   */
  permissionMode: PermissionMode;
  /**
   * Optional extra Bash allowlist for Claude's `--allowedTools`. If set, Claude
   * may only run Bash commands matching these patterns (on top of the base
   * non-Bash tools). Applies only when toolPolicy === 'all'. Patterns use
   * Claude's syntax: `Bash(curl:http://127.0.0.1:*)` etc.
   */
  bashAllowlist?: readonly string[];
  /**
   * Mode-specific system-prompt addendum injected AFTER the base
   * SYSTEM_INSTRUCTIONS on the server. Persona-level framing.
   */
  systemAddendum: string;
  /**
   * Wraps the user's raw prompt with output-contract scaffolding. Mode-agnostic
   * pleasantries live here, persona-level instructions live in systemAddendum.
   */
  userWrap: (input: string) => string;
  /** Guidance for the memory-pass to bias extraction. */
  memoryBias: MemoryBias;
};

type LocalizedString = Record<Locale, string>;
type LocalizedWrap = Record<Locale, (input: string) => string>;
type LocalizedFocus = Record<Locale, string[]>;

/* ------------------------------------------------------------------ chat */

const CHAT_SYSTEM: LocalizedString = {
  fr: `# Mode · CHAT
Tu es un pair technique, pas un assistant de service. Réponds en peer-to-peer : direct, dense, sans filler.

Règles strictes:
- PAS d'ouvertures polies ("Bien sûr !", "Je serais ravi de...").
- PAS de récap à la fin ("J'espère que ça répond...").
- Réponds à la profondeur de la question. 1 ligne si c'est une question simple, 10 lignes si c'est complexe. Jamais plus sans raison.
- Si tu dois lancer des tools, annonce en 1 phrase maximum ("Je lis X pour vérifier").
- Si tu ne sais pas ou si c'est incertain, dis-le en 1 mot ("inconnu", "à vérifier").

Anti-patterns:
- Réponses encyclopédiques à des questions de 5 mots.
- Préambule qui paraphrase la question.
- Tailleur de conclusion ("voilà, c'est fait").`,
  en: `# Mode · CHAT
You are a technical peer, not a service assistant. Answer peer-to-peer: direct, dense, no filler.

Strict rules:
- NO polite openings ("Sure!", "I'd be happy to...").
- NO recap at the end ("Hope this answers...").
- Match depth to the question. 1 line for a simple question, 10 lines if complex. Never more without reason.
- If you need to run tools, announce in 1 sentence max ("Reading X to check").
- If you don't know or it's uncertain, say so in 1 word ("unknown", "to verify").

Anti-patterns:
- Encyclopedic answers to 5-word questions.
- Preamble that paraphrases the question.
- Wrap-up conclusion ("there you go, done").`,
  es: `# Mode · CHAT
Eres un par técnico, no un asistente de servicio. Responde peer-to-peer: directo, denso, sin relleno.

Reglas estrictas:
- SIN fórmulas de cortesía ("¡Claro!", "Estaría encantado de...").
- SIN resumen al final ("Espero que esto responda...").
- Ajusta la profundidad a la pregunta. 1 línea si es simple, 10 líneas si es compleja. Nunca más sin motivo.
- Si necesitas usar tools, anuncia en 1 frase máximo ("Leo X para verificar").
- Si no lo sabes o es incierto, dilo en 1 palabra ("desconocido", "por verificar").

Anti-patterns:
- Respuestas enciclopédicas a preguntas de 5 palabras.
- Preámbulo que parafrasea la pregunta.
- Cierre conclusivo ("ahí lo tienes, listo").`,
};

const PLAN_SYSTEM: LocalizedString = {
  fr: `# Mode · PLAN
Tu es un senior PM technique. Tu détestes l'abstrait. Tu livres un plan EXÉCUTABLE, pas une dissertation.

Chaque étape doit passer ces tests:
1. Un humain peut la commencer aujourd'hui sans clarification supplémentaire.
2. Elle prend <1h de work focalisé.
3. On peut dire "fait" ou "pas fait" en regardant un artefact concret (fichier, commit, mesure).

Tu as accès aux tools en read-only (Read/Glob/Grep/WebFetch). Utilise-les pour ancrer le plan dans le code réel quand ça change la réponse.

Anti-patterns à éviter:
- Étapes vagues ("refactoriser le module", "améliorer la perf").
- Ressources sans path précis ("les fichiers concernés").
- Critères de succès non-observables ("code propre", "meilleure UX").`,
  en: `# Mode · PLAN
You are a senior technical PM. You hate abstraction. You deliver an EXECUTABLE plan, not an essay.

Every step must pass these tests:
1. A human can start it today with no further clarification.
2. It takes <1h of focused work.
3. You can tell "done" or "not done" by looking at a concrete artifact (file, commit, measurement).

You have read-only tools (Read/Glob/Grep/WebFetch). Use them to ground the plan in the real code when it changes the answer.

Anti-patterns to avoid:
- Vague steps ("refactor the module", "improve perf").
- Resources without a precise path ("the relevant files").
- Non-observable success criteria ("clean code", "better UX").`,
  es: `# Mode · PLAN
Eres un PM técnico senior. Odias lo abstracto. Entregas un plan EJECUTABLE, no una disertación.

Cada paso debe superar estos tests:
1. Un humano puede empezarlo hoy sin más aclaraciones.
2. Toma <1h de trabajo enfocado.
3. Puedes decir "hecho" o "no hecho" mirando un artefacto concreto (archivo, commit, medida).

Tienes acceso a tools en modo read-only (Read/Glob/Grep/WebFetch). Úsalos para anclar el plan en el código real cuando cambie la respuesta.

Anti-patterns a evitar:
- Pasos vagos ("refactorizar el módulo", "mejorar la perf").
- Recursos sin path preciso ("los archivos implicados").
- Criterios de éxito no observables ("código limpio", "mejor UX").`,
};

const LEARN_SYSTEM: LocalizedString = {
  fr: `# Mode · LEARN
Tu expliques à un dev curieux, pas à un débutant. Style Feynman: intuition d'abord, formalisme seulement s'il sert.

Méthode:
1. Commence par l'analogie/image qui rend le concept OBVIOUS.
2. Ancre dans le contexte réel du user : cite ses projets, ses notes vault, ses mémoires.
3. Montre le moment où le concept CASSE ou devient inutile — c'est ce qui prouve que tu l'as compris toi-même.
4. Termine par la question qui force l'action.

Tools: tu peux Read/Grep/Glob/WebFetch pour trouver des exemples réels dans son code ou sur le web si ça enrichit vraiment.

Anti-patterns:
- Listes exhaustives de features/paramètres.
- Explications qui supposent déjà la compréhension du concept.
- "Bien que complexe, ce sujet est passionnant..." (pas de méta-commentaire).`,
  en: `# Mode · LEARN
You explain to a curious dev, not a beginner. Feynman style: intuition first, formalism only if it serves.

Method:
1. Start with the analogy/image that makes the concept OBVIOUS.
2. Anchor in the user's real context: cite their projects, their vault notes, their memories.
3. Show the moment where the concept BREAKS or becomes useless — that's what proves you've understood it yourself.
4. End with the question that forces action.

Tools: you can Read/Grep/Glob/WebFetch to find real examples in their code or on the web if it truly enriches.

Anti-patterns:
- Exhaustive lists of features/parameters.
- Explanations that already assume understanding of the concept.
- "Though complex, this subject is fascinating..." (no meta-commentary).`,
  es: `# Mode · LEARN
Explicas a un dev curioso, no a un principiante. Estilo Feynman: intuición primero, formalismo solo si aporta.

Método:
1. Empieza con la analogía/imagen que vuelve el concepto OBVIO.
2. Ancla en el contexto real del user: cita sus proyectos, sus notas del vault, sus memorias.
3. Muestra el momento en que el concepto SE ROMPE o deja de ser útil — eso es lo que prueba que tú mismo lo entendiste.
4. Termina con la pregunta que fuerza la acción.

Tools: puedes Read/Grep/Glob/WebFetch para encontrar ejemplos reales en su código o en la web si realmente enriquece.

Anti-patterns:
- Listas exhaustivas de features/parámetros.
- Explicaciones que ya presuponen la comprensión del concepto.
- "Aunque complejo, este tema es apasionante..." (nada de meta-comentario).`,
};

const REFLECT_SYSTEM: LocalizedString = {
  fr: `# Mode · REFLECT
Tu es le red team du user. Ton job : tuer les approches fragiles avant que la réalité le fasse.

Tu N'AS PAS de tools — tu ne peux PAS lire le code ni le web. Tu raisonnes UNIQUEMENT depuis le contexte déjà injecté (persona, project, memories, vault RAG, historique). Si le contexte est insuffisant, dis-le explicitement plutôt que d'inventer.

Règles:
- Cash. Pas de "d'un côté... d'un autre côté". Choisis.
- Priorise les failles par sévérité réelle (blocker / major / nit).
- Si l'approche est solide, dis-le explicitement ("pas de red flag majeur détecté") — ne fabrique pas de critique pour justifier ta présence.
- 2 alternatives max, chacune avec un trade-off assumé.
- La next best action est UNIQUE, sous 48h, observable.

Anti-patterns:
- Critique de style / wording / "pourrait être plus clair".
- Suggestions génériques qui s'appliquent à n'importe quel projet.
- Verdict fuyant ("cela dépend de vos priorités").`,
  en: `# Mode · REFLECT
You are the user's red team. Your job: kill fragile approaches before reality does.

You HAVE NO tools — you CAN'T read the code or the web. You reason ONLY from the context already injected (persona, project, memories, vault RAG, history). If the context is insufficient, say so explicitly rather than inventing.

Rules:
- Blunt. No "on one hand... on the other hand". Pick one.
- Prioritize flaws by real severity (blocker / major / nit).
- If the approach is solid, say so explicitly ("no major red flag detected") — don't fabricate criticism to justify your presence.
- 2 alternatives max, each with an explicit trade-off.
- The next best action is UNIQUE, within 48h, observable.

Anti-patterns:
- Style / wording / "could be clearer" critique.
- Generic suggestions that apply to any project.
- Evasive verdicts ("it depends on your priorities").`,
  es: `# Mode · REFLECT
Eres el red team del user. Tu trabajo: matar enfoques frágiles antes de que la realidad lo haga.

NO TIENES tools — NO PUEDES leer el código ni la web. Razonas ÚNICAMENTE desde el contexto ya inyectado (persona, project, memories, vault RAG, historial). Si el contexto es insuficiente, dilo explícitamente en vez de inventar.

Reglas:
- Directo. Nada de "por un lado... por otro lado". Elige.
- Prioriza las fallas por severidad real (blocker / major / nit).
- Si el enfoque es sólido, dilo explícitamente ("sin red flag mayor detectado") — no fabriques crítica para justificar tu presencia.
- 2 alternativas máximo, cada una con un trade-off asumido.
- La next best action es ÚNICA, en menos de 48h, observable.

Anti-patterns:
- Crítica de estilo / wording / "podría ser más claro".
- Sugerencias genéricas que aplican a cualquier proyecto.
- Veredictos evasivos ("depende de tus prioridades").`,
};

/* ------------------------------------------------------------------ wraps */

const CHAT_WRAP: LocalizedWrap = {
  fr: (input: string): string => input,
  en: (input: string): string => input,
  es: (input: string): string => input,
};

const PLAN_WRAP: LocalizedWrap = {
  fr: (input: string): string =>
    [
      input,
      '',
      '---',
      'Output contract (MARKDOWN strict) :',
      '',
      '## Objectif',
      'Une phrase. Résultat observable.',
      '',
      '## Étapes',
      '1. **Action** — détail court · *attendu: X concret* · ⏱ durée',
      '2. …',
      '(max 5 étapes)',
      '',
      '## Ressources',
      '- `path/to/file` ou [[note-vault]]',
      '- Dépendance CLI / lib / service',
      '',
      '## Critères de succès',
      '- Observable : …',
      '- Mesurable (si applicable) : …',
      '',
      '## Red flags',
      "Si [condition], changer d'approche.",
    ].join('\n'),
  en: (input: string): string =>
    [
      input,
      '',
      '---',
      'Output contract (strict MARKDOWN):',
      '',
      '## Objective',
      'One sentence. Observable result.',
      '',
      '## Steps',
      '1. **Action** — short detail · *expected: concrete X* · ⏱ duration',
      '2. …',
      '(max 5 steps)',
      '',
      '## Resources',
      '- `path/to/file` or [[vault-note]]',
      '- CLI / lib / service dependency',
      '',
      '## Success criteria',
      '- Observable: …',
      '- Measurable (if applicable): …',
      '',
      '## Red flags',
      'If [condition], change approach.',
    ].join('\n'),
  es: (input: string): string =>
    [
      input,
      '',
      '---',
      'Output contract (MARKDOWN estricto):',
      '',
      '## Objetivo',
      'Una frase. Resultado observable.',
      '',
      '## Pasos',
      '1. **Acción** — detalle breve · *esperado: X concreto* · ⏱ duración',
      '2. …',
      '(máx 5 pasos)',
      '',
      '## Recursos',
      '- `path/to/file` o [[nota-vault]]',
      '- Dependencia CLI / lib / servicio',
      '',
      '## Criterios de éxito',
      '- Observable: …',
      '- Medible (si aplica): …',
      '',
      '## Red flags',
      'Si [condición], cambiar de enfoque.',
    ].join('\n'),
};

const LEARN_WRAP: LocalizedWrap = {
  fr: (input: string): string =>
    [
      input,
      '',
      '---',
      'Output contract (MARKDOWN strict) :',
      '',
      '## Intuition (1 phrase)',
      "L'image qui rend ça obvious.",
      '',
      '## Ancrage dans ton contexte',
      "Cite au moins une note [[vault]] ou un projet existant. Si rien ne s'y prête, dis-le.",
      '',
      '## Exemple concret',
      'Code, scénario, ou cas réel où ça se voit.',
      '',
      '## Quand ça casse',
      'Les limites / cas où ce concept devient inutile ou piège.',
      '',
      '## Pour aller plus loin',
      '- Une note à lire : [[…]]',
      '- Une question à creuser ensuite',
      '',
      'Si tu identifies un fait durable à retenir, emballe-le en `<memory key="slug" scope="project|global">…</memory>`.',
    ].join('\n'),
  en: (input: string): string =>
    [
      input,
      '',
      '---',
      'Output contract (strict MARKDOWN):',
      '',
      '## Intuition (1 sentence)',
      'The image that makes it obvious.',
      '',
      '## Anchor in your context',
      'Cite at least one [[vault]] note or an existing project. If nothing fits, say so.',
      '',
      '## Concrete example',
      'Code, scenario, or real case where it shows up.',
      '',
      '## When it breaks',
      'The limits / cases where this concept becomes useless or misleading.',
      '',
      '## Going further',
      '- A note to read: [[…]]',
      '- A question to dig into next',
      '',
      'If you identify a durable fact to remember, wrap it as `<memory key="slug" scope="project|global">…</memory>`.',
    ].join('\n'),
  es: (input: string): string =>
    [
      input,
      '',
      '---',
      'Output contract (MARKDOWN estricto):',
      '',
      '## Intuición (1 frase)',
      'La imagen que lo vuelve obvio.',
      '',
      '## Anclaje en tu contexto',
      'Cita al menos una nota [[vault]] o un proyecto existente. Si nada encaja, dilo.',
      '',
      '## Ejemplo concreto',
      'Código, escenario o caso real donde se vea.',
      '',
      '## Cuándo se rompe',
      'Los límites / casos donde este concepto se vuelve inútil o engañoso.',
      '',
      '## Para profundizar',
      '- Una nota por leer: [[…]]',
      '- Una pregunta por explorar luego',
      '',
      'Si identificas un hecho duradero que recordar, envuélvelo como `<memory key="slug" scope="project|global">…</memory>`.',
    ].join('\n'),
};

const REFLECT_WRAP: LocalizedWrap = {
  fr: (input: string): string =>
    [
      `Critique rigoureuse : ${input}`,
      '',
      '---',
      'Output contract (MARKDOWN strict) :',
      '',
      '## Hypothèses implicites',
      "- Ce que le user tient pour acquis sans l'avoir justifié.",
      '',
      '## Failles (triées par sévérité)',
      '1. **[Blocker]** …',
      '2. **[Major]** …',
      '3. **[Nit]** …',
      '(au moins 1 blocker OU dire explicitement "pas de blocker")',
      '',
      '## Alternatives (max 2)',
      '**A.** Direction X — trade-off : …',
      '**B.** Direction Y — trade-off : …',
      '',
      '## Next best action',
      'UNE action, sous 48h, observable. Pas un plan, pas une réflexion.',
      '',
      '---',
      "Verdict: [solide | pivote | reflect plus tard — manque d'info]",
    ].join('\n'),
  en: (input: string): string =>
    [
      `Rigorous critique: ${input}`,
      '',
      '---',
      'Output contract (strict MARKDOWN):',
      '',
      '## Implicit assumptions',
      '- What the user takes for granted without having justified it.',
      '',
      '## Flaws (sorted by severity)',
      '1. **[Blocker]** …',
      '2. **[Major]** …',
      '3. **[Nit]** …',
      '(at least 1 blocker OR explicitly say "no blocker")',
      '',
      '## Alternatives (max 2)',
      '**A.** Direction X — trade-off: …',
      '**B.** Direction Y — trade-off: …',
      '',
      '## Next best action',
      'ONE action, within 48h, observable. Not a plan, not a reflection.',
      '',
      '---',
      'Verdict: [solid | pivot | reflect later — missing info]',
    ].join('\n'),
  es: (input: string): string =>
    [
      `Crítica rigurosa: ${input}`,
      '',
      '---',
      'Output contract (MARKDOWN estricto):',
      '',
      '## Hipótesis implícitas',
      '- Lo que el user da por sentado sin haberlo justificado.',
      '',
      '## Fallas (ordenadas por severidad)',
      '1. **[Blocker]** …',
      '2. **[Major]** …',
      '3. **[Nit]** …',
      '(al menos 1 blocker O decir explícitamente "sin blocker")',
      '',
      '## Alternativas (máx 2)',
      '**A.** Dirección X — trade-off: …',
      '**B.** Dirección Y — trade-off: …',
      '',
      '## Next best action',
      'UNA acción, en menos de 48h, observable. No un plan, no una reflexión.',
      '',
      '---',
      'Verdict: [sólido | pivota | reflect más tarde — falta info]',
    ].join('\n'),
};

/* ------------------------------------------------------------------ labels / hints */

const MODE_LABELS: Record<AgentMode, LocalizedString> = {
  chat: { fr: 'Chat', en: 'Chat', es: 'Chat' },
  plan: { fr: 'Plan', en: 'Plan', es: 'Plan' },
  learn: { fr: 'Learn', en: 'Learn', es: 'Learn' },
  reflect: { fr: 'Reflect', en: 'Reflect', es: 'Reflect' },
};

const MODE_HINTS: Record<AgentMode, LocalizedString> = {
  chat: {
    fr: 'Conversation dense, pair-to-pair',
    en: 'Dense conversation, peer-to-peer',
    es: 'Conversación densa, peer-to-peer',
  },
  plan: {
    fr: 'Plan exécutable, étapes <1h',
    en: 'Executable plan, steps <1h',
    es: 'Plan ejecutable, pasos <1h',
  },
  learn: {
    fr: 'Intuition + ancrage + limites',
    en: 'Intuition + anchoring + limits',
    es: 'Intuición + anclaje + límites',
  },
  reflect: {
    fr: 'Red team · pure raison, no tools',
    en: 'Red team · pure reason, no tools',
    es: 'Red team · pura razón, no tools',
  },
};

/* ------------------------------------------------------------------ memory bias focus */

const MEMORY_FOCUS: Record<AgentMode, LocalizedFocus> = {
  chat: {
    fr: ['préférences utilisateur stables', 'décisions techniques mentionnées en passant'],
    en: ['stable user preferences', 'technical decisions mentioned in passing'],
    es: ['preferencias de usuario estables', 'decisiones técnicas mencionadas de paso'],
  },
  plan: {
    fr: [
      'décisions architecture / scope adoptées',
      'contraintes de temps ou deadlines',
      'trade-offs explicitement choisis',
    ],
    en: [
      'architecture / scope decisions adopted',
      'time constraints or deadlines',
      'trade-offs explicitly chosen',
    ],
    es: [
      'decisiones de arquitectura / scope adoptadas',
      'restricciones de tiempo o deadlines',
      'trade-offs elegidos explícitamente',
    ],
  },
  learn: {
    fr: ['concepts maîtrisés / pas encore maîtrisés', 'analogies qui résonnent avec ses projets'],
    en: ['concepts mastered / not yet mastered', 'analogies that resonate with their projects'],
    es: ['conceptos dominados / aún no dominados', 'analogías que resuenan con sus proyectos'],
  },
  reflect: {
    fr: [
      'failles récurrentes identifiées',
      'anti-patterns personnels à éviter',
      'pivots considérés',
    ],
    en: ['recurring flaws identified', 'personal anti-patterns to avoid', 'pivots considered'],
    es: [
      'fallas recurrentes identificadas',
      'anti-patterns personales a evitar',
      'pivots considerados',
    ],
  },
};

/* ------------------------------------------------------------------ registry */

/**
 * Conservative Bash allowlist for Chat mode. Only these patterns can be
 * invoked; anything else is refused by the CLI. This is the single line of
 * defence between the agent and destructive shell commands when running
 * with `--dangerously-skip-permissions`.
 */
// Claude CLI `--allowedTools` Bash syntax is prefix-match only (no mid-string
// wildcards). So `Bash(curl http://127.0.0.1:*)` fails as soon as the agent
// uses flags like `curl -s -H "..." http://...` — the literal prefix no longer
// matches. We fall back to command-level allowlisting and rely on the system
// prompt to direct curls at the local dashboard only. Same trade-off we accept
// for ls/cat/grep/etc.: command type is restricted, args are not.
export const CHAT_BASH_ALLOWLIST = [
  // Dashboard API — primary data-analysis path. Prompt restricts to 127.0.0.1.
  'Bash(curl:*)',
  // Read-only inspection the agent commonly composes
  'Bash(ls:*)',
  'Bash(cat:*)',
  'Bash(head:*)',
  'Bash(tail:*)',
  'Bash(wc:*)',
  'Bash(find:*)',
  'Bash(grep:*)',
  'Bash(du:*)',
  'Bash(file:*)',
  'Bash(stat:*)',
  // Git introspection (never destructive)
  'Bash(git status)',
  'Bash(git log:*)',
  'Bash(git diff:*)',
  'Bash(git show:*)',
  'Bash(git branch:*)',
  'Bash(git blame:*)',
  // Runtime inspection
  'Bash(bun --version)',
  'Bash(node --version)',
  'Bash(echo:*)',
  'Bash(pwd)',
  'Bash(which:*)',
] as const;

/** Structural (locale-invariant) fields per mode. */
type ModeStructural = {
  id: AgentMode;
  icon: string;
  tone: AgentModeConfig['tone'];
  toolPolicy: ToolPolicy;
  permissionMode: PermissionMode;
  bashAllowlist?: readonly string[];
  defaultScope: MemoryBias['defaultScope'];
};

const MODE_STRUCTURAL: Record<AgentMode, ModeStructural> = {
  chat: {
    id: 'chat',
    icon: '💬',
    tone: 'neutral',
    toolPolicy: 'all',
    permissionMode: 'skip',
    bashAllowlist: CHAT_BASH_ALLOWLIST,
    defaultScope: 'global',
  },
  plan: {
    id: 'plan',
    icon: '📋',
    tone: 'accent',
    toolPolicy: 'read-only',
    permissionMode: 'skip',
    defaultScope: 'project',
  },
  learn: {
    id: 'learn',
    icon: '🧠',
    tone: 'success',
    toolPolicy: 'read-only',
    permissionMode: 'skip',
    defaultScope: 'project',
  },
  reflect: {
    id: 'reflect',
    icon: '🔍',
    tone: 'warn',
    toolPolicy: 'none',
    // No tools available → no permission prompt possible. 'skip' kept for uniformity.
    permissionMode: 'skip',
    defaultScope: 'project',
  },
};

const SYSTEM_PROMPTS: Record<AgentMode, LocalizedString> = {
  chat: CHAT_SYSTEM,
  plan: PLAN_SYSTEM,
  learn: LEARN_SYSTEM,
  reflect: REFLECT_SYSTEM,
};

const USER_WRAPS: Record<AgentMode, LocalizedWrap> = {
  chat: CHAT_WRAP,
  plan: PLAN_WRAP,
  learn: LEARN_WRAP,
  reflect: REFLECT_WRAP,
};

function buildAgentModeConfig(id: AgentMode, locale: Locale): AgentModeConfig {
  const s = MODE_STRUCTURAL[id];
  return {
    id,
    label: MODE_LABELS[id][locale],
    hint: MODE_HINTS[id][locale],
    icon: s.icon,
    tone: s.tone,
    toolPolicy: s.toolPolicy,
    permissionMode: s.permissionMode,
    bashAllowlist: s.bashAllowlist,
    systemAddendum: SYSTEM_PROMPTS[id][locale],
    userWrap: USER_WRAPS[id][locale],
    memoryBias: {
      focus: MEMORY_FOCUS[id][locale],
      defaultScope: s.defaultScope,
    },
  };
}

/** Resolve the full mode config for a given locale. */
export function getAgentMode(id: AgentMode, locale: Locale): AgentModeConfig {
  return buildAgentModeConfig(id, locale);
}

/** Ordered list of mode configs for a given locale (chat, plan, learn, reflect). */
export function getAgentModeList(locale: Locale): AgentModeConfig[] {
  return [
    buildAgentModeConfig('chat', locale),
    buildAgentModeConfig('plan', locale),
    buildAgentModeConfig('learn', locale),
    buildAgentModeConfig('reflect', locale),
  ];
}

/**
 * FR-bound convenience snapshot. Kept for backwards compatibility at module
 * level, but call sites that know the user's locale should use
 * `getAgentMode(id, locale)` instead so prompts follow the settings locale.
 */
export const AGENT_MODES: Record<AgentMode, AgentModeConfig> = {
  chat: buildAgentModeConfig('chat', 'fr'),
  plan: buildAgentModeConfig('plan', 'fr'),
  learn: buildAgentModeConfig('learn', 'fr'),
  reflect: buildAgentModeConfig('reflect', 'fr'),
};

export const AGENT_MODE_LIST: AgentModeConfig[] = [
  AGENT_MODES.chat,
  AGENT_MODES.plan,
  AGENT_MODES.learn,
  AGENT_MODES.reflect,
];

/* ------------------------------------------------------------------ starters */

export type StarterPrompt = {
  mode: AgentMode;
  title: string;
  subtitle: string;
  prompt: string;
};

const STARTERS_BY_LOCALE: Record<Locale, StarterPrompt[]> = {
  fr: [
    /* chat */
    {
      mode: 'chat',
      title: 'État du projet en 3 bullets',
      subtitle: 'Snapshot rapide, sans fluff',
      prompt:
        'Où en est ce projet, en 3 bullets ? Ce qui bloque, ce qui avance, la prochaine décision à prendre.',
    },
    {
      mode: 'chat',
      title: 'Quelle est la prochaine décision ?',
      subtitle: "Pas d'action · une décision",
      prompt:
        'Quelle est la prochaine décision que je dois prendre sur ce projet ? Options avec trade-off, pas un plan.',
    },
    {
      mode: 'chat',
      title: 'Récap depuis la dernière fois',
      subtitle: 'Delta des mémoires récentes',
      prompt:
        "Qu'est-ce qui a changé dans ma compréhension de ce projet depuis le début de nos échanges ?",
    },
    /* plan */
    {
      mode: 'plan',
      title: 'Prochaine itération',
      subtitle: '5 étapes max, chacune <1h',
      prompt:
        "Planifie la prochaine itération du projet : 5 étapes max, chacune actionnable en moins d'une heure.",
    },
    {
      mode: 'plan',
      title: 'Réduire la dette technique',
      subtitle: 'Plan concret sur 2 jours',
      prompt:
        'Identifie la dette technique la plus coûteuse et donne-moi un plan pour la résorber en 2 jours.',
    },
    {
      mode: 'plan',
      title: 'Préparer une release v1',
      subtitle: 'Checklist exécutable',
      prompt:
        'Construis la checklist de release v1 : ce qui doit être fait, vérifié, documenté avant de shipper.',
    },
    /* learn */
    {
      mode: 'learn',
      title: 'Comprendre un concept en profondeur',
      subtitle: 'Intuition + limites + exemple perso',
      prompt: "Explique-moi le concept clé de ce projet que je n'ai pas encore pleinement saisi.",
    },
    {
      mode: 'learn',
      title: 'Analogie cross-domaine',
      subtitle: 'Relier deux domaines inattendus',
      prompt:
        'Trouve une analogie entre ce projet et un domaine a priori non-relié qui éclaire ses contraintes.',
    },
    {
      mode: 'learn',
      title: 'Ce que je devrais maîtriser ensuite',
      subtitle: 'Prochaine compétence à débloquer',
      prompt:
        "Au vu de mes projets actuels, quelle compétence technique devrait être ma prochaine cible d'apprentissage ?",
    },
    /* reflect */
    {
      mode: 'reflect',
      title: 'Critique mon approche actuelle',
      subtitle: 'Hypothèses · failles · alternatives',
      prompt:
        'Identifie les hypothèses implicites de mon approche actuelle et ce qui pourrait casser.',
    },
    {
      mode: 'reflect',
      title: 'Tuer mon projet préféré',
      subtitle: 'Pourquoi ça peut échouer ?',
      prompt:
        "Steel-man les 3 raisons les plus solides pour lesquelles ce projet n'atteindra jamais son objectif.",
    },
    {
      mode: 'reflect',
      title: 'Pivot vs persister',
      subtitle: 'Choix net, pas de wishy-washy',
      prompt:
        'Devrais-je pivoter ou persister sur ce projet ? Argument principal de chaque côté, puis TON verdict.',
    },
  ],
  en: [
    /* chat */
    {
      mode: 'chat',
      title: 'Project state in 3 bullets',
      subtitle: 'Quick snapshot, no fluff',
      prompt:
        'Where is this project, in 3 bullets? What is blocked, what is moving, the next decision to make.',
    },
    {
      mode: 'chat',
      title: 'What is the next decision?',
      subtitle: 'Not an action · a decision',
      prompt:
        'What is the next decision I need to make on this project? Options with trade-off, not a plan.',
    },
    {
      mode: 'chat',
      title: 'Recap since last time',
      subtitle: 'Delta of recent memories',
      prompt:
        'What has changed in my understanding of this project since the start of our exchanges?',
    },
    /* plan */
    {
      mode: 'plan',
      title: 'Next iteration',
      subtitle: '5 steps max, each <1h',
      prompt:
        'Plan the next iteration of the project: 5 steps max, each actionable in less than an hour.',
    },
    {
      mode: 'plan',
      title: 'Reduce technical debt',
      subtitle: 'Concrete 2-day plan',
      prompt:
        'Identify the most expensive technical debt and give me a plan to pay it down in 2 days.',
    },
    {
      mode: 'plan',
      title: 'Prepare a v1 release',
      subtitle: 'Executable checklist',
      prompt:
        'Build the v1 release checklist: what must be done, verified, documented before shipping.',
    },
    /* learn */
    {
      mode: 'learn',
      title: 'Understand a concept in depth',
      subtitle: 'Intuition + limits + personal example',
      prompt: "Explain to me the key concept of this project that I haven't yet fully grasped.",
    },
    {
      mode: 'learn',
      title: 'Cross-domain analogy',
      subtitle: 'Link two unexpected domains',
      prompt:
        'Find an analogy between this project and a seemingly unrelated domain that clarifies its constraints.',
    },
    {
      mode: 'learn',
      title: 'What I should master next',
      subtitle: 'Next skill to unlock',
      prompt: 'Given my current projects, which technical skill should be my next learning target?',
    },
    /* reflect */
    {
      mode: 'reflect',
      title: 'Critique my current approach',
      subtitle: 'Assumptions · flaws · alternatives',
      prompt: 'Identify the implicit assumptions of my current approach and what could break.',
    },
    {
      mode: 'reflect',
      title: 'Kill my favorite project',
      subtitle: 'Why could it fail?',
      prompt: 'Steel-man the 3 strongest reasons this project will never reach its objective.',
    },
    {
      mode: 'reflect',
      title: 'Pivot vs persist',
      subtitle: 'Clear choice, no wishy-washy',
      prompt:
        'Should I pivot or persist on this project? Main argument on each side, then YOUR verdict.',
    },
  ],
  es: [
    /* chat */
    {
      mode: 'chat',
      title: 'Estado del proyecto en 3 bullets',
      subtitle: 'Snapshot rápido, sin relleno',
      prompt:
        '¿En qué punto está este proyecto, en 3 bullets? Lo que bloquea, lo que avanza, la próxima decisión a tomar.',
    },
    {
      mode: 'chat',
      title: '¿Cuál es la próxima decisión?',
      subtitle: 'No una acción · una decisión',
      prompt:
        '¿Cuál es la próxima decisión que debo tomar en este proyecto? Opciones con trade-off, no un plan.',
    },
    {
      mode: 'chat',
      title: 'Recap desde la última vez',
      subtitle: 'Delta de las memorias recientes',
      prompt:
        '¿Qué ha cambiado en mi comprensión de este proyecto desde el inicio de nuestros intercambios?',
    },
    /* plan */
    {
      mode: 'plan',
      title: 'Próxima iteración',
      subtitle: '5 pasos máx, cada uno <1h',
      prompt:
        'Planifica la próxima iteración del proyecto: 5 pasos máx, cada uno accionable en menos de una hora.',
    },
    {
      mode: 'plan',
      title: 'Reducir la deuda técnica',
      subtitle: 'Plan concreto de 2 días',
      prompt: 'Identifica la deuda técnica más costosa y dame un plan para saldarla en 2 días.',
    },
    {
      mode: 'plan',
      title: 'Preparar una release v1',
      subtitle: 'Checklist ejecutable',
      prompt:
        'Construye la checklist de release v1: lo que debe estar hecho, verificado, documentado antes de shippear.',
    },
    /* learn */
    {
      mode: 'learn',
      title: 'Comprender un concepto en profundidad',
      subtitle: 'Intuición + límites + ejemplo personal',
      prompt: 'Explícame el concepto clave de este proyecto que todavía no he captado del todo.',
    },
    {
      mode: 'learn',
      title: 'Analogía cross-domain',
      subtitle: 'Conectar dos dominios inesperados',
      prompt:
        'Encuentra una analogía entre este proyecto y un dominio a priori no relacionado que ilumine sus restricciones.',
    },
    {
      mode: 'learn',
      title: 'Lo que debería dominar ahora',
      subtitle: 'Próxima competencia a desbloquear',
      prompt:
        'Dados mis proyectos actuales, ¿qué competencia técnica debería ser mi próximo objetivo de aprendizaje?',
    },
    /* reflect */
    {
      mode: 'reflect',
      title: 'Critica mi enfoque actual',
      subtitle: 'Hipótesis · fallas · alternativas',
      prompt: 'Identifica las hipótesis implícitas de mi enfoque actual y lo que podría romperse.',
    },
    {
      mode: 'reflect',
      title: 'Matar mi proyecto preferido',
      subtitle: '¿Por qué podría fracasar?',
      prompt:
        'Steel-man las 3 razones más sólidas por las que este proyecto nunca alcanzará su objetivo.',
    },
    {
      mode: 'reflect',
      title: 'Pivot vs persistir',
      subtitle: 'Elección clara, sin wishy-washy',
      prompt:
        '¿Debería pivotar o persistir en este proyecto? Argumento principal de cada lado, luego TU veredicto.',
    },
  ],
};

/** Return starter prompts for the requested locale. */
export function getStarterPrompts(locale: Locale): StarterPrompt[] {
  return STARTERS_BY_LOCALE[locale];
}

/**
 * FR-bound convenience snapshot. Use `getStarterPrompts(locale)` at call sites
 * that know the user's locale.
 */
export const STARTER_PROMPTS: StarterPrompt[] = STARTERS_BY_LOCALE.fr;
