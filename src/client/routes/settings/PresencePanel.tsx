import { useCallback, useEffect, useState } from 'react';
import { Button, Card, Chip, Empty, ErrorBanner, Section } from '../../components/ui';
import { apiDelete, apiGet, apiPost } from '../../lib/api';
import { useTranslation } from '../../lib/i18n';

/**
 * Presence settings panel — formerly the "Paramètres" sub-tab inside the
 * /presence page. Moved here so all configuration knobs live under
 * /settings, with the /presence page focused on the operational view
 * (feed / sources / stats).
 *
 * The 7 sections (scheduler, drafter, persona refresh, OpenRouter,
 * Reddit, X read, X write) each manage their own form state. This
 * panel only owns the shared connection-status + connection-list
 * fetches, plus a toast/error surface that was previously plumbed
 * down from the presence route.
 *
 * Why an independent fetch (vs. reusing the presence route's existing
 * state): the /presence route still needs `connectStatus` for gating
 * draft actions (Assist / Auto-post), but we don't want to keep the
 * full `connections[]` array there since SettingsView was its only
 * consumer. Each surface owns its own data lifecycle now.
 */

// ────────── shared types (mirrored from presence.tsx, kept local so
// this panel doesn't re-import from the presence route module) ──────────

type Platform = 'reddit' | 'x';
type DrafterProvider = 'claude' | 'codex';

type ConnectionRow = {
  platform: Platform;
  account_handle: string | null;
  keychain_ref: string | null;
  scopes_json: string | null;
  connected_at: number | null;
  last_refresh_at: number | null;
};

type ConnectStatus = {
  reddit: boolean;
  x: boolean;
  openrouter: boolean;
};

type DrafterConfig = {
  drafterProvider: DrafterProvider;
  scorerModel: string;
  drafterModel: string;
};

type MergedModelLite = { id: string; label: string };

type DrafterConfigResponse = {
  config: DrafterConfig;
  catalog: Record<DrafterProvider, MergedModelLite[]>;
};

type SchedulerConfig = {
  autoScanEnabled: boolean;
  scanIntervalMinutes: number;
  engagementPollIntervalMinutes: number;
  dailyBudgetUsd: number;
  todaySpendUsd?: number;
  engagementPollEnabled: boolean;
};

type Translator = (key: string, vars?: Record<string, string | number>) => string;

type ConnectProps = {
  onReload: () => void;
  onError: (e: unknown) => void;
  onToast: (msg: string) => void;
  t: Translator;
};

// ────────── main panel ──────────

export function PresenceSettingsPanel() {
  const { t } = useTranslation();
  const [connections, setConnections] = useState<ConnectionRow[]>([]);
  const [connectStatus, setConnectStatus] = useState<ConnectStatus>({
    reddit: false,
    x: false,
    openrouter: false,
  });
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const onError = useCallback((e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
    // Auto-clear so a stale error doesn't haunt the next form interaction.
    setTimeout(() => setError(null), 6000);
  }, []);

  const onToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  const loadConnections = useCallback(async () => {
    try {
      const [conns, status] = await Promise.all([
        apiGet<ConnectionRow[]>('/api/presence/connections'),
        apiGet<ConnectStatus>('/api/presence/connect/status'),
      ]);
      setConnections(conns);
      setConnectStatus(status);
    } catch (e) {
      onError(e);
    }
  }, [onError]);

  useEffect(() => {
    void loadConnections();
  }, [loadConnections]);

  const byPlatform = new Map(connections.map((c) => [c.platform, c]));

  // X write is independent of the read Bearer; we hydrate its state via
  // /api/presence/x/can-post inside XWriteConnect itself, but the hero
  // strip wants a same-tick summary so we mirror it here on mount.
  const [xWriteReady, setXWriteReady] = useState<boolean | null>(null);
  useEffect(() => {
    void apiGet<{ canPost: boolean }>('/api/presence/x/can-post')
      .then((r) => setXWriteReady(r.canPost))
      .catch(() => setXWriteReady(false));
  }, []);

  return (
    <div className="flex flex-col gap-6">
      {error ? <ErrorBanner>{error}</ErrorBanner> : null}
      {toast ? (
        <div className="rounded-[var(--radius)] border border-[rgba(48,209,88,0.32)] bg-[rgba(48,209,88,0.08)] px-3 py-2 text-sm text-[#9bf6b1]">
          {toast}
        </div>
      ) : null}

      {/* Hero strip — at-a-glance state of the 4 external services so the
          user can see "all green" without scrolling through every section. */}
      <ConnectionsHero
        openrouter={connectStatus.openrouter}
        reddit={connectStatus.reddit}
        xRead={connectStatus.x}
        xWrite={xWriteReady}
        t={t}
      />

      {/* Group 1 — Automation. Scheduler + drafter run on cadences and
          set the runtime budget; the natural pair to read together. */}
      <SettingsGroup label={t('presence.settings.groups.automation')}>
        <Section
          title={t('presence.settings.scheduler.title')}
          meta={t('presence.settings.scheduler.meta')}
        >
          <Card>
            <SchedulerConfigForm onError={onError} onToast={onToast} t={t} />
          </Card>
        </Section>

        <Section
          title={t('presence.settings.drafter.title')}
          meta={t('presence.settings.drafter.meta')}
        >
          <Card>
            <DrafterConfigForm onError={onError} onToast={onToast} t={t} />
          </Card>
        </Section>
      </SettingsGroup>

      {/* Group 2 — Learning loop. The persona refresh is its own beast:
          neither runtime config nor an external connection. */}
      <SettingsGroup label={t('presence.settings.groups.learning')}>
        <Section
          title={t('presence.settings.persona.title')}
          meta={t('presence.settings.persona.meta')}
        >
          <Card>
            <PersonaRefreshButton onError={onError} onToast={onToast} t={t} />
          </Card>
        </Section>
      </SettingsGroup>

      {/* Group 3 — External connections. Auth/credential-bearing forms.
          Tighter intra-group gap (gap-3 vs default gap-4 on the outer)
          so the 4 service cards visually cohere as a single cluster. */}
      <SettingsGroup label={t('presence.settings.groups.connections')}>
        <Section
          title={t('presence.settings.openrouter.title')}
          meta={t('presence.settings.openrouter.meta')}
        >
          <Card>
            <OpenrouterConnect
              connected={connectStatus.openrouter}
              onReload={() => void loadConnections()}
              onError={onError}
              onToast={onToast}
              t={t}
            />
          </Card>
        </Section>

        <Section
          title={t('presence.settings.reddit.title')}
          meta={t('presence.settings.reddit.meta')}
        >
          <Card>
            <RedditConnect
              connected={connectStatus.reddit}
              row={byPlatform.get('reddit') ?? null}
              onReload={() => void loadConnections()}
              onError={onError}
              onToast={onToast}
              t={t}
            />
          </Card>
        </Section>

        <Section title={t('presence.settings.x.title')} meta={t('presence.settings.x.meta')}>
          <Card>
            <XConnect
              connected={connectStatus.x}
              row={byPlatform.get('x') ?? null}
              onReload={() => void loadConnections()}
              onError={onError}
              onToast={onToast}
              t={t}
            />
          </Card>
        </Section>

        <Section
          title={t('presence.settings.xWrite.title')}
          meta={t('presence.settings.xWrite.meta')}
        >
          <Card>
            <XWriteConnect
              onError={onError}
              onToast={onToast}
              onStateChange={setXWriteReady}
              t={t}
            />
          </Card>
        </Section>
      </SettingsGroup>
    </div>
  );
}

// ────────── grouping primitives (panel-only, not exported) ──────────

/**
 * Light wrapper that prints a small uppercase group label above its
 * children and tightens the inter-section gap. The label uses the
 * same typographic conventions as stat labels elsewhere (10 px, dim
 * color, wide tracking) so it reads as a "chapter title" without
 * competing with the proper Section titles below.
 */
function SettingsGroup({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 px-1">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--text-dim)]">
          {label}
        </span>
        <span className="h-px flex-1 bg-[var(--border)]" aria-hidden="true" />
      </div>
      {children}
    </div>
  );
}

/**
 * At-a-glance state strip for the 4 external services. Each chip is a
 * dot + service name + state — green when connected, neutral when not.
 * X write surfaces null while we're still loading /x/can-post so we
 * don't flash "disconnected" before the truth lands.
 */
function ConnectionsHero({
  openrouter,
  reddit,
  xRead,
  xWrite,
  t,
}: {
  openrouter: boolean;
  reddit: boolean;
  xRead: boolean;
  xWrite: boolean | null;
  t: Translator;
}) {
  const items: Array<{ key: string; label: string; state: boolean | null }> = [
    { key: 'openrouter', label: 'OpenRouter', state: openrouter },
    { key: 'reddit', label: 'Reddit', state: reddit },
    { key: 'xRead', label: t('presence.settings.hero.xRead'), state: xRead },
    { key: 'xWrite', label: t('presence.settings.hero.xWrite'), state: xWrite },
  ];
  const connected = items.filter((i) => i.state === true).length;

  return (
    <div className="rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] px-4 py-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-col gap-0.5">
          <span className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--text-dim)]">
            {t('presence.settings.hero.title')}
          </span>
          <span className="text-[12px] text-[var(--text-mute)]">
            {t('presence.settings.hero.summary', { connected, total: items.length })}
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {items.map((item) => (
            <ConnectionPill key={item.key} label={item.label} state={item.state} />
          ))}
        </div>
      </div>
    </div>
  );
}

function ConnectionPill({ label, state }: { label: string; state: boolean | null }) {
  // Three visual states: pending (loading), connected (green), idle.
  // Pending matters for X write where the can-post probe is async — a
  // grey-then-green flash on first paint would be more confusing than
  // a single transition from amber to green.
  const dotClass =
    state === null ? 'bg-[#ffd60a]' : state ? 'bg-[#30d158]' : 'bg-[var(--text-faint)]';
  const textClass =
    state === null
      ? 'text-[var(--text-dim)]'
      : state
        ? 'text-[#30d158]'
        : 'text-[var(--text-faint)]';
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--surface-2)] px-2 py-0.5 text-[11px] ${textClass}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${dotClass}`} aria-hidden="true" />
      {label}
    </span>
  );
}

// ────────── persona refresh ──────────

/**
 * Manual trigger for the persona anti-patterns refresh. Aggregates the
 * user's recent draft edits into Persona/anti_patterns.md in their vault,
 * then the drafter automatically picks the file up on the next scan.
 * Also runs on a weekly cron — this button is for impatience.
 */
function PersonaRefreshButton({
  onError,
  onToast,
  t,
}: {
  onError: (e: unknown) => void;
  onToast: (msg: string) => void;
  t: Translator;
}) {
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<{
    ngrams: number;
    heavy: number;
    path: string | null;
  } | null>(null);

  async function handleRefresh() {
    setBusy(true);
    try {
      const res = await apiPost<{
        ok: boolean;
        path: string | null;
        ngrams_count: number;
        heavy_edits_count: number;
        reason?: string;
      }>('/api/presence/persona/refresh', {});
      if (!res.ok) {
        onError(new Error(res.reason ?? 'persona_refresh_failed'));
        return;
      }
      setLast({ ngrams: res.ngrams_count, heavy: res.heavy_edits_count, path: res.path });
      onToast(
        t('presence.settings.persona.toast', {
          ngrams: res.ngrams_count,
          heavy: res.heavy_edits_count,
        }),
      );
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Button
          tone="primary"
          onClick={handleRefresh}
          disabled={busy}
          className="!py-1 !text-[12px]"
        >
          {busy ? t('presence.settings.persona.busy') : t('presence.settings.persona.refresh')}
        </Button>
        {last ? (
          <span className="text-[11px] text-[var(--text-dim)]">
            {t('presence.settings.persona.lastResult', {
              ngrams: last.ngrams,
              heavy: last.heavy,
              path: last.path ?? '?',
            })}
          </span>
        ) : null}
      </div>
      <p className="text-[11px] text-[var(--text-dim)]">{t('presence.settings.persona.hint')}</p>
    </div>
  );
}

// ────────── scheduler config ──────────

function SchedulerConfigForm({
  onError,
  onToast,
  t,
}: {
  onError: (e: unknown) => void;
  onToast: (msg: string) => void;
  t: Translator;
}) {
  const [data, setData] = useState<SchedulerConfig | null>(null);
  const [savedCadence, setSavedCadence] = useState<{ scan: number; poll: number } | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void apiGet<SchedulerConfig>('/api/presence/scheduler-config')
      .then((r) => {
        setData(r);
        setSavedCadence({
          scan: r.scanIntervalMinutes,
          poll: r.engagementPollIntervalMinutes,
        });
      })
      .catch(onError);
  }, [onError]);

  if (!data || !savedCadence) {
    return <Empty>{t('common.loading')}</Empty>;
  }

  // Cadence change requires server restart; we surface a hint when the
  // user touched the inputs but hasn't restarted yet (compared to the
  // values we loaded on mount).
  const cadenceDirty =
    data.scanIntervalMinutes !== savedCadence.scan ||
    data.engagementPollIntervalMinutes !== savedCadence.poll;

  async function persist(patch: Partial<SchedulerConfig>) {
    if (!data) return;
    const next = { ...data, ...patch };
    setData(next);
    setSaving(true);
    try {
      const res = await apiPost<SchedulerConfig & { ok: true }>(
        '/api/presence/scheduler-config',
        next,
      );
      setSavedCadence({
        scan: res.scanIntervalMinutes,
        poll: res.engagementPollIntervalMinutes,
      });
      onToast(t('presence.settings.saved'));
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <label className="flex items-center gap-3 text-[13px]">
        <input
          type="checkbox"
          checked={data.autoScanEnabled}
          onChange={(e) => void persist({ autoScanEnabled: e.target.checked })}
          disabled={saving}
          className="cursor-pointer"
        />
        <span className="text-[var(--text)]">{t('presence.settings.scheduler.toggleLabel')}</span>
        <Chip tone={data.autoScanEnabled ? 'success' : 'neutral'}>
          {data.autoScanEnabled
            ? t('presence.settings.scheduler.statusOn')
            : t('presence.settings.scheduler.statusOff')}
        </Chip>
      </label>
      <p className="text-[11px] text-[var(--text-dim)]">
        {data.autoScanEnabled
          ? t('presence.settings.scheduler.hintOn')
          : t('presence.settings.scheduler.hintOff')}
      </p>

      {/* Engagement polling — independent of auto-scan because it's
          essentially free (Reddit public + X syndication CDN), and the user
          who turned auto-scan off to save money still wants their posted
          drafts tracked. */}
      <label className="flex items-center gap-3 text-[13px] mt-2">
        <input
          type="checkbox"
          checked={data.engagementPollEnabled}
          onChange={(e) => void persist({ engagementPollEnabled: e.target.checked })}
          disabled={saving}
          className="cursor-pointer"
        />
        <span className="text-[var(--text)]">
          {t('presence.settings.scheduler.engagementToggleLabel')}
        </span>
        <Chip tone={data.engagementPollEnabled ? 'success' : 'neutral'}>
          {data.engagementPollEnabled
            ? t('presence.settings.scheduler.engagementStatusOn')
            : t('presence.settings.scheduler.engagementStatusOff')}
        </Chip>
      </label>
      <p className="text-[11px] text-[var(--text-dim)]">
        {t('presence.settings.scheduler.engagementHint')}
      </p>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="text-[var(--text-dim)]">
            {t('presence.settings.scheduler.scanCadence')}
          </span>
          <input
            type="number"
            min={5}
            max={1440}
            value={data.scanIntervalMinutes}
            onChange={(e) =>
              setData({ ...data, scanIntervalMinutes: Number(e.target.value) || 45 })
            }
            onBlur={() =>
              data.scanIntervalMinutes !== savedCadence.scan &&
              void persist({ scanIntervalMinutes: data.scanIntervalMinutes })
            }
            className="!py-1 !text-[12px]"
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="text-[var(--text-dim)]">
            {t('presence.settings.scheduler.pollCadence')}
          </span>
          <input
            type="number"
            min={15}
            max={1440}
            value={data.engagementPollIntervalMinutes}
            onChange={(e) =>
              setData({
                ...data,
                engagementPollIntervalMinutes: Number(e.target.value) || 60,
              })
            }
            onBlur={() =>
              data.engagementPollIntervalMinutes !== savedCadence.poll &&
              void persist({
                engagementPollIntervalMinutes: data.engagementPollIntervalMinutes,
              })
            }
            className="!py-1 !text-[12px]"
          />
        </label>
        <label className="flex flex-col gap-1 text-[12px]">
          <span className="text-[var(--text-dim)]">
            {t('presence.settings.scheduler.budgetCap')}
            {data.todaySpendUsd != null ? (
              <span
                className={`ml-2 num text-[10px] ${
                  data.dailyBudgetUsd > 0 && data.todaySpendUsd >= data.dailyBudgetUsd * 0.8
                    ? 'text-[var(--warn)]'
                    : 'text-[var(--text-faint)]'
                }`}
              >
                ${data.todaySpendUsd.toFixed(4)} {t('presence.settings.scheduler.budgetSpentToday')}
              </span>
            ) : null}
          </span>
          <input
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={data.dailyBudgetUsd}
            onChange={(e) => setData({ ...data, dailyBudgetUsd: Number(e.target.value) || 0 })}
            onBlur={() => void persist({ dailyBudgetUsd: data.dailyBudgetUsd })}
            className="!py-1 !text-[12px]"
            title={t('presence.settings.scheduler.budgetTitle')}
          />
        </label>
      </div>

      {cadenceDirty ? (
        <p className="text-[11px] text-[var(--warn)]">
          {t('presence.settings.scheduler.restartHint')}
        </p>
      ) : null}
    </div>
  );
}

// ────────── drafter config ──────────

function DrafterConfigForm({
  onError,
  onToast,
  t,
}: {
  onError: (e: unknown) => void;
  onToast: (msg: string) => void;
  t: Translator;
}) {
  const [data, setData] = useState<DrafterConfigResponse | null>(null);
  const [draft, setDraft] = useState<DrafterConfig | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void apiGet<DrafterConfigResponse>('/api/presence/drafter-config')
      .then((r) => {
        setData(r);
        setDraft(r.config);
      })
      .catch(onError);
  }, [onError]);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!draft) return;
    setSaving(true);
    try {
      await apiPost('/api/presence/drafter-config', draft);
      onToast(t('presence.settings.saved'));
    } catch (e) {
      onError(e);
    } finally {
      setSaving(false);
    }
  }

  if (!data || !draft) {
    return <Empty>{t('common.loading')}</Empty>;
  }

  const modelList = data.catalog[draft.drafterProvider] ?? [];
  const modelOptions =
    modelList.length > 0
      ? modelList.map((m) => ({ value: m.id, label: m.label }))
      : [
          { value: draft.scorerModel, label: draft.scorerModel },
          { value: draft.drafterModel, label: draft.drafterModel },
        ];

  return (
    <form
      onSubmit={handleSave}
      className="grid grid-cols-1 gap-3 md:grid-cols-[minmax(120px,200px)_minmax(160px,1fr)_minmax(160px,1fr)_auto]"
    >
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-[var(--text-dim)]">
          {t('presence.settings.drafter.provider')}
        </span>
        <select
          value={draft.drafterProvider}
          onChange={(e) =>
            setDraft({ ...draft, drafterProvider: e.target.value as DrafterProvider })
          }
          className="!py-1 !text-[12px]"
        >
          <option value="claude">Claude CLI</option>
          <option value="codex">Codex CLI</option>
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-[var(--text-dim)]">
          {t('presence.settings.drafter.scorerModel')}
        </span>
        <select
          value={draft.scorerModel}
          onChange={(e) => setDraft({ ...draft, scorerModel: e.target.value })}
          className="!py-1 !text-[12px]"
        >
          {modelOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-[11px] text-[var(--text-dim)]">
          {t('presence.settings.drafter.drafterModel')}
        </span>
        <select
          value={draft.drafterModel}
          onChange={(e) => setDraft({ ...draft, drafterModel: e.target.value })}
          className="!py-1 !text-[12px]"
        >
          {modelOptions.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <div className="flex items-end">
        <Button tone="primary" type="submit" disabled={saving} className="!py-1 !text-[12px]">
          {saving ? t('common.saving') : t('presence.settings.save')}
        </Button>
      </div>
    </form>
  );
}

// ────────── OpenRouter connect ──────────

function OpenrouterConnect({
  connected,
  onReload,
  onError,
  onToast,
  t,
}: ConnectProps & { connected: boolean }) {
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!apiKey.trim()) return;
    setBusy(true);
    try {
      await apiPost('/api/presence/connect/openrouter', { apiKey: apiKey.trim() });
      setApiKey('');
      onToast(t('presence.settings.saved'));
      onReload();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    if (!window.confirm(t('presence.settings.disconnectConfirm'))) return;
    try {
      await apiDelete('/api/presence/connect/openrouter');
      onToast(t('presence.settings.disconnected'));
      onReload();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[12px]">
        <Chip tone={connected ? 'success' : 'neutral'}>
          {connected
            ? t('presence.settings.connections.connected')
            : t('presence.settings.connections.disconnected')}
        </Chip>
        {connected ? (
          <Button tone="ghost" onClick={handleDisconnect} className="!py-1 !text-[11px]">
            {t('presence.settings.disconnect')}
          </Button>
        ) : null}
      </div>
      <form onSubmit={handleSave} className="flex gap-2">
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder={t('presence.settings.openrouter.keyPlaceholder')}
          className="!py-1 !text-[12px] flex-1"
        />
        <Button tone="primary" type="submit" disabled={busy} className="!py-1 !text-[12px]">
          {busy ? t('common.saving') : t('presence.settings.save')}
        </Button>
      </form>
    </div>
  );
}

// ────────── Reddit connect ──────────

function RedditConnect({
  connected,
  row,
  onReload,
  onError,
  onToast,
  t,
}: ConnectProps & { connected: boolean; row: ConnectionRow | null }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (!clientId.trim() || !clientSecret.trim() || !username.trim() || !password.trim()) {
      // Surface validation instead of silent
      // no-op so the user understands why their click did nothing.
      onError(new Error(t('presence.settings.reddit.validationAllRequired')));
      return;
    }
    setBusy(true);
    try {
      await apiPost('/api/presence/connect/reddit', {
        clientId: clientId.trim(),
        clientSecret: clientSecret.trim(),
        username: username.trim(),
        password,
      });
      setClientId('');
      setClientSecret('');
      setUsername('');
      setPassword('');
      onToast(t('presence.settings.reddit.connected'));
      onReload();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    if (!window.confirm(t('presence.settings.disconnectConfirm'))) return;
    try {
      await apiDelete('/api/presence/connect/reddit');
      onToast(t('presence.settings.disconnected'));
      onReload();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[12px]">
        <Chip tone={connected ? 'success' : 'accent'}>
          {connected
            ? t('presence.settings.connections.connected')
            : t('presence.settings.reddit.publicMode')}
        </Chip>
        {row?.account_handle ? (
          <span className="text-[var(--text-mute)]">u/{row.account_handle}</span>
        ) : null}
        {connected ? (
          <Button tone="ghost" onClick={handleDisconnect} className="!py-1 !text-[11px]">
            {t('presence.settings.disconnect')}
          </Button>
        ) : null}
      </div>
      <p className="text-[11px] text-[var(--text-dim)]">
        {t('presence.settings.reddit.publicHint')}
      </p>
      <form onSubmit={handleSave} className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <input
          value={clientId}
          onChange={(e) => setClientId(e.target.value)}
          placeholder={t('presence.settings.reddit.clientIdPlaceholder')}
          className="!py-1 !text-[12px]"
        />
        <input
          type="password"
          value={clientSecret}
          onChange={(e) => setClientSecret(e.target.value)}
          placeholder={t('presence.settings.reddit.clientSecretPlaceholder')}
          className="!py-1 !text-[12px]"
        />
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t('presence.settings.reddit.usernamePlaceholder')}
          className="!py-1 !text-[12px]"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder={t('presence.settings.reddit.passwordPlaceholder')}
          className="!py-1 !text-[12px]"
        />
        <div className="md:col-span-2 flex justify-end">
          <Button tone="primary" type="submit" disabled={busy} className="!py-1 !text-[12px]">
            {busy ? t('common.saving') : t('presence.settings.reddit.connect')}
          </Button>
        </div>
      </form>
    </div>
  );
}

// ────────── X read connect ──────────

function XConnect({
  connected,
  row,
  onReload,
  onError,
  onToast,
  t,
}: ConnectProps & { connected: boolean; row: ConnectionRow | null }) {
  const [bearer, setBearer] = useState('');
  const [username, setUsername] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSave(event: React.FormEvent) {
    event.preventDefault();
    if (bearer.trim().length < 10) return;
    setBusy(true);
    try {
      await apiPost('/api/presence/connect/x', {
        bearer: bearer.trim(),
        username: username.trim() || undefined,
      });
      setBearer('');
      setUsername('');
      onToast(t('presence.settings.x.connected'));
      onReload();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    if (!window.confirm(t('presence.settings.disconnectConfirm'))) return;
    try {
      await apiDelete('/api/presence/connect/x');
      onToast(t('presence.settings.disconnected'));
      onReload();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[12px]">
        <Chip tone={connected ? 'success' : 'neutral'}>
          {connected
            ? t('presence.settings.connections.connected')
            : t('presence.settings.connections.disconnected')}
        </Chip>
        {row?.account_handle ? (
          <span className="text-[var(--text-mute)]">@{row.account_handle}</span>
        ) : null}
        {connected ? (
          <Button tone="ghost" onClick={handleDisconnect} className="!py-1 !text-[11px]">
            {t('presence.settings.disconnect')}
          </Button>
        ) : null}
      </div>
      <form onSubmit={handleSave} className="grid grid-cols-1 gap-2 md:grid-cols-[2fr_1fr_auto]">
        <input
          type="password"
          value={bearer}
          onChange={(e) => setBearer(e.target.value)}
          placeholder={t('presence.settings.x.bearerPlaceholder')}
          className="!py-1 !text-[12px]"
        />
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          placeholder={t('presence.settings.x.usernamePlaceholder')}
          className="!py-1 !text-[12px]"
        />
        <Button tone="primary" type="submit" disabled={busy} className="!py-1 !text-[12px]">
          {busy ? t('common.saving') : t('presence.settings.x.connect')}
        </Button>
      </form>
    </div>
  );
}

// ────────── X write connect ──────────

/**
 * The four OAuth 1.0a User-Context keys for posting to X. Independent of
 * the read Bearer (which scans timelines / polls engagement) — either can
 * be set without the other. Generated in one click in the developer
 * portal under "Keys and tokens" → "Authentication Tokens" → "Generate".
 *
 * Wired against /api/presence/x/save-write-creds (POST) and
 * /api/presence/x/write-creds (DELETE). The connected badge polls
 * /api/presence/x/can-post on mount + after any save/delete so the UI
 * reflects keychain reality, not just the form state.
 */
function XWriteConnect({
  onError,
  onToast,
  onStateChange,
  t,
}: {
  onError: (e: unknown) => void;
  onToast: (msg: string) => void;
  // Optional: bubble the latest can-post probe up to the panel so the
  // hero strip stays in sync across save / disconnect actions without
  // refetching at the panel level.
  onStateChange?: (canPost: boolean) => void;
  t: Translator;
}) {
  const [canPost, setCanPost] = useState<boolean | null>(null);
  const [consumerKey, setConsumerKey] = useState('');
  const [consumerSecret, setConsumerSecret] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [accessTokenSecret, setAccessTokenSecret] = useState('');
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await apiGet<{ canPost: boolean }>('/api/presence/x/can-post');
      setCanPost(res.canPost);
      onStateChange?.(res.canPost);
    } catch (e) {
      onError(e);
      setCanPost(false);
      onStateChange?.(false);
    }
  }, [onError, onStateChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (
      consumerKey.trim().length < 8 ||
      consumerSecret.trim().length < 8 ||
      accessToken.trim().length < 8 ||
      accessTokenSecret.trim().length < 8
    ) {
      onError(new Error(t('presence.settings.xWrite.validationAllRequired')));
      return;
    }
    setBusy(true);
    try {
      await apiPost('/api/presence/x/save-write-creds', {
        consumerKey: consumerKey.trim(),
        consumerSecret: consumerSecret.trim(),
        accessToken: accessToken.trim(),
        accessTokenSecret: accessTokenSecret.trim(),
      });
      // Wipe the form on success so the secrets don't linger in DOM.
      setConsumerKey('');
      setConsumerSecret('');
      setAccessToken('');
      setAccessTokenSecret('');
      onToast(t('presence.settings.xWrite.connected'));
      await refresh();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function handleDisconnect() {
    if (!window.confirm(t('presence.settings.disconnectConfirm'))) return;
    try {
      await apiDelete('/api/presence/x/write-creds');
      onToast(t('presence.settings.disconnected'));
      await refresh();
    } catch (e) {
      onError(e);
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-[12px]">
        <Chip tone={canPost ? 'success' : 'neutral'}>
          {canPost === null
            ? t('common.loading')
            : canPost
              ? t('presence.settings.connections.connected')
              : t('presence.settings.connections.disconnected')}
        </Chip>
        {canPost ? (
          <Button tone="ghost" onClick={handleDisconnect} className="!py-1 !text-[11px]">
            {t('presence.settings.disconnect')}
          </Button>
        ) : null}
      </div>
      <form onSubmit={handleSave} className="grid grid-cols-1 gap-2 md:grid-cols-2">
        <input
          type="password"
          value={consumerKey}
          onChange={(e) => setConsumerKey(e.target.value)}
          placeholder={t('presence.settings.xWrite.consumerKeyPlaceholder')}
          className="!py-1 !text-[12px]"
          autoComplete="off"
        />
        <input
          type="password"
          value={consumerSecret}
          onChange={(e) => setConsumerSecret(e.target.value)}
          placeholder={t('presence.settings.xWrite.consumerSecretPlaceholder')}
          className="!py-1 !text-[12px]"
          autoComplete="off"
        />
        <input
          type="password"
          value={accessToken}
          onChange={(e) => setAccessToken(e.target.value)}
          placeholder={t('presence.settings.xWrite.accessTokenPlaceholder')}
          className="!py-1 !text-[12px]"
          autoComplete="off"
        />
        <input
          type="password"
          value={accessTokenSecret}
          onChange={(e) => setAccessTokenSecret(e.target.value)}
          placeholder={t('presence.settings.xWrite.accessTokenSecretPlaceholder')}
          className="!py-1 !text-[12px]"
          autoComplete="off"
        />
        <div className="md:col-span-2 flex justify-end">
          <Button tone="primary" type="submit" disabled={busy} className="!py-1 !text-[12px]">
            {busy ? t('common.saving') : t('presence.settings.xWrite.connect')}
          </Button>
        </div>
      </form>
      <p className="text-[11px] text-[var(--text-faint)]">{t('presence.settings.xWrite.howto')}</p>
    </div>
  );
}
