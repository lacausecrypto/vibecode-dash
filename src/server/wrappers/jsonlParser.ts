import { createHash } from 'node:crypto';
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
  normalizeProjects,
  normalizeRoots,
  parseTimestamp,
  runCommand,
} from './jsonlShared';

export type { KnownProject } from './jsonlShared';

export type UsageToolRow = {
  name: string;
  count: number;
};

export type UsageModelRow = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreate: number;
  cacheRead: number;
  totalTokens: number;
  messages: number;
};

export type UsageHourRow = {
  hour: number;
  tokens: number;
  messages: number;
};

export type UsageProjectRow = {
  projectKey: string;
  projectPath: string | null;
  projectId: string | null;
  projectName: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreate: number;
  cacheRead: number;
  totalTokens: number;
  assistantMessages: number;
  userMessages: number;
  messageCount: number;
  sessions: number;
  avgOutputTokens: number;
  cacheReuseRatio: number;
  lastTs: number | null;
  models: Array<{ model: string; messages: number; tokens: number }>;
  tools: UsageToolRow[];
};

export type UsageSnapshot = {
  generatedAt: number;
  fromTs: number;
  toTs: number;
  filesScanned: number;
  linesParsed: number;
  assistantMessages: number;
  userMessages: number;
  byProject: UsageProjectRow[];
  byModel: UsageModelRow[];
  hourly: UsageHourRow[];
  tools: UsageToolRow[];
};

export type UsageSnapshotOptions = {
  claudeConfigDir: string;
  projectRoots: string[];
  knownProjects: KnownProject[];
  fromTs: number;
  toTs: number;
  maxFiles?: number;
  maxTailLines?: number;
};

type CandidateFile = {
  path: string;
  mtime: number;
  projectHint: string | null;
};

type AssistantMessageRecord = {
  key: string;
  sessionId: string;
  projectKey: string;
  projectPath: string | null;
  projectId: string | null;
  projectName: string | null;
  ts: number;
  hour: number;
  model: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreate: number;
  cacheRead: number;
  tools: Set<string>;
};

type ProjectAccumulator = {
  projectKey: string;
  projectPath: string | null;
  projectId: string | null;
  projectName: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreate: number;
  cacheRead: number;
  totalTokens: number;
  assistantMessages: number;
  userMessages: number;
  messageCount: number;
  sessionKeys: Set<string>;
  lastTs: number | null;
  models: Map<string, { messages: number; tokens: number }>;
  tools: Map<string, number>;
};

type CachedSnapshot = {
  key: string;
  expiresAt: number;
  value: UsageSnapshot;
};

const CACHE_TTL_MS = 20_000;
let snapshotCache: CachedSnapshot | null = null;
let inflightSnapshot: { key: string; promise: Promise<UsageSnapshot> } | null = null;

function usageFromMessage(message: Record<string, unknown> | null): {
  inputTokens: number;
  outputTokens: number;
  cacheCreate: number;
  cacheRead: number;
} {
  const usage = asRecord(message?.usage);
  if (!usage) {
    return {
      inputTokens: 0,
      outputTokens: 0,
      cacheCreate: 0,
      cacheRead: 0,
    };
  }

  // Anthropic emits cache-creation tokens in one of two shapes depending on
  // the API version:
  //   - top-level:  usage.cache_creation_input_tokens  (sum of all TTLs)
  //   - nested:     usage.cache_creation.{ephemeral_5m,ephemeral_1h}_input_tokens
  // Prefer top-level when present (already the sum). Fall back to summing the
  // nested breakdown. If both are >0 (never observed in practice but guarded),
  // the top-level wins — it's authoritative.
  const cacheCreation = asRecord(usage.cache_creation);
  const cacheCreationNested =
    asNumber(cacheCreation?.ephemeral_5m_input_tokens) +
    asNumber(cacheCreation?.ephemeral_1h_input_tokens);

  const cacheCreateTop = asNumber(usage.cache_creation_input_tokens);

  return {
    inputTokens: asNumber(usage.input_tokens),
    outputTokens: asNumber(usage.output_tokens),
    cacheCreate: cacheCreateTop > 0 ? cacheCreateTop : cacheCreationNested,
    cacheRead: asNumber(usage.cache_read_input_tokens),
  };
}

function extractToolNames(content: unknown): Set<string> {
  const tools = new Set<string>();
  if (!Array.isArray(content)) {
    return tools;
  }

  for (const item of content) {
    const record = asRecord(item);
    if (!record) {
      continue;
    }

    if (record.type !== 'tool_use') {
      continue;
    }

    const name = asString(record.name);
    if (name && name.length > 0) {
      tools.add(name);
    }
  }

  return tools;
}

function isRealUserPrompt(message: Record<string, unknown> | null): boolean {
  if (!message) {
    return false;
  }

  const content = message.content;
  if (typeof content === 'string') {
    return content.trim().length > 0;
  }

  if (Array.isArray(content)) {
    for (const item of content) {
      const record = asRecord(item);
      if (!record) {
        continue;
      }

      if (
        record.type === 'text' &&
        typeof record.text === 'string' &&
        record.text.trim().length > 0
      ) {
        return true;
      }
    }
  }

  return false;
}

function inferProjectIdentity(
  cwd: string | null,
  projectHint: string | null,
  projects: PreparedProject[],
  roots: PreparedRoot[],
): {
  projectKey: string;
  projectPath: string | null;
  projectId: string | null;
  projectName: string | null;
} {
  if (cwd && cwd.length > 0) {
    const normalizedCwd = resolve(cwd);

    for (const project of projects) {
      if (isSubPath(normalizedCwd, project.normalizedPath)) {
        return {
          projectKey: project.path,
          projectPath: project.path,
          projectId: project.id,
          projectName: project.name,
        };
      }
    }

    for (const root of roots) {
      if (!isSubPath(normalizedCwd, root.normalized)) {
        continue;
      }

      const relative = normalizedCwd.slice(root.normalized.length).replace(/^\/+/, '');
      if (relative.length === 0) {
        return {
          projectKey: root.original,
          projectPath: root.original,
          projectId: null,
          projectName: null,
        };
      }

      const firstSegment = relative.split('/')[0];
      return {
        projectKey: `${root.original.replace(/\/$/, '')}/${firstSegment}`,
        projectPath: `${root.original.replace(/\/$/, '')}/${firstSegment}`,
        projectId: null,
        projectName: null,
      };
    }

    return {
      projectKey: normalizedCwd,
      projectPath: normalizedCwd,
      projectId: null,
      projectName: null,
    };
  }

  const fallback = projectHint || 'unknown';
  return {
    projectKey: `claude:${fallback}`,
    projectPath: null,
    projectId: null,
    projectName: null,
  };
}

async function listCandidateFiles(
  claudeConfigDir: string,
  fromTs: number,
  maxFiles: number,
): Promise<CandidateFile[]> {
  const projectsDir = resolve(expandHomePath(claudeConfigDir), 'projects');
  const commandLimit = Math.max(maxFiles * 4, maxFiles);

  const script =
    'find "$1" -mindepth 2 -maxdepth 2 -type f -name \'*.jsonl\' -exec stat -f "%m\\t%N" {} + 2>/dev/null | awk -F \'\\t\' -v min="$2" \'$1 >= min { print }\' | sort -rn | head -n "$3"';

  const result = await runCommand([
    'sh',
    '-lc',
    script,
    '_',
    projectsDir,
    String(fromTs),
    String(commandLimit),
  ]);
  if (result.code !== 0) {
    throw new Error(result.stderr.trim() || 'list_jsonl_failed');
  }

  const lines = result.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const out: CandidateFile[] = [];
  for (const line of lines) {
    const tabIndex = line.indexOf('\t');
    const escapedTabIndex = line.indexOf('\\t');
    const splitIndex = tabIndex > 0 ? tabIndex : escapedTabIndex;
    const splitSize = tabIndex > 0 ? 1 : 2;
    if (splitIndex <= 0) {
      continue;
    }

    const mtime = Number.parseInt(line.slice(0, splitIndex), 10);
    const path = line.slice(splitIndex + splitSize);
    if (!Number.isFinite(mtime) || path.length === 0) {
      continue;
    }

    const marker = '/projects/';
    const markerIndex = path.indexOf(marker);
    let projectHint: string | null = null;
    if (markerIndex >= 0) {
      const rest = path.slice(markerIndex + marker.length);
      const slash = rest.indexOf('/');
      if (slash > 0) {
        projectHint = rest.slice(0, slash);
      }
    }

    out.push({ path, mtime, projectHint });
    if (out.length >= maxFiles) {
      break;
    }
  }

  return out;
}

async function readTailLines(path: string, maxLines: number): Promise<string[]> {
  let text: string;
  try {
    text = await Bun.file(path).text();
  } catch {
    return [];
  }

  const allLines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (allLines.length <= maxLines) {
    return allLines;
  }
  return allLines.slice(-maxLines);
}

function getOrCreateProjectAccumulator(
  map: Map<string, ProjectAccumulator>,
  key: string,
  identity: {
    projectPath: string | null;
    projectId: string | null;
    projectName: string | null;
  },
): ProjectAccumulator {
  let row = map.get(key);
  if (!row) {
    row = {
      projectKey: key,
      projectPath: identity.projectPath,
      projectId: identity.projectId,
      projectName: identity.projectName,
      inputTokens: 0,
      outputTokens: 0,
      cacheCreate: 0,
      cacheRead: 0,
      totalTokens: 0,
      assistantMessages: 0,
      userMessages: 0,
      messageCount: 0,
      sessionKeys: new Set(),
      lastTs: null,
      models: new Map(),
      tools: new Map(),
    };
    map.set(key, row);
  }

  if (!row.projectPath && identity.projectPath) {
    row.projectPath = identity.projectPath;
  }
  if (!row.projectId && identity.projectId) {
    row.projectId = identity.projectId;
  }
  if (!row.projectName && identity.projectName) {
    row.projectName = identity.projectName;
  }

  return row;
}

async function buildSnapshot(options: UsageSnapshotOptions): Promise<UsageSnapshot> {
  const maxFiles = options.maxFiles || 220;
  const maxTailLines = options.maxTailLines || 1400;

  const candidateFiles = await listCandidateFiles(
    options.claudeConfigDir,
    options.fromTs,
    maxFiles,
  );
  const preparedProjects = normalizeProjects(options.knownProjects);
  const preparedRoots = normalizeRoots(options.projectRoots);

  const assistantByKey = new Map<string, AssistantMessageRecord>();
  const seenUserKeys = new Set<string>();
  const userCountByProject = new Map<string, number>();
  const userHourlyCounts = new Map<number, number>();
  const sessionKeysByProject = new Map<string, Set<string>>();
  const projectIdentityByKey = new Map<
    string,
    {
      projectPath: string | null;
      projectId: string | null;
      projectName: string | null;
    }
  >();

  let linesParsed = 0;

  for (const file of candidateFiles) {
    const lines = await readTailLines(file.path, maxTailLines);
    let lineIndex = 0;

    for (const line of lines) {
      lineIndex += 1;

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

      const ts = parseTimestamp(row.timestamp);
      if (!ts || ts < options.fromTs || ts > options.toTs) {
        continue;
      }

      linesParsed += 1;

      const message = asRecord(row.message);
      const role = asString(message?.role) || asString(row.type);
      if (role !== 'assistant' && role !== 'user') {
        continue;
      }

      const cwd = asString(row.cwd);
      const identity = inferProjectIdentity(cwd, file.projectHint, preparedProjects, preparedRoots);
      projectIdentityByKey.set(identity.projectKey, {
        projectPath: identity.projectPath,
        projectId: identity.projectId,
        projectName: identity.projectName,
      });

      if (role === 'user') {
        if (!isRealUserPrompt(message)) {
          continue;
        }

        const uuid = asString(row.uuid);
        const sessionId = asString(row.sessionId) || 'unknown-session';
        const content = typeof message?.content === 'string' ? message.content : '';
        const fallback = `${sessionId}:${ts}:${content.slice(0, 64)}:${lineIndex}`;
        const userKey = uuid || fallback;

        if (seenUserKeys.has(userKey)) {
          continue;
        }
        seenUserKeys.add(userKey);

        userCountByProject.set(
          identity.projectKey,
          (userCountByProject.get(identity.projectKey) || 0) + 1,
        );
        const hour = new Date(ts * 1000).getHours();
        userHourlyCounts.set(hour, (userHourlyCounts.get(hour) || 0) + 1);
        continue;
      }

      const usage = usageFromMessage(message);
      const model = asString(message?.model);
      const tools = extractToolNames(message?.content);
      const sessionId = asString(row.sessionId) || 'unknown-session';
      const messageId = asString(message?.id);
      const uuid = asString(row.uuid);
      const assistantKey = messageId
        ? `${sessionId}:${messageId}`
        : `${sessionId}:${uuid || `${ts}:${lineIndex}`}`;

      const existing = assistantByKey.get(assistantKey);
      if (!existing) {
        assistantByKey.set(assistantKey, {
          key: assistantKey,
          sessionId,
          projectKey: identity.projectKey,
          projectPath: identity.projectPath,
          projectId: identity.projectId,
          projectName: identity.projectName,
          ts,
          hour: new Date(ts * 1000).getHours(),
          model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheCreate: usage.cacheCreate,
          cacheRead: usage.cacheRead,
          tools,
        });
        continue;
      }

      if (ts > existing.ts) {
        existing.ts = ts;
        existing.hour = new Date(ts * 1000).getHours();
      }

      existing.inputTokens = Math.max(existing.inputTokens, usage.inputTokens);
      existing.outputTokens = Math.max(existing.outputTokens, usage.outputTokens);
      existing.cacheCreate = Math.max(existing.cacheCreate, usage.cacheCreate);
      existing.cacheRead = Math.max(existing.cacheRead, usage.cacheRead);

      if (!existing.model && model) {
        existing.model = model;
      }

      for (const tool of tools) {
        existing.tools.add(tool);
      }

      if (!existing.projectPath && identity.projectPath) {
        existing.projectPath = identity.projectPath;
      }
      if (!existing.projectId && identity.projectId) {
        existing.projectId = identity.projectId;
      }
      if (!existing.projectName && identity.projectName) {
        existing.projectName = identity.projectName;
      }
    }
  }

  const byProjectMap = new Map<string, ProjectAccumulator>();
  const byModelMap = new Map<string, UsageModelRow>();
  const toolMap = new Map<string, number>();
  const hourlyMap = new Map<number, UsageHourRow>();

  for (let hour = 0; hour < 24; hour += 1) {
    hourlyMap.set(hour, { hour, tokens: 0, messages: 0 });
  }

  for (const record of assistantByKey.values()) {
    const totalTokens =
      record.inputTokens + record.outputTokens + record.cacheCreate + record.cacheRead;

    const projectAgg = getOrCreateProjectAccumulator(byProjectMap, record.projectKey, {
      projectPath: record.projectPath,
      projectId: record.projectId,
      projectName: record.projectName,
    });

    projectAgg.inputTokens += record.inputTokens;
    projectAgg.outputTokens += record.outputTokens;
    projectAgg.cacheCreate += record.cacheCreate;
    projectAgg.cacheRead += record.cacheRead;
    projectAgg.totalTokens += totalTokens;
    projectAgg.assistantMessages += 1;
    projectAgg.messageCount += 1;
    projectAgg.sessionKeys.add(record.sessionId);
    projectAgg.lastTs = projectAgg.lastTs ? Math.max(projectAgg.lastTs, record.ts) : record.ts;

    if (record.model) {
      const modelRow = projectAgg.models.get(record.model) || { messages: 0, tokens: 0 };
      modelRow.messages += 1;
      modelRow.tokens += totalTokens;
      projectAgg.models.set(record.model, modelRow);

      const modelAgg = byModelMap.get(record.model) || {
        model: record.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreate: 0,
        cacheRead: 0,
        totalTokens: 0,
        messages: 0,
      };
      modelAgg.inputTokens += record.inputTokens;
      modelAgg.outputTokens += record.outputTokens;
      modelAgg.cacheCreate += record.cacheCreate;
      modelAgg.cacheRead += record.cacheRead;
      modelAgg.totalTokens += totalTokens;
      modelAgg.messages += 1;
      byModelMap.set(record.model, modelAgg);
    }

    for (const tool of record.tools) {
      projectAgg.tools.set(tool, (projectAgg.tools.get(tool) || 0) + 1);
      toolMap.set(tool, (toolMap.get(tool) || 0) + 1);
    }

    const hourRow = hourlyMap.get(record.hour);
    if (hourRow) {
      hourRow.messages += 1;
      hourRow.tokens += totalTokens;
    }
  }

  for (const [projectKey, userCount] of userCountByProject.entries()) {
    const identity =
      projectIdentityByKey.get(projectKey) ||
      ({ projectPath: null, projectId: null, projectName: null } as const);

    const projectAgg = getOrCreateProjectAccumulator(byProjectMap, projectKey, identity);
    projectAgg.userMessages += userCount;
    projectAgg.messageCount += userCount;
  }

  for (const [projectKey, sessionKeys] of sessionKeysByProject.entries()) {
    const identity =
      projectIdentityByKey.get(projectKey) ||
      ({ projectPath: null, projectId: null, projectName: null } as const);

    const projectAgg = getOrCreateProjectAccumulator(byProjectMap, projectKey, identity);
    for (const id of sessionKeys) {
      projectAgg.sessionKeys.add(id);
    }
  }

  for (const [hour, count] of userHourlyCounts.entries()) {
    const row = hourlyMap.get(hour);
    if (!row) {
      continue;
    }
    row.messages += count;
  }

  const byProject = [...byProjectMap.values()]
    .map((row) => {
      const models = [...row.models.entries()]
        .map(([model, stats]) => ({
          model,
          messages: stats.messages,
          tokens: stats.tokens,
        }))
        .sort((a, b) => b.tokens - a.tokens);

      const tools = [...row.tools.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

      const avgOutputTokens =
        row.assistantMessages > 0 ? row.outputTokens / row.assistantMessages : 0;
      const cacheDenominator = row.inputTokens + row.cacheRead;
      const cacheReuseRatio = cacheDenominator > 0 ? row.cacheRead / cacheDenominator : 0;

      return {
        projectKey: row.projectKey,
        projectPath: row.projectPath,
        projectId: row.projectId,
        projectName: row.projectName,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheCreate: row.cacheCreate,
        cacheRead: row.cacheRead,
        totalTokens: row.totalTokens,
        assistantMessages: row.assistantMessages,
        userMessages: row.userMessages,
        messageCount: row.messageCount,
        sessions: row.sessionKeys.size,
        avgOutputTokens,
        cacheReuseRatio,
        lastTs: row.lastTs,
        models,
        tools,
      } satisfies UsageProjectRow;
    })
    .sort((a, b) => b.totalTokens - a.totalTokens || b.messageCount - a.messageCount);

  const byModel = [...byModelMap.values()].sort((a, b) => b.totalTokens - a.totalTokens);
  const tools = [...toolMap.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const hourly = [...hourlyMap.values()].sort((a, b) => a.hour - b.hour);

  return {
    generatedAt: Math.floor(Date.now() / 1000),
    fromTs: options.fromTs,
    toTs: options.toTs,
    filesScanned: candidateFiles.length,
    linesParsed,
    assistantMessages: assistantByKey.size,
    userMessages: seenUserKeys.size,
    byProject,
    byModel,
    hourly,
    tools,
  };
}

export async function getClaudeUsageSnapshot(
  options: UsageSnapshotOptions,
): Promise<UsageSnapshot> {
  const claudeConfigDir = resolve(expandHomePath(options.claudeConfigDir));
  const projectHash = createHash('sha1')
    .update(options.knownProjects.map((project) => `${project.id}:${project.path}`).join('|'))
    .digest('hex');

  const cacheKey = JSON.stringify({
    claudeConfigDir,
    fromTs: options.fromTs,
    toTs: options.toTs,
    maxFiles: options.maxFiles || 220,
    maxTailLines: options.maxTailLines || 1400,
    projectHash,
  });

  const now = Date.now();
  if (snapshotCache && snapshotCache.key === cacheKey && snapshotCache.expiresAt > now) {
    return snapshotCache.value;
  }

  if (inflightSnapshot && inflightSnapshot.key === cacheKey) {
    return inflightSnapshot.promise;
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
      if (inflightSnapshot?.key === cacheKey) {
        inflightSnapshot = null;
      }
    });

  inflightSnapshot = { key: cacheKey, promise };
  return promise;
}

export type DailyProjectAggregate = {
  date: string;
  projectKey: string;
  projectPath: string | null;
  projectId: string | null;
  projectName: string | null;
  source: 'claude' | 'codex';
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
};

type DailyBucket = {
  date: string;
  projectKey: string;
  projectPath: string | null;
  projectId: string | null;
  projectName: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheCreate: number;
  cacheRead: number;
  messageCount: number;
  sessions: Set<string>;
  costUsd: number;
  models: Map<string, { tokens: number; messages: number }>;
  tools: Map<string, number>;
};

function dateFromTs(ts: number): string {
  return new Date(ts * 1000).toISOString().slice(0, 10);
}

export async function buildClaudeDailyByProject(options: {
  claudeConfigDir: string;
  projectRoots: string[];
  knownProjects: KnownProject[];
  fromTs: number;
  toTs: number;
  maxFiles?: number;
}): Promise<{
  rows: DailyProjectAggregate[];
  filesScanned: number;
  linesParsed: number;
}> {
  const { lookupRates } = await import('../lib/pricing');
  const maxFiles = options.maxFiles || 8000;

  const candidateFiles = await listCandidateFiles(
    options.claudeConfigDir,
    options.fromTs,
    maxFiles,
  );
  const preparedProjects = normalizeProjects(options.knownProjects);
  const preparedRoots = normalizeRoots(options.projectRoots);

  const buckets = new Map<string, DailyBucket>();
  const seenAssistantKeys = new Set<string>();
  let linesParsed = 0;

  for (const file of candidateFiles) {
    let text: string;
    try {
      text = await Bun.file(file.path).text();
    } catch {
      continue;
    }

    const lines = text.split('\n');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
      const line = lines[lineIndex].trim();
      if (!line) {
        continue;
      }
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
      const ts = parseTimestamp(row.timestamp);
      if (!ts || ts < options.fromTs || ts > options.toTs) {
        continue;
      }
      const message = asRecord(row.message);
      const role = asString(message?.role) || asString(row.type);
      if (role !== 'assistant') {
        continue;
      }

      const messageId = asString(message?.id);
      const sessionId = asString(row.sessionId) || 'unknown-session';
      const uuid = asString(row.uuid);
      const key = messageId
        ? `${sessionId}:${messageId}`
        : uuid || `${sessionId}:${ts}:${lineIndex}`;
      if (seenAssistantKeys.has(key)) {
        continue;
      }
      seenAssistantKeys.add(key);
      linesParsed += 1;

      const cwd = asString(row.cwd);
      const identity = inferProjectIdentity(cwd, file.projectHint, preparedProjects, preparedRoots);
      const usage = usageFromMessage(message);
      const model = asString(message?.model);
      const date = dateFromTs(ts);
      const bucketKey = `${date}::${identity.projectKey}`;

      let bucket = buckets.get(bucketKey);
      if (!bucket) {
        bucket = {
          date,
          projectKey: identity.projectKey,
          projectPath: identity.projectPath,
          projectId: identity.projectId,
          projectName: identity.projectName,
          inputTokens: 0,
          outputTokens: 0,
          cacheCreate: 0,
          cacheRead: 0,
          messageCount: 0,
          sessions: new Set(),
          costUsd: 0,
          models: new Map(),
          tools: new Map(),
        };
        buckets.set(bucketKey, bucket);
      }

      bucket.inputTokens += usage.inputTokens;
      bucket.outputTokens += usage.outputTokens;
      bucket.cacheCreate += usage.cacheCreate;
      bucket.cacheRead += usage.cacheRead;
      bucket.messageCount += 1;
      bucket.sessions.add(sessionId);

      const rates = lookupRates(model, 'claude');
      bucket.costUsd +=
        (usage.inputTokens * rates.input +
          usage.outputTokens * rates.output +
          usage.cacheRead * rates.cacheRead +
          usage.cacheCreate * rates.cacheWrite) /
        1_000_000;

      if (model) {
        const modelRow = bucket.models.get(model) || { tokens: 0, messages: 0 };
        modelRow.tokens +=
          usage.inputTokens + usage.outputTokens + usage.cacheRead + usage.cacheCreate;
        modelRow.messages += 1;
        bucket.models.set(model, modelRow);
      }

      for (const toolName of extractToolNames(message?.content)) {
        bucket.tools.set(toolName, (bucket.tools.get(toolName) || 0) + 1);
      }
    }
  }

  const rows: DailyProjectAggregate[] = [];
  for (const b of buckets.values()) {
    rows.push({
      date: b.date,
      projectKey: b.projectKey,
      projectPath: b.projectPath,
      projectId: b.projectId,
      projectName: b.projectName,
      source: 'claude',
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      cacheCreate: b.cacheCreate,
      cacheRead: b.cacheRead,
      totalTokens: b.inputTokens + b.outputTokens + b.cacheCreate + b.cacheRead,
      messages: b.messageCount,
      sessions: b.sessions.size,
      costUsd: b.costUsd,
      models: [...b.models.entries()]
        .map(([model, s]) => ({ model, tokens: s.tokens, messages: s.messages }))
        .sort((a, b) => b.tokens - a.tokens),
      tools: [...b.tools.entries()]
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => b.count - a.count),
    });
  }

  return { rows, filesScanned: candidateFiles.length, linesParsed };
}
