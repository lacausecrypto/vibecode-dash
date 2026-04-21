import { describe, expect, test } from 'bun:test';
import { Hono } from 'hono';
import { _internals, authMiddleware } from '../lib/auth';

const { hostIsLoopback, originIsLoopback, tokensEqual } = _internals;

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
