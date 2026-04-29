import { watch } from 'node:fs';
import { resolve } from 'node:path';
import { type Settings, expandHomePath, loadSettings } from '../config';
import { getDb } from '../db';
import { reindexObsidianVault } from '../scanners/obsidianScanner';

/**
 * Watch the vault root for file changes and trigger a debounced reindex.
 * Closes the gap where a user adds a note in Obsidian and the agent can't
 * find it until the scheduled 15-minute rescan fires.
 *
 * Debounce: 2 s after the last change event (Obsidian writes temp files +
 * renames, which would otherwise trigger a flurry of scans).
 * Min interval between actual reindexes: 10 s (avoid hammering on heavy edits).
 */

const DEBOUNCE_MS = 2_000;
const MIN_INTERVAL_MS = 10_000;

type WatcherState = {
  timer: ReturnType<typeof setTimeout> | null;
  lastReindexAt: number;
  running: boolean;
  pending: boolean;
};

let active: { close: () => void } | null = null;

export function stopObsidianWatcher(): void {
  if (active) {
    try {
      active.close();
    } catch {
      /* noop */
    }
    active = null;
  }
}

export async function startObsidianWatcher(): Promise<void> {
  if (active) {
    return;
  }
  const settings: Settings = await loadSettings();
  if (!settings.paths.vaultPath) {
    return;
  }
  const vaultRoot = resolve(expandHomePath(settings.paths.vaultPath));

  const state: WatcherState = {
    timer: null,
    lastReindexAt: 0,
    running: false,
    pending: false,
  };

  const triggerReindex = async () => {
    if (state.running) {
      state.pending = true;
      return;
    }
    state.running = true;
    state.lastReindexAt = Date.now();
    try {
      await reindexObsidianVault(getDb(), await loadSettings());
    } catch (error) {
      console.warn('[obsidianWatcher] reindex failed:', String(error));
    } finally {
      state.running = false;
      if (state.pending) {
        state.pending = false;
        // Schedule a follow-up pass for events that arrived during the reindex.
        setTimeout(() => void triggerReindex(), 500);
      }
    }
  };

  const schedule = () => {
    const minWait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - state.lastReindexAt));
    if (state.timer) {
      clearTimeout(state.timer);
    }
    state.timer = setTimeout(
      () => {
        state.timer = null;
        void triggerReindex();
      },
      Math.max(DEBOUNCE_MS, minWait),
    );
  };

  try {
    const watcher = watch(vaultRoot, { recursive: true }, (_eventType, filename) => {
      if (!filename) return;
      // Ignore Obsidian housekeeping writes — they fire constantly and have
      // no impact on the indexed content.
      if (
        filename.startsWith('.obsidian/') ||
        filename.includes('/.obsidian/') ||
        filename.startsWith('.trash/') ||
        filename.endsWith('~') ||
        filename.endsWith('.tmp')
      ) {
        return;
      }
      if (!filename.endsWith('.md')) {
        return;
      }
      schedule();
    });
    watcher.on('error', (error) => {
      console.warn('[obsidianWatcher] watch error:', String(error));
    });
    active = {
      close: () => {
        if (state.timer) clearTimeout(state.timer);
        watcher.close();
      },
    };
    console.log(`[obsidianWatcher] watching ${vaultRoot}`);
  } catch (error) {
    console.warn('[obsidianWatcher] failed to start:', String(error));
  }
}
