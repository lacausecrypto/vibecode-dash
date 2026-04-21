import type { Hono } from 'hono';

export function registerHealthRoutes(app: Hono): void {
  app.get('/api/health', (c) => {
    return c.json({ ok: true, ts: Date.now() });
  });
}
