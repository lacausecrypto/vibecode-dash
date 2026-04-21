# vibecode-dash

[![npm version](https://img.shields.io/npm/v/vibecode-dash?color=cb3837&logo=npm)](https://www.npmjs.com/package/vibecode-dash)
[![npm downloads (total)](https://img.shields.io/npm/dt/vibecode-dash?color=cb3837&logo=npm&label=downloads)](https://www.npmjs.com/package/vibecode-dash)
[![CI](https://github.com/lacausecrypto/vibecode-dash/actions/workflows/ci.yml/badge.svg)](https://github.com/lacausecrypto/vibecode-dash/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/npm/l/vibecode-dash?color=blue)](LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/lacausecrypto/vibecode-dash?style=social)](https://github.com/lacausecrypto/vibecode-dash)

> *The local-first dashboard for the vibe-coding era.*

A 127.0.0.1 app that turns your LLM CLI sessions, your Git repos, and your Obsidian vault into one observable, writable surface. Built for solo devs who code *with* Claude Code and Codex, and still care about what they ship, what it costs, and what they learn along the way.

```bash
bunx vibecode-dash     # one-shot, no clone, no account
```

> **Status:** First version. ~60 API endpoints, end-to-end functional.

![vibecode-dash demo](docs/media/demo.gif)

---

## Why this exists

Since Karpathy coined "vibe coding" in early 2025, a new workflow has quietly taken over for indie devs: the LLM does most of the typing; you steer. You end up with more projects, more shipped, faster. But your state fragments across places nothing aggregates:

- Your `~/.claude/projects/*.jsonl` (what the model did for you, token by token)
- `ccusage` output in one terminal (what it cost)
- Your `~/projects` tree (what you actually shipped)
- GitHub (what the world sees)
- Your Obsidian vault (what you decided, learned, discarded)
- Your agent session history (what you asked, what the model suggested)

Each of these is a tool. *None of them talk to each other.* You can't ask "which of my 19 repos is this Claude subscription actually paying for?", let alone "what did I decide about auth last month, and which session was that in?"

vibecode-dash answers those questions. It's the instrument panel for a solo dev whose primary tool is an LLM, and whose durable memory is a Markdown vault.

No account. No telemetry. No cloud sync. A SQLite file and a port on loopback.

---

## What's inside, concretely

Five feature areas, all shipped today. Every claim below maps to real routes under `src/server/routes/`.

### 1 · LLM usage telemetry

Parses `~/.claude/projects/*.jsonl` directly and reads Codex's usage store via `@ccusage/codex`. No API calls, no vendor lock-in. Stored in SQLite for retention past the CLIs' own caches.

**What you see**, broken down by **project**, **model**, **hour-of-day**, and **tool**:
- Daily combined feed (Claude + Codex in one timeline)
- Monthly rollups
- **Subscription vs. PAYG math**: what would your last 30 days have cost on API pricing? Real leverage ratio = what you pay (€180 Max + €100 Pro) vs. what you'd have paid PAYG.
- **Dev-equivalent**: at your hourly rate, how many hours of "me writing this manually" did the model actually save? Configurable baseline (default 100 €/h, 2 500 output tokens/h).
- **Cache hit rate**: ratio of context tokens reused vs. freshly ingested. Tells you if your prompts are cache-friendly.

Endpoints: `/api/usage/daily`, `/daily-combined`, `/by-project`, `/by-model`, `/hour-distribution`, `/tool-usage`, `/monthly`, plus Codex equivalents.

### 2 · Projects & GitHub

Scans your `~/projects` roots (configurable) for git repos. For each: LoC, commit cadence, staleness, README/tests presence → a **health score** you can sort by.

Cross-references GitHub in the background: commits, stars, contribution heatmap, **traffic (views/clones) snapshotted daily** so you keep history past GitHub's native 14-day window. npm downloads too if your repo has published packages.

Per-project detail: file tree, README rendered, and a **Competitor Radar + Divergence Engine** (see #5).

Endpoints: `/api/projects`, `/:id`, `/:id/readme`, `/:id/tree`, `/rescan`, plus `/api/github/traffic`, `/heatmap`, `/activity`, `/repos`, `/npm`, `/sync-log`.

### 3 · Obsidian vault: read *and* write

Filesystem scanner + SQLite **FTS5**. No plugin, no daemon, no sync. Parses front-matter, wikilinks, tags. Builds a **forward + reverse link graph**, exposes orphans, an activity timeline, and search.

What's less common: vibecode-dash can **write back to your vault** in two controlled ways:
- **Hubs**: auto-generated `_index.md` at each folder with backlinks, bounded by `<!-- hub:auto:start -->` markers so your hand-written content is untouched.
- **Memory write-back** (see #5): agent-distilled facts become Markdown notes with `collab_reviewed: false` front-matter, waiting for your review.

Endpoints: `/api/obsidian/notes`, `/search`, `/graph`, `/tags`, `/orphans`, `/activity`, `/bootstrap`, `/reindex`, `/hubs/rebuild`.

### 4 · Agent sessions: Plan · Learn · Reflect

A sessions-first UI on top of the `claude` and `codex` CLIs. **Not the SDK. Deliberately.** Spawning binaries means: no vendor credentials in this process, no lock-in to one provider's API shape, future adapters (Ollama, Cursor, Gemini) drop in behind the same session abstraction.

Every session runs in one of **three modes** with distinct system prompts and memory-extraction focus:

| Mode | Prompt posture | What gets remembered |
|---|---|---|
| **Plan** | "Senior PM, no abstractions, executable steps" | Decisions, scope, deadlines |
| **Learn** | "Feynman-style, intuition first, analogies that resonate" | Concepts mastered / not yet, mental models |
| **Reflect** | "Red team. Kill fragile approaches before reality does." | Recurring flaws, personal anti-patterns, pivots considered |

Each session auto-injects: **persona** (`.collaborator/persona/identity.md` + `values.md`), **current project context** (path, recent activity, health), **relevant memories** (global + project-scoped), and **vault RAG** (FTS5 excerpts of related notes). You get a context snapshot on demand to see exactly what's going in.

Sessions persist. Stream responses token-by-token. **Archive a transcript to your vault** as a Markdown note, one click.

Endpoints: `/api/agent/sessions`, `/:id/send`, `/:id/stream`, `/:id/archive-to-vault`, `/context`, `/providers`, `/quick/:command`, `/exec`.

### 5 · Competitor Radar + Divergence Engine

Per-project you can list competitors. On demand, a read-only agent (`claude --read-only` with WebSearch + WebFetch) scans their public surface (GitHub, npm, homepages) and emits **insights** (observations on positioning gaps, features they lack, traction signals) that you can then **promote into your vault** as durable notes.

This is the one feature where the agent looks outward instead of inward. It's opt-in, per-project, and produces Markdown you approve before committing.

Endpoints: `/api/radar/summary`, `/api/projects/:id/competitors`, `/:id/competitors/scan`, `/:id/insights/generate`, `/api/insights`, `/:id/promote`.

---

## The memory loop, what makes it different

Most agent UIs forget everything the moment you close a session. The next time you open Claude, you're explaining your stack, your conventions, and your decisions all over again.

vibecode-dash closes that loop with a **Karpathy-style write-back pass**. After every agent reply is persisted, a second lightweight CLI call runs with no tools enabled (`--tools ""`, cheap and deterministic) and asks the model:

> *"From the exchange just above, distill 0 to 3 durable facts worth remembering for future conversations."*

The prompt is **mode-aware**. Plan sessions harvest decisions, Learn sessions harvest concept progress, Reflect sessions harvest anti-patterns. Four types are tracked everywhere:

- **User preferences**: explicit rules, no-gos, patterns confirmed as yours
- **Project decisions**: tech choices, architecture, scope, deadlines
- **Stable context**: tools, setup, constraints newly revealed
- **Confirmed judgments**: approaches the user has validated, sometimes quieter than corrections

Extracted memories land in SQLite with a `scope` (global / project-specific) and a `decay` half-life. They're injected into future sessions' context. On boot, orphan memories (referencing deleted projects/sessions) are purged.

The twist: **memories also sync to your vault** as Markdown files under `.collaborator/memories/*.md`, with `collab_reviewed: false` front-matter. You see every fact the agent extracted, can edit it, delete it, or mark it as reviewed. The vault stays the source of truth; SQLite is the cache.

In practice this means: the dashboard gets smarter about you over time, the agent stops repeating questions, and everything it learns is **visible, auditable, and portable** (it's just Markdown).

Implementation: `src/server/lib/memoryPass.ts` + `memoryVaultSync.ts`.

---

## How this differs from existing OSS tools

- **Not another LLM observability platform.** No proxy, no SDK, no Docker compose. Just reads the JSONL files Claude Code and Codex already write. [Langfuse](https://github.com/langfuse/langfuse) / [Helicone](https://github.com/Helicone/helicone) target platform teams with app-level telemetry; vibecode-dash targets the solo dev downstream of the CLI.
- **Not a ccusage replacement.** [`ccusage`](https://github.com/ryoppippi/ccusage) owns the "Claude/Codex JSONL parser" corner and it should. vibecode-dash treats usage as one of five surfaces. Same numbers, surrounded by the project and vault context that makes them actionable. It reuses `@ccusage/codex` for the Codex half.
- **Not an Obsidian replacement.** No plugin, no daemon, no sync. A read-only scanner + FTS5 index + bounded hub writes. [SilverBullet](https://github.com/silverbulletmd/silverbullet) and [Logseq](https://github.com/logseq/logseq) replace Obsidian; vibecode-dash leaves it untouched.
- **Local-first GitHub mirror.** [`gh-dash`](https://github.com/dlvhdr/gh-dash) mirrors GitHub to your terminal, [`ghstats`](https://github.com/vladkens/ghstats) / [`repohistory`](https://github.com/repohistory/repohistory) snapshot traffic. vibecode-dash does the traffic-snapshot trick but anchors on *local* repo state. Your working tree is the source of truth; GitHub is enriched metadata.
- **Agent panel wraps CLIs on purpose.** [`claudecodeui`](https://github.com/siteboon/claudecodeui) and [`codedash`](https://github.com/vakovalskii/codedash) are the current OSS agent panels, whole apps built around the agent. Here the agent is one of five tabs, deliberately CLI-subprocess only, and it *sees* your repos and vault without leaving the process. Plus the memory write-back loop, which neither has.
- **Solo-dev scoped.** `127.0.0.1` only. Secrets in OS keyring (macOS `security`, Linux libsecret, Windows DPAPI). No multi-tenant, no auth server, no telemetry. And no roadmap to add any.

---

## Install

### Prerequisites

| Platform | Required | Optional |
|---|---|---|
| **macOS 13+** | [Bun](https://bun.sh) 1.1+ | `gh` for GitHub sync, `claude` + `codex` CLIs for the agent panel |
| **Linux** | Bun 1.1+, `secret-tool` (`libsecret-tools` / `libsecret`) + a Secret Service provider | same |
| **Windows 10+** | Bun 1.1+ | same |

`claude` and `codex` CLIs are *not* npm dependencies. They must be installed separately if you want the agent panel. Every other feature (usage, projects, GitHub, vault) works without them.

Linux keyring install:

```bash
# Debian/Ubuntu
sudo apt install libsecret-tools
# Fedora
sudo dnf install libsecret
# Arch
sudo pacman -S libsecret
```

### Run

```bash
# One-shot, no install step (works once the package is published to npm)
bunx vibecode-dash

# Clone and hack
git clone https://github.com/lacausecrypto/vibecode-dash
cd vibecode-dash
bun install
bun run dev           # :4317 client + :4318 server, hot reload both
```

`bunx vibecode-dash` boots the server on `127.0.0.1:4317`, opens your browser, and stores all state in your OS app-data dir:

- macOS: `~/Library/Application Support/vibecode-dash/`
- Linux: `$XDG_DATA_HOME/vibecode-dash/` (or `~/.local/share/vibecode-dash/`)
- Windows: `%APPDATA%\vibecode-dash\`

Override with `VIBECODEDASH_DATA_DIR=/custom/path` or `--data-dir`.

```bash
vibecode-dash --help           # all flags
vibecode-dash --port 7000      # custom port
vibecode-dash --no-open        # don't auto-open the browser
```

### First-boot behaviour

1. Generates a 64-char auth token in the data dir (`0600` on Unix, NTFS user-scope on Windows).
2. Writes `settings.json` with defaults (`~/projects` as projects root, `~/Documents/Obsidian` as vault).
3. Creates `db.sqlite` from migrations (WAL mode, FTS5 enabled).
4. Starts scanners (projects, Obsidian watcher) on the configured schedule.

Head to **Settings** to point the scanners at your real roots, connect GitHub (click *Sync now* after `gh auth login`), and configure subscription plans for the sub-vs-PAYG math.

---

## Platform support

| Feature | macOS | Linux | Windows |
|---|---|---|---|
| Server (Bun + Hono) | ✅ | ✅ | ✅ |
| SQLite (`bun:sqlite`) | ✅ | ✅ | ✅ |
| Secret storage | `security` keychain | `secret-tool` (libsecret) | PowerShell + DPAPI blob |
| Obsidian watcher | ✅ | ✅ | ✅ |
| `claude` / `codex` CLI spawning | ✅ | ✅ | ✅ |

Paths resolved through `node:os.homedir()` + `node:path.join`, no hardcoded separators. See [`src/server/lib/platform.ts`](src/server/lib/platform.ts).

> **Tested daily on macOS 26 (Apple Silicon).** Linux and Windows code paths exist and are unit-tested, but not (yet) run in CI on those OSes. Reports welcome.

---

## Architecture

```
┌──────────────────────────────────────────────────┐
│  React + Vite (127.0.0.1:4317)                   │
│  ├─ Overview · Usage · Projects · GitHub         │
│  ├─ Vault · Agent · Radar · Settings             │
│  └─ X-Dashboard-Token on every /api/* request    │
└──────────────────────┬───────────────────────────┘
                       │ proxy /api → :4318 (dev)
┌──────────────────────▼───────────────────────────┐
│  Hono (127.0.0.1:4318, single port in prod)      │
│  ├─ auth middleware: Host + Origin + Token       │
│  ├─ ~60 routes under /api/{auth,health,          │
│  │   projects,github,obsidian,usage,             │
│  │   agent,radar,settings}                       │
│  ├─ scheduler (project rescan, github sync,      │
│  │   usage sync) with retry/backoff              │
│  ├─ obsidian fs watcher (debounced)              │
│  └─ agent memory write-back pass                 │
└──────────────────────┬───────────────────────────┘
                       │
┌──────────────────────▼───────────────────────────┐
│  SQLite (data/db.sqlite, WAL mode, 10 migrations)│
│  + FTS5 for vault notes                          │
│  Secrets in OS keyring (not in this repo)        │
└──────────────────────────────────────────────────┘
```

**Stack:** Bun 1.1+ · Hono 4 · React 19 · Vite 7 · Tailwind 4 · SQLite (`bun:sqlite`) · Zod 4. No LLM SDKs. Only CLIs, on purpose.

See [docs/PERFORMANCE.md](docs/PERFORMANCE.md) for resource benchmarks (~340 ms cold start, ~60 MB RSS idle, 1.5 MB npm tarball).

---

## Roadmap

- [x] **Phase 1**: foundations, project scanner, GitHub sync, usage via `ccusage`, base UI
- [x] **Phase 2**: Obsidian scanner + FTS5, agent CLI sessions, quick-commands, direct JSONL analytics, Codex usage integration
- [x] **Phase 3**: Competitor Radar + Divergence Engine, memory write-back pass, vault auto-hubs, vault memory sync
- [x] **v1**: published to npm, `bunx vibecode-dash` install path, OS app-data dir layout, cross-platform keyring, CLI wrapper
- [ ] **v1.1**: Tauri packaging (signed binaries macOS/Linux/Windows, auto-update, tray icon)
- [ ] **v1.2**: embeddings layer (opt-in, local model), more LLM CLI adapters (Ollama, Cursor, Gemini), plugin API
- [ ] **v2**: smart auto-post mode for Reddit / LinkedIn. Drafts devlog posts from your vault + recent project activity (shipped features, insights from the Radar, milestones), with per-platform tone and audience matching. You approve each draft before it leaves the machine.

---

## Security

The server binds `127.0.0.1` only. Three-layer defense on `/api/*`:

1. **Host header** must resolve to loopback (anti-DNS-rebinding).
2. **Origin header**, when present, must be a loopback origin (CSRF block).
3. **`X-Dashboard-Token`**: 64-hex-char secret generated at first boot, stored `0600` in the OS app-data dir, compared with `timingSafeEqual`.

Secrets (GitHub PAT, future provider credentials) live in the OS keyring. Never in the repo. Never in `.env`.

Full threat model in [SECURITY.md](SECURITY.md).

---

## Contributing

Bug reports and PRs welcome. Full dev setup in [CONTRIBUTING.md](CONTRIBUTING.md).

Hard constraints: `127.0.0.1` only, no telemetry ever, CLIs over SDKs, secrets in keyring.

---

## License

[MIT](LICENSE) © 2026 lacausecrypto
