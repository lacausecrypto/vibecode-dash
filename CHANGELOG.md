# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2026-04-21

First public release. End-to-end functional, ~60 API endpoints, single-user / 127.0.0.1 only.

### LLM usage telemetry

- Direct parser for `~/.claude/projects/*.jsonl` (no API calls).
- Codex usage via `@ccusage/codex`.
- Daily / monthly aggregates, breakdowns by project / model / hour-of-day / tool.
- Subscription vs. PAYG math with configurable plans (Max x20, Pro x5 defaults).
- Dev-equivalent hours + cache hit rate computed from session metadata.
- Billing history with per-charge coverage days.

### Projects & GitHub

- Local `~/projects` scanner with health score (LoC, cadence, staleness, README/tests).
- GitHub sync: commits, stars, contribution heatmap, daily traffic snapshots (beyond 14-day window).
- npm downloads tracking for published packages.
- Per-project detail page with file tree, rendered README, competitors tab.
- Scheduler with retry/backoff, sync log persistence.

### Obsidian vault

- Filesystem scanner with SQLite FTS5, debounced watcher.
- Forward + reverse link graph, tags, orphans, activity timeline.
- Vault hubs: auto-generated `_index.md` per folder with backlinks, bounded by `<!-- hub:auto:start -->` markers.
- Vault bootstrap for fresh installations.

### Agent sessions

- Sessions-first UI on top of `claude` and `codex` CLIs (subprocess spawning, no vendor SDK).
- Three modes with distinct system prompts and memory-extraction focus: **Plan**, **Learn**, **Reflect**.
- Context auto-injection: persona (identity + values), current project, relevant memories, vault RAG.
- Streaming responses, persistent sessions, archive-to-vault one-click.
- Quick commands library.

### Memory loop (Karpathy-style write-back)

- After every reply, a second CLI call with tools disabled extracts 0–3 durable facts.
- Mode-aware extraction (Plan → decisions, Learn → concepts, Reflect → anti-patterns).
- Memories stored in SQLite with scope (global/project) and decay half-life.
- Vault sync: memories become reviewable Markdown under `.collaborator/memories/` with `collab_reviewed: false` front-matter.
- Orphan purge on boot.

### Competitor Radar + Divergence Engine

- Per-project competitor tracking.
- Read-only agent scan (`claude --read-only` + WebSearch/WebFetch).
- Insight generation against vault context.
- Insight promotion to vault as durable Markdown notes.

### Infrastructure

- Bun 1.1+ runtime, Hono 4, React 19, Vite 7, Tailwind 4, `bun:sqlite`, Zod 4.
- Auth: three-layer defense (Host + Origin + 64-char token) on every `/api/*` route.
- Secrets: OS keyring (macOS `security`, Linux libsecret, Windows DPAPI blob).
- 10 SQLite migrations, WAL mode, FTS5 enabled.
- 3 locales (FR / EN / ES).
- Cross-platform path resolution via `node:os.homedir()` + `node:path.join`.

### Distribution

- `bunx vibecode-dash` one-shot install via npm.
- CLI: `--port`, `--data-dir`, `--no-open`, `--help`, `--version`.
- OS app-data dir for state: `~/Library/Application Support/vibecode-dash` (macOS), `$XDG_DATA_HOME/vibecode-dash` (Linux), `%APPDATA%\vibecode-dash` (Windows).
- `VIBECODEDASH_DATA_DIR` env var override.
- Published as `vibecode-dash` on npm, MIT licensed.

### Known limitations

- Daily-tested on macOS 26 (Apple Silicon). Linux + Windows code paths unit-tested but not run in CI yet.
- No Tauri packaging yet (planned for v1.1).
- No embeddings layer; vault retrieval is FTS5-only (planned for v1.2).

[Unreleased]: https://github.com/lacausecrypto/vibecode-dash/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lacausecrypto/vibecode-dash/releases/tag/v0.1.0
