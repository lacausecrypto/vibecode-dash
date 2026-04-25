import { describe, expect, test } from 'bun:test';
import { extractJsonArray } from '../lib/presenceDrafter';

describe('extractJsonArray', () => {
  test('parses fenced ```json``` array', () => {
    const raw = '```json\n[{"idx":1,"score":0.8}]\n```';
    expect(extractJsonArray(raw)).toEqual([{ idx: 1, score: 0.8 }]);
  });

  test('parses fenced bare ``` array (no language tag)', () => {
    const raw = '```\n[{"idx":1,"score":0.8}]\n```';
    expect(extractJsonArray(raw)).toEqual([{ idx: 1, score: 0.8 }]);
  });

  test('parses bare array without fences', () => {
    const raw = '[{"idx":1,"score":0.8},{"idx":2,"score":0.4}]';
    expect(extractJsonArray(raw)).toEqual([
      { idx: 1, score: 0.8 },
      { idx: 2, score: 0.4 },
    ]);
  });

  test('tolerates commentary around the array', () => {
    const raw =
      'Sure! Here are the scores:\n[{"idx":1,"score":0.7}]\nLet me know if you need more.';
    expect(extractJsonArray(raw)).toEqual([{ idx: 1, score: 0.7 }]);
  });

  test('returns null on missing brackets', () => {
    expect(extractJsonArray('plain text no JSON')).toBeNull();
  });

  test('returns null on malformed JSON', () => {
    expect(extractJsonArray('[{idx:1, score:0.8,}]')).toBeNull();
  });

  test('returns null on empty input', () => {
    expect(extractJsonArray('')).toBeNull();
  });

  test('returns null when content is an object, not an array', () => {
    // Critical: extractJsonBlock handles {...}; this helper should NOT
    // accidentally parse an object as a single-element array.
    const raw = '```json\n{"idx":1,"score":0.8}\n```';
    expect(extractJsonArray(raw)).toBeNull();
  });

  test('handles empty array', () => {
    expect(extractJsonArray('[]')).toEqual([]);
  });

  test('handles array with extra entries (over-emit by model)', () => {
    // Real-world fault: model emits 9 entries when asked for 8. Parser
    // accepts; the slot-mapper drops out-of-range entries downstream.
    const raw = '```json\n[{"idx":1,"score":0.5},{"idx":2,"score":0.6},{"idx":3,"score":0.7}]\n```';
    const out = extractJsonArray(raw);
    expect(Array.isArray(out)).toBe(true);
    expect(out?.length).toBe(3);
  });

  test('recovers when model wraps array in nested commentary + fences', () => {
    const raw = `Here's my analysis:

\`\`\`json
[
  {"idx": 1, "score": 0.85, "rationale": "high-signal thread, user has direct experience"},
  {"idx": 2, "score": 0.30, "rationale": "off-topic for the user's expertise"}
]
\`\`\`

Note: candidate 2 was a stretch.`;
    const out = extractJsonArray(raw);
    expect(out?.length).toBe(2);
    expect((out?.[0] as { score: number }).score).toBe(0.85);
    expect((out?.[1] as { rationale: string }).rationale).toContain('off-topic');
  });

  test('does not crash on multiple JSON blocks (uses outermost)', () => {
    // Defensive: if the model emits two arrays (e.g. one in a thinking block,
    // one as the answer), we parse from the first `[` to the last `]`. This
    // can lead to invalid JSON if the two blocks aren't a single valid array,
    // but it must NEVER throw — fallback to single-call scoring kicks in.
    const raw = '[1,2,3] some text [4,5,6]';
    // Either valid (lenient parse covers it) or null — must not throw.
    expect(() => extractJsonArray(raw)).not.toThrow();
  });
});
