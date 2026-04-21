import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Heatmap } from '../components/Heatmap';
import { Markdown } from '../components/Markdown';
import { VaultGraphCanvas } from '../components/VaultGraphCanvas';
import { Button, Card, Chip, Empty, Section, Segmented } from '../components/ui';
import { apiGet, apiPost } from '../lib/api';
import { type Locale, dateLocale, formatNumber, useTranslation } from '../lib/i18n';

type Translator = (key: string, vars?: Record<string, string | number>) => string;

type NoteSummary = {
  path: string;
  title: string;
  modified: number;
  size: number;
  tags_json: string | null;
  outgoing_count?: number;
  backlinks_count?: number;
};

type SearchResult = {
  path: string;
  title: string;
  snippet: string;
  score: number;
};

type GraphNode = {
  id: string;
  title: string;
  modified: number;
};

type GraphEdge = {
  src: string;
  dst: string;
  display: string | null;
};

type GraphResponse = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

type TagStat = {
  tag: string;
  count: number;
};

type NoteDetail = {
  path: string;
  title: string;
  body: string;
  tags_json: string | null;
  backlinks: Array<{ src: string; display: string | null }>;
  outgoing: Array<{ dst: string; display: string | null }>;
};

type ActivityDay = { date: string; notes: number };

type Tab = 'recent' | 'orphans' | 'folders' | 'hubs' | 'tags';
type Sort = 'modified' | 'size' | 'degree' | 'alpha';

type BootstrapResponse = {
  ok: boolean;
  bootstrap: {
    created: string[];
    skipped: string[];
    vaultRoot: string;
    files: number;
  };
  reindex: {
    indexed: number;
    links: number;
    tags: number;
    durationMs: number;
  };
};

const FOLDER_COLORS: Record<string, string> = {
  Persona: '#bf5af2',
  Projects: '#64d2ff',
  Sessions: '#ffd60a',
  Daily: '#30d158',
  Inbox: '#ff9500',
  Concepts: '#5e5ce6',
  People: '#ff375f',
  Resources: '#0a84ff',
  Archive: '#8e8e93',
};

function folderFromPath(p: string): string {
  if (!p) return '';
  const idx = p.indexOf('/');
  return idx >= 0 ? p.slice(0, idx) : '';
}

function folderColor(folder: string): string {
  return FOLDER_COLORS[folder] || '#6e6e73';
}

function titleFromPath(p: string): string {
  if (!p) return '';
  const slash = p.lastIndexOf('/');
  const base = slash >= 0 ? p.slice(slash + 1) : p;
  return base.replace(/\.md$/, '');
}

function parseTags(tagsJson: string | null): string[] {
  if (!tagsJson) return [];
  try {
    const parsed = JSON.parse(tagsJson) as string[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function stripHtml(input: string): string {
  return input.replace(/<[^>]+>/g, '');
}

function formatShortDate(ts: number | null | undefined, tr: Translator, locale: Locale): string {
  if (!ts) return 'n/a';
  const d = new Date(ts * 1000);
  const diff = Math.floor((Date.now() - d.getTime()) / 86_400_000);
  if (diff <= 0) return tr('vault.relative.today');
  if (diff === 1) return tr('vault.relative.yesterday');
  if (diff < 7) return tr('vault.relative.days', { n: diff });
  if (diff < 30) return tr('vault.relative.weeks', { n: Math.floor(diff / 7) });
  if (diff < 365)
    return d.toLocaleDateString(dateLocale(locale), { day: '2-digit', month: 'short' });
  return d.toLocaleDateString(dateLocale(locale), { month: 'short', year: '2-digit' });
}

function formatSize(bytes: number): string {
  if (!bytes) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} kB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function buildAnnualDays(activity: ActivityDay[]) {
  const byDate = new Map<string, number>();
  for (const d of activity || []) byDate.set(d.date, Number(d.notes || 0));
  const year = new Date().getUTCFullYear();
  const out: Array<{ date: string; count: number; color?: string | null }> = [];
  const cursor = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year, 11, 31));
  while (cursor <= end) {
    const iso = cursor.toISOString().slice(0, 10);
    out.push({ date: iso, count: byDate.get(iso) || 0, color: null });
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return out;
}

function sortLabel(sort: Sort, tr: Translator): string {
  switch (sort) {
    case 'modified':
      return tr('vault.index.sortModified');
    case 'size':
      return tr('vault.index.sortSize');
    case 'degree':
      return tr('vault.index.sortDegree');
    case 'alpha':
      return tr('vault.index.sortAlpha');
  }
}

export default function VaultRoute() {
  const { t, locale } = useTranslation();
  const [tab, setTab] = useState<Tab>('recent');
  const [sort, setSort] = useState<Sort>('modified');
  const [query, setQuery] = useState('');
  const [graphOpen, setGraphOpen] = useState(true);
  const [notes, setNotes] = useState<NoteSummary[]>([]);
  const [orphans, setOrphans] = useState<NoteSummary[]>([]);
  const [tags, setTags] = useState<TagStat[]>([]);
  const [graph, setGraph] = useState<GraphResponse | null>(null);
  const [activity, setActivity] = useState<ActivityDay[]>([]);
  const [searchResults, setSearchResults] = useState<SearchResult[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedNote, setSelectedNote] = useState<NoteDetail | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [reindexing, setReindexing] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(false);
  const [bootstrapResult, setBootstrapResult] = useState<BootstrapResponse | null>(null);

  async function loadBase() {
    setLoading(true);
    setStatus(null);
    try {
      const [recentNotes, orphanNotes, tagStats, graphData, activityData] = await Promise.all([
        apiGet<NoteSummary[]>('/api/obsidian/notes?limit=500'),
        apiGet<NoteSummary[]>('/api/obsidian/orphans?limit=200'),
        apiGet<TagStat[]>('/api/obsidian/tags'),
        apiGet<GraphResponse>('/api/obsidian/graph?nodes=1500&edges=6000'),
        apiGet<ActivityDay[]>('/api/obsidian/activity?days=365'),
      ]);

      setNotes(recentNotes);
      setOrphans(orphanNotes);
      setTags(tagStats);
      setGraph(graphData);
      setActivity(activityData);

      const first = recentNotes[0]?.path || null;
      if (first && !selectedPath) {
        setSelectedPath(first);
      }
    } catch (error) {
      setStatus(t('vault.status.loadError', { error: String(error) }));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadBase();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedPath) {
      setSelectedNote(null);
      return;
    }
    apiGet<NoteDetail>(`/api/obsidian/note?path=${encodeURIComponent(selectedPath)}`)
      .then((note) => setSelectedNote(note))
      .catch((error) => setStatus(t('vault.status.noteError', { error: String(error) })));
  }, [selectedPath, t]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setSearchResults([]);
      return;
    }
    const timeout = setTimeout(() => {
      apiGet<SearchResult[]>(`/api/obsidian/notes/search?q=${encodeURIComponent(q)}&limit=100`)
        .then((results) => setSearchResults(results))
        .catch((error) => setStatus(t('vault.status.searchError', { error: String(error) })));
    }, 180);
    return () => clearTimeout(timeout);
  }, [query, t]);

  async function bootstrap() {
    setBootstrapping(true);
    setStatus(null);
    try {
      const result = await apiPost<BootstrapResponse>('/api/obsidian/bootstrap', {});
      setBootstrapResult(result);
      setStatus(
        result.ok
          ? t('vault.status.bootstrapOk', {
              created: result.bootstrap.created.length,
              indexed: result.reindex.indexed,
            })
          : t('vault.status.bootstrapFail'),
      );
      await loadBase();
    } catch (error) {
      setStatus(t('vault.status.bootstrapError', { error: String(error) }));
    } finally {
      setBootstrapping(false);
    }
  }

  async function reindex() {
    setReindexing(true);
    setStatus(t('vault.status.indexing'));
    try {
      const result = await apiPost<{
        ok: boolean;
        indexed: number;
        links: number;
        tags: number;
        durationMs: number;
      }>('/api/obsidian/reindex', { force: true });
      setStatus(
        t('vault.status.reindexDone', {
          indexed: result.indexed,
          links: result.links,
          tags: result.tags,
          ms: result.durationMs,
        }),
      );
      await loadBase();
    } catch (error) {
      setStatus(t('vault.status.reindexError', { error: String(error) }));
    } finally {
      setReindexing(false);
    }
  }

  const degreeMap = useMemo(() => {
    const m = new Map<string, number>();
    for (const edge of graph?.edges || []) {
      m.set(edge.src, (m.get(edge.src) || 0) + 1);
      m.set(edge.dst, (m.get(edge.dst) || 0) + 1);
    }
    return m;
  }, [graph]);

  const folderStats = useMemo(() => {
    const map = new Map<
      string,
      { folder: string; count: number; lastModified: number; size: number }
    >();
    for (const note of notes) {
      const folder = folderFromPath(note.path) || t('vault.index.folderRacine');
      const prev = map.get(folder) || {
        folder,
        count: 0,
        lastModified: 0,
        size: 0,
      };
      prev.count += 1;
      prev.lastModified = Math.max(prev.lastModified, note.modified);
      prev.size += note.size || 0;
      map.set(folder, prev);
    }
    return [...map.values()].sort((a, b) => b.count - a.count);
  }, [notes, t]);

  const hubs = useMemo(() => {
    return [...(graph?.nodes || [])]
      .map((node) => ({
        id: node.id,
        title: node.title,
        modified: node.modified,
        degree: degreeMap.get(node.id) || 0,
      }))
      .filter((node) => node.degree > 0)
      .sort((a, b) => b.degree - a.degree)
      .slice(0, 40);
  }, [graph, degreeMap]);

  const listItems = useMemo(() => {
    const base = tab === 'orphans' ? orphans : notes;
    const q = query.trim();
    let items: NoteSummary[] = base;

    if (q.length >= 2) {
      const matched = new Set(searchResults.map((r) => r.path));
      items = base.filter((note) => matched.has(note.path));
    }

    const sorted = [...items];
    if (sort === 'modified') sorted.sort((a, b) => b.modified - a.modified);
    else if (sort === 'size') sorted.sort((a, b) => (b.size || 0) - (a.size || 0));
    else if (sort === 'degree')
      sorted.sort((a, b) => (degreeMap.get(b.path) || 0) - (degreeMap.get(a.path) || 0));
    else if (sort === 'alpha')
      sorted.sort((a, b) => (a.title || a.path).localeCompare(b.title || b.path));

    return sorted.slice(0, 250);
  }, [tab, query, notes, orphans, searchResults, sort, degreeMap]);

  const maxTagCount = useMemo(() => Math.max(1, ...tags.map((t) => t.count)), [tags]);

  const nodeTagsMap = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const note of notes) {
      const tags = parseTags(note.tags_json);
      if (tags.length > 0) map.set(note.path, tags);
    }
    return map;
  }, [notes]);
  const activityTotal = useMemo(
    () => activity.reduce((acc, d) => acc + Number(d.notes || 0), 0),
    [activity],
  );

  const stats = {
    notes: notes.length,
    orphans: orphans.length,
    tags: tags.length,
    edges: graph?.edges.length || 0,
    folders: folderStats.length,
    density: notes.length > 0 ? (graph?.edges.length || 0) / notes.length : 0,
  };

  const searching = query.trim().length >= 2;

  return (
    <div className="flex flex-col gap-4">
      <Section
        title={t('vault.title')}
        meta={t('vault.meta')}
        action={
          <Button tone="accent" onClick={() => void reindex()} disabled={reindexing}>
            {reindexing ? t('vault.reindexing') : t('vault.reindex')}
          </Button>
        }
      >
        {status ? (
          <div className="rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-1.5 text-[12px] text-[var(--text-mute)]">
            {status}
          </div>
        ) : null}

        <StatStrip stats={stats} t={t} />
      </Section>

      <Section
        title={t('vault.activity.title')}
        meta={t('vault.activity.meta', {
          year: String(new Date().getUTCFullYear()),
          n: formatNumber(activityTotal, locale),
        })}
      >
        <Card>
          <Heatmap
            days={buildAnnualDays(activity)}
            palette="cyan"
            totalLabel={t('vault.activityTotalLabel')}
            totalValue={activityTotal}
          />
        </Card>
      </Section>

      {!loading && stats.notes === 0 ? (
        <BootstrapPanel
          busy={bootstrapping || reindexing}
          onBootstrap={() => void bootstrap()}
          onReindex={() => void reindex()}
          result={bootstrapResult}
          t={t}
        />
      ) : null}

      {stats.notes > 0 ? (
        <Section
          title={t('vault.map.title')}
          meta={t('vault.map.meta', {
            nodes: String(graph?.nodes.length || 0),
            edges: String(graph?.edges.length || 0),
          })}
          action={
            <Button tone="ghost" onClick={() => setGraphOpen((o) => !o)}>
              {graphOpen ? t('vault.mapExpanded') : t('vault.mapCollapsed')}
            </Button>
          }
        >
          {graphOpen ? (
            <Card>
              {graph && graph.nodes.length > 0 ? (
                <VaultGraphCanvas
                  graph={graph}
                  selected={selectedPath}
                  onSelect={setSelectedPath}
                  nodeTags={nodeTagsMap}
                  folderColor={folderColor}
                  folderFromPath={folderFromPath}
                  titleFromPath={titleFromPath}
                  height={560}
                />
              ) : (
                <Empty>{t('vault.map.notIndexed')}</Empty>
              )}
            </Card>
          ) : null}
        </Section>
      ) : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <Section
          title={t('vault.index.title')}
          meta={
            tab === 'recent' || tab === 'orphans'
              ? t('vault.index.metaSearch', {
                  count: String(listItems.length),
                  sort: sortLabel(sort, t),
                  searchSuffix: searching ? t('vault.index.ftsFilter') : '',
                })
              : tab === 'folders'
                ? t('vault.index.metaFolders', { count: String(folderStats.length) })
                : tab === 'hubs'
                  ? t('vault.index.metaHubs', { count: String(hubs.length) })
                  : t('vault.index.metaTags', { count: String(tags.length) })
          }
        >
          <Card>
            <div className="flex flex-col gap-2">
              <div className="relative">
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder={t('vault.index.searchPlaceholder')}
                  className="w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2 text-[13px] text-[var(--text)] placeholder:text-[var(--text-faint)] focus:border-[var(--accent)] focus:outline-none"
                />
                {searching ? (
                  <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] uppercase tracking-wider text-[var(--accent)]">
                    {searchResults.length}
                  </span>
                ) : null}
              </div>

              <div className="flex flex-wrap items-center justify-between gap-2">
                <Segmented<Tab>
                  value={tab}
                  options={[
                    { value: 'recent', label: t('vault.index.tabRecent') },
                    { value: 'orphans', label: t('vault.index.tabOrphans') },
                    { value: 'folders', label: t('vault.index.tabFolders') },
                    { value: 'hubs', label: t('vault.index.tabHubs') },
                    { value: 'tags', label: t('vault.index.tabTags') },
                  ]}
                  onChange={setTab}
                />
                {tab === 'recent' || tab === 'orphans' ? (
                  <Segmented<Sort>
                    value={sort}
                    options={[
                      { value: 'modified', label: t('vault.index.sortModified') },
                      { value: 'size', label: t('vault.index.sortSize') },
                      { value: 'degree', label: t('vault.index.sortDegree') },
                      { value: 'alpha', label: t('vault.index.sortAlpha') },
                    ]}
                    onChange={setSort}
                  />
                ) : null}
              </div>
            </div>

            <div className="mt-3 max-h-[70vh] min-h-[280px] overflow-y-auto pr-1">
              {loading ? (
                <p className="py-4 text-center text-[12px] text-[var(--text-dim)]">
                  {t('vault.loading')}
                </p>
              ) : null}

              {!loading && (tab === 'recent' || tab === 'orphans') ? (
                listItems.length === 0 ? (
                  <Empty>
                    {searching ? t('vault.index.emptySearch') : t('vault.index.emptyNotes')}
                  </Empty>
                ) : (
                  <div className="flex flex-col gap-1">
                    {searching
                      ? searchResults
                          .slice(0, 100)
                          .map((res) => (
                            <SearchResultRow
                              key={res.path}
                              result={res}
                              degree={degreeMap.get(res.path) || 0}
                              selected={selectedPath}
                              onSelect={setSelectedPath}
                            />
                          ))
                      : listItems.map((note) => (
                          <NoteRow
                            key={note.path}
                            note={note}
                            degree={degreeMap.get(note.path) || 0}
                            selected={selectedPath}
                            onSelect={setSelectedPath}
                            t={t}
                            locale={locale}
                          />
                        ))}
                  </div>
                )
              ) : null}

              {tab === 'folders' ? (
                folderStats.length === 0 ? (
                  <Empty>{t('vault.index.emptyFolders')}</Empty>
                ) : (
                  <div className="flex flex-col gap-1">
                    {folderStats.map((folder) => (
                      <FolderRow
                        key={folder.folder}
                        folder={folder}
                        total={stats.notes}
                        t={t}
                        locale={locale}
                      />
                    ))}
                  </div>
                )
              ) : null}

              {tab === 'hubs' ? (
                hubs.length === 0 ? (
                  <Empty>{t('vault.index.emptyHubs')}</Empty>
                ) : (
                  <div className="flex flex-col gap-1">
                    {hubs.map((hub) => (
                      <HubRow
                        key={hub.id}
                        hub={hub}
                        maxDegree={Math.max(1, hubs[0]?.degree || 1)}
                        selected={selectedPath}
                        onSelect={setSelectedPath}
                        t={t}
                      />
                    ))}
                  </div>
                )
              ) : null}

              {tab === 'tags' ? (
                tags.length === 0 ? (
                  <Empty>{t('vault.index.emptyTags')}</Empty>
                ) : (
                  <div className="flex flex-wrap gap-1.5">
                    {tags.map((tag) => (
                      <TagChip key={tag.tag} tag={tag} max={maxTagCount} />
                    ))}
                  </div>
                )
              ) : null}
            </div>
          </Card>
        </Section>

        <Section
          title={t('vault.detail.title')}
          meta={selectedNote ? titleFromPath(selectedNote.path) : t('vault.detail.noSelection')}
        >
          <Card>
            {!selectedNote ? (
              <Empty>{t('vault.detail.selectPrompt')}</Empty>
            ) : (
              <NoteDetailView note={selectedNote} onNavigate={setSelectedPath} t={t} />
            )}
          </Card>
        </Section>
      </div>
    </div>
  );
}

function StatStrip({
  stats,
  t,
}: {
  stats: {
    notes: number;
    orphans: number;
    tags: number;
    edges: number;
    folders: number;
    density: number;
  };
  t: Translator;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-1 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-4 py-2.5">
      <InlineStat label={t('vault.stats.notes')} value={String(stats.notes)} color="#64d2ff" />
      <InlineStat
        label={t('vault.stats.orphans')}
        value={String(stats.orphans)}
        color={stats.orphans > 0 ? '#ff9500' : 'var(--text-dim)'}
      />
      <InlineStat label={t('vault.stats.tags')} value={String(stats.tags)} color="#bf5af2" />
      <InlineStat label={t('vault.stats.links')} value={String(stats.edges)} color="#30d158" />
      <InlineStat label={t('vault.stats.folders')} value={String(stats.folders)} color="#5e5ce6" />
      <InlineStat
        label={t('vault.stats.density')}
        value={t('vault.stats.densityValue', { n: stats.density.toFixed(1) })}
        color="#ffd60a"
      />
    </div>
  );
}

function InlineStat({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color: string;
}) {
  return (
    <div className="flex items-baseline gap-1.5">
      <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
        {label}
      </span>
      <span className="num text-[16px] font-semibold" style={{ color }}>
        {value}
      </span>
    </div>
  );
}

function NoteRow({
  note,
  selected,
  onSelect,
  degree,
  t,
  locale,
}: {
  note: NoteSummary;
  selected: string | null;
  onSelect: (path: string) => void;
  degree: number;
  t: Translator;
  locale: Locale;
}) {
  const active = selected === note.path;
  const folder = folderFromPath(note.path);
  return (
    <button
      type="button"
      onClick={() => onSelect(note.path)}
      className={`group flex items-center gap-2 rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-left transition ${active ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)] bg-[var(--surface-1)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)]'}`}
      aria-pressed={active}
    >
      <span
        aria-hidden="true"
        className="h-2 w-2 shrink-0 rounded-full"
        style={{ backgroundColor: folderColor(folder) }}
      />
      <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--text)]">
        {titleFromPath(note.path)}
      </span>
      {folder ? (
        <span className="shrink-0 text-[9.5px] uppercase tracking-wider text-[var(--text-faint)]">
          {folder}
        </span>
      ) : null}
      <span className="num shrink-0 text-[10px] tabular-nums text-[var(--text-faint)]">
        {t('vault.noteRowMeta', {
          back: String(note.backlinks_count ?? 0),
          out: String(note.outgoing_count ?? 0),
          deg: degree > 0 ? t('vault.noteRowDeg', { n: degree }) : '',
          size: formatSize(note.size),
          date: formatShortDate(note.modified, t, locale),
        })}
      </span>
    </button>
  );
}

function SearchResultRow({
  result,
  selected,
  onSelect,
  degree,
}: {
  result: SearchResult;
  selected: string | null;
  onSelect: (path: string) => void;
  degree: number;
}) {
  const active = selected === result.path;
  const folder = folderFromPath(result.path);
  return (
    <button
      type="button"
      onClick={() => onSelect(result.path)}
      className={`group flex flex-col gap-1 rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-left transition ${active ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)] bg-[var(--surface-1)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)]'}`}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: folderColor(folder) }}
        />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--text)]">
          {result.title || titleFromPath(result.path)}
        </span>
        {folder ? (
          <span className="shrink-0 text-[9.5px] uppercase tracking-wider text-[var(--text-faint)]">
            {folder}
          </span>
        ) : null}
        {degree > 0 ? (
          <span className="num shrink-0 text-[10px] tabular-nums text-[var(--text-faint)]">
            d{degree}
          </span>
        ) : null}
      </div>
      <span className="line-clamp-2 text-[11px] leading-snug text-[var(--text-mute)]">
        {stripHtml(result.snippet || '') || result.path}
      </span>
    </button>
  );
}

function FolderRow({
  folder,
  total,
  t,
  locale,
}: {
  folder: { folder: string; count: number; lastModified: number; size: number };
  total: number;
  t: Translator;
  locale: Locale;
}) {
  const pct = total > 0 ? (folder.count / total) * 100 : 0;
  return (
    <div className="flex flex-col gap-1 rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] px-2.5 py-1.5">
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: folderColor(folder.folder) }}
        />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--text)]">
          {folder.folder}
        </span>
        <span className="num shrink-0 text-[10px] tabular-nums text-[var(--text-faint)]">
          {t('vault.folderRow', {
            count: String(folder.count),
            size: formatSize(folder.size),
            date: formatShortDate(folder.lastModified, t, locale),
          })}
        </span>
      </div>
      <div className="h-[3px] w-full overflow-hidden rounded-full bg-[rgba(255,255,255,0.05)]">
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.max(2, pct)}%`,
            backgroundColor: folderColor(folder.folder),
          }}
        />
      </div>
    </div>
  );
}

function HubRow({
  hub,
  maxDegree,
  selected,
  onSelect,
  t,
}: {
  hub: { id: string; title: string; degree: number };
  maxDegree: number;
  selected: string | null;
  onSelect: (path: string) => void;
  t: Translator;
}) {
  const pct = Math.min(100, (hub.degree / maxDegree) * 100);
  const active = selected === hub.id;
  const folder = folderFromPath(hub.id);
  return (
    <button
      type="button"
      onClick={() => onSelect(hub.id)}
      className={`flex flex-col gap-1 rounded-[var(--radius-sm)] border px-2.5 py-1.5 text-left transition ${active ? 'border-[var(--accent)] bg-[var(--accent-soft)]' : 'border-[var(--border)] bg-[var(--surface-1)] hover:border-[var(--border-strong)] hover:bg-[var(--surface-2)]'}`}
    >
      <div className="flex items-center gap-2">
        <span
          aria-hidden="true"
          className="h-2 w-2 shrink-0 rounded-full"
          style={{ backgroundColor: folderColor(folder) }}
        />
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-[var(--text)]">
          {hub.title || titleFromPath(hub.id)}
        </span>
        <span className="num shrink-0 text-[10px] tabular-nums text-[var(--text-faint)]">
          {t('vault.hubDegree', { n: hub.degree })}
        </span>
      </div>
      <div className="h-[3px] w-full overflow-hidden rounded-full bg-[rgba(255,255,255,0.05)]">
        <div
          className="h-full rounded-full"
          style={{
            width: `${Math.max(2, pct)}%`,
            backgroundColor: folderColor(folder),
          }}
        />
      </div>
    </button>
  );
}

function TagChip({ tag, max }: { tag: TagStat; max: number }) {
  const weight = Math.min(1, tag.count / Math.max(1, max));
  const fontSize = 11 + Math.round(weight * 3);
  const border = `rgba(191,90,242,${(0.25 + weight * 0.4).toFixed(2)})`;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border bg-[var(--surface-1)] px-2.5 py-1 text-[var(--text)]"
      style={{ fontSize: `${fontSize}px`, borderColor: border }}
    >
      <span className="text-[var(--text-dim)]">#</span>
      {tag.tag}
      <span className="num text-[10px] text-[var(--text-faint)]">· {tag.count}</span>
    </span>
  );
}

function NoteDetailView({
  note,
  onNavigate,
  t,
}: {
  note: NoteDetail;
  onNavigate: (path: string) => void;
  t: Translator;
}) {
  const tags = parseTags(note.tags_json);
  const folder = folderFromPath(note.path);
  const backlinks = note.backlinks || [];
  const outgoing = note.outgoing || [];

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            aria-hidden="true"
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ backgroundColor: folderColor(folder) }}
          />
          <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-dim)]">
            {folder || t('vault.rootFolder')}
          </span>
          <span className="text-[10px] text-[var(--text-faint)]">·</span>
          <span className="num text-[10px] text-[var(--text-faint)]">
            ←{backlinks.length} →{outgoing.length}
          </span>
        </div>
        <h2 className="text-[18px] font-semibold leading-tight text-[var(--text)]">
          {note.title || titleFromPath(note.path)}
        </h2>
        <p className="truncate text-[11px] text-[var(--text-faint)]">{note.path}</p>
      </div>

      {tags.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <Chip key={tag}>#{tag}</Chip>
          ))}
        </div>
      ) : null}

      <div className="max-h-[52vh] overflow-auto rounded-[var(--radius)] border border-[var(--border)] bg-[var(--bg-alt)] p-4">
        {note.body?.trim() ? (
          <Markdown content={note.body} />
        ) : (
          <p className="text-[12px] text-[var(--text-faint)]">{t('vault.detail.empty')}</p>
        )}
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <LinkPanel
          title={t('vault.detail.backlinks')}
          items={backlinks.map((link) => ({ key: link.src, label: link.src }))}
          onSelect={onNavigate}
        />
        <LinkPanel
          title={t('vault.detail.outgoing')}
          items={outgoing.map((link) => ({ key: link.dst, label: link.dst }))}
          onSelect={onNavigate}
        />
      </div>
    </div>
  );
}

function LinkPanel({
  title,
  items,
  onSelect,
}: {
  title: string;
  items: Array<{ key: string; label: string }>;
  onSelect: (path: string) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] p-2.5">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">{title}</h3>
        <span className="num text-[10px] text-[var(--text-faint)]">{items.length}</span>
      </div>
      {items.length === 0 ? (
        <span className="text-[11px] text-[var(--text-faint)]">—</span>
      ) : (
        <div className="flex flex-col gap-0.5">
          {items.slice(0, 40).map((item) => {
            const folder = folderFromPath(item.key);
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => onSelect(item.key)}
                className="group flex items-center gap-2 rounded-[var(--radius-sm)] px-1.5 py-1 text-left hover:bg-[var(--surface-2)]"
              >
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 shrink-0 rounded-full"
                  style={{ backgroundColor: folderColor(folder) }}
                />
                <span className="min-w-0 flex-1 truncate text-[12px] text-[var(--text)] group-hover:text-[var(--accent)]">
                  {titleFromPath(item.key)}
                </span>
                {folder ? (
                  <span className="shrink-0 text-[9.5px] uppercase tracking-wider text-[var(--text-faint)]">
                    {folder}
                  </span>
                ) : null}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function BootstrapPanel({
  busy,
  onBootstrap,
  onReindex,
  result,
  t,
}: {
  busy: boolean;
  onBootstrap: () => void;
  onReindex: () => void;
  result: BootstrapResponse | null;
  t: Translator;
}) {
  return (
    <Section title={t('vault.bootstrap.title')} meta={t('vault.bootstrap.meta')}>
      <Card>
        <div className="flex flex-col gap-4">
          <div>
            <p className="text-[14px] text-[var(--text)]">{t('vault.bootstrap.intro')}</p>
            <p className="mt-1 text-[12px] text-[var(--text-dim)]">
              {t('vault.bootstrap.introHint')}
            </p>
          </div>

          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            <BootstrapBullet
              label={t('vault.bootstrap.bullet1')}
              description={t('vault.bootstrap.bullet1desc')}
            />
            <BootstrapBullet
              label={t('vault.bootstrap.bullet2')}
              description={t('vault.bootstrap.bullet2desc')}
            />
            <BootstrapBullet
              label={t('vault.bootstrap.bullet3')}
              description={t('vault.bootstrap.bullet3desc')}
            />
            <BootstrapBullet
              label={t('vault.bootstrap.bullet4')}
              description={t('vault.bootstrap.bullet4desc')}
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Link to="/settings">
              <Button tone="ghost">{t('vault.bootstrap.checkPath')}</Button>
            </Link>
            <Button tone="accent" onClick={onBootstrap} disabled={busy}>
              {busy ? t('vault.bootstrap.running') : t('vault.bootstrap.run')}
            </Button>
            <Button tone="ghost" onClick={onReindex} disabled={busy}>
              {t('vault.bootstrap.reindexOnly')}
            </Button>
          </div>

          {result?.ok ? (
            <div className="rounded-[var(--radius)] border border-[rgba(48,209,88,0.32)] bg-[rgba(48,209,88,0.08)] px-3 py-2 text-[12px] text-[#c9f3d6]">
              <div className="font-semibold">{t('vault.bootstrap.done')}</div>
              <div className="mt-0.5 text-[11px] opacity-80">
                {t('vault.bootstrap.doneDetails', {
                  created: result.bootstrap.created.length,
                  skipped: result.bootstrap.skipped.length,
                  indexed: result.reindex.indexed,
                  ms: result.reindex.durationMs,
                })}
              </div>
            </div>
          ) : null}
        </div>
      </Card>
    </Section>
  );
}

function BootstrapBullet({ label, description }: { label: string; description: string }) {
  return (
    <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2">
      <div className="text-[13px] font-medium text-[var(--text)]">{label}</div>
      <div className="mt-0.5 text-[11px] text-[var(--text-dim)]">{description}</div>
    </div>
  );
}
