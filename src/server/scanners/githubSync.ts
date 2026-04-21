import type { Database } from 'bun:sqlite';
import { currentLocale, t as serverT } from '../lib/i18n';
import { keychain } from '../lib/keychain';

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

async function runCommand(
  args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
  const proc = Bun.spawn(args, { stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  return { stdout, stderr, code };
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

  const response = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: {
      authorization: `bearer ${token}`,
      'content-type': 'application/json',
      'user-agent': 'vibecode-dash',
    },
    body: JSON.stringify({ query: QUERY_CALENDAR, variables: { login, from, to } }),
  });

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

  for (const day of weeks) {
    upsert.run(day.date, day.contributionCount, day.color, nowTs);
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
    const response = await fetch(
      `https://api.github.com/users/${encodeURIComponent(login)}/repos?per_page=100&sort=pushed&page=${page}`,
      {
        headers: {
          authorization: `Bearer ${token}`,
          accept: 'application/vnd.github+json',
          'user-agent': 'vibecode-dash',
        },
      },
    );

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`GitHub REST error ${response.status}: ${body}`);
    }

    const repos = (await response.json()) as GithubRepo[];
    if (repos.length === 0) {
      break;
    }

    for (const repo of repos) {
      upsert.run(
        repo.name,
        repo.description,
        repo.html_url,
        repo.stargazers_count,
        repo.forks_count,
        repo.language,
        JSON.stringify({ [repo.language || 'unknown']: 1 }),
        JSON.stringify(repo.topics || []),
        Math.floor(new Date(repo.pushed_at).getTime() / 1000),
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
  const response = await fetch(
    `https://api.github.com/repos/${encodeURIComponent(login)}/${encodeURIComponent(repo)}/traffic/${kind}`,
    {
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'user-agent': 'vibecode-dash',
      },
    },
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

  for (const row of repos) {
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
  }

  db.query('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(
    'last_github_traffic_sync',
    String(nowTs),
  );

  return { repos: syncedRepos, days: syncedDays, errors };
}

export async function syncGithubAll(
  db: Database,
  login: string,
  year?: number,
): Promise<{ repos: number; trafficRepos: number; trafficDays: number; trafficErrors: number }> {
  await syncGithubHeatmap(db, login, year);
  const repos = await syncGithubRepos(db, login);
  const traffic = await syncGithubTraffic(db, login);
  return {
    repos,
    trafficRepos: traffic.repos,
    trafficDays: traffic.days,
    trafficErrors: traffic.errors.length,
  };
}
