import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { expandHomePath } from '../config';
import {
  type KnownProject,
  type PreparedProject,
  type PreparedRoot,
  asNumber,
  asRecord,
  asString,
  isSubPath,
  listRecentJsonlFiles,
  normalizeProjects,
  normalizeRoots,
  parseTimestamp,
} from './jsonlShared';

export type { KnownProject } from './jsonlShared';

export type CodexToolRow = {
  name: string;
  count: number;
};

export type CodexModelRow = {
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  turns: number;
};

export type CodexHourRow = {
  hour: number;
  tokens: number;
  turns: number;
};

export type CodexProjectRow = {
  projectKey: string;
  projectPath: string | null;
  projectId: string | null;
  projectName: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  turns: number;
  sessions: number;
  cacheHitRatio: number;
  lastTs: number | null;
  models: Array<{ model: string; turns: number; tokens: number }>;
  tools: CodexToolRow[];
};

export type CodexRateLimitsRow = {
  primary: { usedPercent: number; windowMinutes: number; resetsAt: number } | null;
  secondary: { usedPercent: number; windowMinutes: number; resetsAt: number } | null;
  planType: string | null;
  observedAt: number;
};

export type CodexUsageSnapshot = {
  generatedAt: number;
  fromTs: number;
  toTs: number;
  filesScanned: number;
  linesParsed: number;
  turns: number;
  sessions: number;
  byProject: CodexProjectRow[];
  byModel: CodexModelRow[];
  hourly: CodexHourRow[];
  tools: CodexToolRow[];
  rateLimits: CodexRateLimitsRow | null;
};

export type CodexUsageSnapshotOptions = {
  sessionsDir?: string;
  projectRoots: string[];
  knownProjects: KnownProject[];
  fromTs: number;
  toTs: number;
  maxFiles?: number;
};

type CandidateFile = {
  path: string;
  mtime: number;
};

type ProjectAccumulator = {
  projectKey: string;
  projectPath: string | null;
  projectId: string | null;
  projectName: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
  turns: number;
  sessionKeys: Set<string>;
  lastTs: number | null;
  models: Map<string, { turns: number; tokens: number }>;
  tools: Map<string, number>;
};

type TurnRecord = {
  sessionId: string;
  projectKey: string;
  projectPath: string | null;
  projectId: string | null;
  projectName: string | null;
  ts: number;
  hour: number;
  model: string | null;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
};

type ToolEvent = {
  projectKey: string;
  projectPath: string | null;
  projectId: string | null;
  projectName: string | null;
  name: string;
};

const CACHE_TTL_MS = 20_000;
let snapshotCache: { key: string; expiresAt: number; value: CodexUsageSnapshot } | null = null;
let inflight: { key: string; promise: Promise<CodexUsageSnapshot> } | null = null;

function defaultSessionsDir(): string {
  return resolve(homedir(), '.codex', 'sessions');
}

function inferProjectIdentity(
  cwd: string | null,
  projects: PreparedProject[],
  roots: PreparedRoot[],
): {
  projectKey: string;
  projectPath: string | null;
  projectId: string | null;
  projectName: string | null;
} {
  if (!cwd || cwd.length === 0) {
    return {
      projectKey: 'codex:unknown',
      projectPath: null,
      projectId: null,
      projectName: null,
    };
  }

  const normalized = resolve(cwd);

  for (const project of projects) {
    if (isSubPath(normalized, project.normalizedPath)) {
      return {
        projectKey: project.path,
        projectPath: project.path,
        projectId: project.id,
        projectName: project.name,
      };
    }
  }

  for (const root of roots) {
    if (!isSubPath(normalized, root.normalized)) {
      continue;
    }
    const rel = normalized.slice(root.normalized.length).replace(/^\/+/, '');
    if (rel.length === 0) {
      return {
        projectKey: root.original,
        projectPath: root.original,
        projectId: null,
        projectName: null,
      };
    }
    const first = rel.split('/')[0];
    const combined = `${root.original.replace(/\/$/, '')}/${first}`;
    return {
      projectKey: combined,
      projectPath: combined,
      projectId: null,
      projectName: null,
    };
  }

  return {
    projectKey: normalized,
    projectPath: normalized,
    projectId: null,
    projectName: null,
  };
}

async function listCandidateFiles(
  sessionsDir: string,
  fromTs: number,
  maxFiles: number,
): Promise<CandidateFile[]> {
  return listRecentJsonlFiles(sessionsDir, {
    fromTs,
    maxFiles,
    minDepth: 1,
  });
}

async function readLines(path: string): Promise<string[]> {
  try {
    const text = await Bun.file(path).text();
    return text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function emptyProjectAccumulator(
  key: string,
  identity: {
    projectPath: string | null;
    projectId: string | null;
    projectName: string | null;
  },
): ProjectAccumulator {
  return {
    projectKey: key,
    projectPath: identity.projectPath,
    projectId: identity.projectId,
    projectName: identity.projectName,
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningOutputTokens: 0,
    totalTokens: 0,
    turns: 0,
    sessionKeys: new Set(),
    lastTs: null,
    models: new Map(),
    tools: new Map(),
  };
}

async function buildSnapshot(options: CodexUsageSnapshotOptions): Promise<CodexUsageSnapshot> {
  const sessionsDir = resolve(expandHomePath(options.sessionsDir || defaultSessionsDir()));
  const maxFiles = options.maxFiles || 200;

  const candidateFiles = await listCandidateFiles(sessionsDir, options.fromTs, maxFiles);
  const preparedProjects = normalizeProjects(options.knownProjects);
  const preparedRoots = normalizeRoots(options.projectRoots);

  const turns: TurnRecord[] = [];
  const toolEvents: ToolEvent[] = [];
  const globalToolCounts = new Map<string, number>();
  const sessionIds = new Set<string>();
  let linesParsed = 0;
  let latestRateLimits: CodexRateLimitsRow | null = null;

  for (const file of candidateFiles) {
    const lines = await readLines(file.path);

    let sessionId = file.path;
    let sessionCwd: string | null = null;
    let currentCwd: string | null = null;
    let currentModel: string | null = null;

    for (const line of lines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }

      const row = asRecord(parsed);
      if (!row) {
        continue;
      }

      linesParsed += 1;

      const type = asString(row.type);
      const payload = asRecord(row.payload);
      const ts = parseTimestamp(row.timestamp);

      if (type === 'session_meta' && payload) {
        sessionId = asString(payload.id) || sessionId;
        sessionCwd = asString(payload.cwd);
        currentCwd = currentCwd || sessionCwd;
        sessionIds.add(sessionId);
        continue;
      }

      if (type === 'turn_context' && payload) {
        const cwd = asString(payload.cwd);
        if (cwd) {
          currentCwd = cwd;
        }
        const model = asString(payload.model);
        if (model) {
          currentModel = model;
        }
        continue;
      }

      if (type === 'response_item' && payload) {
        const payloadType = asString(payload.type);
        if (payloadType === 'function_call') {
          const name = asString(payload.name);
          if (name) {
            globalToolCounts.set(name, (globalToolCounts.get(name) || 0) + 1);
            const identity = inferProjectIdentity(currentCwd, preparedProjects, preparedRoots);
            toolEvents.push({
              projectKey: identity.projectKey,
              projectPath: identity.projectPath,
              projectId: identity.projectId,
              projectName: identity.projectName,
              name,
            });
          }
        }
        continue;
      }

      if (type !== 'event_msg' || !payload) {
        continue;
      }

      const payloadType = asString(payload.type);
      if (payloadType !== 'token_count') {
        continue;
      }

      const rateLimits = asRecord(payload.rate_limits);
      if (rateLimits && ts) {
        const primary = asRecord(rateLimits.primary);
        const secondary = asRecord(rateLimits.secondary);
        const candidate: CodexRateLimitsRow = {
          primary: primary
            ? {
                usedPercent: asNumber(primary.used_percent),
                windowMinutes: asNumber(primary.window_minutes),
                resetsAt: asNumber(primary.resets_at),
              }
            : null,
          secondary: secondary
            ? {
                usedPercent: asNumber(secondary.used_percent),
                windowMinutes: asNumber(secondary.window_minutes),
                resetsAt: asNumber(secondary.resets_at),
              }
            : null,
          planType: asString(rateLimits.plan_type),
          observedAt: ts,
        };
        if (!latestRateLimits || candidate.observedAt > latestRateLimits.observedAt) {
          latestRateLimits = candidate;
        }
      }

      const info = asRecord(payload.info);
      if (!info || !ts || ts < options.fromTs || ts > options.toTs) {
        continue;
      }

      const last = asRecord(info.last_token_usage);
      if (!last) {
        continue;
      }

      const identity = inferProjectIdentity(currentCwd, preparedProjects, preparedRoots);

      turns.push({
        sessionId,
        projectKey: identity.projectKey,
        projectPath: identity.projectPath,
        projectId: identity.projectId,
        projectName: identity.projectName,
        ts,
        hour: new Date(ts * 1000).getHours(),
        model: currentModel,
        inputTokens: asNumber(last.input_tokens),
        cachedInputTokens: asNumber(last.cached_input_tokens),
        outputTokens: asNumber(last.output_tokens),
        reasoningOutputTokens: asNumber(last.reasoning_output_tokens),
        totalTokens: asNumber(last.total_tokens),
      });
    }
  }

  const projectMap = new Map<string, ProjectAccumulator>();
  const modelMap = new Map<string, CodexModelRow>();
  const hourMap = new Map<number, CodexHourRow>();
  for (let hour = 0; hour < 24; hour += 1) {
    hourMap.set(hour, { hour, tokens: 0, turns: 0 });
  }

  for (const turn of turns) {
    const project =
      projectMap.get(turn.projectKey) ||
      emptyProjectAccumulator(turn.projectKey, {
        projectPath: turn.projectPath,
        projectId: turn.projectId,
        projectName: turn.projectName,
      });

    project.inputTokens += turn.inputTokens;
    project.cachedInputTokens += turn.cachedInputTokens;
    project.outputTokens += turn.outputTokens;
    project.reasoningOutputTokens += turn.reasoningOutputTokens;
    project.totalTokens += turn.totalTokens;
    project.turns += 1;
    project.sessionKeys.add(turn.sessionId);
    project.lastTs = project.lastTs ? Math.max(project.lastTs, turn.ts) : turn.ts;
    if (turn.model) {
      const row = project.models.get(turn.model) || { turns: 0, tokens: 0 };
      row.turns += 1;
      row.tokens += turn.totalTokens;
      project.models.set(turn.model, row);
    }
    projectMap.set(turn.projectKey, project);

    if (turn.model) {
      const row = modelMap.get(turn.model) || {
        model: turn.model,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        totalTokens: 0,
        turns: 0,
      };
      row.inputTokens += turn.inputTokens;
      row.cachedInputTokens += turn.cachedInputTokens;
      row.outputTokens += turn.outputTokens;
      row.reasoningOutputTokens += turn.reasoningOutputTokens;
      row.totalTokens += turn.totalTokens;
      row.turns += 1;
      modelMap.set(turn.model, row);
    }

    const hourRow = hourMap.get(turn.hour);
    if (hourRow) {
      hourRow.tokens += turn.totalTokens;
      hourRow.turns += 1;
    }
  }

  for (const event of toolEvents) {
    const project =
      projectMap.get(event.projectKey) ||
      emptyProjectAccumulator(event.projectKey, {
        projectPath: event.projectPath,
        projectId: event.projectId,
        projectName: event.projectName,
      });
    project.tools.set(event.name, (project.tools.get(event.name) || 0) + 1);
    projectMap.set(event.projectKey, project);
  }

  const byProject: CodexProjectRow[] = [...projectMap.values()]
    .map((project) => ({
      projectKey: project.projectKey,
      projectPath: project.projectPath,
      projectId: project.projectId,
      projectName: project.projectName,
      inputTokens: project.inputTokens,
      cachedInputTokens: project.cachedInputTokens,
      outputTokens: project.outputTokens,
      reasoningOutputTokens: project.reasoningOutputTokens,
      totalTokens: project.totalTokens,
      turns: project.turns,
      sessions: project.sessionKeys.size,
      cacheHitRatio: project.inputTokens > 0 ? project.cachedInputTokens / project.inputTokens : 0,
      lastTs: project.lastTs,
      models: [...project.models.entries()]
        .map(([model, stats]) => ({ model, turns: stats.turns, tokens: stats.tokens }))
        .sort((a, b) => b.tokens - a.tokens),
      tools: [...project.tools.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
    }))
    .sort((a, b) => b.totalTokens - a.totalTokens || b.turns - a.turns);

  const byModel = [...modelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  const hourly = [...hourMap.values()].sort((a, b) => a.hour - b.hour);
  const tools: CodexToolRow[] = [...globalToolCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  return {
    generatedAt: Math.floor(Date.now() / 1000),
    fromTs: options.fromTs,
    toTs: options.toTs,
    filesScanned: candidateFiles.length,
    linesParsed,
    turns: turns.length,
    sessions: sessionIds.size,
    byProject,
    byModel,
    hourly,
    tools,
    rateLimits: latestRateLimits,
  };
}

export async function getCodexUsageSnapshot(
  options: CodexUsageSnapshotOptions,
): Promise<CodexUsageSnapshot> {
  const projectHash = createHash('sha1')
    .update(options.knownProjects.map((project) => `${project.id}:${project.path}`).join('|'))
    .digest('hex');

  const cacheKey = JSON.stringify({
    sessionsDir: options.sessionsDir || defaultSessionsDir(),
    fromTs: options.fromTs,
    toTs: options.toTs,
    maxFiles: options.maxFiles || 200,
    projectHash,
  });

  const now = Date.now();
  if (snapshotCache && snapshotCache.key === cacheKey && snapshotCache.expiresAt > now) {
    return snapshotCache.value;
  }

  if (inflight && inflight.key === cacheKey) {
    return inflight.promise;
  }

  const promise = buildSnapshot(options)
    .then((snapshot) => {
      snapshotCache = {
        key: cacheKey,
        expiresAt: Date.now() + CACHE_TTL_MS,
        value: snapshot,
      };
      return snapshot;
    })
    .finally(() => {
      if (inflight?.key === cacheKey) {
        inflight = null;
      }
    });

  inflight = { key: cacheKey, promise };
  return promise;
}

export async function buildCodexDailyByProject(options: {
  sessionsDir?: string;
  projectRoots: string[];
  knownProjects: KnownProject[];
  fromTs: number;
  toTs: number;
  maxFiles?: number;
}): Promise<{
  rows: Array<{
    date: string;
    projectKey: string;
    projectPath: string | null;
    projectId: string | null;
    projectName: string | null;
    source: 'codex';
    inputTokens: number;
    outputTokens: number;
    cacheCreate: number;
    cacheRead: number;
    totalTokens: number;
    messages: number;
    sessions: number;
    costUsd: number;
    models: Array<{ model: string; tokens: number; messages: number }>;
    tools: Array<{ name: string; count: number }>;
  }>;
  filesScanned: number;
  linesParsed: number;
}> {
  const { lookupRates } = await import('../lib/pricing');
  const sessionsDir = resolve(expandHomePath(options.sessionsDir || defaultSessionsDir()));
  const maxFiles = options.maxFiles || 4000;

  const candidateFiles = await listCandidateFiles(sessionsDir, options.fromTs, maxFiles);
  const preparedProjects = normalizeProjects(options.knownProjects);
  const preparedRoots = normalizeRoots(options.projectRoots);

  type Bucket = {
    date: string;
    projectKey: string;
    projectPath: string | null;
    projectId: string | null;
    projectName: string | null;
    inputNet: number;
    cached: number;
    output: number;
    reasoning: number;
    messages: number;
    sessions: Set<string>;
    costUsd: number;
    models: Map<string, { tokens: number; messages: number }>;
    tools: Map<string, number>;
  };
  const buckets = new Map<string, Bucket>();
  let linesParsed = 0;

  for (const file of candidateFiles) {
    let text: string;
    try {
      text = await Bun.file(file.path).text();
    } catch {
      continue;
    }

    let sessionId = file.path;
    let currentCwd: string | null = null;
    let currentModel: string | null = null;

    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed) {
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(trimmed);
      } catch {
        continue;
      }
      const row = asRecord(parsed);
      if (!row) {
        continue;
      }
      linesParsed += 1;

      const type = asString(row.type);
      const payload = asRecord(row.payload);
      const ts = parseTimestamp(row.timestamp);

      if (type === 'session_meta' && payload) {
        sessionId = asString(payload.id) || sessionId;
        currentCwd = asString(payload.cwd) || currentCwd;
        continue;
      }
      if (type === 'turn_context' && payload) {
        const cwd = asString(payload.cwd);
        if (cwd) {
          currentCwd = cwd;
        }
        const model = asString(payload.model);
        if (model) {
          currentModel = model;
        }
        continue;
      }
      if (type === 'response_item' && payload && asString(payload.type) === 'function_call') {
        const name = asString(payload.name);
        if (!name || !ts || ts < options.fromTs || ts > options.toTs) {
          continue;
        }
        const date = new Date(ts * 1000).toISOString().slice(0, 10);
        const identity = inferProjectIdentity(currentCwd, preparedProjects, preparedRoots);
        const bucketKey = `${date}::${identity.projectKey}`;
        const bucket = buckets.get(bucketKey);
        if (bucket) {
          bucket.tools.set(name, (bucket.tools.get(name) || 0) + 1);
        }
        continue;
      }
      if (type !== 'event_msg' || !payload) {
        continue;
      }
      if (asString(payload.type) !== 'token_count') {
        continue;
      }
      if (!ts || ts < options.fromTs || ts > options.toTs) {
        continue;
      }
      const info = asRecord(payload.info);
      const last = asRecord(info?.last_token_usage);
      if (!last) {
        continue;
      }

      const inputRaw = asNumber(last.input_tokens);
      const cached = asNumber(last.cached_input_tokens);
      const output = asNumber(last.output_tokens);
      const reasoning = asNumber(last.reasoning_output_tokens);
      const inputNet = Math.max(0, inputRaw - cached);
      const identity = inferProjectIdentity(currentCwd, preparedProjects, preparedRoots);
      const date = new Date(ts * 1000).toISOString().slice(0, 10);
      const bucketKey = `${date}::${identity.projectKey}`;

      let bucket = buckets.get(bucketKey);
      if (!bucket) {
        bucket = {
          date,
          projectKey: identity.projectKey,
          projectPath: identity.projectPath,
          projectId: identity.projectId,
          projectName: identity.projectName,
          inputNet: 0,
          cached: 0,
          output: 0,
          reasoning: 0,
          messages: 0,
          sessions: new Set(),
          costUsd: 0,
          models: new Map(),
          tools: new Map(),
        };
        buckets.set(bucketKey, bucket);
      }

      bucket.inputNet += inputNet;
      bucket.cached += cached;
      bucket.output += output;
      bucket.reasoning += reasoning;
      bucket.messages += 1;
      bucket.sessions.add(sessionId);

      const rates = lookupRates(currentModel, 'codex');
      const effectiveOutput = output + reasoning;
      bucket.costUsd +=
        (inputNet * rates.input + effectiveOutput * rates.output + cached * rates.cacheRead) /
        1_000_000;

      if (currentModel) {
        const m = bucket.models.get(currentModel) || { tokens: 0, messages: 0 };
        m.tokens += inputNet + effectiveOutput + cached;
        m.messages += 1;
        bucket.models.set(currentModel, m);
      }
    }
  }

  const rows = [...buckets.values()].map((b) => ({
    date: b.date,
    projectKey: b.projectKey,
    projectPath: b.projectPath,
    projectId: b.projectId,
    projectName: b.projectName,
    source: 'codex' as const,
    inputTokens: b.inputNet,
    outputTokens: b.output + b.reasoning,
    cacheCreate: 0,
    cacheRead: b.cached,
    totalTokens: b.inputNet + b.output + b.reasoning + b.cached,
    messages: b.messages,
    sessions: b.sessions.size,
    costUsd: b.costUsd,
    models: [...b.models.entries()]
      .map(([model, s]) => ({ model, tokens: s.tokens, messages: s.messages }))
      .sort((a, c) => c.tokens - a.tokens),
    tools: [...b.tools.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, c) => c.count - a.count),
  }));

  return { rows, filesScanned: candidateFiles.length, linesParsed };
}
