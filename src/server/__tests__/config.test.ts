import { describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { expandHomePath } from '../config';

describe('expandHomePath', () => {
  test('expands tilde to home', () => {
    expect(expandHomePath('~/foo/bar')).toBe(join(homedir(), 'foo/bar'));
  });

  test('expands bare tilde', () => {
    expect(expandHomePath('~')).toBe(homedir());
  });

  test('leaves absolute unix paths untouched', () => {
    expect(expandHomePath('/opt/projects/thing')).toBe('/opt/projects/thing');
  });

  test('leaves absolute windows paths untouched', () => {
    expect(expandHomePath('C:\\Users\\alice\\projects')).toBe('C:\\Users\\alice\\projects');
  });

  test('does not expand embedded tilde', () => {
    expect(expandHomePath('/tmp/~backup')).toBe('/tmp/~backup');
  });
});
