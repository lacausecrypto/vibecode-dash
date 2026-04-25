import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { cors } from 'hono/cors';
import { logger } from 'hono/logger';
import { getDb, runMigrations } from './db';
import { startObsidianWatcher } from './jobs/obsidianWatcher';
import { startScheduler } from './jobs/scheduler';
import { authMiddleware, loadOrCreateToken } from './lib/auth';
import { purgeOrphanMemories } from './lib/memory';
import { seedDefaultPresenceSources } from './lib/presence';
import { registerRoutes } from './routes';
import { registerAuthRoutes } from './routes/auth';

const app = new Hono();
const isProduction = process.env.NODE_ENV === 'production';

if (!isProduction) {
  app.use('*', logger());
  app.use(
    '/api/*',
    cors({
      origin: ['http://localhost:4317', 'http://127.0.0.1:4317'],
      allowHeaders: ['content-type', 'x-dashboard-token'],
      allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    }),
  );
}

const authToken = loadOrCreateToken();
app.use(
  '/api/*',
  authMiddleware({
    token: authToken,
    disabled: process.env.NODE_ENV === 'test' || process.env.VIBECODEDASH_AUTH_DISABLED === '1',
  }),
);

registerAuthRoutes(app, authToken);
registerRoutes(app);

// Resolve the built client relative to this file (install-agnostic). When
// bundled to `dist/server/index.js`, the sibling is `dist/client/`; running
// source from `src/server/index.ts` falls through to the repo-local build,
// and in dev-server mode Vite serves the client directly anyway.
const selfDir = dirname(fileURLToPath(import.meta.url));
const clientRootCandidates = [join(selfDir, '..', 'client'), join(process.cwd(), 'dist', 'client')];
const clientRoot = clientRootCandidates.find((p) => existsSync(p));

if (clientRoot) {
  app.use('/*', serveStatic({ root: clientRoot }));
}

app.get('*', async (c) => {
  if (clientRoot) {
    const indexPath = join(clientRoot, 'index.html');
    if (existsSync(indexPath)) {
      return c.html(await Bun.file(indexPath).text());
    }
  }

  return c.json({
    ok: true,
    message: 'vibecode-dash API running',
    frontend: 'Start Vite with `bun run dev` and open http://localhost:4317',
  });
});

await runMigrations();

// Purge memories whose referenced project or session has disappeared since.
// Cheap, runs once per boot. Kept out of the migration itself because it
// depends on the live state of `projects` / `agent_sessions`.
try {
  const removed = purgeOrphanMemories(getDb());
  if (removed > 0) {
    console.log(`[boot] purged ${removed} orphan agent memories`);
  }
} catch (error) {
  console.warn('[boot] orphan memory cleanup failed:', String(error));
}

// Seed presence sources on first run only. Idempotent via kv flag, so the
// user deleting every seeded source won't trigger re-seeding on next boot.
try {
  const res = seedDefaultPresenceSources(getDb());
  if (res.seeded > 0) {
    console.log(
      `[boot] seeded ${res.seeded} presence sources (batches: ${res.batches.join(', ')})`,
    );
    // Pack A — fire-and-forget validation pass on the freshly seeded rows.
    // Backgrounded so boot stays fast (validation is ~5s for typical seed).
    // Sources confirmed dead get auto-deactivated; partial/error keep their
    // active flag so the user can review.
    void (async () => {
      try {
        const { validateAllSources } = await import('./lib/sourceValidation');
        const out = await validateAllSources(getDb());
        const flagged = out.not_found + out.banned + out.private_count + out.error + out.partial;
        if (flagged > 0) {
          console.log(
            `[boot] post-seed validation: ${out.valid} valid, ${out.not_found} not_found, ` +
              `${out.banned} banned, ${out.private_count} private, ${out.partial} partial, ` +
              `${out.error} error, ${out.deactivated} auto-deactivated`,
          );
        }
      } catch (e) {
        console.warn('[boot] post-seed validation failed:', String(e));
      }
    })();
  }
} catch (error) {
  console.warn('[boot] presence source seeding failed:', String(error));
}

await startScheduler();
void startObsidianWatcher();

const port = Number.parseInt(process.env.PORT || '4317', 10);

// Explicit serve() — works whether this module is the main entry (`bun
// dist/server/index.js`) or imported from the CLI wrapper (`bin/vibecode-dash.mjs`).
// Relying on `export default { fetch }` would only auto-start in the former case.
// idleTimeout bumped from Bun's 10s default: several `npx ccusage*` endpoints
// (by-model, hour-distribution, blocks --active) can take 6–20s on cold npm
// cache, and the 10s default returns 500 before the command finishes.
Bun.serve({
  port,
  hostname: '127.0.0.1',
  idleTimeout: 60,
  fetch: app.fetch,
});

console.log(`vibecode-dash -> http://127.0.0.1:${port}`);
