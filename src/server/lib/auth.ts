import { randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Context, MiddlewareHandler } from 'hono';
import { getDataDir } from '../config';

// Defence-in-depth for a 127.0.0.1-only HTTP server:
//
//   1. Host header must resolve to loopback OR an explicitly allow-listed
//      external host (see VIBECODEDASH_ALLOWED_HOSTS). Blocks DNS rebinding
//      where an attacker gets a browser to send a request to 127.0.0.1 via
//      a hostname they control.
//   2. Origin header (on unsafe methods) must come from a trusted origin
//      (loopback or allow-listed host). Blocks CSRF from third-party pages.
//   3. X-Dashboard-Token must match a per-user secret that lives outside the
//      repo. Blocks any local process that guesses the URL but can't read
//      files owned by the running user (other user accounts, sandboxed apps,
//      browser extensions issuing fetches).
//
// Remote-access path (Tailscale, ngrok-by-host, …):
//   The server still binds 127.0.0.1 only — `tailscale serve` (or any reverse
//   proxy you trust the auth of) terminates TLS on its own listener and
//   forwards to localhost. The proxy preserves the Host header by default,
//   so the auth middleware needs to know which external hostnames are
//   legitimate. Set the env var:
//
//     VIBECODEDASH_ALLOWED_HOSTS="my-mac.tailbeefcafe.ts.net,my-mac.local"
//
//   Comma-separated, case-insensitive, port stripped on match. Empty/unset
//   keeps the strict loopback-only behavior. The token + Origin checks still
//   apply on top — the allowlist is a relaxation of the Host gate, not of
//   authentication.

const TOKEN_HEADER = 'x-dashboard-token';
const TOKEN_BYTES = 32;
const TOKEN_FILE_NAME = 'auth-token';

// Routes that don't require the token (but still go through Host/Origin check).
const UNGATED_PATHS = new Set(['/api/auth/token', '/api/health']);

/**
 * Hostnames that pass the Host/Origin gate even when not loopback. Loaded
 * once at module import — env vars don't change at runtime in our model.
 * Hostnames are lowercased and port-stripped before insertion so the gate
 * doesn't have to do that work per request.
 *
 * Tests override via `AuthOptions.allowedHosts` to avoid polluting
 * process.env across the suite.
 */
const ALLOWED_EXTERNAL_HOSTS: ReadonlySet<string> = parseAllowedHosts(
  process.env.VIBECODEDASH_ALLOWED_HOSTS,
);

function parseAllowedHosts(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => stripHostPort(s.trim()).toLowerCase())
      .filter((s) => s.length > 0),
  );
}

function stripHostPort(host: string): string {
  // Handles IPv6 forms like `[::1]:4317` and `[::1]`. Mirrors the logic
  // baked into hostIsLoopback so allowlisted IPv6 hostnames also work.
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(1, end);
  }
  const colon = host.lastIndexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

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
  const host = stripHostPort(hostHeader.trim()).toLowerCase();
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

/**
 * Loopback OR allow-listed external host. The allowlist is a separate set
 * (not merged into hostIsLoopback) so the loopback fast-path stays cheap
 * and the security model can describe each gate independently.
 *
 * Empty allowlist → behavior is strictly loopback (the historical default).
 *
 * `allowed` defaults to the module-level set parsed from env at startup;
 * tests inject their own to keep process.env clean.
 */
function hostIsAllowed(
  hostHeader: string | undefined,
  allowed: ReadonlySet<string> = ALLOWED_EXTERNAL_HOSTS,
): boolean {
  if (hostIsLoopback(hostHeader)) return true;
  if (!hostHeader || allowed.size === 0) return false;
  const host = stripHostPort(hostHeader.trim()).toLowerCase();
  return allowed.has(host);
}

/** Loopback OR allow-listed origin. Same shape as hostIsAllowed but for Origin. */
function originIsAllowed(
  origin: string | undefined,
  allowed: ReadonlySet<string> = ALLOWED_EXTERNAL_HOSTS,
): boolean {
  if (originIsLoopback(origin)) return true;
  if (!origin || allowed.size === 0) return false;
  try {
    const u = new URL(origin);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const h = u.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    return allowed.has(h);
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
  /**
   * Optional explicit allowlist of external hosts (Tailscale hostname,
   * etc.) accepted on Host + Origin gates. When omitted, the value parsed
   * from `VIBECODEDASH_ALLOWED_HOSTS` at module load is used. Empty set =
   * strict loopback only (historical default).
   */
  allowedHosts?: ReadonlySet<string>;
}

export function authMiddleware(opts: AuthOptions): MiddlewareHandler {
  // Resolve once per middleware instance — opts is fixed at construction.
  const allowed = opts.allowedHosts ?? ALLOWED_EXTERNAL_HOSTS;

  return async (c, next) => {
    if (opts.disabled) return next();

    const method = c.req.method.toUpperCase();

    // CORS preflight — let the cors() middleware answer. It runs earlier in
    // the chain, so in practice we only reach here if cors() let OPTIONS fall
    // through (production, where preflights shouldn't happen anyway).
    if (method === 'OPTIONS') return next();

    const host = c.req.header('host');
    if (!hostIsAllowed(host, allowed)) {
      return deny(c, 'invalid host');
    }

    const origin = c.req.header('origin');
    if (UNSAFE_METHODS.has(method)) {
      // Browsers always attach Origin on CORS-relevant requests. A missing
      // Origin on an unsafe method is almost always a scripted client on the
      // same host — acceptable. If present, it must be loopback or
      // allow-listed (Tailscale hostname etc.).
      if (origin !== undefined && !originIsAllowed(origin, allowed)) {
        return deny(c, 'invalid origin');
      }
    } else if (origin !== undefined && !originIsAllowed(origin, allowed)) {
      // Be strict on cross-origin reads too — prevents exfil via GET if
      // someone ever adds a sensitive JSONP-shaped response.
      return deny(c, 'invalid origin');
    }

    const path = c.req.path;
    if (UNGATED_PATHS.has(path)) return next();

    // Header is the canonical transport — all code paths that can set custom
    // headers (our `apiGet` helper, fetch callers) use it.
    //
    // Fallback: for GET only, accept the token via `?token=…` query param.
    // This exists for DOM resource requests where we can't inject headers:
    // `<img src>`, `<video src>`, `<a download>`. Restricted to GET so we
    // never weaken CSRF protection on state-changing routes — POST/PUT
    // still require the header even if an attacker got the token into a URL.
    //
    // Token exposure risk is acceptable for our loopback-only model: token
    // lands in browser history and server logs, but the server is already
    // 127.0.0.1-gated and the token is per-user. Rotating the token (delete
    // the auth-token file) still invalidates any stale URLs immediately.
    const headerToken = c.req.header(TOKEN_HEADER);
    const queryToken = method === 'GET' ? c.req.query('token') : undefined;
    const provided = headerToken || queryToken;
    if (!provided || !tokensEqual(provided, opts.token)) {
      return deny(c, 'missing or invalid token');
    }

    return next();
  };
}

export const _internals = {
  hostIsLoopback,
  originIsLoopback,
  hostIsAllowed,
  originIsAllowed,
  tokensEqual,
  parseAllowedHosts,
  ALLOWED_EXTERNAL_HOSTS,
};
