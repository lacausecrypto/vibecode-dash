import { homedir, platform } from 'node:os';
import { join } from 'node:path';

export type SupportedPlatform = 'darwin' | 'linux' | 'win32';

export function currentPlatform(): SupportedPlatform {
  const p = platform();
  if (p === 'darwin' || p === 'linux' || p === 'win32') {
    return p;
  }
  throw new Error(`Unsupported platform: ${p}. Supported: darwin, linux, win32.`);
}

export function isMac(): boolean {
  return platform() === 'darwin';
}

export function isLinux(): boolean {
  return platform() === 'linux';
}

export function isWindows(): boolean {
  return platform() === 'win32';
}

/**
 * Default projects root, relative to the user's home directory.
 * Same convention on all three OSes: `~/projects`.
 */
export function defaultProjectsRoot(): string {
  return join(homedir(), 'projects');
}

/**
 * Default Obsidian vault location. Obsidian itself has no canonical path;
 * `~/Documents/Obsidian` is the desktop app's typical install hint. The user
 * is expected to override this from Settings if they keep the vault elsewhere.
 */
export function defaultVaultPath(): string {
  return join(homedir(), 'Documents', 'Obsidian');
}

/**
 * Claude Code stores its per-user config in `~/.claude` on every OS
 * (verified on macOS, Linux, Windows — same convention).
 */
export function defaultClaudeConfigDir(): string {
  return join(homedir(), '.claude');
}

/**
 * Per-user app data directory for vibecode-dash itself (Windows-style
 * `%APPDATA%\vibecode-dash`, XDG `~/.local/share/vibecode-dash` on Linux,
 * `~/Library/Application Support/vibecode-dash` on macOS).
 *
 * Used by the Windows keychain fallback to persist DPAPI-encrypted secrets.
 */
export function appDataDir(): string {
  const p = currentPlatform();
  if (p === 'win32') {
    const appData = process.env.APPDATA;
    if (appData && appData.length > 0) {
      return join(appData, 'vibecode-dash');
    }
    return join(homedir(), 'AppData', 'Roaming', 'vibecode-dash');
  }
  if (p === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'vibecode-dash');
  }
  const xdg = process.env.XDG_DATA_HOME;
  if (xdg && xdg.length > 0) {
    return join(xdg, 'vibecode-dash');
  }
  return join(homedir(), '.local', 'share', 'vibecode-dash');
}
