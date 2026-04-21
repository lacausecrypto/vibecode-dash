import { useEffect, useSyncExternalStore } from 'react';

/**
 * Minimal keyboard shortcut registry, stored client-side in localStorage.
 *
 * Why not the browser default ⌘1-9? macOS browsers intercept them for tab
 * switching — they never reach our listeners. Defaults here use Alt+digit
 * (browser-safe) for navigation and bare single letters for in-page actions.
 */

export type ActionId =
  | 'nav.overview'
  | 'nav.projects'
  | 'nav.github'
  | 'nav.vault'
  | 'nav.usage'
  | 'nav.agent'
  | 'nav.radar'
  | 'nav.settings'
  | 'nav.agentJump'
  | 'radar.scan'
  | 'radar.generate'
  | 'radar.toggleMatrix';

export const ACTION_LABELS: Record<ActionId, string> = {
  'nav.overview': 'Overview',
  'nav.projects': 'Projects',
  'nav.github': 'GitHub',
  'nav.vault': 'Vault',
  'nav.usage': 'Usage',
  'nav.agent': 'Agent',
  'nav.radar': 'Radar',
  'nav.settings': 'Settings',
  'nav.agentJump': 'Agent (jump)',
  'radar.scan': 'Radar — scan concurrents',
  'radar.generate': 'Radar — generate insights',
  'radar.toggleMatrix': 'Radar — toggle matrix',
};

export const DEFAULT_BINDINGS: Record<ActionId, string> = {
  'nav.overview': 'alt+1',
  'nav.projects': 'alt+2',
  'nav.github': 'alt+3',
  'nav.vault': 'alt+4',
  'nav.usage': 'alt+5',
  'nav.agent': 'alt+6',
  'nav.radar': 'alt+7',
  'nav.settings': 'alt+8',
  'nav.agentJump': 'meta+shift+k',
  'radar.scan': 's',
  'radar.generate': 'g',
  'radar.toggleMatrix': 'm',
};

const LS_KEY = 'shortcuts.bindings';

/**
 * Serialize a KeyboardEvent into a canonical stable string:
 *   "[modifier+…]key" where modifiers are sorted alphabetically.
 * Non-alphanumeric keys keep their literal `event.key` (e.g. "Escape", ",").
 */
export function serializeKey(event: KeyboardEvent): string {
  const mods: string[] = [];
  if (event.altKey) mods.push('alt');
  if (event.ctrlKey) mods.push('ctrl');
  if (event.metaKey) mods.push('meta');
  if (event.shiftKey) mods.push('shift');

  let key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  // Normalize some aliases.
  if (key === ' ') key = 'space';

  return mods.length > 0 ? `${mods.join('+')}+${key}` : key;
}

export function formatBinding(binding: string): string {
  // Render human-readable label with real symbols on mac.
  const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
  return binding
    .split('+')
    .map((token) => {
      switch (token) {
        case 'meta':
          return isMac ? '⌘' : 'Ctrl';
        case 'ctrl':
          return isMac ? '⌃' : 'Ctrl';
        case 'alt':
          return isMac ? '⌥' : 'Alt';
        case 'shift':
          return isMac ? '⇧' : 'Shift';
        case 'space':
          return '␣';
        default:
          return token.length === 1 ? token.toUpperCase() : token;
      }
    })
    .join(isMac ? '' : '+');
}

// ───────────────────── Store (subscribe + snapshot) ─────────────────────

type Bindings = Record<ActionId, string>;

const listeners = new Set<() => void>();
let currentBindings: Bindings = load();

function load(): Bindings {
  if (typeof window === 'undefined') return { ...DEFAULT_BINDINGS };
  try {
    const raw = window.localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULT_BINDINGS };
    const parsed = JSON.parse(raw) as Partial<Bindings>;
    // Merge with defaults so newly-added actions always have a binding.
    return { ...DEFAULT_BINDINGS, ...parsed };
  } catch {
    return { ...DEFAULT_BINDINGS };
  }
}

function persist(next: Bindings): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(LS_KEY, JSON.stringify(next));
  } catch {
    /* quota / private mode — ignore */
  }
}

function emit(): void {
  for (const fn of listeners) fn();
}

export function getBindings(): Bindings {
  return currentBindings;
}

export function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function setBinding(id: ActionId, binding: string): void {
  currentBindings = { ...currentBindings, [id]: binding };
  persist(currentBindings);
  emit();
}

export function resetBindings(): void {
  currentBindings = { ...DEFAULT_BINDINGS };
  persist(currentBindings);
  emit();
}

/**
 * Returns the action whose binding collides with `candidate`, excluding
 * `except` so the user can set the same binding they already have.
 */
export function findConflict(candidate: string, except?: ActionId): ActionId | null {
  for (const [id, b] of Object.entries(currentBindings) as [ActionId, string][]) {
    if (b === candidate && id !== except) return id;
  }
  return null;
}

export function useBindings(): Bindings {
  return useSyncExternalStore(subscribe, getBindings, getBindings);
}

// ───────────────────── Runtime dispatcher ─────────────────────

type Handler = (event: KeyboardEvent) => void;

/**
 * Register a handler for an action. The handler fires only when the current
 * keyboard event matches the action's current binding AND the event target is
 * not an editable element. Rebinding updates automatically via subscription.
 */
export function useShortcut(action: ActionId, handler: Handler, enabled = true): void {
  useEffect(() => {
    if (!enabled) return;

    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const tag = target?.tagName || '';
      const editable =
        target?.isContentEditable || tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
      if (editable) return;

      const binding = currentBindings[action];
      if (!binding) return;
      if (serializeKey(event) !== binding) return;

      event.preventDefault();
      handler(event);
    }

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [action, handler, enabled]);
}
