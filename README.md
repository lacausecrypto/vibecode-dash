# vibecode-dash

[![npm version](https://img.shields.io/npm/v/vibecode-dash?color=cb3837&logo=npm)](https://www.npmjs.com/package/vibecode-dash)
[![npm downloads (total)](https://img.shields.io/npm/dt/vibecode-dash?color=cb3837&logo=npm&label=downloads)](https://www.npmjs.com/package/vibecode-dash)
[![CI](https://github.com/lacausecrypto/vibecode-dash/actions/workflows/ci.yml/badge.svg)](https://github.com/lacausecrypto/vibecode-dash/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/vibecode-dash?color=blue)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/lacausecrypto/vibecode-dash?style=social)](https://github.com/lacausecrypto/vibecode-dash)

> Your local mission control for LLM-assisted development.

vibecode-dash turns your Claude Code / Codex CLI sessions, local Git repos, GitHub activity, LLM usage, and Obsidian vault into one observable dashboard. It is built for solo developers who ship with agents and still want to know what changed, what it cost, what is stale, and what they learned along the way.

```bash
bunx vibecode-dash
```

No dashboard account. No telemetry. No cloud database. A Bun server on `127.0.0.1`, a SQLite file, and credentials stored in your OS keyring.

![vibecode-dash demo](docs/media/demo.gif)

**Current status:** `v0.3.3` — usable today, actively evolving. The core dashboard, usage telemetry, project scanner, vault index, agent sessions, Radar, and Presence assist flow are functional. Some social publishing internals are still experimental and are called out below.

---

## Why It Exists

LLM-assisted coding creates a new kind of mess:

- Claude Code and Codex know what happened in sessions, but not what shipped.
- `ccusage` knows tokens and cost, but not which local repo got value from them.
- GitHub knows public activity, but not your local context or abandoned work.
- Obsidian has decisions and lessons, but they rarely flow back into the next agent conversation.
- Social/product feedback lives outside the development loop.

vibecode-dash stitches those surfaces together locally so you can answer practical questions:

- Which projects are alive, stale, dirty, tested, or worth attention today?
- What did Claude and Codex cost this week, by project and model?
- Which notes, decisions, and memories should be available to the next agent session?
- What should I ship, revisit, document, or talk about next?

---

## What You Get

### LLM Usage Telemetry

Reads Claude Code JSONL history and Codex usage data, then stores rollups in SQLite.

- Daily and monthly token/cost views.
- Usage by project, model, hour, and tool.
- Claude + Codex combined timeline.
- Subscription-vs-PAYG math with configurable plan costs.
- Dev-equivalent estimates based on your hourly rate and output-token baseline.

This is not a proxy and not an SDK integration. It reads the artifacts your CLI tools already write.

### Projects + GitHub

Scans configured project roots for local repositories and enriches them with GitHub data when `gh` or a PAT is available.

- Local project inventory with language mix, LoC, README/tests/CI signals, dirty state, and health score.
- Per-project detail pages with README rendering, file tree, git stats, usage, and Radar context.
- GitHub repos, commits, contribution heatmap, traffic snapshots, and npm downloads when available.
- Manual and scheduled rescans.

Your local working tree is treated as the source of truth. GitHub is enrichment, not the primary database.

### Obsidian Vault

Indexes your vault without an Obsidian plugin.

- Markdown scan with front matter, tags, wikilinks, backlinks, orphans, graph, and FTS5 search.
- Read access from the UI and agent context.
- Controlled write-back for generated hubs, archived sessions, Radar insights, and reviewed memories.
- Auto-generated blocks are bounded by markers so hand-written content stays yours.

### Agent Sessions

A sessions UI over the installed `claude` and `codex` CLIs.

- Persistent sessions with streaming responses.
- Modes for Chat, Plan, Learn, and Reflect.
- Context injection from project state, persona files, durable memories, and relevant vault notes.
- Optional archive-to-vault.
- Memory extraction after assistant replies, mirrored back into Markdown for review.

Important: the dashboard wraps local CLIs. You still need `claude` and/or `codex` installed and authenticated separately.

### Competitor Radar

For each project, you can track competitors and ask an agent to produce structured positioning insights.

- Manual competitor list per project.
- Read-only scan path for public competitor surfaces.
- Divergence insights that can be promoted into the vault.
- Designed for product direction, not automated web scraping at scale.

### Presence Copilot

Presence is the social/work-in-public loop. It helps you find relevant threads, draft replies/posts, and track outcomes.

The primary UX is **assist-first**:

- Scan configured Reddit/X sources.
- Score opportunities.
- Draft candidate replies/posts with your local CLI.
- Let you edit, approve, ignore, or reject.
- Copy the final text, open the platform composer/thread, and ask you to mark the result as posted.
- Poll engagement where the platform exposes enough public data.

Honest note: older server-side X auto-publish code still exists behind off-by-default settings for headless/experimental use, but the current product path is manual assist. The UI does not rely on auto-posting.

---

## What It Is Not

- Not a SaaS observability platform.
- Not a multi-user dashboard.
- Not a replacement for Obsidian, GitHub, `ccusage`, Claude Code, or Codex.
- Not a social scheduler.
- Not a hosted agent backend.
- Not air-gapped once you use external CLIs or integrations; Claude, Codex, GitHub, Reddit, X, and OpenRouter calls still go to their respective providers.

The goal is narrower: one local surface for a solo developer's real work loop.

---

## Install

### Requirements

| Platform | Required | Optional |
|---|---|---|
| macOS 13+ | Bun 1.1+ | `gh`, `claude`, `codex` |
| Linux | Bun 1.1+, `secret-tool` for keyring-backed secrets | `gh`, `claude`, `codex` |
| Windows 10+ | Bun 1.1+ | `gh`, `claude`, `codex` |

Linux keyring setup:

```bash
# Debian/Ubuntu
sudo apt install libsecret-tools

# Fedora
sudo dnf install libsecret

# Arch
sudo pacman -S libsecret
```

### Run From npm

```bash
bunx vibecode-dash
```

The packaged app serves the UI and API from one loopback port:

```text
http://127.0.0.1:4317
```

Useful flags:

```bash
vibecode-dash --help
vibecode-dash --version
vibecode-dash --port 7000
vibecode-dash --data-dir ~/.local/share/my-vibecode-dash
vibecode-dash --no-open
```

### Run From Source

```bash
git clone https://github.com/lacausecrypto/vibecode-dash
cd vibecode-dash
bun install
bun run dev
```

Dev mode runs two processes:

- Client: `http://127.0.0.1:4317`
- API: `http://127.0.0.1:4318`

The Vite client proxies `/api` to the server.

---

## First Boot

On first launch, vibecode-dash:

1. Creates a data directory.
2. Generates a local auth token.
3. Writes default settings.
4. Creates and migrates `db.sqlite`.
5. Starts scheduled jobs and the Obsidian watcher when configured.

Default data locations:

| OS | Data directory |
|---|---|
| macOS | `~/Library/Application Support/vibecode-dash/` |
| Linux | `$XDG_DATA_HOME/vibecode-dash/` or `~/.local/share/vibecode-dash/` |
| Windows | `%APPDATA%\vibecode-dash\` |

Defaults can be overridden with:

```bash
VIBECODEDASH_DATA_DIR=/custom/path vibecode-dash
```

In dev mode, state is kept in repo-local `data/` so hacking on the app stays self-contained.

---

## Configuration

Most setup happens in **Settings**.

Recommended first steps:

1. Set your project roots.
2. Set your Obsidian vault path.
3. Add your GitHub username and run a sync.
4. Configure Claude/Codex subscription costs if you care about PAYG comparison.
5. Connect optional services only when you need them.

Optional integrations:

| Integration | Used for | Credential storage |
|---|---|---|
| GitHub / `gh` / PAT | repo metadata, commits, traffic | `gh` auth or OS keyring |
| Claude CLI | agent sessions, memory pass, drafting | Claude CLI's own auth |
| Codex CLI | agent sessions, Codex usage, optional drafting | Codex CLI's own auth |
| Reddit | richer reads and engagement where available | OS keyring |
| X | source reads and optional write credentials | OS keyring |
| OpenRouter | opt-in image generation for Presence drafts | OS keyring |

---

## Architecture

```text
Production:

Browser
  |
  | http://127.0.0.1:4317
  v
Bun + Hono server
  |-- static React app
  |-- /api/* routes
  |-- scheduler jobs
  |-- Obsidian watcher
  |-- CLI wrappers for claude/codex/ccusage/gh
  v
SQLite + OS keyring + local filesystem
```

```text
Development:

Vite client  : http://127.0.0.1:4317
Hono API     : http://127.0.0.1:4318
Proxy        : /api -> 4318
```

Stack:

- Bun
- Hono
- React
- Vite
- Tailwind CSS
- SQLite via `bun:sqlite`
- Zod
- `ccusage` / `@ccusage/codex`
- OS keyring APIs

There are no LLM SDK dependencies in the core agent path. The dashboard delegates to local CLIs so your vendor credentials stay with those tools.

---

## Security Model

vibecode-dash is designed for single-user, local-machine use.

Core defenses:

- Server binds `127.0.0.1` only.
- `/api/*` checks Host, Origin, and `X-Dashboard-Token`.
- Token is generated on first boot and stored in the data dir.
- Secrets are stored in the OS keyring, not in `.env` or SQLite.
- Markdown rendering sanitizes HTML before injecting it into the UI.
- README assets are served through bounded local endpoints rather than a generic file server.

Remote access is possible through a trusted local reverse proxy such as Tailscale Serve, but it must be explicitly allowlisted. See [SECURITY.md](SECURITY.md) for the full threat model.

---

## Development

```bash
bun install
bun run typecheck
bun run lint
bun test src
bun run build
bun run pack:check
```

CI currently runs on Ubuntu and macOS.

Project layout:

```text
src/client/      React UI
src/server/      Hono API, jobs, scanners, wrappers
src/shared/      shared types and mode definitions
scripts/         local maintenance scripts
data/            dev-mode runtime state
docs/            performance notes and media
```

Performance notes and measurement commands live in [docs/PERFORMANCE.md](docs/PERFORMANCE.md).

---

## Roadmap

Near-term priorities:

- Tighten the public README/docs around the current assist-first Presence model.
- Remove or clearly graduate the remaining experimental X auto-publish server path.
- Improve safety around agent execution policies.
- Expand CI coverage for Windows-specific paths.
- Keep packaging small and `bunx` reliable.

Longer-term ideas:

- Signed desktop packaging.
- More local agent adapters.
- Optional local embeddings for vault/project retrieval.
- Better project-to-usage attribution.
- A vault-aware devlog drafter that remains human-approved.

---

## Contributing

Bug reports and PRs are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).

Hard constraints:

- Loopback-first.
- No telemetry.
- Local state stays local unless you explicitly use an external CLI or integration.
- Secrets go through the OS keyring.
- Prefer CLI adapters over vendor SDK lock-in for agent workflows.

---

## License

[MIT](LICENSE) © 2026 lacausecrypto
