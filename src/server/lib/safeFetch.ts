/**
 * fetch() with a hard timeout via AbortController.
 *
 * Outbound HTTP without a timeout is a hang risk: a stalled connection (DNS,
 * upstream tarpit, server hold-and-wait) blocks the calling promise for the
 * lifetime of the runtime. Every place we touch a third party (GitHub, npm,
 * OpenAI, Anthropic) should fall through here so a single bad target never
 * stalls a sync indefinitely.
 *
 * `clearTimeout` runs in `finally` so the timer never leaks on either
 * success or error paths.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 15_000,
): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Bun.spawn() with a SIGTERM-then-SIGKILL escalation. Mirrors the pattern
 * used in the ccusage wrapper: send TERM at `timeoutMs`, follow with KILL
 * 3 s later in case the child ignored TERM. Returns the captured stdout,
 * stderr and exit code; never throws on timeout (the child's exit code
 * surfaces as -1 / signal-killed, callers decide what to do).
 */
export async function spawnWithTimeout(
  args: string[],
  timeoutMs = 15_000,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    stdin: 'ignore',
  });
  const term = setTimeout(() => {
    try {
      proc.kill('SIGTERM');
    } catch {
      // already exited
    }
  }, timeoutMs);
  const hardKill = setTimeout(() => {
    try {
      proc.kill('SIGKILL');
    } catch {
      // already exited
    }
  }, timeoutMs + 3_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { stdout, stderr, code: code ?? -1 };
  } finally {
    clearTimeout(term);
    clearTimeout(hardKill);
  }
}
