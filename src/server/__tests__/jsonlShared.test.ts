import { describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isSubPath, listRecentJsonlFiles } from '../wrappers/jsonlShared';

describe('isSubPath', () => {
  test('accepts root and nested children', () => {
    expect(isSubPath('/tmp/root', '/tmp/root')).toBe(true);
    expect(isSubPath('/tmp/root/child/file.txt', '/tmp/root')).toBe(true);
  });

  test('rejects sibling prefix paths', () => {
    expect(isSubPath('/tmp/root-sibling/file.txt', '/tmp/root')).toBe(false);
    expect(isSubPath('/tmp/root/../outside/file.txt', '/tmp/root')).toBe(false);
  });
});

describe('listRecentJsonlFiles', () => {
  test('filters by depth, mtime and maxFiles without shelling out', async () => {
    const root = mkdtempSync(join(tmpdir(), 'vcd-jsonl-'));
    try {
      mkdirSync(join(root, 'project-a'), { recursive: true });
      mkdirSync(join(root, 'project-b'), { recursive: true });
      mkdirSync(join(root, 'project-b', 'nested'), { recursive: true });

      const oldPath = join(root, 'project-a', 'old.jsonl');
      const freshPath = join(root, 'project-a', 'fresh.jsonl');
      const newerPath = join(root, 'project-b', 'newer.jsonl');
      const tooDeepPath = join(root, 'project-b', 'nested', 'too-deep.jsonl');
      const ignoredExtPath = join(root, 'project-b', 'not-json.txt');

      for (const path of [oldPath, freshPath, newerPath, tooDeepPath, ignoredExtPath]) {
        writeFileSync(path, '{}\n', 'utf8');
      }

      const now = Math.floor(Date.now() / 1000);
      const old = new Date('2020-01-01T00:00:00Z');
      const fresh = new Date('2026-01-01T00:00:00Z');
      const newer = new Date('2026-02-01T00:00:00Z');
      const tooDeep = new Date('2026-03-01T00:00:00Z');
      utimesSync(oldPath, old, old);
      utimesSync(freshPath, fresh, fresh);
      utimesSync(newerPath, newer, newer);
      utimesSync(tooDeepPath, tooDeep, tooDeep);

      const rows = await listRecentJsonlFiles(root, {
        fromTs: now - 365 * 86400,
        maxFiles: 1,
        minDepth: 2,
        maxDepth: 2,
      });

      expect(rows.map((row) => row.path)).toEqual([newerPath]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
