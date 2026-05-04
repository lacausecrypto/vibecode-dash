import type { Database } from 'bun:sqlite';
import { currentLocale, t as serverT } from '../lib/i18n';
import { keychain } from '../lib/keychain';
import { fetchWithTimeout, spawnWithTimeout } from '../lib/safeFetch';

const QUERY_CALENDAR = `
  query($login: String!, $from: DateTime, $to: DateTime) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          totalContributions
          weeks {
            contributionDays {
              date
              contributionCount
              color
              weekday
            }
          }
        }
      }
    }
  }
`;

type GithubContributionDay = {
  date: string;
  contributionCount: number;
  color: string;
};

// Accept any representation GitHub might emit (ISO 8601 string, epoch number,
// missing) and normalize to a finite integer seconds-since-epoch, or null on
// failure. Used for repo.pushed_at and similar date fields; never returns NaN
// which would crash strict-mode SQLite INTEGER binding.
function toEpochSeconds(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? Math.floor(value) : null;
  }
  if (typeof value === 'string' && value.length > 0) {
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
  }
  return null;
}

// Hands off to the shared spawn-with-timeout wrapper. 10 s is plenty for
// `gh auth token` (local op) — we never want the GitHub sync to hang on a
// broken or zombie gh process.
async function runCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  return spawnWithTimeout(args, 10_000);
}

async function githubToken(): Promise<string> {
  try {
    const fromKeychain = (await keychain.get('github-pat')).trim();
    if (fromKeychain.length > 0) {
      return fromKeychain;
    }
  } catch {
    // fallback on gh auth below
  }

  const ghToken = await runCommand(['gh', 'auth', 'token']);
  if (ghToken.code === 0) {
    const token = ghToken.stdout.trim();
    if (token.length > 0) {
      return token;
    }
  }

  throw new Error(serverT(await currentLocale(), 'github.notConnected'));
}

export async function syncGithubHeatmap(db: Database, login: string, year?: number): Promise<void> {
  if (!login.trim()) {
    throw new Error('github.username not configured — set it in Settings → GitHub.');
  }
  const token = await githubToken();
  const now = new Date();
  const y = year ?? now.getUTCFullYear();
  const from = new Date(Date.UTC(y, 0, 1, 0, 0, 0)).toISOString();
  const to = new Date(Date.UTC(y, 11, 31, 23, 59, 59)).toISOString();

  // 20 s timeout: GraphQL contributions calendar usually returns in <2 s
  // but GitHub will occasionally tarpit unauthorized / rate-limited callers
  // for tens of seconds. A bounded timeout means a failed sync attempt
  // surfaces as an error instead of a hung scheduler tick.
  const response = await fetchWithTimeout(
    'https://api.github.com/graphql',
    {
      method: 'POST',
      headers: {
        authorization: `bearer ${token}`,
        'content-type': 'application/json',
        'user-agent': 'vibecode-dash',
      },
      body: JSON.stringify({ query: QUERY_CALENDAR, variables: { login, from, to } }),
    },
    20_000,
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub GraphQL error ${response.status}: ${body}`);
  }

  const json = (await response.json()) as {
    data?: {
      user?: {
        contributionsCollection?: {
          contributionCalendar?: {
            weeks?: Array<{ contributionDays?: GithubContributionDay[] }>;
          };
        };
      };
    };
    errors?: Array<{ message: string }>;
  };

  if (json.errors && json.errors.length > 0) {
    throw new Error(json.errors[0].message);
  }

  const weeks =
    json.data?.user?.contributionsCollection?.contributionCalendar?.weeks?.flatMap(
      (week) => week.contributionDays || [],
    ) || [];

  const nowTs = Math.floor(Date.now() / 1000);
  const upsert = db.query(`
    INSERT INTO github_contributions (date, count, color, synced_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      count = excluded.count,
      color = excluded.color,
      synced_at = excluded.synced_at
  `);

  // Validate each day before touching SQL. DB runs in strict mode, so passing
  // `undefined` for a NOT NULL column aborts the whole sync — a schema change
  // on GitHub's side would silently freeze the heatmap with no recovery.
  let skipped = 0;
  for (const day of weeks) {
    if (
      typeof day.date !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
      typeof day.contributionCount !== 'number' ||
      !Number.isFinite(day.contributionCount)
    ) {
      skipped += 1;
      continue;
    }
    upsert.run(day.date, day.contributionCount, day.color ?? null, nowTs);
  }
  if (skipped > 0) {
    console.warn(`[github] heatmap: skipped ${skipped} malformed day(s) from GraphQL response`);
  }

  db.query('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
    'last_github_heatmap_sync',
    String(nowTs),
  );
}

type GithubRepo = {
  name: string;
  description: string | null;
  html_url: string;
  stargazers_count: number;
  forks_count: number;
  language: string | null;
  topics?: string[];
  pushed_at: string;
  fork: boolean;
};

type GithubTrafficPoint = {
  timestamp: string;
  count: number;
  uniques: number;
};

type GithubViewsResponse = {
  count: number;
  uniques: number;
  views: GithubTrafficPoint[];
};

type GithubClonesResponse = {
  count: number;
  uniques: number;
  clones: GithubTrafficPoint[];
};

export async function syncGithubRepos(db: Database, login: string): Promise<number> {
  const token = await githubToken();
  const nowTs = Math.floor(Date.now() / 1000);
  let page = 1;
  let total = 0;

  const upsert = db.query(`
    INSERT INTO github_repos (
      name, description, url, stars, forks, primary_lang, languages_json, topics_json,
      pushed_at, is_fork, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(name) DO UPDATE SET
      description = excluded.description,
      url = excluded.url,
      stars = excluded.stars,
      forks = excluded.forks,
      primary_lang = excluded.primary_lang,
      languages_json = excluded.languages_json,
      topics_json = excluded.topics_json,
      pushed_at = excluded.pushed_at,
      is_fork = excluded.is_fork,
      synced_at = excluded.synced_at
  `);

  while (true) {
    const response = await fetchWithTimeout(
      `https://api.github.com/users/${encodeURIComponent(login)}/repos?per_page=100&sort=pushed&page=${page}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'vibecode-dash',
        },
      },
      20_000,
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub REST error ${response.status}: ${body}`);
    }

    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      // GitHub returns {message, documentation_url} on auth/rate-limit errors
      // with a 200. Treat as terminal and surface.
      throw new Error(
        `GitHub REST /repos returned non-array payload: ${JSON.stringify(payload).slice(0, 200)}`,
      );
    }
    const repos = payload as GithubRepo[];
    if (repos.length === 0) {
      break;
    }

    for (const repo of repos) {
      if (typeof repo.name !== 'string' || repo.name.length === 0) {
        console.warn('[github] repos: skipping entry without valid name');
        continue;
      }
      // repo.pushed_at may be missing on freshly-created repos; new Date(undefined)
      // yields NaN, which strict-mode SQLite rejects → whole sync aborts.
      const pushedAtSec = toEpochSeconds(repo.pushed_at);
      upsert.run(
        repo.name,
        repo.description ?? null,
        repo.html_url ?? null,
        Number.isFinite(repo.stargazers_count) ? repo.stargazers_count : 0,
        Number.isFinite(repo.forks_count) ? repo.forks_count : 0,
        repo.language ?? null,
        JSON.stringify({ [repo.language || 'unknown']: 1 }),
        JSON.stringify(Array.isArray(repo.topics) ? repo.topics : []),
        pushedAtSec,
        repo.fork ? 1 : 0,
        nowTs,
      );
      total += 1;
    }

    page += 1;
  }

  db.query('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
    'last_github_repos_sync',
    String(nowTs),
  );

  return total;
}

async function fetchGithubTrafficWindow(
  token: string,
  login: string,
  repo: string,
  kind: 'views' | 'clones',
): Promise<GithubTrafficPoint[]> {
  const response = await fetchWithTimeout(
    `https://api.github.com/repos/${encodeURIComponent(login)}/${encodeURIComponent(repo)}/traffic/${kind}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'vibecode-dash',
      },
    },
    15_000,
  );

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub traffic ${kind} error ${response.status}: ${body}`);
  }

  const payload = (await response.json()) as GithubViewsResponse | GithubClonesResponse;
  if (kind === 'views') {
    return (payload as GithubViewsResponse).views || [];
  }
  return (payload as GithubClonesResponse).clones || [];
}

export async function syncGithubTraffic(
  db: Database,
  login: string,
): Promise<{ repos: number; days: number; errors: string[] }> {
  const token = await githubToken();
  const nowTs = Math.floor(Date.now() / 1000);
  const repos = db
    .query<{ name: string }, []>(
      'SELECT name FROM github_repos WHERE COALESCE(is_fork, 0) = 0 ORDER BY pushed_at DESC, name ASC',
    )
    .all();

  const upsert = db.query(`
    INSERT INTO github_repo_traffic_daily (
      repo, date, views_count, views_uniques, clones_count, clones_uniques, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(repo, date) DO UPDATE SET
      views_count = excluded.views_count,
      views_uniques = excluded.views_uniques,
      clones_count = excluded.clones_count,
      clones_uniques = excluded.clones_uniques,
      synced_at = excluded.synced_at
  `);

  let syncedRepos = 0;
  let syncedDays = 0;
  const errors: string[] = [];

  // Per-repo concurrency cap. Without it, 100 repos × 2 fetches kicks off
  // 200 simultaneous calls to GitHub — easy to trip secondary-rate-limit
  // protection ("abuse detection"). 4 in flight is conservative: each batch
  // makes 8 calls (2 endpoints × 4 repos), well under GitHub's documented
  // 5000-req/h primary quota even on a 4-min cycle.
  const PER_REPO_CONCURRENCY = 4;
  const processRepo = async (row: { name: string }) => {
    try {
      const [views, clones] = await Promise.all([
        fetchGithubTrafficWindow(token, login, row.name, 'views'),
        fetchGithubTrafficWindow(token, login, row.name, 'clones'),
      ]);

      const byDate = new Map<
        string,
        {
          viewsCount: number;
          viewsUniques: number;
          clonesCount: number;
          clonesUniques: number;
        }
      >();

      for (const day of views) {
        const date = day.timestamp.slice(0, 10);
        byDate.set(date, {
          viewsCount: day.count || 0,
          viewsUniques: day.uniques || 0,
          clonesCount: byDate.get(date)?.clonesCount || 0,
          clonesUniques: byDate.get(date)?.clonesUniques || 0,
        });
      }

      for (const day of clones) {
        const date = day.timestamp.slice(0, 10);
        const current = byDate.get(date);
        byDate.set(date, {
          viewsCount: current?.viewsCount || 0,
          viewsUniques: current?.viewsUniques || 0,
          clonesCount: day.count || 0,
          clonesUniques: day.uniques || 0,
        });
      }

      for (const [date, values] of byDate.entries()) {
        upsert.run(
          row.name,
          date,
          values.viewsCount,
          values.viewsUniques,
          values.clonesCount,
          values.clonesUniques,
          nowTs,
        );
        syncedDays += 1;
      }

      syncedRepos += 1;
    } catch (error) {
      errors.push(`${row.name}: ${String(error)}`);
    }
  };

  // Process repos in fixed-size batches. Each batch runs in parallel; the
  // outer loop awaits batch completion before starting the next.
  for (let i = 0; i < repos.length; i += PER_REPO_CONCURRENCY) {
    const batch = repos.slice(i, i + PER_REPO_CONCURRENCY);
    await Promise.all(batch.map((row) => processRepo(row)));
  }

  db.query('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
    'last_github_traffic_sync',
    String(nowTs),
  );

  return { repos: syncedRepos, days: syncedDays, errors };
}

type GithubCommitListItem = {
  sha: string;
  commit: {
    author?: { date?: string; name?: string } | null;
    committer?: { date?: string } | null;
    message?: string;
  };
};

/**
 * Fetch the last 365 days of commits across every non-fork repo we know
 * about, persist into `github_commits`. The schema stores `date` as
 * INTEGER unix seconds (cf. migration 0012); per-day aggregation
 * downstream reconstructs the ISO day with strftime, so no truncation
 * here.
 *
 * No `author=` filter on purpose: GitHub's author resolution is brittle
 * (commits with a noreply email that doesn't carry the numeric user-id
 * prefix don't get linked, so the filter under-counts), and the
 * per-project KPI strip wants total commit activity on the repo
 * (including external contributors). User-attributed contributions are
 * already covered by the heatmap via the GraphQL contributionsCollection.
 *
 * Pagination is capped at MAX_PAGES per repo — 5×100 = 500 commits / repo
 * is comfortable headroom for personal projects on a 365 d window without
 * spending the rate-limit budget on long-tail history.
 *
 * Per-commit additions/deletions require a second REST call each, which
 * would multiply quota usage by N×500 with little payoff (we only show
 * SHA + message + date in the UI). Skipped on purpose; the schema columns
 * stay nullable.
 */
export async function syncGithubCommits(
  db: Database,
  login: string,
): Promise<{ repos: number; commits: number; errors: string[] }> {
  if (!login.trim()) {
    throw new Error('github.username not configured — set it in Settings → GitHub.');
  }
  const token = await githubToken();
  const nowTs = Math.floor(Date.now() / 1000);
  const sinceIso = new Date(Date.now() - 365 * 86_400_000).toISOString();

  const repos = db
    .query<{ name: string }, []>(
      'SELECT name FROM github_repos WHERE COALESCE(is_fork, 0) = 0 ORDER BY pushed_at DESC, name ASC',
    )
    .all();

  const upsert = db.query(
    `INSERT INTO github_commits (sha, repo, date, message, additions, deletions)
     VALUES (?, ?, ?, ?, NULL, NULL)
     ON CONFLICT(sha) DO UPDATE SET
       repo    = excluded.repo,
       date    = excluded.date,
       message = excluded.message`,
  );

  let syncedRepos = 0;
  let syncedCommits = 0;
  const errors: string[] = [];

  const PER_REPO_CONCURRENCY = 4;
  const MAX_PAGES = 5;

  const processRepo = async (row: { name: string }) => {
    try {
      let page = 1;
      let total = 0;
      while (page <= MAX_PAGES) {
        const url =
          `https://api.github.com/repos/${encodeURIComponent(login)}/${encodeURIComponent(row.name)}/commits` +
          `?since=${encodeURIComponent(sinceIso)}&per_page=100&page=${page}`;
        const response = await fetchWithTimeout(
          url,
          {
            headers: {
              authorization: `Bearer ${token}`,
              accept: 'application/vnd.github+json',
              'user-agent': 'vibecode-dash',
            },
          },
          15_000,
        );
        if (response.status === 409) {
          // Empty repo — GitHub returns 409 ("Git Repository is empty"). Skip silently.
          break;
        }
        if (!response.ok) {
          const body = await response.text();
          throw new Error(`commits ${response.status}: ${body.slice(0, 200)}`);
        }
        const payload = (await response.json()) as unknown;
        if (!Array.isArray(payload)) {
          throw new Error(`non-array commits payload: ${JSON.stringify(payload).slice(0, 200)}`);
        }
        const commits = payload as GithubCommitListItem[];
        if (commits.length === 0) break;

        for (const c of commits) {
          if (typeof c.sha !== 'string' || c.sha.length === 0) continue;
          const dateStr = c.commit?.author?.date ?? c.commit?.committer?.date ?? null;
          const dateSec = toEpochSeconds(dateStr);
          if (dateSec === null) continue;
          const message = typeof c.commit?.message === 'string' ? c.commit.message : null;
          upsert.run(c.sha, row.name, dateSec, message);
          total += 1;
        }

        if (commits.length < 100) break; // last page
        page += 1;
      }
      syncedCommits += total;
      syncedRepos += 1;
    } catch (error) {
      errors.push(`${row.name}: ${String(error)}`);
    }
  };

  for (let i = 0; i < repos.length; i += PER_REPO_CONCURRENCY) {
    const batch = repos.slice(i, i + PER_REPO_CONCURRENCY);
    await Promise.all(batch.map((r) => processRepo(r)));
  }

  db.query('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
    'last_github_commits_sync',
    String(nowTs),
  );

  return { repos: syncedRepos, commits: syncedCommits, errors };
}

export async function syncGithubAll(
  db: Database,
  login: string,
  year?: number,
): Promise<{
  repos: number;
  trafficRepos: number;
  trafficDays: number;
  trafficErrors: number;
  commitRepos: number;
  commits: number;
  commitErrors: number;
}> {
  await syncGithubHeatmap(db, login, year);
  const repos = await syncGithubRepos(db, login);
  const traffic = await syncGithubTraffic(db, login);
  // Commits sync depends on github_repos being populated first (we only
  // crawl repos we know about). Errors are collected per-repo and don't
  // abort the rest — same contract as syncGithubTraffic.
  const commits = await syncGithubCommits(db, login);
  return {
    repos,
    trafficRepos: traffic.repos,
    trafficDays: traffic.days,
    trafficErrors: traffic.errors.length,
    commitRepos: commits.repos,
    commits: commits.commits,
    commitErrors: commits.errors.length,
  };
}
