import type { Hono } from 'hono';

export function registerAuthRoutes(app: Hono, token: string): void {
  // Returns the shared token to the browser at boot. The Host+Origin checks
  // in the auth middleware guarantee this endpoint is only reachable from a
  // same-origin loopback page, so returning the token here is equivalent to
  // embedding it in the HTML shell.
  app.get('/api/auth/token', (c) => c.json({ token }));
}
