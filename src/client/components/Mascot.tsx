import { useEffect, useRef, useState } from 'react';
import buildingGif from '../assets/clawd/building.gif';
import carryingGif from '../assets/clawd/carrying.gif';
import conductingGif from '../assets/clawd/conducting.gif';
import debuggerGif from '../assets/clawd/debugger.gif';
import errorGif from '../assets/clawd/error.gif';
import happyGif from '../assets/clawd/happy.gif';
import idleReadingGif from '../assets/clawd/idle-reading.gif';
import idleGif from '../assets/clawd/idle.gif';
import jugglingGif from '../assets/clawd/juggling.gif';
import notificationGif from '../assets/clawd/notification.gif';
import reactAnnoyedGif from '../assets/clawd/react-annoyed.gif';
import reactDoubleJumpGif from '../assets/clawd/react-double-jump.gif';
import sleepingGif from '../assets/clawd/sleeping.gif';
import sweepingGif from '../assets/clawd/sweeping.gif';
import thinkingGif from '../assets/clawd/thinking.gif';
import typingGif from '../assets/clawd/typing.gif';
import { type ActivityEvent, subscribeActivity } from '../lib/activityBus';
import { type QuotaSeverity, getQuotaSnapshot, subscribeQuota } from '../lib/quotaSignal';

/**
 * Tamagotchi-style mascot for the sidebar. Reacts to dashboard activity:
 *
 *   idle              no fetch in flight, no recent event
 *   idle-reading      idle for >2 min, gentle "reading" loop
 *   sleeping          idle for >10 min, dim animation
 *   thinking          GET fetch in flight (read query)
 *   typing            mutation in flight (POST/PUT/DELETE)
 *   juggling          ≥3 concurrent fetches — looks busy
 *   building          any fetch >5 s — heavy work
 *   conducting        agent endpoint in flight (orchestration metaphor)
 *   sweeping          sync/scan/rescan endpoint in flight (cleanup metaphor)
 *   carrying          asset/upload endpoint in flight (moving data)
 *   debugger          ≥2 errors in last 30 s — investigating
 *   happy             recent successful mutation (last 3.5 s)
 *   double-jump       big success (>2 s) — celebratory variant
 *   error             single recent fetch error (last 5 s)
 *   react-annoyed     429 rate-limit observed (last 8 s)
 *   notification      something happened off-page (manually triggered)
 *
 * State derivation runs on a 250 ms tick. Once we land on a non-urgent
 * state, we hold it for at least STICKY_MS so the user actually sees the
 * animation play through one cycle instead of a flash. Urgent states
 * (error, rate-limit, big-success) interrupt stickiness.
 */

type MascotState =
  | 'idle'
  | 'idle-reading'
  | 'sleeping'
  | 'thinking'
  | 'typing'
  | 'juggling'
  | 'building'
  | 'conducting'
  | 'sweeping'
  | 'carrying'
  | 'debugger'
  | 'happy'
  | 'double-jump'
  | 'error'
  | 'react-annoyed'
  | 'notification';

const SPRITES: Record<MascotState, string> = {
  idle: idleGif,
  'idle-reading': idleReadingGif,
  sleeping: sleepingGif,
  thinking: thinkingGif,
  typing: typingGif,
  juggling: jugglingGif,
  building: buildingGif,
  conducting: conductingGif,
  sweeping: sweepingGif,
  carrying: carryingGif,
  debugger: debuggerGif,
  happy: happyGif,
  'double-jump': reactDoubleJumpGif,
  error: errorGif,
  'react-annoyed': reactAnnoyedGif,
  notification: notificationGif,
};

const STATE_LABEL: Record<MascotState, string> = {
  idle: 'Clawd is chilling',
  'idle-reading': 'Clawd is reading the docs',
  sleeping: 'Clawd is napping',
  thinking: 'Fetching…',
  typing: 'Saving…',
  juggling: 'Many requests in flight',
  building: 'Heavy work in progress',
  conducting: 'Orchestrating the agent',
  sweeping: 'Sync / scan running',
  carrying: 'Moving data around',
  debugger: 'Investigating recent errors',
  happy: 'Success!',
  'double-jump': 'Big task done — celebrating',
  error: 'Something failed',
  'react-annoyed': 'Rate-limited — backing off',
  notification: 'Notification',
};

// Cooldowns (ms): how long a "reaction" state stays after an event.
const COOLDOWN = {
  happy: 3_500,
  doubleJump: 4_000,
  error: 5_000,
  rateLimit: 8_000,
  debuggerWindow: 30_000, // window in which we count errors for the debugger state
  notification: 6_000, // how long the notification sprite stays after an emit
  // How fresh a quota snapshot has to be to drive a state change. The
  // signal is published every ~60 s by MenuUsageMini; we tolerate up to
  // 5 min of staleness before ignoring (e.g. tab in background).
  quotaFreshness: 5 * 60_000,
};

const DEBUGGER_ERROR_THRESHOLD = 2; // ≥2 errors in the window → debugger state

// Idle thresholds (ms): how long without activity to demote.
const IDLE_READING_MS = 2 * 60_000;
const IDLE_SLEEPING_MS = 10 * 60_000;

// "In-flight is heavy" threshold — if ANY request stays >5 s, switch to
// building (overrides the more specific carrying/sweeping/conducting).
const HEAVY_FETCH_MS = 5_000;

// Minimum time a state stays visible once entered. Prevents the GIF from
// restarting every 250 ms tick when fetches end and start back-to-back.
// Urgent states (error, rate-limit, big-success) bypass this — see
// URGENT_STATES below.
const STICKY_MS = 800;

const URGENT_STATES: ReadonlySet<MascotState> = new Set([
  'error',
  'react-annoyed',
  'double-jump',
  'happy',
  'debugger',
]);

type PathClass = 'agent' | 'sync' | 'asset' | 'normal';

// Classify a fetch path into one of the semantic buckets the new sprites
// represent. Order matters — `/api/agent/sessions/:id/archive-to-vault`
// matches agent first (orchestration is the dominant signal even if it
// also moves data). Tokens were chosen by auditing the actual endpoints
// in src/server/routes/ — see the comment block on each branch.
function classifyPath(path: string): PathClass {
  // Agent: every /api/agent/* route — chat, exec, memories, sessions,
  // quick commands. Always orchestration regardless of method.
  if (path.startsWith('/api/agent')) return 'agent';

  // Sync/cleanup metaphor: any operation that re-derives state from a
  // source of truth. Includes the obvious /sync /scan /rescan /jobs and
  // also the obsidian/github "rebuild/reindex/refresh" verbs that mean
  // the same thing semantically.
  if (
    path.includes('/sync') ||
    path.includes('/scan') ||
    path.includes('/rescan') ||
    path.includes('/jobs') ||
    path.includes('/reindex') ||
    path.includes('/rebuild') ||
    path.includes('/refresh')
  ) {
    return 'sync';
  }

  // Carry metaphor: moving data INTO the dashboard (assets, uploads,
  // imports) or capturing OUT to the vault. /api/obsidian/capture
  // and /api/agent/.../archive-to-vault both qualify but the agent one
  // already matched above — that's intentional, agent context wins.
  if (
    path.includes('/asset') ||
    path.includes('/upload') ||
    path.includes('/import') ||
    path.includes('/capture') ||
    path.includes('/archive-to-vault')
  ) {
    return 'asset';
  }

  return 'normal';
}

type InflightEntry = {
  method: string;
  startedAt: number;
  pathClass: PathClass;
};

type RuntimeState = {
  inflight: Map<string, InflightEntry>;
  recentErrorsAt: number[]; // sliding window for the debugger state
  lastSuccessAt: number;
  lastBigSuccessAt: number;
  lastErrorAt: number;
  lastRateLimitAt: number;
  lastNotificationAt: number;
  lastEventAt: number;
  // Cached from the quotaSignal bus. We don't store the whole snapshot —
  // just the severity + when it was observed — because deriveState only
  // needs the categorical signal, not the underlying %.
  quotaSeverity: QuotaSeverity;
  quotaObservedAt: number;
};

function pruneOldErrors(rt: RuntimeState, now: number): void {
  // Keep at most COOLDOWN.debuggerWindow of error history. Pruned in-place
  // to avoid allocating a fresh array on every tick.
  const cutoff = now - COOLDOWN.debuggerWindow;
  let firstFresh = 0;
  while (firstFresh < rt.recentErrorsAt.length && rt.recentErrorsAt[firstFresh] < cutoff) {
    firstFresh += 1;
  }
  if (firstFresh > 0) rt.recentErrorsAt.splice(0, firstFresh);
}

function quotaSignalFresh(rt: RuntimeState, now: number): boolean {
  return rt.quotaObservedAt > 0 && now - rt.quotaObservedAt < COOLDOWN.quotaFreshness;
}

function deriveState(now: number, rt: RuntimeState): MascotState {
  // 1. Reactions (urgent — checked first so they always win)
  if (now - rt.lastRateLimitAt < COOLDOWN.rateLimit) return 'react-annoyed';
  if (now - rt.lastErrorAt < COOLDOWN.error) return 'error';

  // Quota signals piggyback on the same urgency bracket as rate-limits:
  // a critical quota means a 429 is imminent, no point waiting for one
  // to fire. Stale snapshots are ignored so a quota observed an hour ago
  // doesn't pin the mascot in a worried state forever.
  if (quotaSignalFresh(rt, now)) {
    if (rt.quotaSeverity === 'critical') return 'error';
    if (rt.quotaSeverity === 'warn') return 'react-annoyed';
  }

  // Multiple errors in a short window → debugger (replaces the post-error
  // cooldown after the immediate error reaction has settled). Without
  // this we'd flash error → idle → error each time.
  pruneOldErrors(rt, now);
  if (rt.recentErrorsAt.length >= DEBUGGER_ERROR_THRESHOLD) return 'debugger';

  if (now - rt.lastBigSuccessAt < COOLDOWN.doubleJump) return 'double-jump';
  if (now - rt.lastSuccessAt < COOLDOWN.happy) return 'happy';

  // Notification sits below celebratory states (so a fresh success isn't
  // hidden behind it) but above in-flight states (so the user actually
  // sees the notification sprite even if a thinking GET is happening).
  if (now - rt.lastNotificationAt < COOLDOWN.notification) return 'notification';

  // 2. In-flight. We pick the most semantically specific sprite based on
  //    the request paths in flight, with `building` (>5 s heavy) as the
  //    universal escalation when anything has been hanging too long.
  const inflightCount = rt.inflight.size;
  if (inflightCount > 0) {
    const inflightArr = [...rt.inflight.values()];
    const oldest = inflightArr.reduce((max, v) => Math.max(max, now - v.startedAt), 0);
    if (oldest > HEAVY_FETCH_MS) return 'building';

    // Path-based specificity: the new sprites add metaphor (sweeping,
    // conducting, carrying). If multiple classes are in flight, prefer
    // the one with the most semantic weight: agent > sync > asset.
    const classes = new Set(inflightArr.map((v) => v.pathClass));
    if (classes.has('agent')) return 'conducting';
    if (classes.has('sync')) return 'sweeping';
    if (classes.has('asset')) return 'carrying';

    if (inflightCount >= 3) return 'juggling';
    const anyMutation = inflightArr.some((v) => v.method !== 'GET' && v.method !== 'HEAD');
    return anyMutation ? 'typing' : 'thinking';
  }

  // 3. Idle ladder
  const sinceEvent = now - rt.lastEventAt;
  if (sinceEvent > IDLE_SLEEPING_MS) return 'sleeping';
  if (sinceEvent > IDLE_READING_MS) return 'idle-reading';
  return 'idle';
}

export function Mascot({ size = 56 }: { size?: number }) {
  const [state, setState] = useState<MascotState>('idle');
  // Tracks when we last committed a state change. Combined with STICKY_MS,
  // this prevents a 200 ms thinking → idle → thinking flap every time
  // back-to-back fetches arrive.
  const stateAtRef = useRef<{ state: MascotState; at: number }>({
    state: 'idle',
    at: Date.now(),
  });

  const rt = useRef<RuntimeState>({
    inflight: new Map(),
    recentErrorsAt: [],
    lastSuccessAt: 0,
    lastBigSuccessAt: 0,
    lastErrorAt: 0,
    lastRateLimitAt: 0,
    lastNotificationAt: 0,
    // First mount counts as activity so we don't go straight to 'sleeping'.
    lastEventAt: Date.now(),
    quotaSeverity: getQuotaSnapshot().severity,
    quotaObservedAt: getQuotaSnapshot().observedAt,
  });

  // Preload all sprites on mount so a state transition into a never-
  // -seen-before sprite (e.g. first error of the session) doesn't show a
  // brief blank/broken-image flash while the GIF downloads. Vite has
  // already fingerprinted the URLs at this point so the browser cache
  // serves them on subsequent demand.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    for (const url of Object.values(SPRITES)) {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
    }
  }, []);

  // Honour the OS-level "reduce motion" preference. We can't pause GIF
  // playback itself with CSS (only CSS animations), so the practical move
  // is to hold whatever state we land on for 30 s instead of 0.8 s — that
  // way the mascot effectively stops switching sprites except for the most
  // important transitions (urgent states still bypass stickiness).
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    const onEvent = (e: ActivityEvent) => {
      const r = rt.current;
      // Notification events shouldn't reset the idle timer — they're
      // ambient signals, not user activity. lastEventAt only ticks on
      // fetch-derived events the user is plausibly driving.
      if (e.kind !== 'notification') r.lastEventAt = e.at;
      switch (e.kind) {
        case 'fetch:start': {
          // Skip the bootstrap token-fetch and health pings — those happen
          // every few seconds and would never let the mascot relax.
          if (e.path === '/api/auth/token' || e.path === '/api/health') return;
          r.inflight.set(`${e.method}:${e.path}:${e.at}`, {
            method: e.method,
            startedAt: e.at,
            pathClass: classifyPath(e.path),
          });
          break;
        }
        case 'fetch:end': {
          for (const k of r.inflight.keys()) {
            if (k.startsWith(`${e.method}:${e.path}:`)) {
              r.inflight.delete(k);
              break;
            }
          }
          // Mutation success → happy. Long-running success (>2 s) on any
          // method → "double jump" (big-deal celebratory animation).
          if (e.ms > 2_000) {
            r.lastBigSuccessAt = e.at;
          } else if (e.method !== 'GET' && e.method !== 'HEAD') {
            r.lastSuccessAt = e.at;
          }
          break;
        }
        case 'fetch:error': {
          for (const k of r.inflight.keys()) {
            if (k.startsWith(`${e.method}:${e.path}:`)) {
              r.inflight.delete(k);
              break;
            }
          }
          r.lastErrorAt = e.at;
          r.recentErrorsAt.push(e.at);
          break;
        }
        case 'fetch:rateLimit': {
          r.lastRateLimitAt = e.at;
          break;
        }
        case 'notification': {
          r.lastNotificationAt = e.at;
          break;
        }
      }
    };
    return subscribeActivity(onEvent);
  }, []);

  // Quota subscription is independent of the activity bus — it's a
  // long-lived snapshot, not a per-event signal. The current snapshot is
  // delivered immediately on subscribe (see quotaSignal.ts) so we don't
  // wait up to 60 s for the first publish.
  useEffect(() => {
    return subscribeQuota((snapshot) => {
      rt.current.quotaSeverity = snapshot.severity;
      rt.current.quotaObservedAt = snapshot.observedAt;
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    // Reduced-motion users get a much higher stickiness so the mascot
    // effectively stops swapping sprites in idle conditions. Urgent states
    // (error / rate-limit / quota critical) still interrupt because those
    // carry information the user needs.
    const stickyMs = reducedMotion ? 30_000 : STICKY_MS;
    const tick = () => {
      if (cancelled) return;
      const now = Date.now();
      const proposed = deriveState(now, rt.current);
      const cur = stateAtRef.current;

      if (proposed !== cur.state) {
        const isInterruptible = URGENT_STATES.has(proposed) || now - cur.at >= stickyMs;
        if (isInterruptible) {
          stateAtRef.current = { state: proposed, at: now };
          setState(proposed);
        }
      }
    };
    tick();
    const id = setInterval(tick, 250);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [reducedMotion]);

  // `key={state}` forces React to unmount the previous img and mount a
  // fresh one when the state changes. That replays the CSS keyframe
  // animation declared in globals.css (.mascot-img → mascot-fade-in),
  // giving a soft fade between sprites instead of a hard swap. We skip
  // the class entirely under reduced-motion so the fade keyframe doesn't
  // even register.
  return (
    <img
      key={state}
      className={reducedMotion ? undefined : 'mascot-img'}
      src={SPRITES[state]}
      alt={STATE_LABEL[state]}
      title={STATE_LABEL[state]}
      style={{
        display: 'block',
        imageRendering: 'pixelated',
        maxWidth: size,
        maxHeight: size,
        width: 'auto',
        height: 'auto',
      }}
      draggable={false}
    />
  );
}

// Subscribes to the OS-level reduced-motion preference. Returns the
// current value and re-renders if it changes (rare, but a user may
// toggle the setting mid-session). Module-level so it can be reused if
// other components want it later.
function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  });
  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) return;
    const mql = window.matchMedia('(prefers-reduced-motion: reduce)');
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    // addEventListener is the modern API; older Safari only had
    // `addListener`. We assume the modern variant — Bun + Vite target
    // browsers where addEventListener on MediaQueryList is universal.
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);
  return reduced;
}
