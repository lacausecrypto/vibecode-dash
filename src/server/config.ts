import { existsSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  appDataDir,
  defaultClaudeConfigDir,
  defaultProjectsRoot,
  defaultVaultPath,
} from './lib/platform';

const SubscriptionPlanSchema = z.object({
  plan: z.string(),
  monthlyEur: z.number().min(0),
});

const BillingChargeSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD'),
  amountEur: z.number().min(0),
  plan: z.string(),
  // Coverage in days. Default 31 (typical monthly sub). Set explicitly if a sub was skipped mid-cycle.
  coverageDays: z.number().positive().optional(),
});

const BillingHistorySchema = z
  .object({
    claude: z.array(BillingChargeSchema).default([]),
    codex: z.array(BillingChargeSchema).default([]),
  })
  .default({ claude: [], codex: [] });

const LocaleSchema = z.enum(['fr', 'en', 'es']).default('fr');

const SettingsSchema = z.object({
  locale: LocaleSchema,
  paths: z.object({
    projectsRoots: z.array(z.string()).min(1),
    vaultPath: z.string(),
    claudeConfigDir: z.string(),
    /**
     * Absolute paths the user has explicitly deselected. Detected projects
     * whose path appears here are skipped during scan + hidden from /projects.
     * Blacklist shape: new projects auto-appear until the user opts them out.
     */
    excludedProjects: z.array(z.string()).default([]),
  }),
  github: z.object({
    username: z.string(),
  }),
  schedules: z.object({
    projectRescanMinutes: z.number().min(1),
    githubSyncMinutes: z.number().min(1),
    obsidianSyncMinutes: z.number().min(1).default(10),
    usageSyncMinutes: z.number().min(1),
    presenceScanMinutes: z.number().min(5).default(45),
    presenceEngagementPollMinutes: z.number().min(15).default(60),
  }),
  presence: z
    .object({
      // Scoring and drafting both go through the Claude or Codex CLI so the
      // user's existing subscription / OAuth covers the cost. OpenRouter is
      // reserved for image generation only. Each stage picks its own model
      // from the live catalog at /api/agent/models.
      drafterProvider: z.enum(['claude', 'codex']).default('claude'),
      scorerModel: z.string().default('claude-haiku-4-5-20251001'),
      drafterModel: z.string().default('claude-sonnet-4-6'),
      // X API PAYG cost per read. Default 0.017 ≈ $0.60 / 35 reads (observed
      // bill on Basic tier). Overrideable so the user can keep the ledger
      // honest if their tier changes.
      xReadCostUsd: z.number().min(0).default(0.017),
      // Auto scheduler kill-switch. Default OFF — scans run only when the
      // user clicks "Scan now" in the UI. Toggling this back on (via the
      // Settings tab) takes effect on the next scheduler tick without a
      // server restart, because the scheduler reads the flag at run time.
      // The expire_stale sweep stays on regardless (it's free + DB-only).
      autoScanEnabled: z.boolean().default(false),
      // Hard cap on cumulative cost ledger spend per LOCAL calendar day.
      // 0 = no cap. Checked before each scan; if today's spend already meets
      // or exceeds the cap, the scan aborts with `budget_exceeded: true` so
      // the UI can surface the reason. Manual scan-now respects the cap too
      // (no escape hatch — that defeats the safety net).
      dailyBudgetUsd: z.number().min(0).default(0.5),
      // Engagement polling is INDEPENDENT of autoScanEnabled: it's mostly
      // free (Reddit public permalink.json + X syndication CDN), so the user
      // who turned auto-scan off to save money still wants their posted
      // drafts tracked. Default ON; turn off only if you don't want any
      // background activity at all. Manual /engagement-poll-now bypasses
      // this flag the same way scan-now bypasses TTL.
      engagementPollEnabled: z.boolean().default(true),
      // Override list for the X tweet quality scorer's curated-author boost.
      // When set (non-empty), this list REPLACES the built-in default
      // (`DEFAULT_HIGH_VALUE_HANDLES` in `lib/tweetQuality.ts`) — letting
      // the user point the +0.15 quality bump at their own niche (data
      // engineering, VC, fintech, …) without editing source. Handles are
      // stored without `@` and lowercased on read. Empty / unset =
      // built-in AI-and-indie-dev list.
      highValueAuthorHandles: z.array(z.string()).default([]),
    })
    .default({
      drafterProvider: 'claude',
      scorerModel: 'claude-haiku-4-5-20251001',
      drafterModel: 'claude-sonnet-4-6',
      xReadCostUsd: 0.017,
      autoScanEnabled: false,
      dailyBudgetUsd: 0.5,
      engagementPollEnabled: true,
      highValueAuthorHandles: [],
    }),
  subscriptions: z
    .object({
      usdToEur: z.number().positive().default(0.93),
      claude: SubscriptionPlanSchema.default({ plan: 'Max x20', monthlyEur: 180 }),
      codex: SubscriptionPlanSchema.default({ plan: 'Pro x5', monthlyEur: 100 }),
    })
    .default({
      usdToEur: 0.93,
      claude: { plan: 'Max x20', monthlyEur: 180 },
      codex: { plan: 'Pro x5', monthlyEur: 100 },
    }),
  displayAliases: z.record(z.string(), z.string()).default({}),
  devEquivalent: z
    .object({
      hourlyRateEur: z.number().positive().default(100),
      outputTokensPerHour: z.number().positive().default(2500),
    })
    .default({ hourlyRateEur: 100, outputTokensPerHour: 2500 }),
  billingHistory: BillingHistorySchema,
});

export type Settings = z.infer<typeof SettingsSchema>;

function buildDefaults(): Settings {
  return {
    locale: 'fr',
    paths: {
      projectsRoots: [process.env.PROJECTS_ROOT || defaultProjectsRoot()],
      vaultPath: process.env.VAULT_PATH || defaultVaultPath(),
      claudeConfigDir: process.env.CLAUDE_CONFIG_DIR || defaultClaudeConfigDir(),
      excludedProjects: [],
    },
    github: {
      username: process.env.GITHUB_USERNAME || '',
    },
    schedules: {
      projectRescanMinutes: 30,
      githubSyncMinutes: 30,
      obsidianSyncMinutes: 10,
      usageSyncMinutes: 10,
      presenceScanMinutes: 45,
      presenceEngagementPollMinutes: 60,
    },
    presence: {
      drafterProvider: 'claude',
      scorerModel: 'claude-haiku-4-5-20251001',
      drafterModel: 'claude-sonnet-4-6',
      xReadCostUsd: 0.017,
      autoScanEnabled: false,
      dailyBudgetUsd: 0.5,
      engagementPollEnabled: true,
      highValueAuthorHandles: [],
    },
    subscriptions: {
      usdToEur: 0.93,
      claude: { plan: 'Max x20', monthlyEur: 180 },
      codex: { plan: 'Pro x5', monthlyEur: 100 },
    },
    displayAliases: {},
    devEquivalent: {
      hourlyRateEur: 100,
      outputTokensPerHour: 2500,
    },
    billingHistory: {
      claude: [],
      codex: [],
    },
  };
}

export function expandHomePath(input: string): string {
  if (input.startsWith('~/')) {
    return join(homedir(), input.slice(2));
  }
  if (input === '~') {
    return homedir();
  }
  return input;
}

export function getDataDir(): string {
  const override = process.env.VIBECODEDASH_DATA_DIR;
  if (override && override.length > 0) {
    return expandHomePath(override);
  }
  // Dev + test: repo-local `data/` so cloning and hacking is self-contained.
  // Installed / production: the OS app-data dir, alongside the auth token.
  if (process.env.NODE_ENV === 'production') {
    return appDataDir();
  }
  return join(process.cwd(), 'data');
}

export function getDbPath(): string {
  return join(getDataDir(), 'db.sqlite');
}

function getSettingsPath(): string {
  return join(getDataDir(), 'settings.json');
}

// Cached in-memory. Settings rarely change and loadSettings() is called from
// ~45 places across the codebase (every API route, every scanner). Reading the
// file on every call amplifies FD pressure during page loads + vault scans
// (observed ENFILE "file table overflow" on macOS). Invalidated by saveSettings().
let cachedSettings: Settings | null = null;
let cachedLoad: Promise<Settings> | null = null;

async function loadSettingsFromDisk(): Promise<Settings> {
  const dataDir = getDataDir();
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const path = getSettingsPath();
  const defaults = buildDefaults();
  if (!existsSync(path)) {
    await writeFile(path, JSON.stringify(defaults, null, 2), 'utf8');
    return defaults;
  }

  const raw = await readFile(path, 'utf8');
  const parsed = SettingsSchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    await writeFile(path, JSON.stringify(defaults, null, 2), 'utf8');
    return defaults;
  }

  return parsed.data;
}

export async function loadSettings(): Promise<Settings> {
  if (cachedSettings) return cachedSettings;
  // Concurrent callers share a single in-flight read.
  if (!cachedLoad) {
    cachedLoad = loadSettingsFromDisk()
      .then((data) => {
        cachedSettings = data;
        return data;
      })
      .finally(() => {
        cachedLoad = null;
      });
  }
  return cachedLoad;
}

export async function saveSettings(settings: Settings): Promise<void> {
  const dataDir = getDataDir();
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  const normalized: Settings = {
    ...settings,
    paths: {
      ...settings.paths,
      projectsRoots: settings.paths.projectsRoots.map((p) => expandHomePath(p)),
      vaultPath: expandHomePath(settings.paths.vaultPath),
      claudeConfigDir: expandHomePath(settings.paths.claudeConfigDir),
    },
  };

  await writeFile(getSettingsPath(), JSON.stringify(normalized, null, 2), 'utf8');
  // Invalidate cache — next loadSettings() will re-read.
  cachedSettings = null;
}

export { SettingsSchema };
