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

async function runJsonCommand(args: string[]): Promise<unknown> {
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
    throw new Error(stderrMessage || `Command failed or timed out: ${args.join(' ')}`);
  }

  try {
    return JSON.parse(stdout);
  } catch {
    throw new Error(`Invalid JSON from command: ${args.join(' ')}`);
  }
}

export async function ccusageDaily(since?: string, until?: string): Promise<CcusageDailyRow[]> {
  const args = ['npx', 'ccusage@latest', 'daily', '--json'];
  if (since) {
    args.push('--since', since);
  }
  if (until) {
    args.push('--until', until);
  }

  const data = await runJsonCommand(args);
  if (Array.isArray(data)) {
    return data as CcusageDailyRow[];
  }

  if (data && typeof data === 'object' && Array.isArray((data as { daily?: unknown[] }).daily)) {
    return (data as { daily: CcusageDailyRow[] }).daily;
  }

  return [];
}

export async function ccusageMonthly(): Promise<unknown> {
  return runJsonCommand(['npx', 'ccusage@latest', 'monthly', '--json']);
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

  const data = await runJsonCommand(args);
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
  return runJsonCommand(['npx', '@ccusage/codex@latest', 'monthly', '--json']);
}

export async function codexCcusageSession(since?: string, until?: string): Promise<unknown> {
  const args = ['npx', '@ccusage/codex@latest', 'session', '--json'];
  if (since) {
    args.push('--since', since);
  }
  if (until) {
    args.push('--until', until);
  }
  return runJsonCommand(args);
}
