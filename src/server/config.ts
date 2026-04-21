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
