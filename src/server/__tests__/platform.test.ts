import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { isAbsolute } from 'node:path';
import {
  appDataDir,
  currentPlatform,
  defaultClaudeConfigDir,
  defaultProjectsRoot,
  defaultVaultPath,
} from '../lib/platform';

describe('platform defaults', () => {
  test('currentPlatform returns one of the supported three', () => {
    const p = currentPlatform();
    expect(['darwin', 'linux', 'win32']).toContain(p);
  });

  test('all path defaults are absolute and rooted in $HOME', () => {
    const home = homedir();
    for (const p of [
      defaultProjectsRoot(),
      defaultVaultPath(),
      defaultClaudeConfigDir(),
      appDataDir(),
    ]) {
      expect(isAbsolute(p)).toBe(true);
      expect(p.startsWith(home) || (process.env.APPDATA && p.startsWith(process.env.APPDATA))).toBe(
        true,
      );
    }
  });

  test('defaults contain no machine-specific literals from the author', () => {
    // Guards against accidentally re-introducing the original hardcoded paths.
    const forbidden = ['/Volumes/nvme', 'mybrain', 'projet claude', 'lacausecrypto'];
    const all = [
      defaultProjectsRoot(),
      defaultVaultPath(),
      defaultClaudeConfigDir(),
      appDataDir(),
    ].join('|');
    for (const f of forbidden) {
      expect(all).not.toContain(f);
    }
  });
});
