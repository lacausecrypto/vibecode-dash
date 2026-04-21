import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { DICT_EN } from '../locales/en';
import { DICT_ES } from '../locales/es';
import { DICT_FR } from '../locales/fr';
import { apiGet, apiPut } from './api';

export type Locale = 'fr' | 'en' | 'es';

export const AVAILABLE_LOCALES: Array<{ value: Locale; label: string; flag: string }> = [
  { value: 'fr', label: 'Français', flag: '🇫🇷' },
  { value: 'en', label: 'English', flag: '🇬🇧' },
  { value: 'es', label: 'Español', flag: '🇪🇸' },
];

type Dict = Record<string, unknown>;

const DICTS: Record<Locale, Dict> = {
  fr: DICT_FR,
  en: DICT_EN,
  es: DICT_ES,
};

function getNested(dict: Dict, key: string): string | undefined {
  const parts = key.split('.');
  let cur: unknown = dict;
  for (const part of parts) {
    if (cur && typeof cur === 'object' && part in (cur as Record<string, unknown>)) {
      cur = (cur as Record<string, unknown>)[part];
    } else {
      return undefined;
    }
  }
  return typeof cur === 'string' ? cur : undefined;
}

function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_match, name) =>
    name in vars ? String(vars[name]) : `{${name}}`,
  );
}

/**
 * Translate a key. Falls back to `fr` then to the key itself if missing.
 * Supports `{name}` variable interpolation via the second arg.
 */
export function translate(
  locale: Locale,
  key: string,
  vars?: Record<string, string | number>,
): string {
  const raw = getNested(DICTS[locale], key) ?? getNested(DICTS.fr, key) ?? key;
  return vars ? interpolate(raw, vars) : raw;
}

// ─── Locale-aware formatters ──────────────────────────────────────────────

const DATE_LOCALES: Record<Locale, string> = {
  fr: 'fr-FR',
  en: 'en-GB',
  es: 'es-ES',
};

const NUMBER_LOCALES: Record<Locale, string> = {
  fr: 'fr-FR',
  en: 'en-US',
  es: 'es-ES',
};

export function dateLocale(locale: Locale): string {
  return DATE_LOCALES[locale];
}

export function numberLocale(locale: Locale): string {
  return NUMBER_LOCALES[locale];
}

export function formatNumber(value: number, locale: Locale): string {
  return Intl.NumberFormat(NUMBER_LOCALES[locale]).format(Math.round(value));
}

export function formatCompactNumber(value: number, locale: Locale): string {
  const abs = Math.abs(value);
  const compactLabels: Record<Locale, { b: string; m: string; k: string }> = {
    fr: { b: ' Md', m: ' M', k: ' k' },
    en: { b: 'B', m: 'M', k: 'k' },
    es: { b: ' Md', m: ' M', k: ' k' },
  };
  const { b, m, k } = compactLabels[locale];
  if (abs >= 1_000_000_000) {
    return `${(value / 1_000_000_000).toFixed(abs >= 10_000_000_000 ? 0 : 1)}${b}`;
  }
  if (abs >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}${m}`;
  }
  if (abs >= 1_000) {
    return `${(value / 1_000).toFixed(abs >= 10_000 ? 0 : 1)}${k}`;
  }
  return formatNumber(value, locale);
}

export function formatEur(value: number, locale: Locale): string {
  return Intl.NumberFormat(NUMBER_LOCALES[locale], {
    style: 'currency',
    currency: 'EUR',
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatUsd(value: number, locale: Locale): string {
  return Intl.NumberFormat(NUMBER_LOCALES[locale], {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
  }).format(value);
}

export function formatDate(
  ts: number | Date,
  locale: Locale,
  options?: Intl.DateTimeFormatOptions,
): string {
  const date = typeof ts === 'number' ? new Date(ts * 1000) : ts;
  return date.toLocaleDateString(DATE_LOCALES[locale], options);
}

export function formatRelativeDays(daysAgo: number, locale: Locale): string {
  if (daysAgo <= 0) return translate(locale, 'common.today');
  if (daysAgo === 1) return translate(locale, 'common.yesterday');
  if (daysAgo < 7) return translate(locale, 'common.daysAgo', { n: daysAgo });
  if (daysAgo < 30) return translate(locale, 'common.weeksAgo', { n: Math.floor(daysAgo / 7) });
  if (daysAgo < 365) return translate(locale, 'common.monthsAgo', { n: Math.floor(daysAgo / 30) });
  return translate(locale, 'common.yearsAgo', { n: Math.floor(daysAgo / 365) });
}

// ─── Context + hook ───────────────────────────────────────────────────────

type LocaleContextValue = {
  locale: Locale;
  setLocale: (next: Locale) => void;
  t: (key: string, vars?: Record<string, string | number>) => string;
};

const LocaleContext = createContext<LocaleContextValue | null>(null);

export function LocaleProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>('fr');

  useEffect(() => {
    apiGet<{ locale?: Locale }>('/api/settings')
      .then((s) => {
        if (s.locale && ['fr', 'en', 'es'].includes(s.locale)) {
          setLocaleState(s.locale);
        }
      })
      .catch(() => {});
  }, []);

  const setLocale = useCallback((next: Locale) => {
    setLocaleState(next);
    apiGet<Record<string, unknown>>('/api/settings')
      .then((current) => apiPut('/api/settings', { ...current, locale: next }))
      .catch(() => {});
  }, []);

  const value = useMemo<LocaleContextValue>(
    () => ({
      locale,
      setLocale,
      t: (key, vars) => translate(locale, key, vars),
    }),
    [locale, setLocale],
  );

  return <LocaleContext.Provider value={value}>{children}</LocaleContext.Provider>;
}

export function useTranslation(): LocaleContextValue {
  const ctx = useContext(LocaleContext);
  if (!ctx) {
    // Fallback silencieux si utilisé hors provider (tests, composants isolés)
    return {
      locale: 'fr',
      setLocale: () => {},
      t: (key, vars) => translate('fr', key, vars),
    };
  }
  return ctx;
}
