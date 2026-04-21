export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly statusText: string,
    public readonly detail?: string,
  ) {
    super(`${status} ${statusText}${detail ? `: ${detail}` : ''}`);
    this.name = 'ApiError';
  }
}

type ApiInit = RequestInit & { signal?: AbortSignal };

const TOKEN_ENDPOINT = '/api/auth/token';
const TOKEN_HEADER = 'x-dashboard-token';

// Cached bootstrap. Single flight: concurrent callers share the same promise
// so we don't open N parallel requests to /auth/token on page load.
let tokenPromise: Promise<string> | null = null;

function fetchToken(): Promise<string> {
  const res = fetch(TOKEN_ENDPOINT, {
    method: 'GET',
    headers: { accept: 'application/json' },
    credentials: 'same-origin',
  }).then(async (r) => {
    if (!r.ok) {
      const detail = await r.text().catch(() => '');
      throw new ApiError(r.status, r.statusText, detail || undefined);
    }
    const body = (await r.json()) as { token?: unknown };
    if (typeof body.token !== 'string' || body.token.length === 0) {
      throw new ApiError(500, 'Invalid token response');
    }
    return body.token;
  });
  // Clear the cache if bootstrap failed — otherwise every subsequent call
  // would replay the same rejection forever.
  res.catch(() => {
    tokenPromise = null;
  });
  return res;
}

function getToken(): Promise<string> {
  if (!tokenPromise) tokenPromise = fetchToken();
  return tokenPromise;
}

/**
 * For raw fetch() callers (e.g. SSE streaming) that can't go through request().
 * Returns the header name + token so the caller can attach it themselves.
 */
export async function getApiAuthHeader(): Promise<Record<string, string>> {
  return { [TOKEN_HEADER]: await getToken() };
}

async function request<T>(path: string, init: ApiInit = {}): Promise<T> {
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...(init.body ? { 'content-type': 'application/json' } : {}),
  };

  // The token endpoint itself must not require the header — would deadlock.
  if (path !== TOKEN_ENDPOINT) {
    headers[TOKEN_HEADER] = await getToken();
  }

  // Caller-supplied headers win, so tests can still override.
  const merged = { ...headers, ...((init.headers as Record<string, string> | undefined) || {}) };

  const res = await fetch(path, { ...init, headers: merged, credentials: 'same-origin' });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new ApiError(res.status, res.statusText, detail || undefined);
  }
  return (await res.json()) as T;
}

export async function apiGet<T>(path: string, init?: ApiInit): Promise<T> {
  return request<T>(path, { ...init, method: 'GET' });
}

export async function apiPost<T>(path: string, body?: unknown, init?: ApiInit): Promise<T> {
  return request<T>(path, {
    ...init,
    method: 'POST',
    body: body ? JSON.stringify(body) : undefined,
  });
}

export async function apiPut<T>(path: string, body: unknown, init?: ApiInit): Promise<T> {
  return request<T>(path, {
    ...init,
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

export async function apiDelete<T>(path: string, init?: ApiInit): Promise<T> {
  return request<T>(path, { ...init, method: 'DELETE' });
}

export function __resetApiTokenForTests(): void {
  tokenPromise = null;
}
