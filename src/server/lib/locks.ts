/**
 * Tiny per-key async mutex. Use to serialise concurrent operations that share
 * a logical resource — a session id for prepareSessionRun, a file path for
 * markdown appends — without blocking the whole server.
 *
 * Contract:
 *   await withLock('session:abc', async () => { …critical section… });
 * Calls with the same key queue FIFO. Different keys run in parallel.
 * Cleanup is automatic: when the queue for a key drains, the key is evicted.
 */

type Chain = {
  tail: Promise<unknown>;
  depth: number;
};

const chains = new Map<string, Chain>();

export async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const current = chains.get(key);
  const prev: Promise<unknown> = current?.tail ?? Promise.resolve();

  let release: () => void = () => {
    /* replaced below */
  };
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });

  chains.set(key, {
    tail: prev.then(() => next),
    depth: (current?.depth ?? 0) + 1,
  });

  try {
    await prev;
    return await fn();
  } finally {
    release();
    const entry = chains.get(key);
    if (entry) {
      entry.depth -= 1;
      if (entry.depth <= 0) {
        chains.delete(key);
      }
    }
  }
}

/**
 * Open-ended variant of withLock: await your turn, get a release function.
 * Use when the critical section outlives a single closure (e.g. an HTTP
 * streaming handler that returns a Response before the stream body completes).
 *
 *   const release = await acquireLock('session:abc');
 *   try { …long-running work including a ReadableStream… }
 *   finally { release(); }
 *
 * The caller MUST call release() exactly once or the queue stalls.
 */
export async function acquireLock(key: string): Promise<() => void> {
  const current = chains.get(key);
  const prev: Promise<unknown> = current?.tail ?? Promise.resolve();
  let release: () => void = () => {
    /* replaced */
  };
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  chains.set(key, {
    tail: prev.then(() => next),
    depth: (current?.depth ?? 0) + 1,
  });
  await prev;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    release();
    const entry = chains.get(key);
    if (entry) {
      entry.depth -= 1;
      if (entry.depth <= 0) {
        chains.delete(key);
      }
    }
  };
}

/** Test helper — returns the number of keys with active waiters. */
export function activeLockCount(): number {
  return chains.size;
}
