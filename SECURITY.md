# Security

## Threat model

vibecode-dash is designed for **single-user, single-machine** use. The threat model reflects that:

### In scope

- **Other processes on the same machine** running under different OS users (accidentally exposing localhost services to `nobody`, sandboxed utilities, browser extensions issuing `fetch`).
- **Third-party web pages** the user visits that try to hit `http://127.0.0.1:4317/...` from JavaScript (CSRF, DNS rebinding).
- **Accidental secret disclosure** via repo contents, `.env` files, logs.

### Out of scope

- Remote attackers on the LAN/internet — the server **only** binds `127.0.0.1`; there is no port exposed beyond the loopback interface.
- Users with physical access to the machine and the same OS account — at that point everything is game (the keyring, the browser session, the SSH keys).
- Hardened multi-tenant deployments. Don't run this on a shared server.

---

## Defences

### Network

The Hono server binds `127.0.0.1` only, never `0.0.0.0`. See [`src/server/index.ts`](src/server/index.ts).

### Request-level (`/api/*`)

Three independent checks, all enforced by [`src/server/lib/auth.ts`](src/server/lib/auth.ts):

1. **Host header** must resolve to loopback (`127.0.0.1`, `localhost`, `::1`). Blocks DNS rebinding where an attacker gets a browser to send a request to `127.0.0.1` via a hostname they control.
2. **Origin header**, when present, must be a loopback origin. Blocks CSRF from third-party pages (which a browser would auto-attach `Origin` to on unsafe methods).
3. **`X-Dashboard-Token` header** must match a 64-hex-character secret generated at first boot and compared with `timingSafeEqual`. The token lives at:
   - macOS: `~/Library/Application Support/vibecode-dash/auth-token`
   - Linux: `$XDG_DATA_HOME/vibecode-dash/auth-token` (or `~/.local/share/vibecode-dash/auth-token`)
   - Windows: `%APPDATA%\vibecode-dash\auth-token`
   - File mode `0600` (Windows: NTFS ACLs via user profile scope).

`OPTIONS` preflights bypass the auth checks so CORS works cleanly. `/api/auth/token` and `/api/health` are ungated (but still pass Host + Origin).

### Secrets at rest

No secret is ever written to the repo or to `.env`. GitHub PATs and similar tokens live in the OS keyring, accessed through [`src/server/lib/keychain.ts`](src/server/lib/keychain.ts):

| OS | Backend | Install command |
|---|---|---|
| macOS | `security` CLI → login keychain | built-in |
| Linux | `secret-tool` → libsecret (GNOME Keyring / KWallet / KeePassXC) | `apt install libsecret-tools` |
| Windows | PowerShell + DPAPI blob in `%APPDATA%\vibecode-dash\secrets\*.dpapi` | built-in |

The Windows DPAPI blob is encrypted with the current user's profile key — only the same OS user, on the same machine, can decrypt it.

### Process isolation

LLM CLIs (`claude`, `codex`) are spawned as subprocesses with `Bun.spawn`. No SDK is used (no credential forwarding into the dashboard process memory). Agent sessions persist *transcripts*, not credentials.

---

## What vibecode-dash **never** does

- Open a port beyond loopback.
- Phone home (no telemetry, no error-reporting SaaS).
- Write secrets to the repo or to `data/`.
- Ship tokens to the browser except over the gated `/api/auth/token` endpoint.
- Execute arbitrary shell commands from API input — agent invocations use fixed argv arrays.

---

## Reporting a vulnerability

Open a **private** security advisory on GitHub (`Security` tab → `Report a vulnerability`) or email the maintainer directly. Please don't file public issues for security bugs.

Include:
- A minimal reproduction (local is fine — this project runs on loopback).
- The OS and Bun version (`bun --version`).
- The commit SHA you tested against.

I'll acknowledge within 72 hours and aim for a fix within two weeks for anything exploitable. There is no bug bounty — this is an unfunded side project.

---

## Hardening tips for contributors

- Never `console.log(token)` or any value read from the keyring.
- If you add a new `/api/*` route, it's gated by default — no extra work needed. If you need it ungated (health checks, bootstrap), add it to `UNGATED_PATHS` in `auth.ts` and document why.
- Never call `app.use(..., cors({ origin: '*' }))`. CORS is only enabled in dev with an explicit loopback whitelist.
- When spawning a CLI, pass arguments as an array (`Bun.spawn(['claude', '--read-only', ...])`), never a composed string.
