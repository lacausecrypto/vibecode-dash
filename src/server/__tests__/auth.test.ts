import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { _internals, authMiddleware } from '../lib/auth';

const {
  hostIsLoopback,
  originIsLoopback,
  hostIsAllowed,
  originIsAllowed,
  tokensEqual,
  parseAllowedHosts,
} = _internals;

describe('hostIsLoopback', () => {
  test.each([
    ['127.0.0.1:4318', true],
    ['127.0.0.1', true],
    ['localhost:4317', true],
    ['LOCALHOST:4317', true],
    ['[::1]:4318', true],
    ['[::1]', true],
    ['evil.example.com', false],
    ['192.168.1.10:4318', false],
    ['127.0.0.1.evil.com', false],
    ['', false],
    [undefined, false],
  ])('host %s -> %s', (input, expected) => {
    expect(hostIsLoopback(input as string | undefined)).toBe(expected);
  });
});

describe('originIsLoopback', () => {
  test.each([
    ['http://127.0.0.1:4317', true],
    ['http://localhost:4317', true],
    ['https://localhost', true],
    ['http://[::1]:4318', true],
    ['http://evil.example.com', false],
    ['file:///etc/passwd', false],
    ['null', false],
    ['', false],
    [undefined, false],
  ])('origin %s -> %s', (input, expected) => {
    expect(originIsLoopback(input as string | undefined)).toBe(expected);
  });
});

describe('tokensEqual', () => {
  test('equal tokens match', () => {
    expect(tokensEqual('abc123', 'abc123')).toBe(true);
  });
  test('different tokens fail', () => {
    expect(tokensEqual('abc123', 'abc124')).toBe(false);
  });
  test('different lengths fail', () => {
    expect(tokensEqual('abc', 'abc1')).toBe(false);
  });
});

const TOKEN = 'a'.repeat(64);

function buildApp() {
  const app = new Hono();
  app.use('/api/*', authMiddleware({ token: TOKEN }));
  app.get('/api/auth/token', (c) => c.json({ token: TOKEN }));
  app.get('/api/health', (c) => c.json({ ok: true }));
  app.get('/api/projects', (c) => c.json({ data: [] }));
  app.post('/api/projects', (c) => c.json({ ok: true }));
  return app;
}

describe('authMiddleware', () => {
  const app = buildApp();

  test('rejects non-loopback Host', async () => {
    const r = await app.request('/api/projects', {
      headers: { host: 'evil.example.com' },
    });
    expect(r.status).toBe(403);
  });

  test('rejects cross-origin GET', async () => {
    const r = await app.request('/api/projects', {
      headers: { host: '127.0.0.1:4318', origin: 'http://evil.example.com' },
    });
    expect(r.status).toBe(403);
  });

  test('rejects cross-origin POST', async () => {
    const r = await app.request('/api/projects', {
      method: 'POST',
      headers: {
        host: '127.0.0.1:4318',
        origin: 'http://evil.example.com',
        'content-type': 'application/json',
        'x-dashboard-token': TOKEN,
      },
      body: '{}',
    });
    expect(r.status).toBe(403);
  });

  test('rejects missing token on gated route', async () => {
    const r = await app.request('/api/projects', {
      headers: { host: '127.0.0.1:4318' },
    });
    expect(r.status).toBe(403);
  });

  test('rejects wrong token on gated route', async () => {
    const r = await app.request('/api/projects', {
      headers: { host: '127.0.0.1:4318', 'x-dashboard-token': 'wrong' },
    });
    expect(r.status).toBe(403);
  });

  test('accepts correct token on gated route', async () => {
    const r = await app.request('/api/projects', {
      headers: { host: '127.0.0.1:4318', 'x-dashboard-token': TOKEN },
    });
    expect(r.status).toBe(200);
  });

  test('allows /api/auth/token without token header', async () => {
    const r = await app.request('/api/auth/token', {
      headers: { host: '127.0.0.1:4318' },
    });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ token: TOKEN });
  });

  test('allows /api/health without token header', async () => {
    const r = await app.request('/api/health', {
      headers: { host: '127.0.0.1:4318' },
    });
    expect(r.status).toBe(200);
  });

  test('allows OPTIONS preflight through', async () => {
    // OPTIONS is skipped; downstream must handle (no route here -> 404).
    const r = await app.request('/api/projects', {
      method: 'OPTIONS',
      headers: {
        host: '127.0.0.1:4318',
        origin: 'http://evil.example.com',
      },
    });
    expect(r.status).not.toBe(403);
  });

  test('disabled mode bypasses everything', async () => {
    const loose = new Hono();
    loose.use('/api/*', authMiddleware({ token: TOKEN, disabled: true }));
    loose.post('/api/projects', (c) => c.json({ ok: true }));
    const r = await loose.request('/api/projects', {
      method: 'POST',
      headers: { host: 'evil.example.com', origin: 'http://evil.example.com' },
    });
    expect(r.status).toBe(200);
  });
});

// ─── parseAllowedHosts ───

describe('parseAllowedHosts', () => {
  test('returns empty set for unset / empty / whitespace input', () => {
    expect(parseAllowedHosts(undefined).size).toBe(0);
    expect(parseAllowedHosts('').size).toBe(0);
    expect(parseAllowedHosts('   ').size).toBe(0);
    expect(parseAllowedHosts(',,,').size).toBe(0);
  });

  test('parses comma-separated list, lowercasing + port-stripping', () => {
    const set = parseAllowedHosts('Mac.TAILBEEF.ts.net:443, my-mac.local, 100.64.0.5:8080');
    expect(set.has('mac.tailbeef.ts.net')).toBe(true);
    expect(set.has('my-mac.local')).toBe(true);
    expect(set.has('100.64.0.5')).toBe(true);
    // port-stripped, NOT preserved
    expect(set.has('mac.tailbeef.ts.net:443')).toBe(false);
  });

  test('handles IPv6 hostnames in brackets', () => {
    const set = parseAllowedHosts('[fd7a:115c:a1e0::1]:443');
    expect(set.has('fd7a:115c:a1e0::1')).toBe(true);
  });
});

// ─── hostIsAllowed (loopback + explicit allowlist) ───

describe('hostIsAllowed', () => {
  const tailnet = new Set(['mac.tailbeef.ts.net', 'my-mac.local']);

  test('loopback hosts always pass, regardless of allowlist', () => {
    expect(hostIsAllowed('127.0.0.1:4318', tailnet)).toBe(true);
    expect(hostIsAllowed('localhost', tailnet)).toBe(true);
    expect(hostIsAllowed('[::1]', tailnet)).toBe(true);
    // Even with empty allowlist, loopback works (unchanged behavior).
    expect(hostIsAllowed('127.0.0.1', new Set())).toBe(true);
  });

  test('allow-listed external host passes (case-insensitive, port-tolerant)', () => {
    expect(hostIsAllowed('mac.tailbeef.ts.net', tailnet)).toBe(true);
    expect(hostIsAllowed('MAC.TAILBEEF.ts.net:443', tailnet)).toBe(true);
    expect(hostIsAllowed('my-mac.local:8080', tailnet)).toBe(true);
  });

  test('non-allow-listed external host is rejected even with non-empty list', () => {
    expect(hostIsAllowed('evil.example.com', tailnet)).toBe(false);
    expect(hostIsAllowed('attacker.tailbeef.ts.net', tailnet)).toBe(false);
    // Empty allowlist + non-loopback → strict reject (historical behavior).
    expect(hostIsAllowed('mac.tailbeef.ts.net', new Set())).toBe(false);
  });

  test('rejects undefined / empty Host', () => {
    expect(hostIsAllowed(undefined, tailnet)).toBe(false);
    expect(hostIsAllowed('', tailnet)).toBe(false);
  });
});

describe('originIsAllowed', () => {
  const tailnet = new Set(['mac.tailbeef.ts.net']);

  test('loopback origin passes', () => {
    expect(originIsAllowed('http://127.0.0.1:4317', tailnet)).toBe(true);
    expect(originIsAllowed('http://localhost', tailnet)).toBe(true);
  });

  test('https Origin from allow-listed host passes (Tailscale serves HTTPS)', () => {
    expect(originIsAllowed('https://mac.tailbeef.ts.net', tailnet)).toBe(true);
    expect(originIsAllowed('https://MAC.TAILBEEF.TS.NET:443', tailnet)).toBe(true);
  });

  test('non-allow-listed external origin rejected', () => {
    expect(originIsAllowed('https://evil.example.com', tailnet)).toBe(false);
    // Empty allowlist + non-loopback → reject (historical behavior).
    expect(originIsAllowed('https://mac.tailbeef.ts.net', new Set())).toBe(false);
  });

  test('non-http(s) protocol rejected even when hostname is allow-listed', () => {
    expect(originIsAllowed('file://mac.tailbeef.ts.net', tailnet)).toBe(false);
    expect(originIsAllowed('ftp://mac.tailbeef.ts.net', tailnet)).toBe(false);
  });

  test('malformed origin rejected', () => {
    expect(originIsAllowed('not a url', tailnet)).toBe(false);
    expect(originIsAllowed('', tailnet)).toBe(false);
    expect(originIsAllowed(undefined, tailnet)).toBe(false);
  });
});

// ─── End-to-end through the middleware with allowlist ───

describe('authMiddleware with allowedHosts', () => {
  const TAILNET = new Set(['mac.tailbeef.ts.net']);
  const TOKEN_E2E = 'a'.repeat(64);

  function buildApp() {
    const app = new Hono();
    app.use('/api/*', authMiddleware({ token: TOKEN_E2E, allowedHosts: TAILNET }));
    app.get('/api/projects', (c) => c.json({ ok: true }));
    app.post('/api/projects', (c) => c.json({ ok: true }));
    return app;
  }

  test('GET from Tailscale Host with valid token passes', async () => {
    const r = await buildApp().request('/api/projects', {
      headers: {
        host: 'mac.tailbeef.ts.net',
        'x-dashboard-token': TOKEN_E2E,
      },
    });
    expect(r.status).toBe(200);
  });

  test('GET from Tailscale Host without token still rejected (allowlist relaxes Host, NOT auth)', async () => {
    const r = await buildApp().request('/api/projects', {
      headers: { host: 'mac.tailbeef.ts.net' },
    });
    expect(r.status).toBe(403);
  });

  test('POST from Tailscale Origin + Host + token passes', async () => {
    const r = await buildApp().request('/api/projects', {
      method: 'POST',
      headers: {
        host: 'mac.tailbeef.ts.net',
        origin: 'https://mac.tailbeef.ts.net',
        'x-dashboard-token': TOKEN_E2E,
      },
    });
    expect(r.status).toBe(200);
  });

  test('POST from Tailscale Host but evil Origin rejected', async () => {
    const r = await buildApp().request('/api/projects', {
      method: 'POST',
      headers: {
        host: 'mac.tailbeef.ts.net',
        origin: 'https://evil.example.com',
        'x-dashboard-token': TOKEN_E2E,
      },
    });
    expect(r.status).toBe(403);
  });

  test('GET from non-allow-listed Host rejected even with valid token', async () => {
    const r = await buildApp().request('/api/projects', {
      headers: {
        host: 'attacker.tailbeef.ts.net',
        'x-dashboard-token': TOKEN_E2E,
      },
    });
    expect(r.status).toBe(403);
  });
});
