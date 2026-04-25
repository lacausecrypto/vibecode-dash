export type CcusageDailyRow = {
  date?: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
  totalCost?: number;
  [key: string]: unknown;
};

export type CodexCcusageDailyRow = {
  date?: string;
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  costUSD?: number;
  models?: Record<string, unknown>;
  [key: string]: unknown;
};

/**
 * Hard cap on concurrent `npx ccusage` (or codex-ccusage) processes. Each
 * one opens ~20 k FDs (every Claude JSONL session file) — without this cap,
 * three or four parallel callers will saturate `kern.maxfiles` (122 880 on
 * macOS) and trigger `ENFILE: posix_spawn '/bin/sh'` cascading errors.
 *
 * 2 concurrent is a safe ceiling: enough to overlap a daily call with a
 * blocks call, far below the FD ceiling.
 */
const MAX_CONCURRENT_CCUSAGE = 2;
let activeCcusageSpawns = 0;
const ccusageQueue: Array<() => void> = [];

function acquireCcusageSlot(): Promise<() => void> {
  if (activeCcusageSpawns < MAX_CONCURRENT_CCUSAGE) {
    activeCcusageSpawns += 1;
    return Promise.resolve(releaseSlot);
  }
  return new Promise<() => void>((resolve) => {
    ccusageQueue.push(() => {
      activeCcusageSpawns += 1;
      resolve(releaseSlot);
    });
  });
}

function releaseSlot(): void {
  activeCcusageSpawns -= 1;
  const next = ccusageQueue.shift();
  if (next) next();
}

async function runJsonCommand(args: string[]): Promise<unknown> {
  const release = await acquireCcusageSlot();
  try {
    const timeoutMs = 45_000;
    const proc = Bun.spawn(args, {
      stdout: 'pipe',
      stderr: 'pipe',
      stdin: 'ignore',
    });

    const timeout = setTimeout(() => {
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore kill failures
      }
    }, timeoutMs);

    const hardKill = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore kill failures
      }
    }, timeoutMs + 3_000);

    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timeout);
    clearTimeout(hardKill);

    if (code !== 0) {
      const stderrMessage = stderr.trim();
      console.warn(
        `[ccusage] exit=${code} cmd=${args.join(' ')}\n  stderr=${stderrMessage.slice(0, 500)}\n  stdout=${stdout.slice(0, 200)}`,
      );
      throw new Error(stderrMessage || `Command failed or timed out: ${args.join(' ')}`);
    }

    try {
      return JSON.parse(stdout);
    } catch {
      throw new Error(`Invalid JSON from command: ${args.join(' ')}`);
    }
  } finally {
    release();
  }
}

/**
 * Keyed cache + in-flight dedup wrapper around runJsonCommand.
 *
 * Why every ccusage helper goes through this:
 *   - same arg-list returns same data within `ttlMs` → no need to spawn
 *   - concurrent callers share one promise → never more than 1 spawn per key
 *   - failures aren't cached (next call retries)
 *
 * Cache key is the joined arg list: `daily --since 20260101` and
 * `daily --since 20260102` are different keys, as expected.
 */
type CacheEntry = { at: number; value: unknown };
const ccCache = new Map<string, CacheEntry>();
const ccInflight = new Map<string, Promise<unknown>>();

async function cachedJsonCommand(args: string[], ttlMs: number): Promise<unknown> {
  const key = args.join('\0');
  const now = Date.now();
  const hit = ccCache.get(key);
  if (hit && now - hit.at < ttlMs) {
    return hit.value;
  }
  const ongoing = ccInflight.get(key);
  if (ongoing) return ongoing;

  const promise = runJsonCommand(args)
    .then((value) => {
      ccCache.set(key, { at: Date.now(), value });
      return value;
    })
    .finally(() => {
      ccInflight.delete(key);
    });
  ccInflight.set(key, promise);
  return promise;
}

// TTLs chosen so the cached value is "fresh enough" without re-spawning:
//   - daily/session: 60 s — covers UI auto-refresh + dashboard reload
//   - monthly: 5 min — month-level data barely moves intraday
const CCUSAGE_DAILY_TTL_MS = 60_000;
const CCUSAGE_MONTHLY_TTL_MS = 5 * 60_000;

export async function ccusageDaily(since?: string, until?: string): Promise<CcusageDailyRow[]> {
  const args = ['npx', 'ccusage@latest', 'daily', '--json'];
  if (since) {
    args.push('--since', since);
  }
  if (until) {
    args.push('--until', until);
  }

  const data = await cachedJsonCommand(args, CCUSAGE_DAILY_TTL_MS);
  if (Array.isArray(data)) {
    return data as CcusageDailyRow[];
  }

  if (data && typeof data === 'object' && Array.isArray((data as { daily?: unknown[] }).daily)) {
    return (data as { daily: CcusageDailyRow[] }).daily;
  }

  return [];
}

export async function ccusageMonthly(): Promise<unknown> {
  return cachedJsonCommand(['npx', 'ccusage@latest', 'monthly', '--json'], CCUSAGE_MONTHLY_TTL_MS);
}

export async function codexCcusageDaily(
  since?: string,
  until?: string,
): Promise<CodexCcusageDailyRow[]> {
  const args = ['npx', '@ccusage/codex@latest', 'daily', '--json'];
  if (since) {
    args.push('--since', since);
  }
  if (until) {
    args.push('--until', until);
  }

  const data = await cachedJsonCommand(args, CCUSAGE_DAILY_TTL_MS);
  if (Array.isArray(data)) {
    return data as CodexCcusageDailyRow[];
  }

  if (data && typeof data === 'object') {
    const daily = (data as { daily?: unknown[] }).daily;
    if (Array.isArray(daily)) {
      return daily as CodexCcusageDailyRow[];
    }
  }

  return [];
}

export async function codexCcusageMonthly(): Promise<unknown> {
  return cachedJsonCommand(
    ['npx', '@ccusage/codex@latest', 'monthly', '--json'],
    CCUSAGE_MONTHLY_TTL_MS,
  );
}

export async function codexCcusageSession(since?: string, until?: string): Promise<unknown> {
  const args = ['npx', '@ccusage/codex@latest', 'session', '--json'];
  if (since) {
    args.push('--since', since);
  }
  if (until) {
    args.push('--until', until);
  }
  return cachedJsonCommand(args, CCUSAGE_DAILY_TTL_MS);
}
