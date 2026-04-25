# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0] — 2026-04-25

Second release. Adds the **Presence Copilot** social workflow, a system-wide
**activity bus + mascot**, OAuth-aware quota tracking, and a batch of
reliability fixes. Backwards-compatible: existing `data/settings.json` and DB
files upgrade in place.

### Added

#### Presence Copilot — social drafting & engagement (Phase 4)

A human-in-the-loop pipeline for posting on X and Reddit from your own
account. The dashboard scans curated sources, scores opportunities, drafts
candidate replies/posts via your local Claude or Codex CLI, then waits for
explicit approval before anything leaves your machine. Nothing is auto-
posted; everything is reviewable.

- New `/presence` route with feed, draft timeline, status transitions
  (proposed → kept → drafting → ready → posted | dismissed | expired).
- Multi-platform connectors: X (read-only bearer + handle), Reddit (script
  OAuth2), OpenRouter (image generation), Anthropic + Codex OAuth (live
  quota polling). All credentials in OS keychain.
- Source intelligence:
  - **Validation** (Pack A): per-platform reachability checks (Reddit
    `/about`, X handle via syndication CDN). Flags `valid` / `not_found` /
    `banned` / `private`.
  - **Health diagnostics** (Pack B): seven ROI bands (`pristine`,
    `workhorse`, `noisy`, `stale`, `dead`, `unscored`, `never_scanned`)
    computed from 30/60-day activity windows + edit ratio.
  - **Auto-prune assistant** (Pack C): one-click deactivation of low-ROI
    sources with a 7-day cooldown on dismissed suggestions.
- Per-draft cost ledger (PAYG image gen + scoring) capped by a daily
  budget setting (`presence.dailyBudgetUsd`, default $0.50).
- Engagement snapshots after publication (1 h / 24 h / 7 d) — likes,
  reposts, replies, profile clicks where the platform exposes them.
- Boot-time seed of 16 default sources (`r/claude`, `r/codex`,
  `r/MachineLearning`, X lists `@anthropic`, `@openai`, …) with
  fire-and-forget validation.
- Six new scheduler jobs (`presence-scan`, `presence-engagement`,
  `presence-health`, `presence-persona-refresh`, `presence-codex-quota`,
  `presence-expire-stale`).
- API surface: ~40 new `/api/presence/*` endpoints (CRUD on sources +
  drafts, scan-now, validate-all, refresh-health, prune-suggestions,
  cost-ledger, engagement timeline).
- DB: 4 new migrations (`0013_social_presence`, `0014_source_validation`,
  `0015_source_health`, `0016_prune_cooldown`), 5 new tables, 8 new
  columns, partial unique index `ux_presence_drafts_thread` (idempotent
  scanning).

#### Activity bus + Mascot widget

- Framework-agnostic pub/sub layer (`activityBus.ts`, `quotaSignal.ts`)
  for fetch lifecycle (start/end/error/rate-limit) and quota snapshots.
  Zero deps, no React coupling.
- Sidebar mascot ("Clawd") with 17 animated states reacting to dashboard
  fetches, quota severity, rate limits, errors, and idle events. Sticky
  animations with 250 ms tick.
- Live quota mini-widget (`MenuUsageMini`) polls Claude + Codex every 60 s
  and surfaces the worst window (5 h / 7 d) at the menu level.

#### Sync log moved to Settings → Logs

- Refresh log panel extracted from the GitHub page into a dedicated
  `Settings → Logs` tab (kind filter, last-sync pills per source, action
  buttons). Rationale: logs are a cross-source concern, not GitHub-only.

#### Markdown asset rendering with auth

- `<img>` and `<video>` `src` attributes inside rendered Markdown
  (READMEs, vault notes, agent replies) now resolve against
  `/api/projects/{id}/asset?path=…&token=…`. Required because browsers
  cannot inject custom headers on `<img>` requests.
- External `<a>` links in rendered Markdown auto-receive
  `rel="noopener noreferrer"` to prevent token leakage via the Referer
  header.

#### HeatmapLine + project view toggles

- New `HeatmapLine` component (Recharts area chart) as an alternative to
  the GitHub-style grid. Project + GitHub routes ship a grid/line toggle.
- Per-day cell tooltips now show views, clones, npm downloads, and
  commits in a single hover.

#### Agent models catalogue

- New `/api/agent/models` endpoint merges hardcoded base models +
  `~/.{claude,codex}/config` + 60-day JSONL history. Drives populated
  dropdowns in Agent + Presence settings instead of hardcoded lists.

#### Localization

- ~500 new i18n keys across `fr` / `en` / `es` (Presence UI, mascot
  states, quota mini-widget, new KPI labels, view toggles).

### Changed

- **Server idle timeout** bumped from Bun's 10 s default to **60 s** —
  several `ccusage` endpoints (by-model, hour-distribution, blocks
  --active) can take 6–20 s on a cold npm cache and were getting
  cut off mid-flight. Visible as: fewer spurious 500s on Usage page.
- **Billing accrual rule**: when two charges overlap (e.g. plan upgrade
  mid-cycle), the **newest charge wins** for a given day. Previously the
  two were summed, which over-stated cost during 3–5-day overlaps. New
  helpers `activeChargeAt`, `sumPrepaidInRange`, `activeDaily`,
  `activeMonthly` exposed in `lib/billing.ts`.
- **Settings cache**: `loadSettings()` is now memoized (single in-flight
  read shared across concurrent callers) to avoid file-descriptor
  pressure on heavy scans (observed `ENFILE: file table overflow`
  during vault + project rescans). Invalidated on `saveSettings()`.
- **API client gains `apiPatch`**, and every method now publishes
  start/end/error/rate-limit events on the activity bus (consumed by
  the mascot, future telemetry).

### Fixed

- **`bun dist/server/index.js` failed with `EADDRINUSE`** because the
  module exported a default `{ port, fetch }` *and* called `Bun.serve`
  explicitly — Bun bound twice on the same port. The default export was
  removed; only the explicit `Bun.serve` remains. Run-via-CLI-wrapper
  (`bunx vibecode-dash`) was unaffected; only `bun run start` and
  direct execution were broken.
- **GitHub 1-day traffic KPI flashed −100 %** after a manual sync
  because today's row was already counted while yesterday's was not yet
  promoted. Now correctly treats the latest day as pending until the
  next scheduled sync.
- **GitHub top-repo card** now respects the same pending-today semantics
  as the global KPIs.
- **npm downloads parser** rejects proxied HTML 200 responses (strict
  shape check) and distinguishes `not_found` (skip package) from
  `error` (mark stale, retry later). Fixes 0-count bias when a proxy
  returns wrong content-type.
- **Anthropic + Codex OAuth quota windows** check
  `now >= bar.resetsAt` before rendering %, preventing the menu from
  freezing on the previous window's percentage after a reset.
- **Orphan agent memories** are now purged on boot
  (`db/index.ts` startup hook) when their parent session has been
  deleted.

### Security

- New OAuth wrappers (X, Reddit, OpenRouter, Anthropic, Codex) all store
  credentials in the OS keychain — never on disk, never in env vars.
  Refresh flow delegated to the upstream CLIs where applicable
  (`anthropic`, `codex`); otherwise a TTL+backoff cache prevents 429
  storms.
- Markdown renderer sanitizes external `<a>` with
  `rel="noopener noreferrer"` (mitigates token leak via Referer).
- Loopback Host + Origin checks remain on every API route. Token via
  `?token=…` query param accepted **only on `GET`** so CSRF on unsafe
  methods stays protected; rationale: `<img>/<video>` cannot inject
  custom headers, see `Markdown.tsx` post-process.
- Presence drafter system prompts use `toolPolicy: 'none'` to prevent
  the local CLI from shelling out while reasoning over thread content.
- Migrations 0011 and 0012 drop unused legacy tables
  (`usage_by_project`, `usage_hourly`, `embeddings`); audited as
  zero-reader before drop.

### Removed

- Legacy `usage_by_project` and `usage_hourly` tables (zombie rows from
  earlier prototypes, never read or written by current code).
- The `embeddings` placeholder table (never wired; will return as a
  proper feature in v1.2 if needed).

### Known limitations

- Reddit script-type OAuth requires storing the account password (or
  app password) in keychain. Tracked as future hardening: prefer the
  reddit "app password" flow and document rotation cadence.
- Image-generation prompts are sent to OpenRouter as-is. Future work:
  PII scrubbing pass before external send.
- Presence rate-limiting is delegated to upstream APIs; no per-user
  daily cap on image gen yet. The dailyBudget config is the safety
  net.
- Linux + Windows code paths still unit-tested but not in CI.

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

[Unreleased]: https://github.com/lacausecrypto/vibecode-dash/compare/v0.2.0...HEAD
[0.2.0]: https://github.com/lacausecrypto/vibecode-dash/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/lacausecrypto/vibecode-dash/releases/tag/v0.1.0
