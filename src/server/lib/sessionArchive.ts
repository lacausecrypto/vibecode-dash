import type { Database } from 'bun:sqlite';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { type Settings, expandHomePath } from '../config';
import { listMemories } from './memory';

/**
 * Export a conversation to a markdown file under `{vault}/Sessions/`. This is
 * the "episodic memory" layer of the Karpathy LLM OS — raw chronological log
 * of notable exchanges, browsable in Obsidian. Distillation into evergreen
 * Concepts/Projects is a separate, manual step.
 */

export type SessionArchiveInput = {
  settings: Settings;
  db: Database;
  session: {
    id: string;
    title: string | null;
    created_at: number;
    context_json: string | null;
  };
  messages: Array<{
    role: string;
    content: string | null;
    ts: number;
  }>;
  project: { id: string; name: string; path: string } | null;
};

export type SessionArchiveResult = {
  path: string;
  relativePath: string;
  bytes: number;
};

function formatDate(ts: number): string {
  const d = new Date(ts * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts * 1000);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function slugify(input: string): string {
  return (
    input
      .toLowerCase()
      .normalize('NFD')
      .replace(/\p{Diacritic}/gu, '')
      .replace(/[^a-z0-9-]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60) || 'session'
  );
}

function roleLabel(role: string): string {
  if (role === 'user') return 'User';
  if (role === 'assistant') return 'Assistant';
  if (role === 'tool') return 'Tool';
  return role;
}

function renderMessages(messages: SessionArchiveInput['messages']): string {
  const parts: string[] = [];
  for (const message of messages) {
    const content = (message.content || '').trim();
    if (!content) {
      continue;
    }
    parts.push(`## ${roleLabel(message.role)} · ${formatTime(message.ts)}`);
    parts.push('');
    parts.push(content);
    parts.push('');
  }
  return parts.join('\n').trim();
}

function renderMemoriesBlock(db: Database, sessionId: string, projectId: string | null): string {
  const global = listMemories(db, 'global');
  const projectMems = projectId ? listMemories(db, `project:${projectId}`) : [];
  const sessionMems = listMemories(db, `session:${sessionId}`);

  const all = [
    ...projectMems.filter((m) => m.related_session_id === sessionId),
    ...sessionMems,
    ...global.filter((m) => m.related_session_id === sessionId),
  ];

  if (all.length === 0) {
    return '';
  }

  const lines = all.map((m) => {
    const scopeLabel = m.scope.startsWith('project:')
      ? 'projet'
      : m.scope.startsWith('session:')
        ? 'session'
        : 'global';
    return `- **[${scopeLabel}] ${m.key}** · ${m.content.trim()} _(${m.source})_`;
  });

  return ['## Mémoires distillées', '', ...lines, ''].join('\n');
}

function buildFrontMatter(options: {
  sessionId: string;
  date: string;
  provider: string | null;
  model: string | null;
  project: string | null;
  title: string;
}): string {
  const lines: string[] = ['---', 'type: session'];
  lines.push(`session_id: ${options.sessionId}`);
  lines.push(`date: ${options.date}`);
  if (options.provider) {
    lines.push(`provider: ${options.provider}`);
  }
  if (options.model) {
    lines.push(`model: ${options.model}`);
  }
  if (options.project) {
    lines.push(`project: "[[Projects/${options.project}]]"`);
  }
  lines.push(`title: ${JSON.stringify(options.title)}`);
  lines.push('collab_reviewed: false');
  const tags = ['session'];
  if (options.provider) tags.push(options.provider);
  tags.push(options.date.slice(0, 7)); // YYYY-MM bucket for time-based filters
  if (options.project) tags.push(`project/${options.project}`);
  lines.push(`tags: [${tags.map((t) => JSON.stringify(t)).join(', ')}]`);
  lines.push('---');
  return lines.join('\n');
}

export async function archiveSessionToVault(
  input: SessionArchiveInput,
): Promise<SessionArchiveResult> {
  if (!input.settings.paths.vaultPath) {
    throw new Error('vault_not_configured');
  }

  const vaultRoot = resolve(expandHomePath(input.settings.paths.vaultPath));
  const sessionsDir = join(vaultRoot, 'Sessions');
  await mkdir(sessionsDir, { recursive: true });

  const date = formatDate(input.session.created_at);
  const context = (() => {
    try {
      return input.session.context_json
        ? (JSON.parse(input.session.context_json) as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  })();

  const provider = typeof context.provider === 'string' ? (context.provider as string) : null;
  const model = typeof context.model === 'string' ? (context.model as string) : null;
  const title = input.session.title?.trim() || 'Session agent';
  const slug = slugify(title);
  const filename = `${date}_${slug}.md`;
  const fullPath = join(sessionsDir, filename);
  const relativePath = `Sessions/${filename}`;

  const frontMatter = buildFrontMatter({
    sessionId: input.session.id,
    date,
    provider,
    model,
    project: input.project?.name || null,
    title,
  });

  const heading = `# ${title}`;
  const metaLine = [
    provider ? `**${provider}**` : null,
    model ? `\`${model}\`` : null,
    input.project ? `projet : [[Projects/${input.project.name}]]` : null,
    `${input.messages.length} message${input.messages.length > 1 ? 's' : ''}`,
  ]
    .filter(Boolean)
    .join(' · ');

  const memoriesBlock = renderMemoriesBlock(input.db, input.session.id, input.project?.id || null);
  const body = renderMessages(input.messages);

  const content = [
    frontMatter,
    '',
    heading,
    '',
    `> ${metaLine}`,
    '',
    memoriesBlock,
    memoriesBlock ? '' : null,
    '## Conversation',
    '',
    body,
    '',
  ]
    .filter((p): p is string => p !== null)
    .join('\n');

  await writeFile(fullPath, content, 'utf8');

  return {
    path: fullPath,
    relativePath,
    bytes: Buffer.byteLength(content, 'utf8'),
  };
}
