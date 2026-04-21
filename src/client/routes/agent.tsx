import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Markdown } from '../components/Markdown';
import { Button, Card, Chip, Empty, FieldLabel, Section, Segmented } from '../components/ui';
import { DEFAULT_MODEL, MODEL_CATALOG, type ProviderId } from '../lib/agentModels';
import {
  type AgentMode,
  getAgentMode,
  getAgentModeList,
  getStarterPrompts,
} from '../lib/agentModes';
import { apiDelete, apiGet, apiPost, getApiAuthHeader } from '../lib/api';
import { type Locale, dateLocale, useTranslation } from '../lib/i18n';

type Translator = (key: string, vars?: Record<string, string | number>) => string;

type ProviderInfo = {
  id: 'claude' | 'codex';
  command: string;
};

type ProvidersResponse = {
  mode: 'cli';
  providers: ProviderInfo[];
};

type ProjectSummary = {
  id: string;
  path: string;
  name: string;
};

type SessionContext = {
  provider: 'claude' | 'codex';
  cwd: string;
  model?: string;
};

type SessionSummary = {
  id: string;
  created_at: number;
  updated_at: number;
  model: string | null;
  title: string | null;
  context_json: string | null;
  context: SessionContext | null;
  archived: number;
  message_count: number;
  last_message: string | null;
  total_tokens?: number;
};

type AgentMessage = {
  id: string;
  session_id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls_json: string | null;
  ts: number;
};

type SessionDetail = {
  session: SessionSummary;
  messages: AgentMessage[];
};

type AgentExecResult = {
  ok: boolean;
  provider: 'claude' | 'codex';
  command: string[];
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
};

type SessionSendResponse = {
  ok: boolean;
  sessionId: string;
  result: AgentExecResult;
  injectedMemories?: string[];
  extractedMemories?: number;
};

type PersonaSnapshot = {
  identity: string | null;
  values: string | null;
  path: string | null;
};

type VaultMatch = {
  path: string;
  title: string;
  snippet: string;
  score: number;
};

type MemoryRow = {
  id: string;
  scope: string;
  key: string;
  content: string;
  source: 'manual' | 'auto' | 'persona';
  created_at: number;
  updated_at: number;
  related_project_id: string | null;
  related_session_id: string | null;
  tags_json: string | null;
  pinned: number;
};

type ContextSnapshot = {
  persona: PersonaSnapshot;
  projectId: string | null;
  projectName: string | null;
  projectPath: string | null;
  memories: {
    global: MemoryRow[];
    project: MemoryRow[];
    session: MemoryRow[];
  };
  vaultMatches: VaultMatch[];
  tokensEstimate: number;
  queryFallback?: 'prompt' | 'last_user' | 'session_title' | 'none';
  queryPreview?: string;
};

function toDateTime(ts: number, locale: Locale): string {
  return new Date(ts * 1000).toLocaleString(dateLocale(locale));
}

function relativeTime(ts: number, t: Translator): string {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) {
    return t('agent.relative.secondsAgo', { n: diff });
  }
  if (diff < 3600) {
    return t('agent.relative.minutesAgo', { n: Math.floor(diff / 60) });
  }
  if (diff < 86400) {
    return t('agent.relative.hoursAgo', { n: Math.floor(diff / 3600) });
  }
  return t('agent.relative.daysAgo', { n: Math.floor(diff / 86400) });
}

function trimForPreview(value: string, max = 140): string {
  const clean = value.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) {
    return clean;
  }
  return `${clean.slice(0, max)}…`;
}

function parseToolMeta(raw: string | null): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

type UserInjectionMeta = {
  personaLoaded: boolean;
  projectId: string | null;
  projectName: string | null;
  memoriesGlobal: number;
  memoriesProject: number;
  memoriesSession: number;
  vaultMatches: Array<{ path: string; title: string }>;
  tokensEstimate: number;
};

type AssistantMeta = {
  provider?: 'claude' | 'codex';
  model?: string | null;
  durationMs?: number;
  costUsd?: number | null;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreateTokens: number;
    cacheReadTokens: number;
    reasoningTokens?: number;
  } | null;
  summaryUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreateTokens: number;
    cacheReadTokens: number;
  } | null;
  memoryPassUsage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreateTokens: number;
    cacheReadTokens: number;
  } | null;
  activities?: unknown[] | null;
  remoteSessionId?: string | null;
  ok?: boolean;
  timedOut?: boolean;
};

function parseInjection(meta: Record<string, unknown> | null): UserInjectionMeta | null {
  if (!meta || typeof meta !== 'object') {
    return null;
  }
  const context = (meta as { context?: unknown }).context;
  if (!context || typeof context !== 'object') {
    return null;
  }
  return context as UserInjectionMeta;
}

function parseAssistantMeta(meta: Record<string, unknown> | null): AssistantMeta | null {
  if (!meta || typeof meta !== 'object') {
    return null;
  }
  if ('context' in meta) {
    return null;
  }
  return meta as AssistantMeta;
}

function formatCost(usd: number | null | undefined): string | null {
  if (!usd || usd <= 0) {
    return null;
  }
  if (usd < 0.01) {
    return `$${(usd * 1000).toFixed(2)}m`; // mille-cents
  }
  return `$${usd.toFixed(3)}`;
}

function formatDuration(ms: number | undefined): string {
  if (!ms || ms < 1000) {
    return `${ms || 0} ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)} s`;
  }
  return `${(ms / 60_000).toFixed(1)} min`;
}

function numberLabel(value: number, locale: Locale): string {
  return new Intl.NumberFormat(dateLocale(locale)).format(Math.round(value));
}

type StreamPhase =
  | 'idle'
  | 'preparing'
  | 'connecting'
  | 'session'
  | 'waiting'
  | 'receiving'
  | 'finalizing'
  | 'memory_pass';

type ActivityItem =
  | { kind: 'thinking'; id: string; ts: number; text: string }
  | {
      kind: 'subagent';
      id: string;
      ts: number;
      parentToolUseId: string;
      text: string;
    }
  | {
      kind: 'task';
      id: string;
      ts: number;
      taskId: string;
      toolUseId: string;
      description: string;
    }
  | {
      kind: 'tool';
      id: string;
      ts: number;
      toolUseId: string;
      name: string;
      input: unknown;
      parentToolUseId: string | null;
      status: 'running' | 'ok' | 'error';
      result?: string;
      truncated?: boolean;
    };

function toolIcon(name: string): string {
  const key = name.toLowerCase();
  if (key === 'read') return '📖';
  if (key === 'write') return '✏';
  if (key === 'edit') return '✎';
  if (key === 'bash') return '▶';
  if (key === 'glob') return '⚹';
  if (key === 'grep') return '⌕';
  if (key === 'webfetch' || key === 'websearch') return '🌐';
  if (key === 'task' || key === 'agent') return '🧭';
  if (key === 'todowrite') return '☑';
  if (key.startsWith('mcp__')) return '⎔';
  return '•';
}

/**
 * Rehydrate ActivityItem[] from the raw SSE events persisted in the assistant
 * message's tool_calls_json.activities array. Lets the UI replay the timeline
 * after a page reload instead of only showing it during the live stream.
 */
function hydrateActivities(raw: unknown[]): ActivityItem[] {
  const items: ActivityItem[] = [];
  const toolById = new Map<string, number>(); // toolUseId → index into items
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const event = entry as Record<string, unknown>;
    const type = typeof event.type === 'string' ? event.type : '';
    if (type === 'thinking' && typeof event.text === 'string') {
      items.push({
        kind: 'thinking',
        id: `think-hydrate-${items.length}`,
        ts: 0,
        text: event.text,
      });
    } else if (type === 'subagent' && typeof event.text === 'string') {
      items.push({
        kind: 'subagent',
        id: `sub-hydrate-${items.length}`,
        ts: 0,
        parentToolUseId: String(event.parentToolUseId || ''),
        text: event.text,
      });
    } else if (type === 'task_start') {
      items.push({
        kind: 'task',
        id: `task-${String(event.taskId)}`,
        ts: 0,
        taskId: String(event.taskId),
        toolUseId: String(event.toolUseId || ''),
        description: String(event.description || 'Sub-agent'),
      });
    } else if (type === 'tool_use' && typeof event.toolUseId === 'string') {
      const index = items.length;
      items.push({
        kind: 'tool',
        id: `tool-${event.toolUseId}`,
        ts: 0,
        toolUseId: event.toolUseId,
        name: String(event.name || 'tool'),
        input: event.input,
        parentToolUseId: (event.parentToolUseId as string | null) || null,
        status: 'running',
      });
      toolById.set(event.toolUseId, index);
    } else if (type === 'tool_result' && typeof event.toolUseId === 'string') {
      const idx = toolById.get(event.toolUseId);
      if (idx !== undefined) {
        const existing = items[idx];
        if (existing.kind === 'tool') {
          existing.status = event.isError === true ? 'error' : 'ok';
          existing.result = typeof event.content === 'string' ? event.content : '';
          existing.truncated = event.truncated === true;
        }
      }
    }
  }
  return items;
}

function toolSummary(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') {
    return name;
  }
  const rec = input as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  const short = (v: string, max = 80) => (v.length <= max ? v : `${v.slice(0, max)}…`);

  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
      return short(str(rec.file_path) || name);
    case 'Bash':
      return short(str(rec.command) || name);
    case 'Glob':
    case 'Grep':
      return short(str(rec.pattern) || name);
    case 'Task':
    case 'Agent':
      return short(str(rec.description) || str(rec.prompt) || name);
    case 'WebFetch':
      return short(str(rec.url) || name);
    case 'WebSearch':
      return short(str(rec.query) || name);
    default:
      return name;
  }
}

function getPhaseLabel(phase: StreamPhase, t: Translator): string {
  switch (phase) {
    case 'idle':
      return '';
    case 'preparing':
      return t('agent.phase.preparing');
    case 'connecting':
      return t('agent.phase.connecting');
    case 'session':
      return t('agent.phase.session');
    case 'waiting':
      return t('agent.phase.waiting');
    case 'receiving':
      return t('agent.phase.receiving');
    case 'finalizing':
      return t('agent.phase.finalizing');
    case 'memory_pass':
      return t('agent.phase.memoryPass');
    default:
      return '';
  }
}

const PHASE_TONE: Record<StreamPhase, 'accent' | 'success' | 'warn' | 'neutral'> = {
  idle: 'neutral',
  preparing: 'neutral',
  connecting: 'neutral',
  session: 'accent',
  waiting: 'warn',
  receiving: 'success',
  finalizing: 'accent',
  memory_pass: 'accent',
};

function getThinkingPhrases(phase: StreamPhase, t: Translator): string[] {
  switch (phase) {
    case 'preparing':
      return [
        t('agent.thinking.preparing1'),
        t('agent.thinking.preparing2'),
        t('agent.thinking.preparing3'),
        t('agent.thinking.preparing4'),
      ];
    case 'connecting':
      return [t('agent.thinking.connecting1'), t('agent.thinking.connecting2')];
    case 'session':
      return [t('agent.thinking.session1'), t('agent.thinking.session2')];
    case 'waiting':
      return [
        t('agent.thinking.waiting1'),
        t('agent.thinking.waiting2'),
        t('agent.thinking.waiting3'),
        t('agent.thinking.waiting4'),
        t('agent.thinking.waiting5'),
        t('agent.thinking.waiting6'),
        t('agent.thinking.waiting7'),
      ];
    case 'receiving':
      return [t('agent.thinking.receiving1'), t('agent.thinking.receiving2')];
    case 'finalizing':
      return [t('agent.thinking.finalizing1'), t('agent.thinking.finalizing2')];
    case 'memory_pass':
      return [
        t('agent.thinking.memoryPass1'),
        t('agent.thinking.memoryPass2'),
        t('agent.thinking.memoryPass3'),
        t('agent.thinking.memoryPass4'),
      ];
    default:
      return [];
  }
}

function formatElapsed(ms: number): string {
  if (ms < 1000) {
    return `${ms} ms`;
  }
  const s = ms / 1000;
  if (s < 60) {
    return `${s.toFixed(1)} s`;
  }
  return `${Math.floor(s / 60)}m ${(s % 60).toFixed(0).padStart(2, '0')}s`;
}

const LS_KEYS = {
  sessionId: 'agent.selectedSessionId',
  mode: 'agent.mode',
  draft: 'agent.draft',
  rightOpen: 'agent.rightOpen',
  leftCollapsed: 'agent.leftCollapsed',
  timeoutSec: 'agent.timeoutSec',
  newProvider: 'agent.newProvider',
  newModel: 'agent.newModel',
  newCwd: 'agent.newCwd',
  quickProjectId: 'agent.quickProjectId',
  streamSnapshot: 'agent.streamSnapshot',
} as const;

type StreamSnapshot = {
  sessionId: string;
  phase: StreamPhase;
  startedAt: number;
  deltaCount: number;
  streamingText: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheCreateTokens: number;
    cacheReadTokens: number;
  } | null;
  activities: ActivityItem[];
  optimisticUserMessage: string | null;
  savedAt: number;
};

const SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;

function readSnapshot(): StreamSnapshot | null {
  const raw = lsGet(LS_KEYS.streamSnapshot);
  if (!raw) return null;
  try {
    const snap = JSON.parse(raw) as StreamSnapshot;
    if (!snap.sessionId || !snap.startedAt) return null;
    if (Date.now() - snap.savedAt > SNAPSHOT_MAX_AGE_MS) return null;
    return snap;
  } catch {
    return null;
  }
}

function lsGet(key: string): string | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string | null): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    if (value === null) {
      window.localStorage.removeItem(key);
    } else {
      window.localStorage.setItem(key, value);
    }
  } catch {
    /* quota or private mode */
  }
}

export default function AgentRoute() {
  const { t, locale } = useTranslation();
  const [searchParams] = useSearchParams();
  const projectFromQuery = searchParams.get('projectId');

  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() =>
    lsGet(LS_KEYS.sessionId),
  );
  const [sessionDetail, setSessionDetail] = useState<SessionDetail | null>(null);

  const [newProvider, setNewProvider] = useState<'claude' | 'codex'>(
    () => (lsGet(LS_KEYS.newProvider) as 'claude' | 'codex' | null) || 'claude',
  );
  const [newModel, setNewModel] = useState(() => lsGet(LS_KEYS.newModel) || '');
  const [newCwd, setNewCwd] = useState(() => lsGet(LS_KEYS.newCwd) || '');
  const [newTitle, setNewTitle] = useState('');

  const [prompt, setPrompt] = useState(() => lsGet(LS_KEYS.draft) || '');
  const [timeoutSec, setTimeoutSec] = useState(() => {
    const raw = lsGet(LS_KEYS.timeoutSec);
    const n = raw ? Number.parseInt(raw, 10) : 120;
    return Number.isFinite(n) && n > 0 ? n : 120;
  });

  const [quickProjectId, setQuickProjectId] = useState(() => lsGet(LS_KEYS.quickProjectId) || '');

  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const [contextSnapshot, setContextSnapshot] = useState<ContextSnapshot | null>(null);
  const [contextLoading, setContextLoading] = useState(false);

  const [memoryDraftKey, setMemoryDraftKey] = useState('');
  const [memoryDraftContent, setMemoryDraftContent] = useState('');
  const [memoryDraftScope, setMemoryDraftScope] = useState<'global' | 'project' | 'session'>(
    'project',
  );

  const [mode, setMode] = useState<AgentMode>(
    () => (lsGet(LS_KEYS.mode) as AgentMode | null) || 'chat',
  );
  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // `showStreamUI` is derived and accounts for a restored snapshot: on fresh
  // mount `running` is false but the snapshot may have set a non-idle phase +
  // startedAt, and we still want the bubble / PhaseBar on screen.
  // Streaming — hydrate from snapshot if present so a page nav mid-stream
  // restores the bubble visually. Only the sessionId match matters at init;
  // the per-session gate happens in the restore effect below.
  const initialSnapshot = useMemo(() => readSnapshot(), []);
  const [streamingText, setStreamingText] = useState(() => initialSnapshot?.streamingText ?? '');
  const [streamSpinner, setStreamSpinner] = useState(0);
  const [streamDeltas, setStreamDeltas] = useState(() => initialSnapshot?.deltaCount ?? 0);
  const [streamPhase, setStreamPhase] = useState<StreamPhase>(
    () => initialSnapshot?.phase ?? 'idle',
  );
  const [streamStartedAt, setStreamStartedAt] = useState<number | null>(
    () => initialSnapshot?.startedAt ?? null,
  );
  const [streamElapsedMs, setStreamElapsedMs] = useState(() =>
    initialSnapshot ? Date.now() - initialSnapshot.startedAt : 0,
  );
  const [activities, setActivities] = useState<ActivityItem[]>(
    () => initialSnapshot?.activities ?? [],
  );
  const [optimisticUserMessage, setOptimisticUserMessage] = useState<string | null>(
    () => initialSnapshot?.optimisticUserMessage ?? null,
  );
  const [streamUsage, setStreamUsage] = useState<{
    inputTokens: number;
    outputTokens: number;
    cacheCreateTokens: number;
    cacheReadTokens: number;
  } | null>(() => initialSnapshot?.usage ?? null);
  const streamAbortRef = useRef<AbortController | null>(null);

  // Panel collapse (QoL — widen conversation)
  const [leftCollapsed, setLeftCollapsed] = useState(() => lsGet(LS_KEYS.leftCollapsed) === '1');
  const [rightOpen, setRightOpen] = useState(() => lsGet(LS_KEYS.rightOpen) === '1');

  // In-conversation search
  const [searchQuery, setSearchQuery] = useState('');

  // Toast
  const [toast, setToast] = useState<{
    message: string;
    tone: 'neutral' | 'success' | 'danger';
  } | null>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showToast = useCallback(
    (message: string, tone: 'neutral' | 'success' | 'danger' = 'neutral') => {
      setToast({ message, tone });
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
      toastTimerRef.current = setTimeout(() => setToast(null), 2800);
    },
    [],
  );
  useEffect(() => {
    return () => {
      if (toastTimerRef.current) {
        clearTimeout(toastTimerRef.current);
      }
    };
  }, []);

  // Per-session model override (lives in memory; persisted via context_json on next send)
  const [sessionModelOverride, setSessionModelOverride] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!running && streamingText.length === 0) {
      return;
    }
    const id = setInterval(() => setStreamSpinner((n) => (n + 1) % 10), 80);
    return () => clearInterval(id);
  }, [running, streamingText.length]);

  // Elapsed timer during stream (also ticks for a restored snapshot so a
  // stream-in-progress shown after nav-back keeps advancing its counter).
  useEffect(() => {
    if (streamStartedAt === null || streamPhase === 'idle') {
      return;
    }
    const id = setInterval(() => {
      setStreamElapsedMs(Date.now() - streamStartedAt);
    }, 200);
    return () => clearInterval(id);
  }, [streamStartedAt, streamPhase]);

  // Persist state to localStorage
  useEffect(() => {
    lsSet(LS_KEYS.sessionId, selectedSessionId);
  }, [selectedSessionId]);
  useEffect(() => {
    lsSet(LS_KEYS.mode, mode);
  }, [mode]);
  useEffect(() => {
    lsSet(LS_KEYS.draft, prompt);
  }, [prompt]);
  useEffect(() => {
    lsSet(LS_KEYS.rightOpen, rightOpen ? '1' : '0');
  }, [rightOpen]);
  useEffect(() => {
    lsSet(LS_KEYS.leftCollapsed, leftCollapsed ? '1' : '0');
  }, [leftCollapsed]);
  useEffect(() => {
    lsSet(LS_KEYS.timeoutSec, String(timeoutSec));
  }, [timeoutSec]);
  useEffect(() => {
    lsSet(LS_KEYS.newProvider, newProvider);
  }, [newProvider]);
  useEffect(() => {
    lsSet(LS_KEYS.newModel, newModel);
  }, [newModel]);
  useEffect(() => {
    lsSet(LS_KEYS.newCwd, newCwd);
  }, [newCwd]);
  useEffect(() => {
    lsSet(LS_KEYS.quickProjectId, quickProjectId);
  }, [quickProjectId]);

  // Persist live-stream snapshot so navigation away + back restores the bubble.
  // Cleared on natural stream end (see finally block in sendMessage).
  useEffect(() => {
    if (streamPhase === 'idle' || !selectedSessionId || streamStartedAt === null) {
      return;
    }
    const snap: StreamSnapshot = {
      sessionId: selectedSessionId,
      phase: streamPhase,
      startedAt: streamStartedAt,
      deltaCount: streamDeltas,
      streamingText,
      usage: streamUsage,
      activities,
      optimisticUserMessage,
      savedAt: Date.now(),
    };
    lsSet(LS_KEYS.streamSnapshot, JSON.stringify(snap));
  }, [
    streamPhase,
    selectedSessionId,
    streamStartedAt,
    streamDeltas,
    streamingText,
    streamUsage,
    activities,
    optimisticUserMessage,
  ]);

  // On mount, if we restored a snapshot, decide whether to keep it or drop it.
  // Drop conditions: session mismatch, or the session already contains an
  // assistant message newer than the snapshot's start (stream finished while
  // user was on another route).
  useEffect(() => {
    if (!initialSnapshot) return;
    if (initialSnapshot.sessionId !== selectedSessionId) {
      // Snapshot belongs to a different session — clear visual + storage.
      setStreamPhase('idle');
      setStreamingText('');
      setStreamStartedAt(null);
      setStreamDeltas(0);
      setOptimisticUserMessage(null);
      setActivities([]);
      setStreamUsage(null);
      lsSet(LS_KEYS.streamSnapshot, null);
      return;
    }
    // Same session: the background stream may have completed. Trust the
    // session detail: if the latest assistant message was created after the
    // snapshot started, the reply already landed in the DB.
    if (sessionDetail && sessionDetail.session.id === selectedSessionId) {
      const lastAssistant = [...sessionDetail.messages]
        .reverse()
        .find((m) => m.role === 'assistant');
      const snapSec = Math.floor(initialSnapshot.startedAt / 1000);
      if (lastAssistant && lastAssistant.ts >= snapSec) {
        setStreamPhase('idle');
        setStreamingText('');
        setStreamStartedAt(null);
        setStreamDeltas(0);
        setOptimisticUserMessage(null);
        setActivities([]);
        setStreamUsage(null);
        lsSet(LS_KEYS.streamSnapshot, null);
      }
    }
  }, [initialSnapshot, selectedSessionId, sessionDetail]);

  async function refreshSessions(selectedId?: string | null) {
    const rows = await apiGet<SessionSummary[]>('/api/agent/sessions?limit=100');
    setSessions(rows);

    const target = selectedId || selectedSessionId;
    if (target && rows.some((row) => row.id === target)) {
      setSelectedSessionId(target);
      return;
    }

    if (rows[0]?.id) {
      setSelectedSessionId(rows[0].id);
    } else {
      setSelectedSessionId(null);
      setSessionDetail(null);
    }
  }

  async function loadDetail(sessionId: string) {
    const detail = await apiGet<SessionDetail>(`/api/agent/sessions/${sessionId}`);
    setSessionDetail(detail);
  }

  useEffect(() => {
    Promise.all([
      apiGet<ProvidersResponse>('/api/agent/providers'),
      apiGet<ProjectSummary[]>('/api/projects'),
      apiGet<SessionSummary[]>('/api/agent/sessions?limit=100'),
    ])
      .then(([providerData, projectData, sessionData]) => {
        setProviders(providerData.providers);
        setProjects(projectData);
        setSessions(sessionData);

        // Respect restored state from localStorage. Only fall back to defaults
        // when the restored value is empty or invalid for the current dataset.
        if (projectData[0]) {
          setNewCwd((prev) => {
            if (prev && projectData.some((project) => project.path === prev)) {
              return prev;
            }
            return projectData[0].path;
          });
          const fromQueryValid =
            projectFromQuery && projectData.some((project) => project.id === projectFromQuery);
          setQuickProjectId((prev) => {
            if (fromQueryValid) {
              return projectFromQuery as string;
            }
            if (prev && projectData.some((project) => project.id === prev)) {
              return prev;
            }
            return projectData[0].id;
          });
        }

        if (sessionData.length > 0) {
          setSelectedSessionId((prev) => {
            if (prev && sessionData.some((row) => row.id === prev)) {
              return prev;
            }
            return sessionData[0].id;
          });
        } else {
          setSelectedSessionId(null);
        }
      })
      .catch((error) => setStatus(t('agent.status.initError', { error: String(error) })))
      .finally(() => setLoading(false));
  }, [projectFromQuery, t]);

  useEffect(() => {
    if (!selectedSessionId) {
      setSessionDetail(null);
      return;
    }
    loadDetail(selectedSessionId).catch((error) =>
      setStatus(t('agent.status.sessionError', { error: String(error) })),
    );
  }, [selectedSessionId, t]);

  useEffect(() => {
    if (!sessionDetail?.messages.length) {
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [sessionDetail?.messages.length]);

  useEffect(() => {
    if (streamingText.length === 0) {
      return;
    }
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [streamingText]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        return;
      }
      if (running) {
        streamAbortRef.current?.abort();
        return;
      }
      if (rightOpen) {
        setRightOpen(false);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [running, rightOpen]);

  useEffect(() => {
    if (running) {
      messagesEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
  }, [running]);

  // Debounced live context preview
  useEffect(() => {
    if (!selectedSessionId) {
      setContextSnapshot(null);
      return;
    }

    const timeout = setTimeout(() => {
      setContextLoading(true);
      apiPost<ContextSnapshot>('/api/agent/context', {
        sessionId: selectedSessionId,
        userMessage: prompt,
      })
        .then((data) => setContextSnapshot(data))
        .catch(() => {
          /* ignore */
        })
        .finally(() => setContextLoading(false));
    }, 250);

    return () => clearTimeout(timeout);
  }, [selectedSessionId, prompt]);

  async function createSession() {
    setRunning(true);
    setStatus(null);
    try {
      const created = await apiPost<SessionSummary>('/api/agent/sessions', {
        provider: newProvider,
        model: newModel.trim() || undefined,
        cwd: newCwd || undefined,
        title: newTitle.trim() || undefined,
      });
      setNewTitle('');
      await refreshSessions(created.id);
      await loadDetail(created.id);
      setStatus(t('agent.status.sessionCreated', { label: created.title || created.id }));
    } catch (error) {
      setStatus(t('agent.status.createError', { error: String(error) }));
    } finally {
      setRunning(false);
    }
  }

  const sendMessage = useCallback(
    async (rawContent: string, selectedMode: AgentMode = mode) => {
      const trimmed = rawContent.trim();
      if (!trimmed) {
        setStatus(t('agent.status.emptyPrompt'));
        return;
      }
      if (!selectedSessionId) {
        setStatus(t('agent.status.pickOrCreate'));
        return;
      }

      // The server applies the mode's output-contract wrap (AGENT_MODES.userWrap).
      // We send the raw user text + the mode name so the DB stores the clean
      // original message and the model sees the contract for this turn only.
      setRunning(true);
      setStreamingText('');
      setStreamDeltas(0);
      setStreamPhase('preparing');
      setStreamStartedAt(Date.now());
      setStreamElapsedMs(0);
      setActivities([]);
      setStreamUsage(null);
      setOptimisticUserMessage(trimmed);
      setStatus(null);
      setPrompt('');

      const controller = new AbortController();
      streamAbortRef.current = controller;

      try {
        const authHeader = await getApiAuthHeader();
        const response = await fetch(`/api/agent/sessions/${selectedSessionId}/stream`, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', ...authHeader },
          credentials: 'same-origin',
          body: JSON.stringify({
            content: trimmed,
            mode: selectedMode,
            timeoutMs: timeoutSec * 1000,
          }),
        });

        if (!response.ok || !response.body) {
          throw new Error(`stream_failed · ${response.status} ${response.statusText}`);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let accumulated = '';
        let finalized = false;

        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          const frames = buffer.split('\n\n');
          buffer = frames.pop() || '';

          for (const frame of frames) {
            if (!frame.startsWith('data:')) {
              continue;
            }
            const payload = frame.slice(5).trim();
            if (!payload) {
              continue;
            }
            let event: Record<string, unknown>;
            try {
              event = JSON.parse(payload) as Record<string, unknown>;
            } catch {
              continue;
            }

            const type = event.type;
            if (type === 'start') {
              setStreamPhase('connecting');
            } else if (type === 'session') {
              setStreamPhase((current) => (current === 'receiving' ? current : 'waiting'));
            } else if (type === 'model') {
              setStreamPhase((current) => (current === 'receiving' ? current : 'waiting'));
            } else if (type === 'delta' && typeof event.text === 'string') {
              accumulated += event.text;
              setStreamingText(accumulated);
              setStreamDeltas((count) => count + 1);
              setStreamPhase('receiving');
            } else if (type === 'thinking' && typeof event.text === 'string') {
              const item: ActivityItem = {
                kind: 'thinking',
                id: `think-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                ts: Date.now(),
                text: event.text,
              };
              setActivities((prev) => [...prev, item]);
              setStreamPhase((current) => (current === 'receiving' ? current : 'waiting'));
            } else if (type === 'subagent' && typeof event.text === 'string') {
              const item: ActivityItem = {
                kind: 'subagent',
                id: `sub-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                ts: Date.now(),
                parentToolUseId: String(event.parentToolUseId || ''),
                text: event.text,
              };
              setActivities((prev) => [...prev, item]);
              setStreamPhase((current) => (current === 'receiving' ? current : 'waiting'));
            } else if (type === 'task_start') {
              const item: ActivityItem = {
                kind: 'task',
                id: `task-${String(event.taskId)}`,
                ts: Date.now(),
                taskId: String(event.taskId),
                toolUseId: String(event.toolUseId || ''),
                description: String(event.description || 'Sub-agent'),
              };
              setActivities((prev) => [...prev, item]);
              setStreamPhase((current) => (current === 'receiving' ? current : 'waiting'));
            } else if (type === 'tool_use' && typeof event.toolUseId === 'string') {
              const item: ActivityItem = {
                kind: 'tool',
                id: `tool-${event.toolUseId}`,
                ts: Date.now(),
                toolUseId: event.toolUseId,
                name: String(event.name || 'tool'),
                input: event.input,
                parentToolUseId: (event.parentToolUseId as string | null) || null,
                status: 'running',
              };
              setActivities((prev) => [...prev, item]);
              setStreamPhase((current) => (current === 'receiving' ? current : 'waiting'));
            } else if (type === 'tool_result' && typeof event.toolUseId === 'string') {
              const targetId = `tool-${event.toolUseId}`;
              const content = typeof event.content === 'string' ? event.content : '';
              const isError = event.isError === true;
              const truncated = event.truncated === true;
              setActivities((prev) =>
                prev.map((item) =>
                  item.id === targetId && item.kind === 'tool'
                    ? {
                        ...item,
                        status: isError ? 'error' : 'ok',
                        result: content,
                        truncated,
                      }
                    : item,
                ),
              );
            } else if (type === 'done' && event.result && typeof event.result === 'object') {
              const result = event.result as {
                ok?: boolean;
                durationMs?: number;
                exitCode?: number;
              };
              setStreamPhase('finalizing');
              setStatus(
                result.ok
                  ? t('agent.status.responseReceived', { ms: result.durationMs ?? 0 })
                  : t('agent.status.commandFailed', { exitCode: result.exitCode ?? 0 }),
              );
            } else if (type === 'usage' && event.usage && typeof event.usage === 'object') {
              const u = event.usage as {
                inputTokens?: number;
                outputTokens?: number;
                cacheCreateTokens?: number;
                cacheReadTokens?: number;
              };
              setStreamUsage({
                inputTokens: typeof u.inputTokens === 'number' ? u.inputTokens : 0,
                outputTokens: typeof u.outputTokens === 'number' ? u.outputTokens : 0,
                cacheCreateTokens:
                  typeof u.cacheCreateTokens === 'number' ? u.cacheCreateTokens : 0,
                cacheReadTokens: typeof u.cacheReadTokens === 'number' ? u.cacheReadTokens : 0,
              });
            } else if (type === 'summary_error' && typeof event.message === 'string') {
              showToast(
                t('agent.toast.summaryFailed', { message: event.message.slice(0, 80) }),
                'danger',
              );
            } else if (type === 'memory_pass_start') {
              setStreamPhase('memory_pass');
            } else if (type === 'memory_pass_done') {
              const extracted = typeof event.extracted === 'number' ? event.extracted : 0;
              const skipped =
                typeof event.skippedDuplicates === 'number' ? event.skippedDuplicates : 0;
              const durationMs = typeof event.durationMs === 'number' ? event.durationMs : 0;
              if (extracted > 0) {
                const seconds = Math.round(durationMs / 100) / 10;
                showToast(
                  extracted > 1
                    ? t('agent.toast.memoryDistilledMany', { n: extracted, seconds })
                    : t('agent.toast.memoryDistilledOne', { n: extracted, seconds }),
                  'success',
                );
              } else if (skipped > 0) {
                showToast(
                  skipped > 1
                    ? t('agent.toast.nothingNewMany', { n: skipped })
                    : t('agent.toast.nothingNewOne', { n: skipped }),
                  'neutral',
                );
              }
              setStreamPhase('finalizing');
            } else if (type === 'finalized' && event.sessionId) {
              finalized = true;
              const hint =
                typeof event.extractedMemories === 'number' && event.extractedMemories > 0
                  ? t('agent.status.memoryHint', { n: event.extractedMemories })
                  : '';
              setStatus((prev) => `${prev || t('agent.status.responseReceivedShort')}${hint}`);
              await refreshSessions(event.sessionId as string);
              await loadDetail(event.sessionId as string);
            } else if (type === 'error' && typeof event.message === 'string') {
              setStatus(t('agent.status.streamError', { error: event.message }));
            }
          }
        }

        if (!finalized) {
          // Fallback: reload in case finalized event was missed (e.g. aborted)
          await refreshSessions(selectedSessionId);
          await loadDetail(selectedSessionId);
        }
      } catch (error) {
        if ((error as Error).name === 'AbortError') {
          setStatus(t('agent.status.abortedByUser'));
        } else {
          setStatus(t('agent.status.sendError', { error: String(error) }));
        }
      } finally {
        setRunning(false);
        setStreamingText('');
        setStreamPhase('idle');
        setStreamStartedAt(null);
        setStreamDeltas(0);
        setOptimisticUserMessage(null);
        streamAbortRef.current = null;
        lsSet(LS_KEYS.streamSnapshot, null);
      }
    },
    [mode, selectedSessionId, timeoutSec, t, showToast],
  );

  function stopGeneration() {
    streamAbortRef.current?.abort();
  }

  async function sendPrompt() {
    await sendMessage(prompt);
  }

  async function regenerateLastReply() {
    if (!sessionDetail || sessionDetail.messages.length === 0 || running) {
      return;
    }
    const lastUser = [...sessionDetail.messages].reverse().find((m) => m.role === 'user');
    if (!lastUser?.content) {
      setStatus(t('agent.status.noUserMessageToRegenerate'));
      return;
    }
    await sendMessage(lastUser.content, 'chat');
  }

  async function copyToClipboard(messageId: string, text: string) {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedId(messageId);
      setTimeout(() => setCopiedId((current) => (current === messageId ? null : current)), 1500);
      showToast(t('agent.toast.copiedClipboard'), 'success');
    } catch {
      showToast(t('agent.toast.copyImpossible'), 'danger');
    }
  }

  async function archiveSession() {
    if (!selectedSessionId) {
      return;
    }
    await deleteSessionById(selectedSessionId);
  }

  async function deleteSessionById(sessionId: string) {
    const target = sessions.find((row) => row.id === sessionId);
    const label = target?.title || t('agent.confirm.thisSession');
    const confirmed = window.confirm(t('agent.confirm.deleteSession', { label }));
    if (!confirmed) {
      return;
    }
    try {
      await apiDelete<{ ok: boolean }>(`/api/agent/sessions/${sessionId}`);
      if (selectedSessionId === sessionId) {
        await refreshSessions(null);
      } else {
        await refreshSessions();
      }
      showToast(t('agent.toast.sessionDeleted'), 'success');
    } catch (error) {
      showToast(t('agent.toast.deleteError', { error: String(error) }), 'danger');
    }
  }

  async function archiveSessionToVault() {
    if (!selectedSessionId) {
      return;
    }
    setRunning(true);
    try {
      const result = await apiPost<{
        ok: boolean;
        path: string;
        relativePath: string;
        bytes: number;
      }>(`/api/agent/sessions/${selectedSessionId}/archive-to-vault`, {});
      showToast(t('agent.toast.archivedToVault', { path: result.relativePath }), 'success');
    } catch (error) {
      const message = String(error);
      if (message.includes('vault_not_configured')) {
        showToast(t('agent.toast.vaultNotConfigured'), 'danger');
      } else if (message.includes('session_empty')) {
        showToast(t('agent.toast.sessionEmpty'), 'neutral');
      } else {
        showToast(t('agent.toast.archiveError', { message }), 'danger');
      }
    } finally {
      setRunning(false);
    }
  }

  async function runQuick(
    command: 'project-summary' | 'project-critique' | 'usage-weekly' | 'vault-orphans',
  ) {
    setRunning(true);
    setStatus(null);
    try {
      const response = await apiPost<{
        ok: boolean;
        sessionId: string;
        result: AgentExecResult;
        extractedMemories?: number;
      }>(`/api/agent/quick/${command}`, {
        sessionId: selectedSessionId || undefined,
        projectId: quickProjectId || undefined,
        provider: newProvider,
        model: newModel.trim() || undefined,
        cwd: newCwd || undefined,
        timeoutMs: timeoutSec * 1000,
      });
      await refreshSessions(response.sessionId);
      await loadDetail(response.sessionId);
      const memoryHint = response.extractedMemories
        ? t('agent.status.memoryHint', { n: response.extractedMemories })
        : '';
      setStatus(
        response.ok
          ? t('agent.status.quickOk', {
              command,
              ms: response.result.durationMs,
              memoryHint,
            })
          : t('agent.status.quickFail', {
              command,
              exitCode: response.result.exitCode,
            }),
      );
    } catch (error) {
      setStatus(t('agent.status.quickError', { error: String(error) }));
    } finally {
      setRunning(false);
    }
  }

  async function saveMemory() {
    if (!memoryDraftContent.trim() || !memoryDraftKey.trim()) {
      showToast(t('agent.toast.keyAndContentRequired'), 'danger');
      return;
    }

    const scope =
      memoryDraftScope === 'project' && contextSnapshot?.projectId
        ? `project:${contextSnapshot.projectId}`
        : memoryDraftScope === 'session' && selectedSessionId
          ? `session:${selectedSessionId}`
          : 'global';

    try {
      await apiPost<MemoryRow>('/api/agent/memories', {
        scope,
        key: memoryDraftKey.trim(),
        content: memoryDraftContent.trim(),
        source: 'manual',
        relatedProjectId: contextSnapshot?.projectId || null,
        relatedSessionId: selectedSessionId,
        pinned: memoryDraftScope === 'global',
      });
      setMemoryDraftKey('');
      setMemoryDraftContent('');
      showToast(t('agent.toast.memorySaved', { scope }), 'success');
      if (selectedSessionId) {
        const snapshot = await apiPost<ContextSnapshot>('/api/agent/context', {
          sessionId: selectedSessionId,
          userMessage: prompt,
        });
        setContextSnapshot(snapshot);
      }
    } catch (error) {
      showToast(t('agent.toast.memoryError', { error: String(error) }), 'danger');
    }
  }

  async function removeMemory(id: string) {
    try {
      await apiDelete<{ ok: boolean }>(`/api/agent/memories/${id}`);
      showToast(t('agent.toast.memoryDeleted'), 'success');
      if (selectedSessionId) {
        const snapshot = await apiPost<ContextSnapshot>('/api/agent/context', {
          sessionId: selectedSessionId,
          userMessage: prompt,
        });
        setContextSnapshot(snapshot);
      }
    } catch (error) {
      showToast(t('agent.toast.deleteError', { error: String(error) }), 'danger');
    }
  }

  const activeSession = useMemo(() => {
    if (!selectedSessionId) {
      return null;
    }
    return sessions.find((session) => session.id === selectedSessionId) || null;
  }, [sessions, selectedSessionId]);

  const activeProvider = activeSession?.context?.provider || newProvider;
  const activeModel = activeSession?.context?.model || activeSession?.model || null;

  const streamingLooksLive = streamDeltas > 1;
  const showStreamUI = running || (streamPhase !== 'idle' && streamStartedAt !== null);

  return (
    <div className="flex flex-col gap-2">
      {/* Session header strip */}
      <header className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] px-4 py-2">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span
            className={`h-2 w-2 shrink-0 rounded-full ${activeProvider === 'codex' ? 'bg-[#ffd60a]' : 'bg-[#64d2ff]'}`}
            title={t('agent.header.providerTitle', { provider: activeProvider })}
          />
          <div className="min-w-0">
            <div className="truncate text-[14px] font-semibold tracking-tight text-[var(--text)]">
              {activeSession?.title || t('agent.header.noSession')}
            </div>
            <div className="truncate text-[11px] text-[var(--text-dim)]">
              {activeSession
                ? `${activeProvider} · ${activeModel || DEFAULT_MODEL[activeProvider]} · ${activeSession.context?.cwd || '—'}`
                : t('agent.header.pickLeft')}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void archiveSessionToVault()}
            disabled={!selectedSessionId || running}
            className="btn btn-ghost !px-2 !py-1 !text-[11px]"
            title={t('agent.header.toVaultTitle')}
          >
            {t('agent.header.toVaultLabel')}
          </button>
          <button
            type="button"
            onClick={() => void archiveSession()}
            disabled={!selectedSessionId || running}
            className="btn btn-ghost !px-2 !py-1 !text-[11px]"
            title={t('agent.header.archiveTitle')}
          >
            {t('agent.header.archive')}
          </button>
          <button
            type="button"
            onClick={() => setRightOpen((value) => !value)}
            className={`btn !px-2 !py-1 !text-[11px] ${rightOpen ? 'btn-accent' : 'btn-ghost'}`}
            title={t('agent.header.contextTitle')}
            aria-pressed={rightOpen}
          >
            {t('agent.header.context')}
            {contextSnapshot ? (
              <span className="ml-1.5 rounded-full bg-[var(--surface-2)] px-1.5 py-0.5 text-[10px] num text-[var(--text-dim)]">
                ~{contextSnapshot.tokensEstimate}
              </span>
            ) : null}
          </button>
        </div>
      </header>

      <div className="agent-shell" data-sessions={leftCollapsed ? 'collapsed' : 'open'}>
        {/* ============== LEFT — Sessions ============== */}
        <aside className="agent-pane">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-3 py-2">
            {leftCollapsed ? (
              <button
                type="button"
                onClick={() => setLeftCollapsed(false)}
                className="text-[13px] text-[var(--text-dim)] hover:text-[var(--text)]"
                aria-label={t('agent.sessions.expandAria')}
                title={t('agent.sessions.expandTitle')}
              >
                ▸
              </button>
            ) : (
              <>
                <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--text-dim)]">
                  {t('agent.sessions.heading')} ·{' '}
                  <span className="num text-[var(--text-faint)]">{sessions.length}</span>
                </span>
                <div className="flex items-center gap-1">
                  <details className="relative">
                    <summary className="cursor-pointer list-none rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-2)] px-1.5 text-[13px] leading-5 text-[var(--text-mute)] hover:text-[var(--text)]">
                      +
                    </summary>
                    <div className="absolute right-0 z-10 mt-1 flex w-[220px] flex-col gap-2 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[rgba(11,13,17,0.96)] p-2 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.8)] backdrop-blur">
                      <Segmented
                        value={newProvider}
                        options={[
                          { value: 'claude', label: 'Claude' },
                          { value: 'codex', label: 'Codex' },
                        ]}
                        onChange={(value) => {
                          setNewProvider(value);
                          setNewModel(DEFAULT_MODEL[value]);
                        }}
                      />
                      <select
                        value={newCwd}
                        onChange={(event) => setNewCwd(event.target.value)}
                        className="!py-1 !text-[12px]"
                      >
                        <option value="">{t('agent.sessions.defaultRoot')}</option>
                        {projects.map((project) => (
                          <option key={project.id} value={project.path}>
                            {project.name}
                          </option>
                        ))}
                      </select>
                      <select
                        value={newModel || DEFAULT_MODEL[newProvider]}
                        onChange={(event) => setNewModel(event.target.value)}
                        className="!py-1 !text-[12px]"
                      >
                        {MODEL_CATALOG[newProvider].map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                      <input
                        value={newTitle}
                        onChange={(event) => setNewTitle(event.target.value)}
                        placeholder={t('agent.sessions.titlePlaceholder')}
                        className="!py-1 !text-[12px]"
                      />
                      <Button
                        tone="accent"
                        onClick={() => void createSession()}
                        disabled={running}
                        className="w-full !py-1 !text-[12px]"
                      >
                        {t('agent.sessions.createButton')}
                      </Button>
                    </div>
                  </details>
                  <button
                    type="button"
                    onClick={() => setLeftCollapsed(true)}
                    className="text-[13px] text-[var(--text-dim)] hover:text-[var(--text)]"
                    aria-label={t('agent.sessions.collapseAria')}
                    title={t('agent.sessions.collapseAria')}
                  >
                    ◂
                  </button>
                </div>
              </>
            )}
          </div>

          {!leftCollapsed ? (
            <div className="agent-sessions-scroll">
              {loading ? (
                <p className="text-sm text-[var(--text-dim)]">{t('agent.sessions.loading')}</p>
              ) : null}
              {sessions.map((session) => (
                <SessionTile
                  key={session.id}
                  session={session}
                  active={selectedSessionId === session.id}
                  onClick={() => setSelectedSessionId(session.id)}
                  onDelete={() => void deleteSessionById(session.id)}
                />
              ))}
              {!loading && sessions.length === 0 ? (
                <Empty>{t('agent.sessions.empty')}</Empty>
              ) : null}
            </div>
          ) : (
            <div className="agent-sessions-scroll !items-center !px-1.5 !py-2">
              {sessions.map((session) => {
                const isCodex = session.context?.provider === 'codex';
                const label =
                  session.title ||
                  t('agent.sessions.sessionLabel', {
                    provider: session.context?.provider || 'agent',
                  });
                const initial = (label.trim()[0] || '?').toUpperCase();
                const active = selectedSessionId === session.id;
                return (
                  <button
                    key={session.id}
                    type="button"
                    onClick={() => setSelectedSessionId(session.id)}
                    title={t('agent.sessions.tileTitle', {
                      label,
                      count: session.message_count,
                      relative: relativeTime(session.updated_at, t),
                    })}
                    aria-label={label}
                    className={`relative flex h-8 w-8 shrink-0 items-center justify-center rounded-[var(--radius)] border text-[11px] font-semibold transition ${
                      active
                        ? 'border-[rgba(100,210,255,0.45)] bg-[var(--accent-soft)] text-[var(--text)]'
                        : 'border-[var(--border)] bg-[var(--surface-1)] text-[var(--text-dim)] hover:border-[var(--border-strong)] hover:text-[var(--text)]'
                    }`}
                  >
                    <span
                      className={`absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full ${isCodex ? 'bg-[#ffd60a]' : 'bg-[#64d2ff]'}`}
                      aria-hidden="true"
                    />
                    {initial}
                  </button>
                );
              })}
            </div>
          )}
        </aside>

        {/* ============== CENTER — Conversation (hero) ============== */}
        <section className="agent-pane">
          {/* Toolbar */}
          <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2">
            <Segmented
              value={mode}
              options={getAgentModeList(locale).map((m) => ({
                value: m.id,
                label: `${m.icon} ${m.label}`,
              }))}
              onChange={setMode}
            />
            <span className="hidden min-w-0 truncate text-[11px] text-[var(--text-dim)] md:inline">
              {getAgentMode(mode, locale).hint}
            </span>

            <div className="ml-auto flex items-center gap-1.5">
              <input
                value={searchQuery}
                onChange={(event) => setSearchQuery(event.target.value)}
                placeholder={t('agent.toolbar.filterPlaceholder')}
                className="w-[140px] !py-1 !text-[12px]"
              />

              <details className="relative">
                <summary
                  className="btn btn-ghost cursor-pointer list-none !px-2 !py-1 !text-[12px]"
                  title={t('agent.toolbar.moreTitle')}
                >
                  ⋯
                </summary>
                <div className="absolute right-0 z-10 mt-1 flex w-[280px] flex-col gap-0.5 rounded-[var(--radius)] border border-[var(--border-strong)] bg-[rgba(11,13,17,0.96)] p-2 shadow-[0_24px_60px_-20px_rgba(0,0,0,0.8)] backdrop-blur">
                  <button
                    type="button"
                    onClick={() => {
                      if (!sessionDetail) return;
                      const text = sessionDetail.messages
                        .map((m) => `${m.role.toUpperCase()}\n${m.content || ''}`)
                        .join('\n\n---\n\n');
                      navigator.clipboard.writeText(text).then(() => {
                        showToast(t('agent.toast.conversationCopied'), 'success');
                      });
                    }}
                    disabled={!sessionDetail || sessionDetail.messages.length === 0}
                    className="flex items-center justify-between rounded-[var(--radius-sm)] px-2 py-1.5 text-left text-[12px] text-[var(--text-mute)] transition hover:bg-[var(--surface-2)] hover:text-[var(--text)] disabled:opacity-50"
                  >
                    {t('agent.toolbar.copyConversation')}
                    <span className="text-[10px] text-[var(--text-faint)]">
                      {t('agent.toolbar.copyConversationBadge')}
                    </span>
                  </button>
                  <div className="my-1 border-t border-[var(--border)]" />
                  <span className="px-2 pt-1 text-[10px] uppercase tracking-[0.08em] text-[var(--text-faint)]">
                    {t('agent.toolbar.quickActions')}
                  </span>
                  <QuickAction
                    label={t('agent.quick.projectSummaryLabel')}
                    description={t('agent.quick.projectSummaryDesc')}
                    disabled={running || !quickProjectId}
                    onClick={() => void runQuick('project-summary')}
                  />
                  <QuickAction
                    label={t('agent.quick.projectCritiqueLabel')}
                    description={t('agent.quick.projectCritiqueDesc')}
                    disabled={running || !quickProjectId}
                    onClick={() => void runQuick('project-critique')}
                  />
                  <QuickAction
                    label={t('agent.quick.usageWeeklyLabel')}
                    description={t('agent.quick.usageWeeklyDesc')}
                    disabled={running}
                    onClick={() => void runQuick('usage-weekly')}
                  />
                  <QuickAction
                    label={t('agent.quick.vaultOrphansLabel')}
                    description={t('agent.quick.vaultOrphansDesc')}
                    disabled={running}
                    onClick={() => void runQuick('vault-orphans')}
                  />
                  <div className="mt-1 border-t border-[var(--border)] pt-2">
                    <FieldLabel label={t('agent.toolbar.target')}>
                      <select
                        value={quickProjectId}
                        onChange={(event) => setQuickProjectId(event.target.value)}
                        className="!py-1 !text-[12px]"
                      >
                        {projects.map((project) => (
                          <option key={project.id} value={project.id}>
                            {project.name}
                          </option>
                        ))}
                      </select>
                    </FieldLabel>
                  </div>
                </div>
              </details>
            </div>
          </div>

          {/* Scrollable conversation area */}
          <div ref={messagesContainerRef} className="agent-conversation">
            <div className="agent-conversation-inner">
              {(() => {
                const messages = sessionDetail?.messages ?? [];
                const q = searchQuery.trim().toLowerCase();
                const filtered = q
                  ? messages.filter((m) => (m.content || '').toLowerCase().includes(q))
                  : messages;
                return filtered.map((message) => (
                  <MessageBubble
                    key={message.id}
                    message={message}
                    copiedId={copiedId}
                    onCopy={copyToClipboard}
                    highlight={q}
                    onRegenerate={
                      message.role === 'assistant' ? () => void regenerateLastReply() : undefined
                    }
                    running={running}
                  />
                ));
              })()}

              {showStreamUI && optimisticUserMessage ? (
                <OptimisticUserBubble text={optimisticUserMessage} />
              ) : null}

              {showStreamUI && streamingText.length > 0 ? (
                <StreamingBubble
                  text={streamingText}
                  spinnerFrame={streamSpinner}
                  live={streamingLooksLive}
                  phase={streamPhase}
                  elapsedMs={streamElapsedMs}
                  deltaCount={streamDeltas}
                  activities={activities}
                  running={running}
                  usage={streamUsage}
                />
              ) : null}

              {showStreamUI && streamingText.length === 0 ? (
                <TypingIndicator
                  spinnerFrame={streamSpinner}
                  phase={streamPhase}
                  elapsedMs={streamElapsedMs}
                  activities={activities}
                  usage={streamUsage}
                />
              ) : null}

              {!running && (!sessionDetail || sessionDetail.messages.length === 0) ? (
                <EmptyConversation
                  onUseStarter={(starterPrompt, starterMode) => {
                    setMode(starterMode);
                    setPrompt(starterPrompt);
                  }}
                  disabled={!selectedSessionId}
                />
              ) : null}

              <div ref={messagesEndRef} />
            </div>
          </div>

          {/* Composer docked at the bottom of the conversation pane */}
          <div className="agent-composer-wrap">
            <Composer
              prompt={prompt}
              setPrompt={setPrompt}
              mode={mode}
              onSend={() => void sendPrompt()}
              onStop={stopGeneration}
              running={running}
              disabled={!selectedSessionId}
              timeoutSec={timeoutSec}
              setTimeoutSec={setTimeoutSec}
              contextTokens={contextSnapshot?.tokensEstimate || 0}
              contextNotes={contextSnapshot?.vaultMatches.length || 0}
              spinnerFrame={streamSpinner}
            />
          </div>
        </section>
      </div>

      {/* ============== DRAWER — Context (overlay slide-in) ============== */}
      {rightOpen ? (
        <div
          className="agent-drawer-overlay"
          // biome-ignore lint/a11y/useSemanticElements: native <dialog> would require showModal() which conflicts with our custom backdrop + animation flow
          role="dialog"
          aria-label={t('agent.drawer.ariaLabel')}
        >
          <button
            type="button"
            className="agent-drawer-backdrop"
            onClick={() => setRightOpen(false)}
            aria-label={t('agent.drawer.backdropAria')}
          />
          <aside className="agent-drawer-panel">
            <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-2.5">
              <div>
                <div className="text-[12px] font-semibold tracking-tight text-[var(--text)]">
                  {t('agent.drawer.title')}
                </div>
                <div className="text-[11px] text-[var(--text-dim)]">
                  {contextLoading
                    ? t('agent.drawer.calculating')
                    : contextSnapshot
                      ? t('agent.drawer.summary', {
                          tokens: contextSnapshot.tokensEstimate,
                          notes: contextSnapshot.vaultMatches.length,
                        })
                      : t('agent.drawer.dash')}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setRightOpen(false)}
                className="text-[16px] leading-none text-[var(--text-dim)] hover:text-[var(--text)]"
                aria-label={t('agent.drawer.closeAria')}
                title={t('agent.drawer.closeTitle')}
              >
                ×
              </button>
            </div>
            <div className="agent-drawer-scroll">
              <ContextPreview
                snapshot={contextSnapshot}
                loading={contextLoading}
                onRemoveMemory={removeMemory}
              />

              <details className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)]">
                <summary className="cursor-pointer list-none px-3 py-2 text-[12px] font-medium text-[var(--text-mute)] hover:text-[var(--text)]">
                  {t('agent.drawer.addMemory')}
                </summary>
                <div className="flex flex-col gap-2 border-t border-[var(--border)] px-3 py-3">
                  <Segmented
                    value={memoryDraftScope}
                    options={[
                      { value: 'project', label: t('agent.drawer.scopeProject') },
                      { value: 'global', label: t('agent.drawer.scopeGlobal') },
                      { value: 'session', label: t('agent.drawer.scopeSession') },
                    ]}
                    onChange={setMemoryDraftScope}
                  />
                  <input
                    value={memoryDraftKey}
                    onChange={(event) => setMemoryDraftKey(event.target.value)}
                    placeholder={t('agent.drawer.memoryKeyPlaceholder')}
                  />
                  <textarea
                    value={memoryDraftContent}
                    onChange={(event) => setMemoryDraftContent(event.target.value)}
                    placeholder={t('agent.drawer.memoryContentPlaceholder')}
                    className="min-h-[72px]"
                  />
                  <Button
                    tone="accent"
                    onClick={() => void saveMemory()}
                    disabled={!memoryDraftKey.trim() || !memoryDraftContent.trim()}
                  >
                    {t('agent.drawer.saveMemory')}
                  </Button>
                </div>
              </details>

              {providers.length > 0 ? (
                <div className="flex flex-wrap items-center gap-1 text-[10px] text-[var(--text-dim)]">
                  <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-faint)]">
                    {t('agent.drawer.cliHeading')}
                  </span>
                  {providers.map((p) => (
                    <Chip key={p.id} tone="neutral">
                      <code className="text-[10px]">{p.command}</code>
                    </Chip>
                  ))}
                </div>
              ) : null}
            </div>
          </aside>
        </div>
      ) : null}

      {/* Toast */}
      {toast ? (
        <output className="agent-toast" data-tone={toast.tone} aria-live="polite">
          {toast.message}
        </output>
      ) : null}
    </div>
  );
}

function SessionTile({
  session,
  active,
  onClick,
  onDelete,
}: {
  session: SessionSummary;
  active: boolean;
  onClick: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    // biome-ignore lint/a11y/useSemanticElements: <button> cannot contain the nested delete <button>; tabIndex+role+keyboard handlers give equivalent a11y
    <div
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onClick();
        }
      }}
      className={`group relative cursor-pointer rounded-[var(--radius)] border px-3 py-2 text-left transition ${active ? 'border-[rgba(100,210,255,0.45)] bg-[var(--accent-soft)]' : 'border-[var(--border)] bg-[var(--surface-1)] hover:border-[var(--border-strong)]'}`}
    >
      <button
        type="button"
        onClick={(event) => {
          event.stopPropagation();
          onDelete();
        }}
        onKeyDown={(event) => event.stopPropagation()}
        className="absolute right-1.5 top-1.5 flex h-5 w-5 items-center justify-center rounded-[var(--radius-sm)] text-[13px] leading-none text-[var(--text-faint)] opacity-0 transition hover:bg-[rgba(255,69,58,0.15)] hover:text-[var(--danger)] group-hover:opacity-100 focus:opacity-100"
        aria-label={t('agent.sessions.deleteAria', {
          label: session.title || session.id,
        })}
        title={t('agent.sessions.deleteTitle')}
      >
        ×
      </button>
      <div className="flex items-center gap-2 pr-5">
        <span
          className={`h-1.5 w-1.5 shrink-0 rounded-full ${session.context?.provider === 'codex' ? 'bg-[#ffd60a]' : 'bg-[#64d2ff]'}`}
        />
        <span className="truncate text-[13px] font-medium text-[var(--text)]">
          {session.title ||
            t('agent.sessions.sessionLabel', {
              provider: session.context?.provider || 'agent',
            })}
        </span>
      </div>
      <div className="mt-1 line-clamp-1 text-[11px] text-[var(--text-faint)]">
        {trimForPreview(session.last_message || '') || '—'}
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-[var(--text-dim)]">
        <span className="flex items-center gap-2">
          <span className="num">{t('agent.sessions.msgCount', { n: session.message_count })}</span>
          {session.total_tokens && session.total_tokens > 0 ? (
            <span className="num text-[var(--text-faint)]">
              {formatTokenCount(session.total_tokens)}
            </span>
          ) : null}
        </span>
        <span>{relativeTime(session.updated_at, t)}</span>
      </div>
    </div>
  );
}

function formatTokenCount(n: number): string {
  if (n < 1_000) return `${n} tok`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(n < 10_000 ? 1 : 0)}k tok`;
  return `${(n / 1_000_000).toFixed(2)}M tok`;
}

function InjectionBar({ meta }: { meta: UserInjectionMeta }) {
  const { t } = useTranslation();
  const memoriesTotal = meta.memoriesGlobal + meta.memoriesProject + meta.memoriesSession;
  const chips: Array<{ tone: 'accent' | 'success' | 'warn' | 'neutral'; label: string }> = [];
  if (meta.personaLoaded) {
    chips.push({ tone: 'accent', label: 'persona' });
  }
  if (meta.projectName) {
    chips.push({ tone: 'success', label: meta.projectName });
  }
  if (memoriesTotal > 0) {
    chips.push({ tone: 'warn', label: t('agent.injection.mem', { n: memoriesTotal }) });
  }
  if (meta.vaultMatches && meta.vaultMatches.length > 0) {
    chips.push({
      tone: 'neutral',
      label: t('agent.injection.vault', { n: meta.vaultMatches.length }),
    });
  }

  if (chips.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
      <span className="text-[var(--text-faint)]">{t('agent.injection.label')}</span>
      {chips.map((chip) => (
        <Chip key={chip.label} tone={chip.tone}>
          {chip.label}
        </Chip>
      ))}
      {meta.vaultMatches?.slice(0, 3).map((match) => (
        <span
          key={match.path}
          className="truncate text-[10px] text-[var(--text-faint)]"
          title={match.path}
        >
          {match.title}
        </span>
      ))}
    </div>
  );
}

function ContextPreview({
  snapshot,
  loading,
  onRemoveMemory,
}: {
  snapshot: ContextSnapshot | null;
  loading: boolean;
  onRemoveMemory: (id: string) => void;
}) {
  const { t } = useTranslation();
  if (loading && !snapshot) {
    return (
      <Card tight>
        <p className="text-[12px] text-[var(--text-dim)]">{t('agent.context.calculating')}</p>
      </Card>
    );
  }

  if (!snapshot) {
    return (
      <Card tight>
        <p className="text-[12px] text-[var(--text-dim)]">
          {t('agent.context.pickSessionToPreview')}
        </p>
      </Card>
    );
  }

  const personaHint = t('agent.context.personaHint', {
    identityCode: '§__IDENTITY__§',
    valuesCode: '§__VALUES__§',
  });
  const personaHintParts = personaHint.split(/(§__IDENTITY__§|§__VALUES__§)/);

  const noMemoryTemplate = t('agent.context.noProjectMemory', {
    memoryTag: '§__MEMORY_TAG__§',
  });
  const noMemoryParts = noMemoryTemplate.split('§__MEMORY_TAG__§');

  return (
    <div className="flex flex-col gap-3">
      {/* Persona */}
      <Card tight>
        <div className="flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
            {t('agent.context.personaHeading')}
          </span>
          <Chip tone={snapshot.persona.identity || snapshot.persona.values ? 'accent' : 'neutral'}>
            {snapshot.persona.identity || snapshot.persona.values
              ? t('agent.context.personaLoaded')
              : t('agent.context.personaEmpty')}
          </Chip>
        </div>
        {snapshot.persona.identity || snapshot.persona.values ? (
          <details className="mt-2 text-[12px]">
            <summary className="cursor-pointer text-[var(--text-mute)]">
              {t('agent.context.personaShow', { path: snapshot.persona.path ?? '' })}
            </summary>
            {snapshot.persona.identity ? (
              <div className="mt-2">
                <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
                  {t('agent.context.personaIdentity')}
                </div>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[12px] text-[var(--text-mute)]">
                  {snapshot.persona.identity}
                </pre>
              </div>
            ) : null}
            {snapshot.persona.values ? (
              <div className="mt-2">
                <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
                  {t('agent.context.personaValues')}
                </div>
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap text-[12px] text-[var(--text-mute)]">
                  {snapshot.persona.values}
                </pre>
              </div>
            ) : null}
          </details>
        ) : (
          <p className="mt-2 text-[11px] text-[var(--text-faint)]">
            {personaHintParts.map((part, idx) => {
              if (part === '§__IDENTITY__§') {
                return <code key={`id-${idx}-${part}`}>.collaborator/persona/identity.md</code>;
              }
              if (part === '§__VALUES__§') {
                return <code key={`val-${idx}-${part}`}>values.md</code>;
              }
              return <span key={`tx-${idx}-${part}`}>{part}</span>;
            })}
          </p>
        )}
      </Card>

      {/* Project */}
      <Card tight>
        <div className="flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
            {t('agent.context.projectHeading')}
          </span>
          <Chip tone={snapshot.projectId ? 'success' : 'neutral'}>
            {snapshot.projectName || t('agent.context.projectDetected')}
          </Chip>
        </div>
        {snapshot.projectPath ? (
          <div className="mt-1 truncate text-[11px] text-[var(--text-faint)]">
            {snapshot.projectPath}
          </div>
        ) : null}

        <div className="mt-2 flex flex-col gap-1">
          {snapshot.memories.project.length === 0 ? (
            <span className="text-[11px] text-[var(--text-faint)]">
              {noMemoryParts.map((part, idx) =>
                idx === 0 ? (
                  <span key={`nm-${idx}-${part}`}>{part}</span>
                ) : (
                  <span key={`nm-${idx}-${part}`}>
                    <code>&lt;memory&gt;</code>
                    {part}
                  </span>
                ),
              )}
            </span>
          ) : (
            snapshot.memories.project.map((memory) => (
              <MemoryLine key={memory.id} memory={memory} onRemove={onRemoveMemory} />
            ))
          )}
        </div>
      </Card>

      {/* Global memories */}
      {snapshot.memories.global.length > 0 ? (
        <Card tight>
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
              {t('agent.context.globalMemories')}
            </span>
            <Chip tone="accent">{snapshot.memories.global.length}</Chip>
          </div>
          <div className="mt-2 flex flex-col gap-1">
            {snapshot.memories.global.map((memory) => (
              <MemoryLine key={memory.id} memory={memory} onRemove={onRemoveMemory} />
            ))}
          </div>
        </Card>
      ) : null}

      {/* Session memories */}
      {snapshot.memories.session.length > 0 ? (
        <Card tight>
          <div className="flex items-center justify-between">
            <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
              {t('agent.context.sessionMemories')}
            </span>
            <Chip tone="neutral">{snapshot.memories.session.length}</Chip>
          </div>
          <div className="mt-2 flex flex-col gap-1">
            {snapshot.memories.session.map((memory) => (
              <MemoryLine key={memory.id} memory={memory} onRemove={onRemoveMemory} />
            ))}
          </div>
        </Card>
      ) : null}

      {/* Vault RAG */}
      <Card tight>
        <div className="flex items-center justify-between">
          <span className="text-[11px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
            {t('agent.context.vaultHeading')}
          </span>
          <Chip tone={snapshot.vaultMatches.length > 0 ? 'accent' : 'neutral'}>
            {snapshot.vaultMatches.length} / 5
          </Chip>
        </div>
        {snapshot.queryFallback && snapshot.queryFallback !== 'none' ? (
          <div className="mt-2 text-[10px] text-[var(--text-faint)]">
            {t('agent.context.queryLabel')}
            <span className="text-[var(--text-dim)]">
              {snapshot.queryFallback === 'prompt'
                ? t('agent.context.queryFromPrompt')
                : snapshot.queryFallback === 'last_user'
                  ? t('agent.context.queryFromLastUser')
                  : t('agent.context.queryFromTitle')}
            </span>
            {snapshot.queryPreview ? (
              <span className="ml-1 text-[var(--text-mute)] italic" title={snapshot.queryPreview}>
                — {snapshot.queryPreview.slice(0, 60)}
                {snapshot.queryPreview.length > 60 ? '…' : ''}
              </span>
            ) : null}
          </div>
        ) : null}
        {snapshot.vaultMatches.length === 0 ? (
          <p className="mt-2 text-[11px] text-[var(--text-faint)]">
            {snapshot.queryFallback === 'none'
              ? t('agent.context.vaultNoQuery')
              : t('agent.context.vaultNoMatches')}
          </p>
        ) : (
          <div className="mt-2 flex flex-col gap-1.5">
            {snapshot.vaultMatches.map((match) => (
              <div
                key={match.path}
                className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5"
                title={match.path}
              >
                <div className="truncate text-[12px] font-medium text-[var(--text)]">
                  {match.title}
                </div>
                <div className="truncate text-[10px] text-[var(--text-faint)]">{match.path}</div>
                <div className="mt-1 line-clamp-2 text-[11px] text-[var(--text-mute)]">
                  {match.snippet}
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function MemoryLine({
  memory,
  onRemove,
}: {
  memory: MemoryRow;
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  const sourceDot =
    memory.source === 'auto'
      ? 'bg-[#ffd60a]'
      : memory.source === 'persona'
        ? 'bg-[#bf5af2]'
        : 'bg-[#64d2ff]';

  return (
    <div className="group relative flex items-start gap-2 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] px-2 py-1.5">
      <span className={`mt-1 h-1.5 w-1.5 shrink-0 rounded-full ${sourceDot}`} />
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <span className="truncate text-[12px] font-medium text-[var(--text)]">
            {memory.pinned ? '📌 ' : ''}
            {memory.key}
          </span>
          <span className="text-[10px] text-[var(--text-faint)]">{memory.source}</span>
        </div>
        <p className="line-clamp-2 text-[11px] text-[var(--text-mute)]">{memory.content}</p>
      </div>
      <button
        type="button"
        onClick={() => onRemove(memory.id)}
        className="opacity-0 transition-opacity group-hover:opacity-100"
        aria-label={t('agent.memory.deleteAria')}
      >
        <span className="text-[11px] text-[var(--text-dim)] hover:text-[var(--danger)]">×</span>
      </button>
    </div>
  );
}

function QuickAction({
  label,
  description,
  onClick,
  disabled,
}: {
  label: string;
  description: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="flex flex-col items-start gap-0.5 rounded-[var(--radius-sm)] border border-transparent px-2 py-1.5 text-left transition hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-50"
    >
      <span className="text-[12px] font-medium text-[var(--text)]">{label}</span>
      <span className="text-[11px] text-[var(--text-dim)]">{description}</span>
    </button>
  );
}

function EmptyConversation({
  onUseStarter,
  disabled,
}: {
  onUseStarter: (prompt: string, mode: AgentMode) => void;
  disabled: boolean;
}) {
  const { t, locale } = useTranslation();
  return (
    <div className="flex min-h-[260px] flex-col items-center justify-center gap-4 text-center">
      <div>
        <div className="text-[15px] font-semibold text-[var(--text)]">{t('agent.empty.title')}</div>
        <div className="mt-1 text-[12px] text-[var(--text-dim)]">{t('agent.empty.subtitle')}</div>
      </div>
      <div className="grid w-full max-w-[480px] grid-cols-1 gap-2 sm:grid-cols-2">
        {getStarterPrompts(locale).map((starter) => {
          const starterMode = getAgentMode(starter.mode, locale);
          return (
            <button
              type="button"
              key={starter.title}
              onClick={() => onUseStarter(starter.prompt, starter.mode)}
              disabled={disabled}
              className="flex flex-col items-start gap-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-left transition hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              <div className="flex items-center gap-2">
                <Chip tone={starterMode.tone}>
                  {starterMode.icon} {starterMode.label}
                </Chip>
                <span className="text-[12px] font-medium text-[var(--text)]">{starter.title}</span>
              </div>
              <span className="text-[11px] text-[var(--text-dim)]">{starter.subtitle}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function MessageBubble({
  message,
  copiedId,
  onCopy,
  onRegenerate,
  running,
  highlight,
}: {
  message: AgentMessage;
  copiedId: string | null;
  onCopy: (id: string, text: string) => void;
  onRegenerate?: () => void;
  running: boolean;
  highlight?: string;
}) {
  const { t, locale } = useTranslation();
  void highlight;
  const toolMeta = parseToolMeta(message.tool_calls_json);
  const injection = parseInjection(toolMeta);
  const assistantMeta = parseAssistantMeta(toolMeta);
  const isUser = message.role === 'user';
  const isTool = message.role === 'tool';
  const isAssistant = message.role === 'assistant';
  const isCopied = copiedId === message.id;

  const roleLabel = isUser
    ? t('agent.message.roleYou')
    : isTool
      ? t('agent.message.roleTool')
      : assistantMeta?.provider || t('agent.message.roleAssistant');
  const roleColor = isUser
    ? 'text-[#64d2ff]'
    : isTool
      ? 'text-[#ffd60a]'
      : assistantMeta?.provider === 'codex'
        ? 'text-[#ffd60a]'
        : 'text-[#30d158]';

  return (
    <article
      className={`group rounded-[var(--radius)] border px-3 py-2.5 transition-colors ${isUser ? 'border-[rgba(100,210,255,0.24)] bg-[rgba(100,210,255,0.06)]' : isTool ? 'border-[rgba(255,214,10,0.32)] bg-[rgba(255,214,10,0.06)]' : 'border-[var(--border)] bg-[var(--surface-1)]'}`}
    >
      <header className="mb-1.5 flex items-center justify-between gap-2 text-[11px]">
        <div className="flex items-center gap-2">
          <span className={`font-semibold uppercase tracking-[0.08em] ${roleColor}`}>
            {roleLabel}
          </span>
          {assistantMeta?.model ? <Chip tone="neutral">{assistantMeta.model}</Chip> : null}
          {assistantMeta?.timedOut ? <Chip tone="danger">{t('agent.message.timeout')}</Chip> : null}
          {assistantMeta?.ok === false ? (
            <Chip tone="danger">{t('agent.message.exitNonZero')}</Chip>
          ) : null}
        </div>
        <div className="flex items-center gap-2 text-[var(--text-faint)]">
          <span className="num">{toDateTime(message.ts, locale)}</span>
        </div>
      </header>

      {isAssistant ? (
        <Markdown content={message.content || t('agent.message.emptyContent')} />
      ) : (
        <pre className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--text)]">
          {message.content || t('agent.message.emptyContent')}
        </pre>
      )}

      {injection && isUser ? <InjectionBar meta={injection} /> : null}

      {isAssistant && assistantMeta?.activities && assistantMeta.activities.length > 0 ? (
        <ActivityTimeline items={hydrateActivities(assistantMeta.activities)} />
      ) : null}

      {isAssistant && assistantMeta ? <AssistantFooter meta={assistantMeta} /> : null}

      {isAssistant ? (
        <footer className="mt-2 flex items-center gap-2 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Button
            tone="ghost"
            className="!px-2 !py-1 text-[11px]"
            onClick={() => onCopy(message.id, message.content || '')}
            aria-label={t('agent.message.copyAria')}
          >
            {isCopied ? t('agent.message.copied') : t('agent.message.copy')}
          </Button>
          {onRegenerate ? (
            <Button
              tone="ghost"
              className="!px-2 !py-1 text-[11px]"
              onClick={onRegenerate}
              disabled={running}
              aria-label={t('agent.message.regenerateAria')}
            >
              {t('agent.message.regenerate')}
            </Button>
          ) : null}
        </footer>
      ) : null}

      {assistantMeta?.remoteSessionId ? (
        <div className="mt-1 text-[10px] text-[var(--text-faint)]">
          {t('agent.message.remoteSession')}
          <code>{assistantMeta.remoteSessionId}</code>
        </div>
      ) : null}
    </article>
  );
}

function AssistantFooter({ meta }: { meta: AssistantMeta }) {
  const { t, locale } = useTranslation();
  const parts: string[] = [];
  if (meta.durationMs) {
    parts.push(formatDuration(meta.durationMs));
  }
  const sumUsage = (
    u:
      | NonNullable<AssistantMeta['usage']>
      | NonNullable<AssistantMeta['summaryUsage']>
      | null
      | undefined,
  ) => {
    if (!u) return 0;
    return u.inputTokens + u.outputTokens + (u.cacheCreateTokens || 0) + (u.cacheReadTokens || 0);
  };
  const mainTotal = sumUsage(meta.usage);
  const summaryTotal = sumUsage(meta.summaryUsage);
  const memoryPassTotal = sumUsage(meta.memoryPassUsage);
  const grandTotal = mainTotal + summaryTotal + memoryPassTotal;

  if (grandTotal > 0) {
    parts.push(t('agent.footer.tok', { n: numberLabel(grandTotal, locale) }));
  }
  if (meta.usage?.cacheReadTokens && meta.usage.cacheReadTokens > 0) {
    parts.push(t('agent.footer.cache', { n: numberLabel(meta.usage.cacheReadTokens, locale) }));
  }
  if (meta.usage?.reasoningTokens && meta.usage.reasoningTokens > 0) {
    parts.push(t('agent.footer.thinking', { n: numberLabel(meta.usage.reasoningTokens, locale) }));
  }
  if (summaryTotal > 0) {
    parts.push(t('agent.footer.summary', { n: numberLabel(summaryTotal, locale) }));
  }
  if (memoryPassTotal > 0) {
    parts.push(t('agent.footer.memory', { n: numberLabel(memoryPassTotal, locale) }));
  }
  const cost = formatCost(meta.costUsd);
  if (cost) {
    parts.push(cost);
  }

  if (parts.length === 0) {
    return null;
  }

  return (
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px] text-[var(--text-dim)]">
      {parts.map((part) => (
        <span
          key={part}
          className="inline-flex items-center rounded-full border border-[var(--border)] bg-[var(--surface-1)] px-2 py-0.5 num"
        >
          {part}
        </span>
      ))}
    </div>
  );
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function OptimisticUserBubble({ text }: { text: string }) {
  const { t } = useTranslation();
  return (
    <article className="rounded-[var(--radius)] border border-[rgba(100,210,255,0.24)] bg-[rgba(100,210,255,0.06)] px-3 py-2.5">
      <header className="mb-1.5 flex items-center gap-2 text-[11px]">
        <span className="font-semibold uppercase tracking-[0.08em] text-[#64d2ff]">
          {t('agent.message.roleYou')}
        </span>
        <span className="text-[var(--text-faint)]">{t('agent.optimistic.justNow')}</span>
      </header>
      <pre className="whitespace-pre-wrap text-[13px] leading-relaxed text-[var(--text)]">
        {text}
      </pre>
    </article>
  );
}

function usePhasePhrase(phase: StreamPhase, _tick: number, t: Translator): string {
  const bank = getThinkingPhrases(phase, t);
  if (!bank || bank.length === 0) {
    return getPhaseLabel(phase, t) || '';
  }
  return bank[0] ?? '';
}

function ActivityTimeline({ items }: { items: ActivityItem[] }) {
  const { t } = useTranslation();
  if (items.length === 0) {
    return null;
  }
  const tools = items.filter((i) => i.kind === 'tool').length;
  const thoughts = items.filter((i) => i.kind === 'thinking').length;
  const tasks = items.filter((i) => i.kind === 'task').length;
  const subs = items.filter((i) => i.kind === 'subagent').length;
  const chipParts: string[] = [];
  if (tools > 0)
    chipParts.push(
      tools > 1
        ? t('agent.activity.toolsMany', { n: tools })
        : t('agent.activity.toolsOne', { n: tools }),
    );
  if (thoughts > 0) chipParts.push(t('agent.activity.thoughts', { n: thoughts }));
  if (tasks > 0)
    chipParts.push(
      tasks > 1
        ? t('agent.activity.tasksMany', { n: tasks })
        : t('agent.activity.tasksOne', { n: tasks }),
    );
  if (subs > 0) chipParts.push(t('agent.activity.subagents', { n: subs }));
  const defaultOpen = items.length <= 8;
  const heading =
    items.length > 1
      ? t('agent.activity.headingMany', { n: items.length })
      : t('agent.activity.headingOne', { n: items.length });

  return (
    <details
      className="group flex flex-col gap-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--bg-alt)] p-2"
      open={defaultOpen}
    >
      <summary className="flex cursor-pointer list-none items-center justify-between px-1 text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
        <span>
          <span className="mr-1.5 inline-block transition-transform group-open:rotate-90">▸</span>
          {heading}
          {chipParts.length > 0 ? (
            <span className="ml-2 text-[var(--text-faint)] normal-case tracking-normal">
              {chipParts.join(' · ')}
            </span>
          ) : null}
        </span>
      </summary>
      <div className="mt-1 flex flex-col gap-1">
        {items.map((item) => (
          <ActivityRow key={item.id} item={item} />
        ))}
      </div>
    </details>
  );
}

function ActivityRow({ item }: { item: ActivityItem }) {
  const { t } = useTranslation();
  if (item.kind === 'thinking') {
    return (
      <details className="group rounded-[var(--radius-sm)] border border-transparent px-2 py-1 hover:bg-[var(--surface-1)]">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-[12px] text-[var(--text-mute)]">
          <span className="text-[var(--violet)]">💭</span>
          <span className="truncate">{t('agent.activity.innerThought')}</span>
          <span className="ml-auto text-[10px] text-[var(--text-faint)]">
            {t('agent.activity.charsSuffix', { n: item.text.length })}
          </span>
        </summary>
        <pre className="mt-1 max-h-[240px] overflow-auto whitespace-pre-wrap border-l-2 border-[rgba(191,90,242,0.3)] pl-2 text-[11px] text-[var(--text-mute)]">
          {item.text}
        </pre>
      </details>
    );
  }

  if (item.kind === 'subagent') {
    return (
      <details className="group rounded-[var(--radius-sm)] border border-transparent px-2 py-1 hover:bg-[var(--surface-1)]">
        <summary className="flex cursor-pointer list-none items-center gap-2 text-[12px] text-[var(--text-mute)]">
          <span>🧭</span>
          <span className="truncate">{t('agent.activity.subagentText')}</span>
          <span className="ml-auto text-[10px] text-[var(--text-faint)]">
            {t('agent.activity.charsSuffix', { n: item.text.length })}
          </span>
        </summary>
        <pre className="mt-1 max-h-[240px] overflow-auto whitespace-pre-wrap border-l-2 border-[rgba(100,210,255,0.3)] pl-2 text-[11px] text-[var(--text-mute)]">
          {item.text}
        </pre>
      </details>
    );
  }

  if (item.kind === 'task') {
    return (
      <div className="flex items-center gap-2 rounded-[var(--radius-sm)] px-2 py-1 text-[12px]">
        <span>🧭</span>
        <span className="truncate text-[var(--text-mute)]">
          {t('agent.activity.taskLabel')}
          <span className="text-[var(--text)]">{item.description}</span>
        </span>
      </div>
    );
  }

  const statusColor =
    item.status === 'ok'
      ? 'text-[var(--success)]'
      : item.status === 'error'
        ? 'text-[var(--danger)]'
        : 'text-[var(--text-dim)]';
  const statusLabel = item.status === 'ok' ? '✓' : item.status === 'error' ? '✕' : '…';
  const inputPretty =
    typeof item.input === 'string' ? item.input : JSON.stringify(item.input, null, 2);

  return (
    <details className="group rounded-[var(--radius-sm)] border border-transparent px-2 py-1 hover:bg-[var(--surface-1)]">
      <summary className="flex cursor-pointer list-none items-center gap-2 text-[12px]">
        <span className="shrink-0">{toolIcon(item.name)}</span>
        <span className="shrink-0 font-medium text-[var(--text)]">{item.name}</span>
        <span className="truncate text-[var(--text-mute)]">
          {toolSummary(item.name, item.input)}
        </span>
        <span className={`ml-auto shrink-0 num text-[11px] ${statusColor}`}>{statusLabel}</span>
      </summary>
      <div className="mt-1 flex flex-col gap-1 text-[11px]">
        <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-faint)]">
          {t('agent.activity.input')}
        </div>
        <pre className="max-h-[180px] overflow-auto whitespace-pre-wrap border-l-2 border-[var(--border)] pl-2 text-[var(--text-mute)]">
          {inputPretty}
        </pre>
        {item.result !== undefined ? (
          <>
            <div className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-faint)]">
              {t('agent.activity.resultBase')}
              {item.truncated ? t('agent.activity.truncatedSuffix') : ''}
              {item.status === 'error' ? t('agent.activity.errorSuffix') : ''}
            </div>
            <pre
              className={`max-h-[240px] overflow-auto whitespace-pre-wrap border-l-2 pl-2 ${
                item.status === 'error'
                  ? 'border-[rgba(255,69,58,0.3)] text-[var(--danger)]'
                  : 'border-[rgba(48,209,88,0.3)] text-[var(--text-mute)]'
              }`}
            >
              {item.result}
            </pre>
          </>
        ) : null}
      </div>
    </details>
  );
}

function PhaseBar({
  phase,
  elapsedMs,
  deltaCount,
  usage,
}: {
  phase: StreamPhase;
  elapsedMs: number;
  deltaCount: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreateTokens: number;
    cacheReadTokens: number;
  } | null;
}) {
  const { t, locale } = useTranslation();
  const phaseLabel = getPhaseLabel(phase, t);
  const usageTotal = usage
    ? usage.inputTokens + usage.outputTokens + usage.cacheCreateTokens + usage.cacheReadTokens
    : 0;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-dim)]">
      <Chip tone={PHASE_TONE[phase]}>{phaseLabel || t('agent.phase.streamFallback')}</Chip>
      <span className="ml-auto flex items-center gap-2 num text-[10px] text-[var(--text-faint)]">
        {usageTotal > 0 && usage ? (
          <span
            title={`in ${numberLabel(usage.inputTokens, locale)} · out ${numberLabel(usage.outputTokens, locale)} · cache read ${numberLabel(usage.cacheReadTokens, locale)} · cache write ${numberLabel(usage.cacheCreateTokens, locale)}`}
          >
            {t('agent.footer.tok', { n: numberLabel(usageTotal, locale) })}
            {usage.outputTokens > 0 ? ` · out ${numberLabel(usage.outputTokens, locale)}` : ''}
          </span>
        ) : null}
        {deltaCount > 0 ? (
          <span>
            {deltaCount > 1
              ? t('agent.stream.chunksMany', { n: deltaCount })
              : t('agent.stream.chunksOne', { n: deltaCount })}
          </span>
        ) : null}
        <span>{formatElapsed(elapsedMs)}</span>
      </span>
    </div>
  );
}

function TypingIndicator({
  spinnerFrame,
  phase,
  elapsedMs,
  activities,
  usage,
}: {
  spinnerFrame: number;
  phase: StreamPhase;
  elapsedMs: number;
  activities: ActivityItem[];
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreateTokens: number;
    cacheReadTokens: number;
  } | null;
}) {
  const { t } = useTranslation();
  const phrase = usePhasePhrase(phase, elapsedMs, t);
  return (
    <div className="thinking-shimmer flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2.5">
      <div className="flex items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[#30d158]">
          {t('agent.activity.assistant')}
        </span>
        <span className="num text-[13px] text-[var(--accent)]">
          {SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]}
        </span>
        <span className="typing-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
        <span className="text-[13px] text-[var(--text-mute)]">
          {phrase || t('agent.phase.defaultThinking')}
        </span>
      </div>
      <ActivityTimeline items={activities} />
      <PhaseBar phase={phase} elapsedMs={elapsedMs} deltaCount={0} usage={usage} />
    </div>
  );
}

function StreamingBubble({
  text,
  spinnerFrame,
  live,
  phase,
  elapsedMs,
  deltaCount,
  activities,
  running,
  usage,
}: {
  text: string;
  spinnerFrame: number;
  live: boolean;
  phase: StreamPhase;
  elapsedMs: number;
  deltaCount: number;
  activities: ActivityItem[];
  running: boolean;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheCreateTokens: number;
    cacheReadTokens: number;
  } | null;
}) {
  const { t } = useTranslation();
  const phrase = usePhasePhrase(phase, elapsedMs, t);
  const showPulse = running;
  return (
    <article
      className={`flex flex-col gap-2 rounded-[var(--radius)] border border-[rgba(48,209,88,0.24)] bg-[var(--surface-1)] px-3 py-2.5 ${
        running ? 'thinking-shimmer' : ''
      }`}
    >
      <header className="flex items-center justify-between gap-2 text-[11px]">
        <div className="flex items-center gap-2">
          <span className="font-semibold uppercase tracking-[0.08em] text-[#30d158]">
            {t('agent.activity.assistant')}
          </span>
          {running ? (
            <>
              <span className="num text-[13px] text-[var(--accent)]">
                {SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]}
              </span>
              <span className="typing-dots" aria-hidden="true">
                <span />
                <span />
                <span />
              </span>
              {phrase ? (
                <span className="text-[12px] text-[var(--text-mute)]">{phrase}</span>
              ) : null}
            </>
          ) : (
            <Chip tone={live ? 'success' : 'neutral'}>
              <span className="num">{SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]}</span>
              {live ? t('agent.stream.streaming') : t('agent.stream.received')}
            </Chip>
          )}
        </div>
        <span className="num text-[10px] text-[var(--text-faint)]">
          {t('agent.stream.charsSuffix', { n: text.length })}
        </span>
      </header>
      <ActivityTimeline items={activities} />
      <Markdown content={text} />
      {showPulse ? (
        <span className="pulse-accent mt-1 inline-block h-3 w-[2px] bg-[var(--accent)]" />
      ) : null}
      <PhaseBar phase={phase} elapsedMs={elapsedMs} deltaCount={deltaCount} usage={usage} />
    </article>
  );
}

function Composer({
  prompt,
  setPrompt,
  mode,
  onSend,
  onStop,
  running,
  disabled,
  timeoutSec,
  setTimeoutSec,
  contextTokens,
  contextNotes,
  spinnerFrame,
}: {
  prompt: string;
  setPrompt: (value: string) => void;
  mode: AgentMode;
  onSend: () => void;
  onStop: () => void;
  running: boolean;
  disabled: boolean;
  timeoutSec: number;
  setTimeoutSec: (value: number) => void;
  contextTokens: number;
  contextNotes: number;
  spinnerFrame: number;
}) {
  const { t, locale } = useTranslation();
  const modeConfig = getAgentMode(mode, locale);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const element = textareaRef.current;
    if (!element) {
      return;
    }
    element.style.height = 'auto';
    const next = Math.min(260, element.scrollHeight);
    element.style.height = `${next}px`;
  }, [prompt]);

  const memoryHintTemplate = t('agent.composer.memoryHint', {
    memoryTag: '§__MEMORY_TAG__§',
  });
  const memoryHintParts = memoryHintTemplate.split('§__MEMORY_TAG__§');

  const composerInner = (
    <div className="agent-composer-inner">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-[var(--text-dim)]">
        <Chip tone={modeConfig.tone}>
          {t('agent.composer.modeChip', {
            icon: modeConfig.icon,
            label: modeConfig.label.toLowerCase(),
          })}
          {modeConfig.toolPolicy === 'none' ? t('agent.composer.noTools') : null}
          {modeConfig.toolPolicy === 'read-only' ? t('agent.composer.readOnly') : null}
        </Chip>
        <Chip tone="neutral">
          <span className="num">{contextTokens}</span> {t('agent.composer.tokContext')}
        </Chip>
        <Chip tone="neutral">
          <span className="num">{contextNotes}</span> {t('agent.composer.notesVault')}
        </Chip>
        <span className="ml-auto flex items-center gap-1.5">
          {t('agent.composer.timeout')}
          <input
            type="number"
            min={5}
            max={600}
            value={timeoutSec}
            onChange={(event) => setTimeoutSec(Number(event.target.value) || 120)}
            className="w-14 !py-0.5 !text-[11px]"
          />
          s
        </span>
      </div>

      <div className="relative">
        <textarea
          ref={textareaRef}
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          placeholder={t('agent.composer.placeholder', {
            label: modeConfig.label,
            hint: modeConfig.hint,
          })}
          disabled={disabled}
          className="!min-h-[88px] w-full resize-none !pr-[120px] !text-[13.5px] leading-relaxed"
          style={{ maxHeight: 260 }}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              if (!running && !disabled) {
                onSend();
              }
            }
          }}
        />
        <div className="absolute right-2 bottom-2 flex items-center gap-1.5">
          {running ? (
            <>
              <span className="num text-[12px] text-[var(--accent)]">
                {SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]}
              </span>
              <Button tone="neutral" onClick={onStop} className="!px-2 !py-1 !text-[11px]">
                {t('agent.composer.stop')}
              </Button>
            </>
          ) : (
            <Button
              tone="primary"
              onClick={onSend}
              disabled={disabled || !prompt.trim()}
              className="!px-3 !py-1 !text-[11px]"
            >
              {t('agent.composer.send')}
            </Button>
          )}
        </div>
      </div>

      <span className="text-[10px] text-[var(--text-faint)]">
        {memoryHintParts.map((part, idx) =>
          idx === 0 ? (
            <span key={`mh-${idx}-${part}`}>{part}</span>
          ) : (
            <span key={`mh-${idx}-${part}`}>
              <code>&lt;memory key="..." scope="project"&gt;…&lt;/memory&gt;</code>
              {part}
            </span>
          ),
        )}
      </span>
    </div>
  );

  return composerInner;
}
