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

1. **Host header** must resolve to loopback (`127.0.0.1`, `localhost`, `::1`) **or to an explicitly allow-listed external host** (see *Remote access via Tailscale* below). Blocks DNS rebinding where an attacker gets a browser to send a request to `127.0.0.1` via a hostname they control.
2. **Origin header**, when present, must be loopback or an allow-listed origin. Blocks CSRF from third-party pages (which a browser would auto-attach `Origin` to on unsafe methods).
3. **`X-Dashboard-Token` header** must match a 64-hex-character secret generated at first boot and compared with `timingSafeEqual`. The token lives at:
   - macOS: `~/Library/Application Support/vibecode-dash/auth-token`
   - Linux: `$XDG_DATA_HOME/vibecode-dash/auth-token` (or `~/.local/share/vibecode-dash/auth-token`)
   - Windows: `%APPDATA%\vibecode-dash\auth-token`
   - File mode `0600` (Windows: NTFS ACLs via user profile scope).

`OPTIONS` preflights bypass the auth checks so CORS works cleanly. `/api/auth/token` and `/api/health` are ungated (but still pass Host + Origin).

### Remote access via Tailscale

The dashboard never opens a port beyond loopback **and never will**. Remote access (e.g. accessing the dashboard from your iPhone) goes through a reverse proxy you trust the auth of — typically [Tailscale](https://tailscale.com/) running on the same Mac.

Architecture:

```
iPhone ─[WireGuard tunnel]─► tailscaled (100.x.x.x:443, TLS auto-cert)
                                  │ reverse proxy
                                  ▼
                             127.0.0.1:4317  (vibecode-dash, UNCHANGED)
```

The Tailscale daemon already running on your Mac terminates TLS with a Let's Encrypt cert provisioned by Tailscale, then forwards to localhost. The vibecode-dash server stays bound to `127.0.0.1` — only the local proxy can reach it. Identity is enforced at the WireGuard layer (per-device keys, revocable from `https://login.tailscale.com/admin/machines`).

Setup:

```bash
# On the Mac, expose the dashboard on the Tailnet
tailscale serve --bg --https=443 http://127.0.0.1:4317

# Find the hostname Tailscale assigned
tailscale status   # → e.g. "mac.tail-beefcafe.ts.net"
```

Because the Host/Origin gate rejects everything that isn't loopback by default, you must tell the dashboard which external hostname to accept. Set `VIBECODEDASH_ALLOWED_HOSTS` (comma-separated, port-stripped, case-insensitive) before launching the server:

```bash
VIBECODEDASH_ALLOWED_HOSTS="mac.tail-beefcafe.ts.net" bunx vibecode-dash
```

The token + Origin checks still apply on top — the allowlist relaxes the **Host gate only**, not authentication. A Tailnet peer who reaches the dashboard still needs the token, which they fetch from the ungated `/api/auth/token` endpoint on first hit (then stored in localStorage).

What this gives you:

- ✅ Server stays `127.0.0.1` (unchanged binding, defence-in-depth preserved)
- ✅ TLS to your iPhone (no self-signed cert pain)
- ✅ Identity revocable per-device from the Tailscale admin console
- ✅ Public internet exposure stays OFF (Tailnet peers only — Tailscale Funnel must be opted in separately and is **not** what `tailscale serve` does)

What you still need to know:

- The token endpoint is ungated. Anyone in your Tailnet can fetch it. Keep your Tailnet personal or audit `tailscale status` regularly.
- Don't enable [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) on this service unless you really mean to expose it to the public internet — Funnel routes any internet client through to the proxy, bypassing the Tailnet identity gate.
- If you lose your iPhone, revoke its key from the [Tailscale admin console](https://login.tailscale.com/admin/machines) — the device is removed from the Tailnet and can't reach the dashboard. The on-disk auth token stays valid (still required by other peers), so no token rotation is needed unless the device was compromised at the keychain level.

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
