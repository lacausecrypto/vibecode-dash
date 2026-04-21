import { describe, expect, test } from 'bun:test';
import { resolveVaultPath } from '../scanners/obsidianScanner';

describe('resolveVaultPath', () => {
  const vault = '/tmp/vault';

  test('resolves simple relative path', () => {
    expect(resolveVaultPath(vault, 'Daily/2026-04-19.md')).toBe('/tmp/vault/Daily/2026-04-19.md');
  });

  test('rejects escape via parent traversal', () => {
    expect(() => resolveVaultPath(vault, '../etc/passwd')).toThrow(/escapes vault/);
  });

  test('rejects escape via deep traversal', () => {
    expect(() => resolveVaultPath(vault, 'foo/../../etc/passwd')).toThrow(/escapes vault/);
  });

  test('allows root itself', () => {
    expect(resolveVaultPath(vault, '')).toBe(vault);
  });
});
