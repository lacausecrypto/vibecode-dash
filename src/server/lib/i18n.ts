import { loadSettings } from '../config';

type Locale = 'fr' | 'en' | 'es';

const DICT: Record<Locale, Record<string, string>> = {
  fr: {
    'agent.abortedByUser': "Arrêté par l'utilisateur.",
    'agent.emptyResponse': '(réponse vide)',
    'agent.aborted': '(arrêté)',
    'agent.timeout': 'Timeout atteint ({seconds} s)',
    'agent.timeoutLong': 'Timeout atteint ({seconds} s) — aucune réponse générée avant la coupure.',
    'agent.execFailed': 'Agent command failed (exit {exitCode}).',
    'github.notConnected':
      'GitHub non connecté. Option simple: exécute `gh auth login` puis clique sur "Sync now". Option alternative: ajoute un PAT en keychain avec `security add-generic-password -s vibecode-dash -a github-pat -w <PAT>`.',
  },
  en: {
    'agent.abortedByUser': 'Aborted by the user.',
    'agent.emptyResponse': '(empty response)',
    'agent.aborted': '(aborted)',
    'agent.timeout': 'Timeout reached ({seconds} s)',
    'agent.timeoutLong': 'Timeout reached ({seconds} s) — no response generated before cutoff.',
    'agent.execFailed': 'Agent command failed (exit {exitCode}).',
    'github.notConnected':
      'GitHub not connected. Simple option: run `gh auth login` then click "Sync now". Alternate: add a PAT to keychain with `security add-generic-password -s vibecode-dash -a github-pat -w <PAT>`.',
  },
  es: {
    'agent.abortedByUser': 'Interrumpido por el usuario.',
    'agent.emptyResponse': '(respuesta vacía)',
    'agent.aborted': '(interrumpido)',
    'agent.timeout': 'Timeout alcanzado ({seconds} s)',
    'agent.timeoutLong':
      'Timeout alcanzado ({seconds} s) — ninguna respuesta generada antes del corte.',
    'agent.execFailed': 'Agent command failed (exit {exitCode}).',
    'github.notConnected':
      'GitHub no conectado. Opción simple: ejecuta `gh auth login` luego haz clic en "Sync now". Alternativa: añade un PAT al keychain con `security add-generic-password -s vibecode-dash -a github-pat -w <PAT>`.',
  },
};

function interpolate(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_m, k) => (k in vars ? String(vars[k]) : `{${k}}`));
}

export function t(locale: Locale, key: string, vars?: Record<string, string | number>): string {
  const raw = DICT[locale]?.[key] ?? DICT.fr[key] ?? key;
  return vars ? interpolate(raw, vars) : raw;
}

export async function currentLocale(): Promise<Locale> {
  try {
    const settings = await loadSettings();
    return (settings.locale as Locale) || 'fr';
  } catch {
    return 'fr';
  }
}
