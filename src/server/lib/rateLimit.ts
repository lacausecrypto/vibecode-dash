/**
 * In-memory sliding-window rate limiter for expensive routes.
 *
 * Reason: endpoints that shell out to Claude/Codex CLI can stall the machine
 * and cost real money if hammered (user misclicks a button, or a script loops).
 * A local dashboard has a single user, but the defence is cheap and bounds
 * runaway loops.
 *
 * Usage:
 *   const rl = rateLimit(3, 60_000);  // max 3 per minute
 *   const verdict = rl.check(`scan:${projectId}`);
 *   if (!verdict.ok) return c.json({ error: 'rate_limited', retryAfterMs: verdict.retryAfterMs }, 429);
 */

type Verdict = { ok: true } | { ok: false; retryAfterMs: number };

export function rateLimit(maxCalls: number, windowMs: number) {
  const hits = new Map<string, number[]>();

  function prune(now: number) {
    if (hits.size < 256) return;
    for (const [key, arr] of hits) {
      const alive = arr.filter((t) => now - t < windowMs);
      if (alive.length === 0) hits.delete(key);
      else hits.set(key, alive);
    }
  }

  return {
    check(key: string): Verdict {
      const now = Date.now();
      const arr = (hits.get(key) || []).filter((t) => now - t < windowMs);
      if (arr.length >= maxCalls) {
        const oldest = arr[0];
        return { ok: false, retryAfterMs: Math.max(0, windowMs - (now - oldest)) };
      }
      arr.push(now);
      hits.set(key, arr);
      prune(now);
      return { ok: true };
    },
    /** Test helper. */
    reset(): void {
      hits.clear();
    },
  };
}
