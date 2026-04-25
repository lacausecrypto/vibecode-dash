/**
 * Tiny pub/sub for "something just happened in the dashboard".
 *
 * Used by the Mascot widget to react to fetches in flight, recent successes,
 * errors, rate limits, etc. Kept dumb on purpose — no buffering, no async,
 * no React. Subscribers receive every event synchronously and decide what
 * to do (debounce, fold into state, ignore).
 *
 * Why a custom bus instead of a global state library: the mascot is the
 * only consumer today, and React Context would force every fetch helper
 * to know about React. Keeping the bus framework-agnostic means the
 * server-side Bun runtime could subscribe later (e.g. log to OTLP) with
 * zero change.
 */

export type ActivityEvent =
  | { kind: 'fetch:start'; path: string; method: string; at: number }
  | { kind: 'fetch:end'; path: string; method: string; status: number; ms: number; at: number }
  | { kind: 'fetch:error'; path: string; method: string; status: number; at: number }
  | { kind: 'fetch:rateLimit'; path: string; at: number }
  // Generic "something noteworthy happened off-page" — drives the Mascot's
  // notification sprite. The source decides what counts as noteworthy
  // (presence-feed delta, big sync completed, insight discovered, etc.).
  // Kept loose on purpose: the bus stays dumb, listeners decide if they
  // care. `reason` is free-form for tooltips / future debug surfaces.
  | { kind: 'notification'; reason: string; at: number };

type Listener = (event: ActivityEvent) => void;

const listeners = new Set<Listener>();

export function emitActivity(event: ActivityEvent): void {
  // Synchronous fan-out. A bad listener throwing shouldn't kill the others
  // and shouldn't propagate back into the fetch path.
  for (const fn of listeners) {
    try {
      fn(event);
    } catch (err) {
      console.warn('[activityBus] listener threw', err);
    }
  }
}

export function subscribeActivity(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}
