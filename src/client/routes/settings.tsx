import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { SyncLogSection } from '../components/SyncLogSection';
import { Button, Card, Chip, ErrorBanner, FieldLabel, Section } from '../components/ui';
import { apiGet, apiPost, apiPut } from '../lib/api';
import { AVAILABLE_LOCALES, type Locale, dateLocale, useTranslation } from '../lib/i18n';
import { formatEur } from '../lib/pricing';
import {
  ACTION_LABELS,
  type ActionId,
  findConflict,
  formatBinding,
  getBindings,
  resetBindings,
  serializeKey,
  setBinding,
  subscribe,
} from '../lib/shortcuts';
import { PresenceSettingsPanel } from './settings/PresencePanel';

type SubscriptionPlan = {
  plan: string;
  monthlyEur: number;
};

type BillingCharge = {
  date: string;
  amountEur: number;
  plan: string;
  coverageDays?: number;
};

type Settings = {
  locale: Locale;
  paths: {
    projectsRoots: string[];
    vaultPath: string;
    claudeConfigDir: string;
    excludedProjects?: string[];
  };
  github: { username: string };
  schedules: {
    projectRescanMinutes: number;
    githubSyncMinutes: number;
    obsidianSyncMinutes: number;
    usageSyncMinutes: number;
  };
  subscriptions: {
    usdToEur: number;
    claude: SubscriptionPlan;
    codex: SubscriptionPlan;
  };
  displayAliases: Record<string, string>;
  devEquivalent: {
    hourlyRateEur: number;
    outputTokensPerHour: number;
  };
  billingHistory: {
    claude: BillingCharge[];
    codex: BillingCharge[];
  };
};

type SyncKey = 'projects' | 'github' | 'obsidian' | 'usage-claude' | 'usage-codex';
type SyncState = { running: boolean; result: string | null; error: string | null };

function toPositiveInt(value: string, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    return fallback;
  }
  return parsed;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

type TabId = 'general' | 'data' | 'costs' | 'display' | 'presence' | 'logs' | 'shortcuts' | 'about';

const TAB_DEFS: Array<{ id: TabId; labelKey: string; hint?: string }> = [
  { id: 'general', labelKey: 'settings.tabs.general' },
  { id: 'data', labelKey: 'settings.tabs.data' },
  { id: 'costs', labelKey: 'settings.tabs.costs' },
  { id: 'display', labelKey: 'settings.tabs.display' },
  { id: 'presence', labelKey: 'settings.tabs.presence' },
  { id: 'logs', labelKey: 'settings.tabs.logs' },
  { id: 'shortcuts', labelKey: 'settings.tabs.shortcuts' },
  { id: 'about', labelKey: 'settings.tabs.about' },
];

export default function SettingsRoute() {
  const { t, locale, setLocale } = useTranslation();
  const [settings, setSettings] = useState<Settings | null>(null);
  const [savedSnapshot, setSavedSnapshot] = useState<string>('');
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [syncState, setSyncState] = useState<Record<SyncKey, SyncState>>({
    projects: { running: false, result: null, error: null },
    github: { running: false, result: null, error: null },
    obsidian: { running: false, result: null, error: null },
    'usage-claude': { running: false, result: null, error: null },
    'usage-codex': { running: false, result: null, error: null },
  });

  const syncMeta: Record<
    SyncKey,
    {
      label: string;
      endpoint: string;
      body?: Record<string, unknown>;
      describe: (payload: unknown) => string;
    }
  > = {
    projects: {
      label: t('settings.syncs.projects'),
      endpoint: '/api/projects/rescan',
      describe: (payload) => {
        const p = (payload as { scanned?: number; durationMs?: number }) || {};
        return t('settings.syncs.projectsDone', { n: p.scanned ?? 0, ms: p.durationMs ?? 0 });
      },
    },
    github: {
      label: t('settings.syncs.github'),
      endpoint: '/api/github/sync',
      describe: (payload) => {
        const p = (payload as { repos?: number; events?: number; durationMs?: number }) || {};
        return t('settings.syncs.githubDone', {
          repos: p.repos ?? 0,
          events: p.events ?? 0,
          ms: p.durationMs ?? 0,
        });
      },
    },
    obsidian: {
      label: t('settings.syncs.obsidian'),
      endpoint: '/api/obsidian/reindex',
      body: { force: true },
      describe: (payload) => {
        const p =
          (payload as {
            indexed?: number;
            links?: number;
            tags?: number;
            durationMs?: number;
          }) || {};
        return t('settings.syncs.obsidianDone', {
          indexed: p.indexed ?? 0,
          links: p.links ?? 0,
          tags: p.tags ?? 0,
          ms: p.durationMs ?? 0,
        });
      },
    },
    'usage-claude': {
      label: t('settings.syncs.usageClaude'),
      endpoint: '/api/usage/sync',
      describe: (payload) => {
        const p = (payload as { rows?: number }) || {};
        return t('settings.syncs.usageDone', { n: p.rows ?? 0 });
      },
    },
    'usage-codex': {
      label: t('settings.syncs.usageCodex'),
      endpoint: '/api/usage/codex/sync',
      describe: (payload) => {
        const p = (payload as { rows?: number }) || {};
        return t('settings.syncs.usageDone', { n: p.rows ?? 0 });
      },
    },
  };

  async function load() {
    try {
      setError(null);
      const s = await apiGet<Settings>('/api/settings');
      setSettings(s);
      setSavedSnapshot(JSON.stringify(s));
      setStatus(null);
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    void load();
  }, []);

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      await apiPut('/api/settings', settings);
      const snapshot = JSON.stringify(settings);
      setSavedSnapshot(snapshot);
      setStatus(
        t('settings.saved', {
          time: new Date().toLocaleTimeString(dateLocale(locale)),
        }),
      );
    } catch (e) {
      setError(`${t('common.empty')} ${String(e)}`);
    } finally {
      setSaving(false);
    }
  }

  async function triggerSync(key: SyncKey) {
    const meta = syncMeta[key];
    setSyncState((prev) => ({
      ...prev,
      [key]: { running: true, result: null, error: null },
    }));
    try {
      const payload = await apiPost(meta.endpoint, meta.body || {});
      setSyncState((prev) => ({
        ...prev,
        [key]: { running: false, result: meta.describe(payload), error: null },
      }));
    } catch (e) {
      setSyncState((prev) => ({
        ...prev,
        [key]: { running: false, result: null, error: String(e) },
      }));
    }
  }

  if (!settings) {
    return (
      <div className="flex flex-col gap-4">
        <Section title={t('settings.title')} meta={t('settings.loadingLabel')} />
        <ErrorBanner>{error}</ErrorBanner>
      </div>
    );
  }

  const currentSnapshot = JSON.stringify(settings);
  const dirty = currentSnapshot !== savedSnapshot;

  const update = (partial: Partial<Settings>): void => setSettings({ ...settings, ...partial });

  return (
    <div className="flex flex-col gap-4">
      {/* ─────────────────── Sticky header bar ─────────────────── */}
      <header className="sticky top-0 z-20 -mx-3 flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[rgba(11,13,17,0.82)] px-4 py-2.5 backdrop-blur-xl md:-mx-6 md:px-6">
        <div className="flex min-w-0 items-baseline gap-3">
          <h1 className="text-[15px] font-semibold tracking-tight text-[var(--text)]">
            {t('settings.title')}
          </h1>
          <span className="truncate text-[12px] text-[var(--text-dim)]">{t('settings.meta')}</span>
        </div>
        <div className="flex items-center gap-2">
          <Chip tone={dirty ? 'warn' : 'success'}>
            {dirty ? t('common.unsavedChanges') : t('common.synced')}
          </Chip>
          {dirty ? (
            <Button
              tone="ghost"
              onClick={() => {
                if (!savedSnapshot) return;
                try {
                  setSettings(JSON.parse(savedSnapshot) as Settings);
                  setStatus(t('settings.cancelled'));
                } catch {
                  setError(t('settings.restoreFailed'));
                }
              }}
            >
              {t('common.cancel')}
            </Button>
          ) : null}
          <Button tone="ghost" onClick={() => void load()}>
            {t('common.reload')}
          </Button>
          <Button tone="primary" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? t('common.saving') : t('common.save')}
          </Button>
        </div>
      </header>

      {status || error ? (
        <div className="flex flex-col gap-2">
          {status ? (
            <div className="rounded-[var(--radius-sm)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-1.5 text-[12px] text-[var(--text-mute)]">
              {status}
            </div>
          ) : null}
          {error ? <ErrorBanner>{error}</ErrorBanner> : null}
        </div>
      ) : null}

      {/* ─────────────────── Tabs strip ─────────────────── */}
      <SettingsTabs />

      {/* ─────────────────── Active panel ─────────────────── */}
      <SettingsPanels
        settings={settings}
        update={update}
        onLocaleChange={(loc) => {
          update({ locale: loc });
          setLocale(loc);
        }}
        syncMeta={syncMeta}
        syncState={syncState}
        onTriggerSync={(key) => void triggerSync(key)}
      />
    </div>
  );
}

// ─────────────────────────────────────────────────────────────

function SettingsTabs() {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const active: TabId = (params.get('tab') as TabId) || 'general';

  function setTab(next: TabId) {
    const p = new URLSearchParams(params);
    p.set('tab', next);
    setParams(p, { replace: true });
  }

  return (
    <nav
      className="no-scrollbar flex overflow-x-auto rounded-[var(--radius-lg)] border border-[var(--border)] bg-[var(--surface-1)] p-0.5"
      aria-label="Settings sections"
    >
      {TAB_DEFS.map((tab) => {
        const label = tabLabel(t, tab);
        const isActive = active === tab.id;
        return (
          <button
            key={tab.id}
            type="button"
            onClick={() => setTab(tab.id)}
            aria-current={isActive ? 'page' : undefined}
            className={`whitespace-nowrap rounded-[var(--radius)] px-3 py-1.5 text-[12.5px] font-medium transition ${
              isActive
                ? 'bg-[var(--surface-2)] text-[var(--text)]'
                : 'text-[var(--text-dim)] hover:text-[var(--text)]'
            }`}
          >
            {label}
          </button>
        );
      })}
    </nav>
  );
}

function tabLabel(t: (key: string) => string, tab: (typeof TAB_DEFS)[number]): string {
  return t(tab.labelKey);
}

function SettingsPanels({
  settings,
  update,
  onLocaleChange,
  syncMeta,
  syncState,
  onTriggerSync,
}: {
  settings: Settings;
  update: (partial: Partial<Settings>) => void;
  onLocaleChange: (loc: Locale) => void;
  syncMeta: Record<
    SyncKey,
    {
      label: string;
      endpoint: string;
      body?: Record<string, unknown>;
      describe: (payload: unknown) => string;
    }
  >;
  syncState: Record<SyncKey, SyncState>;
  onTriggerSync: (key: SyncKey) => void;
}) {
  const [params] = useSearchParams();
  const active: TabId = (params.get('tab') as TabId) || 'general';

  if (active === 'general') {
    return (
      <PanelLanguagePathsGithub
        settings={settings}
        update={update}
        onLocaleChange={onLocaleChange}
      />
    );
  }
  if (active === 'data') {
    return (
      <PanelData
        settings={settings}
        update={update}
        syncMeta={syncMeta}
        syncState={syncState}
        onTriggerSync={onTriggerSync}
      />
    );
  }
  if (active === 'costs') {
    return <PanelCosts settings={settings} update={update} />;
  }
  if (active === 'display') {
    return <PanelDisplay settings={settings} update={update} />;
  }
  if (active === 'presence') {
    return <PresenceSettingsPanel />;
  }
  if (active === 'logs') {
    return <SyncLogSection />;
  }
  if (active === 'shortcuts') {
    return <PanelShortcuts />;
  }
  return <PanelAbout />;
}

// ─────────────────────────────────────────────────────────────
// Panels

function PanelLanguagePathsGithub({
  settings,
  update,
  onLocaleChange,
}: {
  settings: Settings;
  update: (partial: Partial<Settings>) => void;
  onLocaleChange: (loc: Locale) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <Section title={t('settings.language.title')} meta={t('settings.language.meta')}>
        <Card>
          <FieldLabel label={t('settings.language.label')}>
            <div className="flex flex-wrap gap-2">
              {AVAILABLE_LOCALES.map((opt) => {
                const active = settings.locale === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    onClick={() => onLocaleChange(opt.value)}
                    className={`flex items-center gap-2 rounded-[var(--radius)] border px-3 py-2 text-[13px] transition ${active ? 'border-[var(--accent)] bg-[var(--accent-soft)] text-[var(--text)]' : 'border-[var(--border)] text-[var(--text-dim)] hover:border-[var(--border-strong)] hover:text-[var(--text)]'}`}
                    aria-pressed={active}
                  >
                    <span aria-hidden="true" className="text-[16px]">
                      {opt.flag}
                    </span>
                    <span className="font-medium">{opt.label}</span>
                  </button>
                );
              })}
            </div>
          </FieldLabel>
          <p className="mt-3 text-[12px] text-[var(--text-dim)]">{t('settings.language.hint')}</p>
        </Card>
      </Section>

      <Section title={t('settings.paths.title')} meta={t('settings.paths.meta')}>
        <Card>
          <div className="flex flex-col gap-4">
            <FieldLabel label={t('settings.paths.projectsRoots')}>
              <textarea
                value={settings.paths.projectsRoots.join('\n')}
                onChange={(e) =>
                  update({
                    paths: {
                      ...settings.paths,
                      projectsRoots: e.target.value
                        .split('\n')
                        .map((line) => line.trim())
                        .filter(Boolean),
                    },
                  })
                }
              />
              <PathsStatus roots={settings.paths.projectsRoots} />
            </FieldLabel>

            <ProjectsSelector
              rootsSignature={settings.paths.projectsRoots.join('\n')}
              excluded={settings.paths.excludedProjects || []}
              onChange={(next) => update({ paths: { ...settings.paths, excludedProjects: next } })}
            />

            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <FieldLabel label={t('settings.paths.vaultPath')}>
                <input
                  value={settings.paths.vaultPath}
                  onChange={(e) =>
                    update({
                      paths: { ...settings.paths, vaultPath: e.target.value },
                    })
                  }
                />
              </FieldLabel>

              <FieldLabel label={t('settings.paths.claudeConfigDir')}>
                <input
                  value={settings.paths.claudeConfigDir}
                  onChange={(e) =>
                    update({
                      paths: { ...settings.paths, claudeConfigDir: e.target.value },
                    })
                  }
                />
              </FieldLabel>
            </div>
          </div>
        </Card>
      </Section>

      <Section title={t('settings.github.title')} meta={t('settings.github.meta')}>
        <Card>
          <FieldLabel label={t('settings.github.username')}>
            <input
              className="max-w-sm"
              value={settings.github.username}
              onChange={(e) => update({ github: { username: e.target.value } })}
            />
          </FieldLabel>
          <p className="mt-3 text-[12px] text-[var(--text-dim)]">
            {t('settings.github.instructions', {
              authCmd: '`gh auth login`',
              githubPage: 'GitHub',
              syncNow: t('github.syncNow'),
              tokenCmd: '`gh auth token`',
              keychainCmd:
                '`security add-generic-password -s vibecode-dash -a github-pat -w <PAT>`',
            })}
          </p>
        </Card>
      </Section>
    </div>
  );
}

function PanelData({
  settings,
  update,
  syncMeta,
  syncState,
  onTriggerSync,
}: {
  settings: Settings;
  update: (partial: Partial<Settings>) => void;
  syncMeta: Record<
    SyncKey,
    {
      label: string;
      endpoint: string;
      body?: Record<string, unknown>;
      describe: (p: unknown) => string;
    }
  >;
  syncState: Record<SyncKey, SyncState>;
  onTriggerSync: (key: SyncKey) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <Section title={t('settings.schedules.title')} meta={t('settings.schedules.meta')}>
        <Card>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
            <NumberSetting
              label={t('settings.schedules.projectRescan')}
              value={settings.schedules.projectRescanMinutes}
              onChange={(value) =>
                update({ schedules: { ...settings.schedules, projectRescanMinutes: value } })
              }
            />
            <NumberSetting
              label={t('settings.schedules.githubSync')}
              value={settings.schedules.githubSyncMinutes}
              onChange={(value) =>
                update({ schedules: { ...settings.schedules, githubSyncMinutes: value } })
              }
            />
            <NumberSetting
              label={t('settings.schedules.obsidianSync')}
              value={settings.schedules.obsidianSyncMinutes}
              onChange={(value) =>
                update({ schedules: { ...settings.schedules, obsidianSyncMinutes: value } })
              }
            />
            <NumberSetting
              label={t('settings.schedules.usageSync')}
              value={settings.schedules.usageSyncMinutes}
              onChange={(value) =>
                update({ schedules: { ...settings.schedules, usageSyncMinutes: value } })
              }
            />
          </div>
        </Card>
      </Section>

      <Section title={t('settings.syncs.title')} meta={t('settings.syncs.meta')}>
        <Card>
          <div className="flex flex-col gap-2">
            {(Object.keys(syncMeta) as SyncKey[]).map((key) => (
              <SyncRow
                key={key}
                label={syncMeta[key].label}
                state={syncState[key]}
                onRun={() => onTriggerSync(key)}
              />
            ))}
          </div>
          <p className="mt-3 text-[12px] text-[var(--text-dim)]">
            {t('settings.syncs.endpointsNote')}
          </p>
        </Card>
      </Section>
    </div>
  );
}

function PanelCosts({
  settings,
  update,
}: {
  settings: Settings;
  update: (partial: Partial<Settings>) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-4">
      <Section title={t('settings.subscriptions.title')} meta={t('settings.subscriptions.meta')}>
        <Card>
          <SubscriptionsList settings={settings} update={update} />
        </Card>
      </Section>

      <Section title={t('settings.devEquivalent.title')} meta={t('settings.devEquivalent.meta')}>
        <Card>
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <FieldLabel label={t('settings.devEquivalent.hourlyRate')}>
              <input
                type="number"
                min={0}
                step="5"
                value={settings.devEquivalent.hourlyRateEur}
                onChange={(e) =>
                  update({
                    devEquivalent: {
                      ...settings.devEquivalent,
                      hourlyRateEur: Number(e.target.value) || 0,
                    },
                  })
                }
              />
            </FieldLabel>
            <FieldLabel label={t('settings.devEquivalent.outputTokensPerHour')}>
              <input
                type="number"
                min={100}
                step="100"
                value={settings.devEquivalent.outputTokensPerHour}
                onChange={(e) =>
                  update({
                    devEquivalent: {
                      ...settings.devEquivalent,
                      outputTokensPerHour: Number(e.target.value) || 2500,
                    },
                  })
                }
              />
            </FieldLabel>
          </div>
          <p className="mt-3 text-[12px] text-[var(--text-dim)]">
            {t('settings.devEquivalent.hint')}
          </p>
        </Card>
      </Section>

      <Section title={t('settings.billing.title')} meta={t('settings.billing.meta')}>
        <Card>
          <UnifiedBillingTable
            history={settings.billingHistory}
            onChange={(billingHistory) => update({ billingHistory })}
          />
          <p className="mt-4 text-[12px] text-[var(--text-dim)]">
            {t('settings.billing.coverageExplain')}
          </p>
        </Card>
      </Section>
    </div>
  );
}

function PanelDisplay({
  settings,
  update,
}: {
  settings: Settings;
  update: (partial: Partial<Settings>) => void;
}) {
  const { t } = useTranslation();
  return (
    <Section title={t('settings.aliases.title')} meta={t('settings.aliases.meta')}>
      <Card>
        <AliasEditor
          aliases={settings.displayAliases}
          onChange={(displayAliases) => update({ displayAliases })}
        />
      </Card>
    </Section>
  );
}

function PanelAbout() {
  const { t } = useTranslation();
  return (
    <Section title={t('settings.agent.title')} meta={t('settings.agent.meta')}>
      <Card>
        <p className="text-sm text-[var(--text-mute)]">
          {t('settings.agent.description', {
            claudeCli: '`claude`',
            codexCli: '`codex`',
            endpoint: '`/api/agent/exec`',
          })}
        </p>
      </Card>
    </Section>
  );
}

function PanelShortcuts() {
  return (
    <Section
      title="Raccourcis clavier"
      meta="click une ligne pour capturer une nouvelle touche · Esc annule"
      action={
        <Button tone="ghost" onClick={() => resetBindings()}>
          Reset defaults
        </Button>
      }
    >
      <Card>
        <ShortcutsSectionBody />
      </Card>
    </Section>
  );
}

function PathsStatus({ roots }: { roots: string[] }) {
  const [data, setData] = useState<Array<{
    input: string;
    resolved: string;
    exists: boolean;
    candidates: number;
  }> | null>(null);
  const signature = roots.join('\n');

  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      apiGet<{
        roots: Array<{ input: string; resolved: string; exists: boolean; candidates: number }>;
      }>('/api/projects/paths/check')
        .then((res) => {
          if (!cancelled) setData(res.roots);
        })
        .catch(() => {
          if (!cancelled) setData([]);
        });
    }, 400);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [signature]);

  if (roots.length === 0) return null;

  // Map response to input order in case server returned a different sort.
  const byInput = new Map((data || []).map((r) => [r.input, r]));

  return (
    <div className="mt-2 flex flex-col gap-0.5 text-[11px]">
      {roots.map((root) => {
        const row = byInput.get(root);
        if (!row) {
          return (
            <div key={root} className="flex items-center gap-2 text-[var(--text-faint)]">
              <span className="h-1.5 w-1.5 rounded-full bg-[var(--text-faint)]" />
              <span className="truncate">{root}</span>
              <span>— vérif…</span>
            </div>
          );
        }
        const tone = !row.exists
          ? 'text-[#ff453a]'
          : row.candidates === 0
            ? 'text-[#ffd60a]'
            : 'text-[#30d158]';
        const dot = !row.exists
          ? 'bg-[#ff453a]'
          : row.candidates === 0
            ? 'bg-[#ffd60a]'
            : 'bg-[#30d158]';
        const label = !row.exists
          ? 'introuvable'
          : row.candidates === 0
            ? '0 projet détecté'
            : `${row.candidates} projet${row.candidates > 1 ? 's' : ''}`;
        return (
          <div
            key={root}
            className={`flex items-center gap-2 ${tone}`}
            title={row.resolved !== row.input ? `résolu → ${row.resolved}` : undefined}
          >
            <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
            <span className="truncate font-mono text-[var(--text-mute)]">{root}</span>
            <span>— {label}</span>
          </div>
        );
      })}
    </div>
  );
}

function ProjectsSelector({
  rootsSignature,
  excluded,
  onChange,
}: {
  rootsSignature: string;
  excluded: string[];
  onChange: (next: string[]) => void;
}) {
  type DetectRoot = {
    input: string;
    resolved: string;
    exists: boolean;
    projects: Array<{ path: string; name: string; excluded: boolean }>;
  };
  const [data, setData] = useState<DetectRoot[] | null>(null);
  const [openRoots, setOpenRoots] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    apiGet<{ roots: DetectRoot[] }>('/api/projects/paths/detect')
      .then((res) => {
        if (cancelled) return;
        setData(res.roots);
        // Auto-expand all non-empty roots on first load.
        setOpenRoots(
          (prev) =>
            new Set(
              prev.size === 0
                ? res.roots.filter((r) => r.projects.length > 0).map((r) => r.input)
                : [...prev],
            ),
        );
      })
      .catch(() => {
        if (!cancelled) setData([]);
      });
    return () => {
      cancelled = true;
    };
  }, [open, rootsSignature, excluded.length]);

  const excludedSet = new Set(excluded);

  function togglePath(path: string) {
    const next = new Set(excludedSet);
    if (next.has(path)) next.delete(path);
    else next.add(path);
    onChange([...next]);
  }

  function toggleRoot(rootInput: string) {
    setOpenRoots((prev) => {
      const next = new Set(prev);
      if (next.has(rootInput)) next.delete(rootInput);
      else next.add(rootInput);
      return next;
    });
  }

  function allOnRoot(root: DetectRoot, mode: 'select' | 'deselect') {
    const next = new Set(excludedSet);
    for (const p of root.projects) {
      if (mode === 'select') next.delete(p.path);
      else next.add(p.path);
    }
    onChange([...next]);
  }

  const totals = data
    ? {
        detected: data.reduce((a, r) => a + r.projects.length, 0),
        selected:
          data.reduce((a, r) => a + r.projects.length, 0) -
          data.reduce((a, r) => a + r.projects.filter((p) => excludedSet.has(p.path)).length, 0),
      }
    : null;

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="mt-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)]"
    >
      <summary className="flex cursor-pointer items-center justify-between gap-2 px-3 py-2 text-[12.5px] text-[var(--text)]">
        <span className="flex items-center gap-2">
          <span className="inline-block transition-transform" aria-hidden="true">
            ▸
          </span>
          <span className="font-medium">Projets détectés</span>
          {totals ? (
            <span className="text-[11px] text-[var(--text-dim)]">
              {totals.selected} / {totals.detected} sélectionnés
            </span>
          ) : null}
        </span>
        <span className="text-[11px] text-[var(--text-faint)]">
          click pour {open ? 'replier' : 'déplier'}
        </span>
      </summary>

      <div className="border-t border-[var(--border)]">
        {!data ? (
          <div className="px-3 py-2 text-[12px] text-[var(--text-dim)]">Détection…</div>
        ) : data.length === 0 ? (
          <div className="px-3 py-2 text-[12px] text-[var(--text-faint)]">
            Aucun root configuré.
          </div>
        ) : (
          data.map((root) => {
            const isOpenRoot = openRoots.has(root.input);
            const rootExcluded = root.projects.filter((p) => excludedSet.has(p.path)).length;
            return (
              <div key={root.input} className="border-b border-[var(--border)] last:border-b-0">
                <button
                  type="button"
                  onClick={() => toggleRoot(root.input)}
                  className="flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-[var(--surface-2)]"
                >
                  <span className="flex items-center gap-2">
                    <span
                      className="inline-block transition-transform"
                      style={{ transform: isOpenRoot ? 'rotate(90deg)' : 'rotate(0deg)' }}
                      aria-hidden="true"
                    >
                      ▸
                    </span>
                    <span className="font-mono text-[var(--text-mute)]">{root.input}</span>
                  </span>
                  <span className="text-[11px] text-[var(--text-faint)]">
                    {root.projects.length === 0
                      ? root.exists
                        ? '0 projet'
                        : 'introuvable'
                      : `${root.projects.length - rootExcluded}/${root.projects.length}`}
                  </span>
                </button>

                {isOpenRoot && root.projects.length > 0 ? (
                  <div className="flex flex-col gap-0 bg-[var(--surface-2)]/50 px-3 py-1.5">
                    <div className="mb-1 flex items-center gap-2 text-[10.5px] text-[var(--text-faint)]">
                      <button
                        type="button"
                        onClick={() => allOnRoot(root, 'select')}
                        className="hover:text-[var(--accent)]"
                      >
                        tout sélectionner
                      </button>
                      <span>·</span>
                      <button
                        type="button"
                        onClick={() => allOnRoot(root, 'deselect')}
                        className="hover:text-[var(--accent)]"
                      >
                        tout désélectionner
                      </button>
                    </div>
                    {root.projects.map((p) => {
                      const isExcluded = excludedSet.has(p.path);
                      return (
                        <label
                          key={p.path}
                          className="flex cursor-pointer items-center gap-2 py-0.5 text-[12px] hover:bg-[var(--surface-2)]"
                          title={p.path}
                        >
                          <input
                            type="checkbox"
                            checked={!isExcluded}
                            onChange={() => togglePath(p.path)}
                          />
                          <span
                            className={
                              isExcluded
                                ? 'text-[var(--text-faint)] line-through'
                                : 'text-[var(--text)]'
                            }
                          >
                            {p.name}
                          </span>
                          <span className="truncate font-mono text-[10.5px] text-[var(--text-faint)]">
                            {p.path}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </details>
  );
}

function NumberSetting({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <FieldLabel label={label}>
      <input
        type="number"
        min={1}
        value={value}
        onChange={(event) => onChange(toPositiveInt(event.target.value, value))}
      />
    </FieldLabel>
  );
}

function AliasEditor({
  aliases,
  onChange,
}: {
  aliases: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  const { t } = useTranslation();
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const entries = Object.entries(aliases).sort(([a], [b]) => a.localeCompare(b));

  function addAlias() {
    const k = newKey.trim();
    const v = newValue.trim();
    if (!k || !v) return;
    onChange({ ...aliases, [k]: v });
    setNewKey('');
    setNewValue('');
  }

  function updateAlias(oldKey: string, nextKey: string, nextValue: string) {
    const copy = { ...aliases };
    delete copy[oldKey];
    copy[nextKey.trim() || oldKey] = nextValue;
    onChange(copy);
  }

  function removeAlias(key: string) {
    const copy = { ...aliases };
    delete copy[key];
    onChange(copy);
  }

  return (
    <div className="flex flex-col gap-2">
      {entries.length === 0 ? (
        <p className="text-[12px] text-[var(--text-faint)]">{t('settings.aliases.empty')}</p>
      ) : (
        entries.map(([key, value]) => (
          <div
            key={key}
            className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2"
          >
            <input
              defaultValue={key}
              onBlur={(e) => updateAlias(key, e.target.value, value)}
              placeholder={t('settings.aliases.canonicalPlaceholder')}
              className="text-[13px]"
            />
            <span aria-hidden="true" className="text-[var(--text-faint)]">
              →
            </span>
            <input
              value={value}
              onChange={(e) => updateAlias(key, key, e.target.value)}
              placeholder={t('settings.aliases.displayPlaceholder')}
              className="text-[13px]"
            />
            <Button tone="ghost" onClick={() => removeAlias(key)}>
              ✕
            </Button>
          </div>
        ))
      )}

      <div className="mt-2 grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto] items-center gap-2 border-t border-[var(--border)] pt-3">
        <input
          value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          placeholder={t('settings.aliases.canonicalShort')}
          className="text-[13px]"
          onKeyDown={(e) => {
            if (e.key === 'Enter') addAlias();
          }}
        />
        <span aria-hidden="true" className="text-[var(--text-faint)]">
          →
        </span>
        <input
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          placeholder={t('settings.aliases.displayShort')}
          className="text-[13px]"
          onKeyDown={(e) => {
            if (e.key === 'Enter') addAlias();
          }}
        />
        <Button tone="accent" onClick={addAlias} disabled={!newKey.trim() || !newValue.trim()}>
          {t('common.add')}
        </Button>
      </div>
    </div>
  );
}

type BillingHistoryValue = Settings['billingHistory'];
type Vendor = keyof BillingHistoryValue;
const VENDORS: readonly Vendor[] = ['claude', 'codex'] as const;

const VENDOR_COLOR: Record<Vendor, string> = {
  claude: '#64d2ff',
  codex: '#ff9500',
};

function safeNum(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function SubscriptionsList({
  settings,
  update,
}: {
  settings: Settings;
  update: (partial: Partial<Settings>) => void;
}) {
  const { t, locale } = useTranslation();

  function updateSub(vendor: Vendor, patch: Partial<SubscriptionPlan>) {
    update({
      subscriptions: {
        ...settings.subscriptions,
        [vendor]: { ...settings.subscriptions[vendor], ...patch },
      },
    });
  }

  const totalMonthly =
    safeNum(settings.subscriptions.claude.monthlyEur) +
    safeNum(settings.subscriptions.codex.monthlyEur);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {VENDORS.map((vendor) => {
          const sub = settings.subscriptions[vendor];
          const color = VENDOR_COLOR[vendor];
          const monthly = safeNum(sub.monthlyEur);
          return (
            <div
              key={vendor}
              className="flex flex-col gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] p-3.5"
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: color }}
                  />
                  <span className="text-[13px] font-semibold capitalize tracking-[0.01em] text-[var(--text)]">
                    {vendor}
                  </span>
                </div>
                <span className="num text-[11px] tabular-nums text-[var(--text-faint)]">
                  {t('settings.subscriptions.perDay', {
                    amount: formatEur(monthly / 30, locale),
                  })}
                </span>
              </div>

              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
                  {t('settings.subscriptions.plan')}
                </span>
                <input
                  value={sub.plan}
                  onChange={(e) => updateSub(vendor, { plan: e.target.value })}
                  placeholder={t('settings.subscriptions.planPlaceholder')}
                  className="!py-1 !text-[12.5px]"
                />
              </label>

              <label className="flex flex-col gap-1">
                <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
                  {t('settings.subscriptions.monthly')}
                </span>
                <div className="flex items-baseline gap-2">
                  <input
                    type="number"
                    min={0}
                    step="0.01"
                    value={sub.monthlyEur}
                    onChange={(e) => updateSub(vendor, { monthlyEur: Number(e.target.value) || 0 })}
                    className="num !py-1 !text-right !text-[15px] font-semibold tabular-nums"
                    style={{ color }}
                  />
                  <span className="shrink-0 text-[11px] text-[var(--text-faint)]">€</span>
                </div>
              </label>
            </div>
          );
        })}
      </div>

      <div className="flex items-baseline justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3.5 py-2.5">
        <span className="text-[10.5px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
          {t('settings.subscriptions.totalMonthly')}
        </span>
        <div className="flex items-baseline gap-2">
          <span className="num text-[18px] font-semibold tabular-nums text-[var(--text)]">
            {formatEur(totalMonthly, locale)}
          </span>
          <span className="num text-[10.5px] tabular-nums text-[var(--text-faint)]">
            {t('settings.subscriptions.totalDaily', {
              amount: formatEur(totalMonthly / 30, locale),
            })}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-2 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] p-3.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[10.5px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
            {t('settings.subscriptions.conversion')}
          </span>
          <span className="num text-[11px] tabular-nums text-[var(--text-dim)]">
            {t('settings.subscriptions.usdToEurPreview', {
              rate: settings.subscriptions.usdToEur.toFixed(4),
            })}
          </span>
        </div>
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2">
          <label className="flex flex-col gap-1">
            <span className="text-[10px] uppercase tracking-[0.08em] text-[var(--text-dim)]">
              {t('settings.subscriptions.usdToEur')}
            </span>
            <input
              type="number"
              min={0}
              step="0.0001"
              value={settings.subscriptions.usdToEur}
              onChange={(e) =>
                update({
                  subscriptions: {
                    ...settings.subscriptions,
                    usdToEur: Number(e.target.value) || 0.93,
                  },
                })
              }
              className="num !py-1 !text-[12.5px] tabular-nums"
              style={{ maxWidth: 120 }}
            />
          </label>
          <p className="min-w-[240px] flex-1 text-[11.5px] leading-snug text-[var(--text-dim)]">
            {t('settings.subscriptions.usdToEurHint', { ccusage: '`ccusage`' })}
          </p>
        </div>
      </div>
    </div>
  );
}

function UnifiedBillingTable({
  history,
  onChange,
}: {
  history: BillingHistoryValue;
  onChange: (next: BillingHistoryValue) => void;
}) {
  const { t, locale } = useTranslation();
  const dtLocale = dateLocale(locale);

  type Row = { vendor: Vendor; index: number; charge: BillingCharge };
  const rows: Row[] = VENDORS.flatMap((vendor) =>
    (history[vendor] || []).map((charge, index) => ({ vendor, index, charge })),
  ).sort((a, b) => b.charge.date.localeCompare(a.charge.date));

  const perVendor = VENDORS.map((vendor) => {
    const list = history[vendor] || [];
    const sum = list.reduce((acc, c) => acc + safeNum(c.amountEur), 0);
    return {
      vendor,
      count: list.length,
      sum,
      avg: list.length ? sum / list.length : 0,
    };
  });

  const monthGroups = (() => {
    const map = new Map<string, Row[]>();
    for (const row of rows) {
      const ym = row.charge.date.slice(0, 7);
      if (!map.has(ym)) map.set(ym, []);
      map.get(ym)?.push(row);
    }
    return [...map.entries()];
  })();

  function formatMonthLabel(ym: string): string {
    const [year, month] = ym.split('-').map(Number);
    if (!year || !month) return ym;
    const d = new Date(Date.UTC(year, month - 1, 1));
    return d.toLocaleDateString(dtLocale, { month: 'long', year: 'numeric' });
  }

  function mutateCharge(vendor: Vendor, index: number, patch: Partial<BillingCharge>) {
    onChange({
      ...history,
      [vendor]: (history[vendor] || []).map((c, i) => (i === index ? { ...c, ...patch } : c)),
    });
  }

  function removeCharge(vendor: Vendor, index: number) {
    onChange({ ...history, [vendor]: (history[vendor] || []).filter((_, i) => i !== index) });
  }

  function addCharge(vendor: Vendor) {
    const list = history[vendor] || [];
    const last = list[list.length - 1];
    onChange({
      ...history,
      [vendor]: [
        ...list,
        {
          date: todayIso(),
          amountEur: last?.amountEur ?? 0,
          plan: last?.plan ?? '',
          coverageDays: last?.coverageDays ?? 31,
        },
      ],
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3.5 py-2.5">
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          {perVendor.map((v) => {
            const color = VENDOR_COLOR[v.vendor];
            const dim = v.count === 0;
            return (
              <div
                key={v.vendor}
                className={`flex items-baseline gap-1.5 ${dim ? 'opacity-40' : ''}`}
              >
                <span
                  aria-hidden="true"
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: color }}
                />
                <span
                  className="text-[12.5px] font-semibold capitalize tracking-[0.01em]"
                  style={{ color }}
                >
                  {v.vendor}
                </span>
                <span className="num text-[11px] tabular-nums text-[var(--text-dim)]">
                  {v.count}{' '}
                  {v.count > 1 ? t('settings.billing.chargeMany') : t('settings.billing.chargeOne')}
                </span>
                <span className="num text-[12.5px] font-semibold tabular-nums text-[var(--text)]">
                  {formatEur(v.sum, locale)}
                </span>
                {v.count > 1 ? (
                  <span className="num text-[10px] tabular-nums text-[var(--text-faint)]">
                    ·{' '}
                    {t('settings.billing.avgPerCharge', {
                      amount: formatEur(v.avg, locale),
                    })}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>
        <div className="flex items-center gap-1.5">
          {VENDORS.map((vendor) => {
            const color = VENDOR_COLOR[vendor];
            return (
              <Button
                key={vendor}
                tone="ghost"
                onClick={() => addCharge(vendor)}
                className="!py-1 !text-[11.5px]"
              >
                <span
                  aria-hidden="true"
                  className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle"
                  style={{ backgroundColor: color }}
                />
                <span className="capitalize">{t('settings.billing.addFor', { vendor })}</span>
              </Button>
            );
          })}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-start gap-1 rounded-[var(--radius)] border border-dashed border-[var(--border)] bg-[var(--surface-1)] px-3.5 py-4">
          <p className="text-[12.5px] text-[var(--text-mute)]">{t('settings.billing.empty')}</p>
          <p className="text-[11px] text-[var(--text-faint)]">{t('settings.billing.emptyHint')}</p>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {monthGroups.map(([ym, monthRows]) => {
            const monthSum = monthRows.reduce((acc, r) => acc + safeNum(r.charge.amountEur), 0);
            return (
              <div key={ym} className="flex flex-col gap-1">
                <div className="flex items-baseline justify-between gap-2 px-1">
                  <span className="text-[10px] uppercase tracking-[0.1em] text-[var(--text-faint)]">
                    {formatMonthLabel(ym)}
                  </span>
                  <span className="num text-[10px] tabular-nums text-[var(--text-faint)]">
                    {t('settings.billing.monthTotal', {
                      amount: formatEur(monthSum, locale),
                    })}
                  </span>
                </div>
                <div className="overflow-hidden rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)]">
                  {monthRows.map(({ vendor, index, charge }, i) => {
                    const color = VENDOR_COLOR[vendor];
                    return (
                      <div
                        key={`${vendor}-${index}-${charge.date}`}
                        className={`group relative flex items-center gap-2.5 py-1.5 pl-4 pr-2 transition-colors hover:bg-[var(--surface-2)] ${i > 0 ? 'border-t border-[var(--border)]' : ''}`}
                      >
                        <span
                          aria-hidden="true"
                          title={vendor}
                          className="absolute left-1.5 top-1/2 h-2 w-2 -translate-y-1/2 rounded-full"
                          style={{ backgroundColor: color }}
                        />
                        <input
                          type="date"
                          value={charge.date}
                          onChange={(e) => mutateCharge(vendor, index, { date: e.target.value })}
                          className="!py-0.5 !text-[12px]"
                          style={{ width: 120 }}
                        />
                        <div className="flex items-baseline gap-1">
                          <input
                            type="number"
                            min={0}
                            step="0.01"
                            value={charge.amountEur}
                            onChange={(e) =>
                              mutateCharge(vendor, index, {
                                amountEur: Number(e.target.value) || 0,
                              })
                            }
                            className="num !py-0.5 !text-right !text-[12.5px] font-semibold tabular-nums"
                            style={{ width: 84 }}
                          />
                          <span className="shrink-0 text-[10.5px] text-[var(--text-faint)]">€</span>
                        </div>
                        <input
                          value={charge.plan}
                          onChange={(e) => mutateCharge(vendor, index, { plan: e.target.value })}
                          placeholder={t('settings.billing.planPlaceholder')}
                          className="min-w-0 flex-1 !py-0.5 !text-[12px]"
                        />
                        <div className="flex items-baseline gap-1">
                          <input
                            type="number"
                            min={1}
                            step="1"
                            value={charge.coverageDays ?? ''}
                            placeholder={t('settings.billing.coverageAuto')}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (!v) {
                                const { coverageDays: _omit, ...rest } = charge;
                                void _omit;
                                onChange({
                                  ...history,
                                  [vendor]: (history[vendor] || []).map((row, i2) =>
                                    i2 === index ? (rest as BillingCharge) : row,
                                  ),
                                });
                                return;
                              }
                              mutateCharge(vendor, index, {
                                coverageDays: Number(v) || 31,
                              });
                            }}
                            className="num !py-0.5 !text-right !text-[12px] tabular-nums"
                            style={{ width: 58 }}
                          />
                          <span className="shrink-0 text-[10.5px] text-[var(--text-faint)]">
                            {t('settings.billing.coverageUnit')}
                          </span>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeCharge(vendor, index)}
                          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-[13px] text-[var(--text-faint)] opacity-0 transition hover:bg-[rgba(255,69,58,0.12)] hover:text-[var(--danger)] focus:opacity-100 group-hover:opacity-100"
                          aria-label={t('settings.billing.deleteAria')}
                          title={t('settings.billing.deleteAria')}
                        >
                          ×
                        </button>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function SyncRow({
  label,
  state,
  onRun,
}: {
  label: string;
  state: SyncState;
  onRun: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-[var(--radius)] border border-[var(--border)] bg-[var(--surface-1)] px-3 py-2">
      <span className="min-w-[180px] text-[13px] font-medium text-[var(--text)]">{label}</span>
      <Button tone="accent" onClick={onRun} disabled={state.running}>
        {state.running ? t('common.running') : t('common.run')}
      </Button>
      <span className="min-h-[1em] flex-1 text-[12px]">
        {state.error ? (
          <span className="text-[#ff453a]">{state.error}</span>
        ) : state.result ? (
          <span className="text-[#30d158]">{state.result}</span>
        ) : (
          <span className="text-[var(--text-faint)]">—</span>
        )}
      </span>
    </div>
  );
}

function ShortcutsSectionBody() {
  const [bindings, setBindingsState] = useState(() => getBindings());
  const [recording, setRecording] = useState<ActionId | null>(null);
  const [conflict, setConflict] = useState<string | null>(null);

  useEffect(() => {
    const unsub = subscribe(() => setBindingsState(getBindings()));
    return unsub;
  }, []);

  useEffect(() => {
    if (!recording) return;
    const target: ActionId = recording;
    function onKey(event: KeyboardEvent) {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === 'Escape') {
        setRecording(null);
        setConflict(null);
        return;
      }
      if (['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) return;

      const next = serializeKey(event);
      const c = findConflict(next, target);
      if (c) {
        setConflict(`conflit avec « ${ACTION_LABELS[c]} »`);
        return;
      }
      setBinding(target, next);
      setRecording(null);
      setConflict(null);
    }
    window.addEventListener('keydown', onKey, { capture: true });
    return () => window.removeEventListener('keydown', onKey, { capture: true });
  }, [recording]);

  const groups: Array<{ title: string; actions: ActionId[] }> = [
    {
      title: 'Navigation',
      actions: [
        'nav.overview',
        'nav.projects',
        'nav.github',
        'nav.vault',
        'nav.usage',
        'nav.agent',
        'nav.radar',
        'nav.settings',
        'nav.agentJump',
      ],
    },
    { title: 'Radar', actions: ['radar.scan', 'radar.generate', 'radar.toggleMatrix'] },
  ];

  return (
    <div className="flex flex-col gap-4">
      {groups.map((group) => (
        <div key={group.title} className="flex flex-col gap-1">
          <div className="text-[10.5px] uppercase tracking-[0.1em] text-[var(--text-dim)]">
            {group.title}
          </div>
          <div className="grid grid-cols-1 gap-0.5 md:grid-cols-2">
            {group.actions.map((id) => {
              const active = recording === id;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => {
                    setConflict(null);
                    setRecording(active ? null : id);
                  }}
                  className={`flex items-center justify-between gap-2 rounded-[var(--radius-sm)] border px-2 py-1 text-left text-[12px] transition ${
                    active
                      ? 'border-[var(--accent)] bg-[rgba(100,210,255,0.08)]'
                      : 'border-[var(--border)] hover:bg-[var(--surface-2)]'
                  }`}
                >
                  <span className="text-[var(--text)]">{ACTION_LABELS[id]}</span>
                  <kbd
                    className={`num text-[11px] tabular-nums ${
                      active ? 'text-[var(--accent)]' : 'text-[var(--text-mute)]'
                    }`}
                  >
                    {active ? 'presse une touche…' : formatBinding(bindings[id])}
                  </kbd>
                </button>
              );
            })}
          </div>
        </div>
      ))}
      {conflict ? (
        <p className="text-[11px] text-[#ffd60a]">{conflict} — essaie une autre touche.</p>
      ) : null}
    </div>
  );
}
