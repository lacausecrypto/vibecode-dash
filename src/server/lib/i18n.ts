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
    'agent.execHints.codexMcpTransport':
      "💡 Probable cause : modèle non reconnu par codex (alias absent de ~/.codex/config.toml ou non disponible dans l'API OpenAI). Vérifie le nom du modèle ou ajoute-le dans ta config codex.",
    'agent.execHints.modelNotFound':
      '💡 Modèle non disponible avec ta clé API. Choisis-en un autre dans le sélecteur ou demande l’accès à OpenAI.',
    'agent.execHints.apiKey':
      '💡 Clé API manquante ou invalide pour ce provider. Vérifie ta config (Anthropic / OpenAI) ou la keychain.',
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
    'agent.execHints.codexMcpTransport':
      '💡 Likely cause: model not recognised by codex (alias missing from ~/.codex/config.toml, or not available on the OpenAI API). Check the model name or add it to your codex config.',
    'agent.execHints.modelNotFound':
      '💡 This model is not available with your API key. Pick a different one in the selector, or request access from OpenAI.',
    'agent.execHints.apiKey':
      '💡 API key missing or invalid for this provider. Check your config (Anthropic / OpenAI) or keychain.',
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
    'agent.execHints.codexMcpTransport':
      '💡 Causa probable: modelo no reconocido por codex (alias ausente de ~/.codex/config.toml, o no disponible en la API OpenAI). Verifica el nombre del modelo o añádelo a tu config codex.',
    'agent.execHints.modelNotFound':
      '💡 Este modelo no está disponible con tu clave API. Elige otro en el selector o solicita acceso a OpenAI.',
    'agent.execHints.apiKey':
      '💡 Clave API ausente o inválida para este provider. Verifica tu config (Anthropic / OpenAI) o el keychain.',
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
