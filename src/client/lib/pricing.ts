export type PricingSource = 'claude' | 'codex';

export type ModelPrice = {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};

const CLAUDE_PRICING: Array<[string, ModelPrice]> = [
  ['opus-4-7', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['opus-4-6', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['opus-4', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['opus', { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 }],
  ['sonnet-4-6', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['sonnet-4', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['sonnet-3-5', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['sonnet', { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }],
  ['haiku-4-5', { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
  ['haiku-3-5', { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 }],
  ['haiku', { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }],
];

const CODEX_PRICING: Array<[string, ModelPrice]> = [
  ['gpt-5-codex', { input: 1.25, output: 10, cacheRead: 0.125 }],
  ['gpt-5-mini', { input: 0.25, output: 2, cacheRead: 0.025 }],
  ['gpt-5-nano', { input: 0.05, output: 0.4, cacheRead: 0.005 }],
  ['gpt-5', { input: 1.25, output: 10, cacheRead: 0.125 }],
  ['gpt-4o-mini', { input: 0.15, output: 0.6, cacheRead: 0.075 }],
  ['gpt-4o', { input: 2.5, output: 10, cacheRead: 1.25 }],
  ['gpt-4', { input: 5, output: 15, cacheRead: 2.5 }],
  ['o4', { input: 2, output: 8, cacheRead: 0.5 }],
  ['o3', { input: 2, output: 8, cacheRead: 0.5 }],
];

const CLAUDE_FALLBACK: ModelPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const CODEX_FALLBACK: ModelPrice = { input: 1.25, output: 10, cacheRead: 0.125 };

export const USD_TO_EUR = 0.92;

// Defaults calibrés senior 2026 (France freelance ~ 800 €/TJM + US senior ~$150/h blended).
// Quality-adjusted throughput : ~100 LoC/h × 25 tokens/LoC (avec commentaires/docs) = 2500 tok/h.
// Ajuste via data/settings.json > devEquivalent ou surcharge à l'appel.
export const DEV_HOURLY_RATE_EUR = 100;
export const DEV_OUTPUT_TOKENS_PER_HOUR = 2500;

export type DevParams = {
  hourlyRateEur?: number;
  outputTokensPerHour?: number;
};

// -----------------------------------------------------------------------------
// Dev effort estimation — 3 estimateurs indépendants + range low/mid/high.
//
// Problème avec le modèle simple `outputTokens / tokensPerHour` :
//   - Traite 100% des output tokens comme du code production-ready
//   - Ignore la structure temporelle (sessions, jours actifs)
//   - Présente une valeur unique alors que l'incertitude est ×3+
//
// Nouveau modèle : 3 estimateurs qui regardent des signaux différents,
// puis combinaison robuste (médiane). Affichage avec range low/mid/high.
// -----------------------------------------------------------------------------

export type DevEffortParams = {
  hourlyRateEur: number;
  // Part base des output tokens considérés comme code. Ajustée dynamiquement
  // selon le cache hit share (cf. `adaptiveCodeRatioEnabled`).
  codeRatio: number;
  // Tokens par ligne de code effective (TypeScript/Python avec commentaires)
  tokensPerLoc: number;
  // LoC qu'un dev senior produit par heure en mode focus (incluant debug + review)
  locPerHour: number;
  // Minutes équivalentes par message agent (1 message = 1 itération dev)
  minutesPerMessage: number;
  // Heures par session (session LLM ~ session de programmation ciblée)
  hoursPerSession: number;
  // Heures focus productives par jour actif calendaire
  hoursPerActiveDay: number;
  // Plafond dur d'heures par jour actif pour clamper mid/high (évite des
  // estimations à 10× la durée humaine physique disponible).
  maxHoursPerDay: number;
  // Si true, codeRatio effectif = codeRatio × (1 − cacheHitShare × 0.5).
  // Raison : un projet à fort cache itère sur du code existant (refacto/debug)
  // plutôt que de produire du code neuf, donc moins de LoC net par output token.
  adaptiveCodeRatioEnabled: boolean;
};

export const DEFAULT_DEV_EFFORT_PARAMS: DevEffortParams = {
  hourlyRateEur: 100,
  codeRatio: 0.5,
  tokensPerLoc: 30,
  locPerHour: 15,
  minutesPerMessage: 5,
  hoursPerSession: 0.75,
  hoursPerActiveDay: 6,
  maxHoursPerDay: 10,
  adaptiveCodeRatioEnabled: true,
};

export type DevEffortMetrics = {
  outputTokens: number;
  messages?: number;
  sessions?: number;
  activeDays?: number;
  // Tokens d'input non-cachés (prompts + fichiers lus frais).
  inputTokens?: number;
  // Cache hits (contexte déjà vu, réutilisé sans re-compute).
  cacheReadTokens?: number;
  // Cache writes (premier passage d'un contexte qui sera réutilisé).
  cacheCreateTokens?: number;
};

export type DevEffortEstimate = {
  // Blended + range en heures (après clamp calendaire éventuel)
  lowHours: number;
  midHours: number;
  highHours: number;
  // Idem en €
  lowEur: number;
  midEur: number;
  highEur: number;
  // Les 3 estimateurs bruts (AVANT agrégation + clamp — pour transparence)
  tokenBased: {
    estimatedLoc: number;
    effectiveCodeRatio: number; // codeRatio réellement appliqué (adaptatif)
    cacheHitShare: number; // diagnostic
    hours: number;
    eur: number;
  };
  activityBased: {
    sessionsHours: number;
    messagesHours: number;
    hours: number; // max des deux (dominant)
    eur: number;
  };
  calendarBased: {
    activeDays: number;
    hours: number;
    eur: number;
  };
  // Clamp calendaire : plafond appliqué sur mid/high si dépassement
  calendarCap: {
    applied: boolean;
    midCappedFrom: number | null; // valeur avant clamp, null sinon
    highCappedFrom: number | null;
    capHours: number; // = activeDays × maxHoursPerDay
  };
  // Params utilisés
  params: DevEffortParams;
};

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) {
    return 0;
  }
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export function estimateDevEffort(
  metrics: DevEffortMetrics,
  override: Partial<DevEffortParams> = {},
): DevEffortEstimate {
  const params = { ...DEFAULT_DEV_EFFORT_PARAMS, ...override };

  // --- codeRatio adaptatif ---
  // cacheHitShare = cache_read / (input + cache_read + cache_create)
  // Interprétation : plus cette part est élevée, plus l'agent itère sur du
  // contexte déjà vu (refacto, debug, lectures répétées) plutôt que d'écrire
  // du code neuf. On dampe codeRatio proportionnellement.
  const inputTok = Math.max(0, metrics.inputTokens ?? 0);
  const cacheReadTok = Math.max(0, metrics.cacheReadTokens ?? 0);
  const cacheCreateTok = Math.max(0, metrics.cacheCreateTokens ?? 0);
  const ctxTotal = inputTok + cacheReadTok + cacheCreateTok;
  const cacheHitShare = ctxTotal > 0 ? cacheReadTok / ctxTotal : 0;
  const effectiveCodeRatio = params.adaptiveCodeRatioEnabled
    ? params.codeRatio * (1 - cacheHitShare * 0.5)
    : params.codeRatio;

  // 1) Token-based : quantité de code produite × vélocité senior
  const effectiveCodeTokens = Math.max(0, metrics.outputTokens * effectiveCodeRatio);
  const estimatedLoc = effectiveCodeTokens / params.tokensPerLoc;
  const tokenHours = estimatedLoc / params.locPerHour;

  // 2) Activity-based : intensité d'interaction (sessions + messages)
  const sessionsHours = (metrics.sessions ?? 0) * params.hoursPerSession;
  const messagesHours = ((metrics.messages ?? 0) * params.minutesPerMessage) / 60;
  // Les sessions capturent le gros œuvre ; les messages peuvent être dominés par
  // des échanges courts (meta). On prend le max — le plus intense gagne.
  const activityHours = Math.max(sessionsHours, messagesHours);

  // 3) Calendar-based : durée réelle d'engagement dev
  const activeDays = metrics.activeDays ?? 0;
  const calendarHours = activeDays * params.hoursPerActiveDay;

  // Range : low = min non-nul, high = max, mid = médiane
  const candidates = [tokenHours, activityHours, calendarHours].filter((h) => h > 0);
  const lowHoursRaw = candidates.length > 0 ? Math.min(...candidates) : 0;
  const highHoursRaw = candidates.length > 0 ? Math.max(...candidates) : 0;
  const midHoursRaw = candidates.length > 0 ? median(candidates) : 0;

  // --- Clamp calendaire ---
  // Aucun humain ne peut produire plus de maxHoursPerDay d'effort dev par jour
  // actif. Les deux autres estimateurs (token + activity) peuvent gonfler avec
  // des re-writes, sessions courtes etc. On plafonne mid/high par la réalité
  // physique. Si activeDays = 0, on skip le clamp (métrique manquante).
  const capHours = activeDays > 0 ? activeDays * params.maxHoursPerDay : Number.POSITIVE_INFINITY;
  const highCapHours = capHours * 1.5; // tolérance 50% pour l'upper bound
  const midCapped = midHoursRaw > capHours && capHours !== Number.POSITIVE_INFINITY;
  const highCapped = highHoursRaw > highCapHours && highCapHours !== Number.POSITIVE_INFINITY;
  const midHours = midCapped ? capHours : midHoursRaw;
  const highHours = highCapped ? highCapHours : highHoursRaw;
  // low reste non clampé : il représente déjà le plancher
  const lowHours = Math.min(lowHoursRaw, midHours);

  const rate = params.hourlyRateEur;
  return {
    lowHours,
    midHours,
    highHours,
    lowEur: lowHours * rate,
    midEur: midHours * rate,
    highEur: highHours * rate,
    tokenBased: {
      estimatedLoc,
      effectiveCodeRatio,
      cacheHitShare,
      hours: tokenHours,
      eur: tokenHours * rate,
    },
    activityBased: {
      sessionsHours,
      messagesHours,
      hours: activityHours,
      eur: activityHours * rate,
    },
    calendarBased: {
      activeDays,
      hours: calendarHours,
      eur: calendarHours * rate,
    },
    calendarCap: {
      applied: midCapped || highCapped,
      midCappedFrom: midCapped ? midHoursRaw : null,
      highCappedFrom: highCapped ? highHoursRaw : null,
      capHours: capHours === Number.POSITIVE_INFINITY ? 0 : capHours,
    },
    params,
  };
}

export const CLAUDE_SUBSCRIPTION_EUR_MONTH = 180;
export const CODEX_SUBSCRIPTION_EUR_MONTH = 100;
export const SUBSCRIPTION_DAYS_IN_MONTH = 30;

export type BillingCharge = {
  date: string; // YYYY-MM-DD
  amountEur: number;
  plan: string;
  coverageDays?: number;
};

export type BillingHistory = {
  claude: BillingCharge[];
  codex: BillingCharge[];
};

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
      // Active charge without explicit coverage → assume 31 days rolling.
      endTs = startTs + 31 * DAY_SEC;
    }
  }
  const coverageDays = Math.max(1, (endTs - startTs) / DAY_SEC);
  return { startTs, endTs, coverageDays };
}

// Cash basis: somme exacte des charges dont la date tombe dans [fromTs, toTs].
// C'est ce qui a été débité sur ton compte bancaire dans cette fenêtre.
function sumChargesInRange(charges: BillingCharge[], fromTs: number, toTs: number): number {
  let total = 0;
  for (const charge of charges) {
    const chargeTs = dateIsoToTs(charge.date);
    if (chargeTs >= fromTs && chargeTs <= toTs) {
      total += charge.amountEur;
    }
  }
  return total;
}

// Returns the most recent charge covering a given timestamp. Implements the
// "newest wins" overlap rule so plan upgrades (older charge still technically
// covering when the new one is debited) don't double-count.
function activeChargeAt(
  charges: BillingCharge[],
  ts: number,
): { amountEur: number; startTs: number; endTs: number; coverageDays: number } | null {
  const sorted = [...charges].sort((a, b) => a.date.localeCompare(b.date));
  for (let i = sorted.length - 1; i >= 0; i -= 1) {
    const { startTs, endTs, coverageDays } = chargeCoverage(sorted, i);
    if (ts >= startTs && ts < endTs) {
      return { amountEur: sorted[i].amountEur, startTs, endTs, coverageDays };
    }
  }
  return null;
}

// Accrual restricted to charges debited in [fromTs, toTs], capped at asOfTs
// so "accrued" means "elapsed portion of the period already consumed" — not
// "theoretical cost of the window". Combined with sumPrepaidInRange (tail
// after asOfTs), the invariant `accrued + prepaid ≈ cash` holds for charges
// fully contained in the window, and the Economy card breakdown sums to
// cashEur cleanly. Pre-window charges are intentionally excluded: their
// spill-over is already accounted for in the previous window's cash.
function sumAccruedInRange(
  charges: BillingCharge[],
  fromTs: number,
  toTs: number,
  asOfTs: number,
): number {
  if (!charges || charges.length === 0 || toTs <= fromTs) {
    return 0;
  }
  const sorted = [...charges].sort((a, b) => a.date.localeCompare(b.date));
  let total = 0;
  for (let i = 0; i < sorted.length; i += 1) {
    const chargeTs = dateIsoToTs(sorted[i].date);
    if (chargeTs < fromTs || chargeTs > toTs) continue;
    const { startTs, endTs, coverageDays } = chargeCoverage(sorted, i);
    const elapsedEnd = Math.min(endTs, asOfTs, toTs);
    const elapsedStart = Math.max(startTs, fromTs);
    if (elapsedEnd <= elapsedStart) continue;
    const elapsedDays = (elapsedEnd - elapsedStart) / DAY_SEC;
    total += (sorted[i].amountEur * elapsedDays) / coverageDays;
  }
  return total;
}

// Subscription € still to run after asOfTs, restricted to charges debited in
// [fromTs, toTs]. Replaces the previous `cash − accrued` heuristic which
// leaked pre-window charges into the prepaid bucket.
function sumPrepaidInRange(
  charges: BillingCharge[],
  fromTs: number,
  toTs: number,
  asOfTs: number,
): number {
  let total = 0;
  for (const charge of charges) {
    const chargeTs = dateIsoToTs(charge.date);
    if (chargeTs < fromTs || chargeTs > toTs) continue;
    // coverageDays is resolved the same way chargeCoverage does, but we only
    // need this charge's bounds — sort locally to find its index.
    const sorted = [...charges].sort((a, b) => a.date.localeCompare(b.date));
    const idx = sorted.findIndex((c) => c === charge);
    const { endTs, coverageDays } = chargeCoverage(sorted, idx);
    const remainingSec = Math.max(0, endTs - Math.max(asOfTs, chargeTs));
    total += (charge.amountEur * (remainingSec / DAY_SEC)) / coverageDays;
  }
  return total;
}

// €/day of whichever charge is active right now (asOfTs). Sum directly rather
// than routing through a synthetic monthly → /30 division: it's one fewer
// place where a 30d≠month assumption can leak in.
function activeDailyRate(charges: BillingCharge[], asOfTs: number): number {
  const active = activeChargeAt(charges, asOfTs);
  return active ? active.amountEur / active.coverageDays : 0;
}

function activeMonthlyRate(charges: BillingCharge[], asOfTs: number): number {
  // Kept as convenience (some KPIs still want a €/mo framing). It's
  // activeDailyRate × 30 — no re-derivation path so the two stay consistent.
  return activeDailyRate(charges, asOfTs) * 30;
}

export type BillingCost = {
  // Cash basis: sum of charges actually debited in [fromTs, toTs]. "Ce que tu as payé."
  total: number;
  claude: number;
  codex: number;
  // Accrual basis: prorata (newest charge wins on overlap). "Coût de la période."
  accrued: { total: number; claude: number; codex: number };
  // € still to run after asOfTs, restricted to charges debited in the window.
  // Calculated per-charge (not cash − accrued) to avoid leaking pre-window
  // charges' tail-accrual into the prepaid bucket.
  prepaid: { total: number; claude: number; codex: number };
  // €/day of whichever plan is active at asOfTs. Canonical "ABO/JOUR".
  activeDaily: { total: number; claude: number; codex: number };
  // Kept for callers that want a €/mo framing. = activeDaily × 30.
  activeMonthly: { total: number; claude: number; codex: number };
};

export function computeBillingCost(
  history: BillingHistory | undefined,
  source: 'combined' | 'claude' | 'codex',
  fromTs: number,
  toTs: number,
  asOfTs: number = Math.floor(Date.now() / 1000),
): BillingCost {
  const claudeCharges = source === 'codex' ? [] : history?.claude || [];
  const codexCharges = source === 'claude' ? [] : history?.codex || [];

  const claudePaid = sumChargesInRange(claudeCharges, fromTs, toTs);
  const codexPaid = sumChargesInRange(codexCharges, fromTs, toTs);

  const claudeAccrued = sumAccruedInRange(claudeCharges, fromTs, toTs, asOfTs);
  const codexAccrued = sumAccruedInRange(codexCharges, fromTs, toTs, asOfTs);

  const claudePrepaid = sumPrepaidInRange(claudeCharges, fromTs, toTs, asOfTs);
  const codexPrepaid = sumPrepaidInRange(codexCharges, fromTs, toTs, asOfTs);

  const claudeDaily = activeDailyRate(claudeCharges, asOfTs);
  const codexDaily = activeDailyRate(codexCharges, asOfTs);

  return {
    total: claudePaid + codexPaid,
    claude: claudePaid,
    codex: codexPaid,
    accrued: {
      total: claudeAccrued + codexAccrued,
      claude: claudeAccrued,
      codex: codexAccrued,
    },
    prepaid: {
      total: claudePrepaid + codexPrepaid,
      claude: claudePrepaid,
      codex: codexPrepaid,
    },
    activeDaily: {
      total: claudeDaily + codexDaily,
      claude: claudeDaily,
      codex: codexDaily,
    },
    activeMonthly: {
      total: (claudeDaily + codexDaily) * 30,
      claude: claudeDaily * 30,
      codex: codexDaily * 30,
    },
  };
}

// Kept for backward compat (fallback when no billing history is configured).
export function subscriptionCostEur(
  source: 'combined' | 'claude' | 'codex',
  periodDays: number,
): { total: number; claude: number; codex: number } {
  const claudeRate = CLAUDE_SUBSCRIPTION_EUR_MONTH / SUBSCRIPTION_DAYS_IN_MONTH;
  const codexRate = CODEX_SUBSCRIPTION_EUR_MONTH / SUBSCRIPTION_DAYS_IN_MONTH;
  const claude = source === 'codex' ? 0 : claudeRate * periodDays;
  const codex = source === 'claude' ? 0 : codexRate * periodDays;
  return { total: claude + codex, claude, codex };
}

export function devEquivalentHours(outputTokens: number, params: DevParams = {}): number {
  if (!Number.isFinite(outputTokens) || outputTokens <= 0) {
    return 0;
  }
  const tph = params.outputTokensPerHour ?? DEV_OUTPUT_TOKENS_PER_HOUR;
  if (tph <= 0) {
    return 0;
  }
  return outputTokens / tph;
}

export function devEquivalentEur(outputTokens: number, params: DevParams = {}): number {
  const rate = params.hourlyRateEur ?? DEV_HOURLY_RATE_EUR;
  return devEquivalentHours(outputTokens, params) * rate;
}

type HoursLocale = 'fr' | 'en' | 'es';

const HOURS_SUFFIX: Record<
  HoursLocale,
  { min: string; h: string; d: string; mo: string; y: string }
> = {
  fr: { min: 'min', h: 'h', d: 'j', mo: 'mo', y: 'a' },
  en: { min: 'min', h: 'h', d: 'd', mo: 'mo', y: 'y' },
  es: { min: 'min', h: 'h', d: 'd', mo: 'm', y: 'a' },
};

export function formatHours(hours: number, locale: HoursLocale = 'fr'): string {
  const s = HOURS_SUFFIX[locale];
  if (!Number.isFinite(hours) || hours <= 0) {
    return `0 ${s.h}`;
  }
  if (hours < 1) {
    return `${Math.round(hours * 60)} ${s.min}`;
  }
  if (hours < 8) {
    return `${hours.toFixed(1)} ${s.h}`;
  }
  const days = hours / 7;
  if (days < 20) {
    return `${days.toFixed(1)} ${s.d}`;
  }
  const months = days / 20;
  if (months < 12) {
    return `${months.toFixed(1)} ${s.mo}`;
  }
  return `${(months / 12).toFixed(1)} ${s.y}`;
}

export function lookupPrice(model: string | null, source: PricingSource): ModelPrice {
  const lower = (model || '').toLowerCase();
  const table = source === 'claude' ? CLAUDE_PRICING : CODEX_PRICING;
  for (const [key, price] of table) {
    if (lower.includes(key)) {
      return price;
    }
  }
  return source === 'claude' ? CLAUDE_FALLBACK : CODEX_FALLBACK;
}

export type CostModelSlice = {
  model: string;
  tokens: number;
  source: PricingSource;
};

export type CostBreakdownInput = {
  models: CostModelSlice[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  defaultSource: PricingSource;
};

export type CostBreakdown = {
  inputUsd: number;
  outputUsd: number;
  cacheReadUsd: number;
  cacheWriteUsd: number;
  totalUsd: number;
  savingsUsd: number;
  inputEur: number;
  outputEur: number;
  cacheReadEur: number;
  cacheWriteEur: number;
  totalEur: number;
  savingsEur: number;
  blendedInputPer1M: number;
  blendedOutputPer1M: number;
  blendedCacheReadPer1M: number;
  costPerMillionTokensEur: number;
};

export function computeCost(input: CostBreakdownInput): CostBreakdown {
  const totalModelTokens = input.models.reduce((sum, m) => sum + m.tokens, 0);

  let blendedInput: number;
  let blendedOutput: number;
  let blendedCacheRead: number;
  let blendedCacheWrite: number;

  if (totalModelTokens > 0) {
    let wIn = 0;
    let wOut = 0;
    let wCR = 0;
    let wCW = 0;
    for (const slice of input.models) {
      const price = lookupPrice(slice.model, slice.source);
      const weight = slice.tokens / totalModelTokens;
      wIn += price.input * weight;
      wOut += price.output * weight;
      wCR += (price.cacheRead ?? price.input * 0.1) * weight;
      wCW += (price.cacheWrite ?? price.input * 1.25) * weight;
    }
    blendedInput = wIn;
    blendedOutput = wOut;
    blendedCacheRead = wCR;
    blendedCacheWrite = wCW;
  } else {
    const fallback = input.defaultSource === 'claude' ? CLAUDE_FALLBACK : CODEX_FALLBACK;
    blendedInput = fallback.input;
    blendedOutput = fallback.output;
    blendedCacheRead = fallback.cacheRead ?? fallback.input * 0.1;
    blendedCacheWrite = fallback.cacheWrite ?? fallback.input * 1.25;
  }

  const inputUsd = (input.inputTokens / 1_000_000) * blendedInput;
  const outputUsd = (input.outputTokens / 1_000_000) * blendedOutput;
  const cacheReadUsd = (input.cacheReadTokens / 1_000_000) * blendedCacheRead;
  const cacheWriteUsd = (input.cacheWriteTokens / 1_000_000) * blendedCacheWrite;
  const totalUsd = inputUsd + outputUsd + cacheReadUsd + cacheWriteUsd;
  const savingsUsd =
    (input.cacheReadTokens / 1_000_000) * Math.max(0, blendedInput - blendedCacheRead);

  const totalTokens =
    input.inputTokens + input.outputTokens + input.cacheReadTokens + input.cacheWriteTokens;
  const costPerMillionTokens = totalTokens > 0 ? (totalUsd / totalTokens) * 1_000_000 : 0;

  return {
    inputUsd,
    outputUsd,
    cacheReadUsd,
    cacheWriteUsd,
    totalUsd,
    savingsUsd,
    inputEur: inputUsd * USD_TO_EUR,
    outputEur: outputUsd * USD_TO_EUR,
    cacheReadEur: cacheReadUsd * USD_TO_EUR,
    cacheWriteEur: cacheWriteUsd * USD_TO_EUR,
    totalEur: totalUsd * USD_TO_EUR,
    savingsEur: savingsUsd * USD_TO_EUR,
    blendedInputPer1M: blendedInput,
    blendedOutputPer1M: blendedOutput,
    blendedCacheReadPer1M: blendedCacheRead,
    costPerMillionTokensEur: costPerMillionTokens * USD_TO_EUR,
  };
}

const NUMBER_LOCALE: Record<HoursLocale, string> = {
  fr: 'fr-FR',
  en: 'en-US',
  es: 'es-ES',
};

export function formatEur(value: number, locale: HoursLocale = 'fr'): string {
  if (!Number.isFinite(value)) {
    return '—';
  }
  const nLocale = NUMBER_LOCALE[locale];
  if (Math.abs(value) < 0.01 && value !== 0) {
    return new Intl.NumberFormat(nLocale, {
      style: 'currency',
      currency: 'EUR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
      .format(0.01 * Math.sign(value || 1))
      .replace(/^/, '< ');
  }
  if (Math.abs(value) < 10) {
    return new Intl.NumberFormat(nLocale, {
      style: 'currency',
      currency: 'EUR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    }).format(value);
  }
  if (Math.abs(value) < 1000) {
    return new Intl.NumberFormat(nLocale, {
      style: 'currency',
      currency: 'EUR',
      minimumFractionDigits: 0,
      maximumFractionDigits: 1,
    }).format(value);
  }
  return new Intl.NumberFormat(nLocale, {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 0,
    maximumFractionDigits: 0,
  }).format(value);
}

export function formatEurPerMillion(value: number, locale: HoursLocale = 'fr'): string {
  if (!Number.isFinite(value) || value === 0) {
    return '—';
  }
  return `${formatEur(value, locale)} / M tok`;
}
