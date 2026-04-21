import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context, MiddlewareHandler } from 'hono';
import { getDataDir } from '../config';

// Defence-in-depth for a 127.0.0.1-only HTTP server:
//
//   1. Host header must resolve to loopback. Blocks DNS rebinding where an
//      attacker gets a browser to send a request to 127.0.0.1 via a hostname
//      they control.
//   2. Origin header (on unsafe methods) must come from a trusted loopback
//      origin. Blocks CSRF from third-party pages.
//   3. X-Dashboard-Token must match a per-user secret that lives outside the
//      repo. Blocks any local process that guesses the URL but can't read
//      files owned by the running user (other user accounts, sandboxed apps,
//      browser extensions issuing fetches).

const TOKEN_HEADER = 'x-dashboard-token';
const TOKEN_BYTES = 32;
const TOKEN_FILE_NAME = 'auth-token';

// Routes that don't require the token (but still go through Host/Origin check).
const UNGATED_PATHS = new Set(['/api/auth/token', '/api/health']);

function tokenPath(): string {
  return join(getDataDir(), TOKEN_FILE_NAME);
}

/** Absolute path to the auth-token file. Exposed so the agent can read it via
 * shell substitution instead of carrying the literal token in its context. */
export function getTokenPath(): string {
  return tokenPath();
}

export function loadOrCreateToken(): string {
  const dir = getDataDir();
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const path = tokenPath();
  if (existsSync(path)) {
    const stored = readFileSync(path, 'utf8').trim();
    if (stored.length >= TOKEN_BYTES * 2) return stored;
  }
  const token = randomBytes(TOKEN_BYTES).toString('hex');
  writeFileSync(path, token, { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on Windows (NTFS ACLs) — file already scoped to user profile.
  }
  return token;
}

function hostIsLoopback(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false;
  // Strip optional port, keep raw host.
  // Handles IPv6 forms like `[::1]:4317` and `[::1]`.
  let host = hostHeader.trim();
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end === -1) return false;
    host = host.slice(1, end);
  } else {
    const colon = host.lastIndexOf(':');
    if (colon !== -1) host = host.slice(0, colon);
  }
  host = host.toLowerCase();
  return host === '127.0.0.1' || host === 'localhost' || host === '::1';
}

function originIsLoopback(origin: string | undefined): boolean {
  if (!origin) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    // URL.hostname returns IPv6 bracketed on some runtimes ("[::1]") and bare
    // on others ("::1") — normalize by stripping surrounding brackets.
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  } catch {
    return false;
  }
}

const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function tokensEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

function deny(c: Context, reason: string) {
  return c.json({ error: 'forbidden', reason }, 403);
}

export interface AuthOptions {
  token: string;
  /** If true, bypass all checks (test mode). */
  disabled?: boolean;
}

export function authMiddleware(opts: AuthOptions): MiddlewareHandler {
  return async (c, next) => {
    if (opts.disabled) return next();

    const method = c.req.method.toUpperCase();

    // CORS preflight — let the cors() middleware answer. It runs earlier in
    // the chain, so in practice we only reach here if cors() let OPTIONS fall
    // through (production, where preflights shouldn't happen anyway).
    if (method === 'OPTIONS') return next();

    const host = c.req.header('host');
    if (!hostIsLoopback(host)) {
      return deny(c, 'invalid host');
    }

    const origin = c.req.header('origin');
    if (UNSAFE_METHODS.has(method)) {
      // Browsers always attach Origin on CORS-relevant requests. A missing
      // Origin on an unsafe method is almost always a scripted client on the
      // same host — acceptable. If present, it must be loopback.
      if (origin !== undefined && !originIsLoopback(origin)) {
        return deny(c, 'invalid origin');
      }
    } else if (origin !== undefined && !originIsLoopback(origin)) {
      // Be strict on cross-origin reads too — prevents exfil via GET if
      // someone ever adds a sensitive JSONP-shaped response.
      return deny(c, 'invalid origin');
    }

    const path = c.req.path;
    if (UNGATED_PATHS.has(path)) return next();

    const provided = c.req.header(TOKEN_HEADER);
    if (!provided || !tokensEqual(provided, opts.token)) {
      return deny(c, 'missing or invalid token');
    }

    return next();
  };
}

export const _internals = {
  hostIsLoopback,
  originIsLoopback,
  tokensEqual,
};
