# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.2] — 2026-04-30

Patch release: three targeted bug fixes — Radar promote was silently
failing in the UI even when the server write succeeded, the
project-detail header was squeezing the project name to "m..." on
tablet, and Obsidian was accumulating false-positive orphans because
the auto hubs only rebuilt on manual reindex.

### Fixed

- **Radar — "→ Concept" promote button.** Two stacked bugs that made
  the action look broken from the user's seat:
  - The InsightCard had `catch { /* swallow */ }` around the promote
    POST. Any thrown error (vault path unset, write permission denied,
    insight not in DB) produced no feedback. Replaced with an
    `onError` prop wired to the parent's existing ErrorBanner, plus a
    check on `res.ok === false` server responses.
  - On success the server flipped the insight's status to `explored`,
    but the client's in-memory list wasn't updated until the next
    `loadRadar` tick. The user saw the toast briefly, then the insight
    stayed in the pending list — looking like the action was a no-op.
    `onPromoted` now also receives the `insightId` so the parent
    `showPromotedToast` can `setInsights(rows ⇒ rows.filter(...))`.
- **Project-detail header layout < lg.** On viewports below 1024 px the
  header card laid out 5 items on a single flex-wrap row (avatar /
  identity / health gauge / sessions+tokens / Ask agent + Rescan
  buttons). The right-side strip claimed ~350 px on its own, squeezing
  the identity zone via flex-1 + min-w-0 — project name truncated to
  "m...", metadata wrapping word-by-word vertically. Fix: split into
  two zones (identity / metrics + actions) and stack them on < lg via
  `flex-col lg:flex-row lg:flex-wrap`. `ml-auto` on the buttons cluster
  keeps them right-anchored on the second row.
- **Obsidian — reduce false-positive orphans.** Every promoted insight
  (`Concepts/radar/<slug>.md`) and archived session
  (`Sessions/<...>.md`) was flagged as orphan in the Vault page until
  the user manually clicked "Reindex Obsidian" in Settings. Cause: the
  `rebuildVaultHubs` step (which writes `Concepts/_index.md`,
  `Sessions/_index.md`, etc. — the auto hubs that backlink every note
  in their folder) was only called from the manual reindex endpoint.
  The scheduled job and the fs watcher both called
  `reindexObsidianVault` directly. Fix: move the `rebuildVaultHubs`
  call into `reindexObsidianVault` itself, so the scheduler tick + the
  watcher debounced reindex + the manual endpoint all refresh the
  hubs in the same pass. Failure-tolerant: a hub-write error logs a
  warning and the link scan continues.

## [0.3.1] — 2026-04-30

Patch release: agent CLI error diagnostics, refreshed model catalogs,
UI fixes on tablet popovers + project rows.

### Fixed

- **Agent — codex stdout error extraction.** Codex CLI 0.121+ emits the real
  upstream API error (`model_not_found`, `invalid_api_key`, etc.) as a
  `type:"error"` or `type:"turn.failed"` NDJSON event in **stdout**, not
  stderr. Stderr is full of rmcp transport noise that was drowning the signal.
  New `extractCodexErrorFromStdout` walks the NDJSON and returns the most
  actionable message (handles bare `message`, `error.message`, and
  double-encoded JSON envelopes).
- **Agent — friendly hints.** New `diagnoseCliError` pattern-matches the
  extracted text and returns a localised one-liner via the server i18n dict.
  Three rules: `model_not_found` (4xx from OpenAI / Anthropic), API key
  missing/invalid, codex MCP transport (model alias missing from
  `~/.codex/config.toml`). New keys: `agent.execHints.{codexMcpTransport,
  modelNotFound, apiKey}` in fr / en / es.
- **Agent — language policy in system prompt.** `buildSystemInstructions`
  now prefixes a "reply in the SAME language as the latest USER message"
  rule. Stops the model from mirroring the locale-bound mode addendum
  when the user switches languages mid-conversation.
- **UI — agent pane popovers escape bounds.** `.agent-pane` was `overflow:
  hidden` to keep rounded corners crisp, but it also clipped the
  new-session and more-options popovers' left edge on tablet widths.
  Switched to `overflow: visible` (inner scroll containers own their
  own overflow). Popover backdrop changed from translucent + `backdrop-
  blur` to solid `#0b0d11` for readability.
- **UI — project rows stack on tablet.** `ProjectRow` and `UsageRow` were
  stacking only at < 640 px. On 768–1023 px tablets the metric strip
  claimed ~440 px on its own, leaving < 200 px for the identity zone.
  Bumped breakpoint to `lg` (1024 px) so tablets get the 2-row stack
  with a 3-col metric grid; lg+ keeps the dense single-row layout.

### Chore

- **Agent model catalogs refreshed to April 2026 surface area** (Anthropic
  + OpenAI Codex docs):
  - Claude — adds Opus 4.5 / 4.1 dated variants, Sonnet 4.5 dated,
    `best` / `opusplan` / `opus[1m]` / `sonnet[1m]` aliases.
  - Codex — drops deprecations (gpt-5.0/5.1/5.2, o3/o4 family, gpt-4o*),
    adds `gpt-5.4-mini` and `gpt-5.3-codex-spark`.
- `.gitignore` excludes `CLAUDE.md` (local Claude Code project context, not
  shipped in the published package).

## [0.3.0] — 2026-04-30

Big visual + structural release. Overview gains an NPM metric and a fully
modular VS comparator; Usage gets a per-project cumul stacked-bars view
with EUR cost; Radar gets an insights donut; Presence settings move under
`/settings`; an Ask-agent quick-recap shortcut creates pre-loaded sessions.
Server hardened (CSP, Markdown sanitizer, symlink check, cross-platform
`isSubPath`). External shell deps dropped (ccusage local install, JSONL
pure-JS walker). Mobile responsive polish across the dashboard.

### Added — Overview, Usage, Radar visualisations

- **Overview — NPM as a first-class metric.** Heatmap section toggle
  now exposes "NPM" alongside Contribs, Views, Clones, LLM*, Notes.
  Per-repo aggregates fed by `/api/github/npm/daily-by-repo`.
- **Overview — Heatmap cumul view.** New Grille / Cumul toggle. Cumul
  swaps Heatmap for HeatmapStackedBars and stacks per-repo cumulative
  totals over a year window. Cumul lib gains a `year` bucket (single-
  column "all-time" headline).
- **Overview — modular VS comparator.** Replaces the hard-coded
  10-mode enum with a dynamic A vs B picker. METRIC_DEFS catalogues
  every signal (LLM tokens variants, cache, cost, GitHub commits/views/
  clones/uniques, NPM downloads, vault notes) tagged with category +
  unit. The chart auto-detects whether to share the Y axis (same unit)
  or render two independent scales, with a per-mode insight string.
  Window selector goes 1 d → all-time. Section header has a swap A↔B
  button.
- **Usage — per-project cumul stacked-bars view** (tokens or EUR cost,
  granularity Jour → Trim.) backed by a new
  `/api/usage/by-project/stacked-daily` endpoint. The cost view stacks
  the same time-weighted subscription accrual ("ABO RÉEL") the user
  is already calibrated on from the project list.
- **Radar — insights mix donut + 2-col KPI layout.** Replaces the
  4-flat-card strip that wrapped labels on tablets. Left column: 2
  context KPIs (competitors / total insights). Right column: Recharts
  donut segmented by insight type (`market_gap` / `overlap` / `vault_echo`)
  with center total and side legend.

### Added — Workflow shortcuts

- **Project-detail "Ask agent" quick-recap button.** Now creates a
  fresh agent session with a randomly-picked recent model + a
  structured seed prompt (FR / EN / ES, picks up the dashboard locale
  automatically). The seed includes project metadata, 90-day Claude/
  Codex usage, competitors, README excerpt; asks for a synthetic
  recap, prioritised next 3 actions, market analysis, technical audit,
  honest verdict.
- **Settings — Presence sub-page extracted.** The 7 presence
  configuration sections (scheduler, drafter, persona refresh,
  OpenRouter, Reddit, X read, X write) now live under
  `/settings?tab=presence` with a hero status strip + thematic groups
  (Automatisation / Apprentissage / Connexions). Legacy
  `/presence?tab=settings` redirects.
- **Mobile quick-bar in app header** (< 640 px viewports): mascot +
  Claude/Codex 5 h gauges. Tap → `/usage`. Subscribes to the existing
  quotaSignal so no extra fetch.
- **`Section` component gains `actionWide` prop** for sections with
  wide Segmented actions (Heatmap, VS comparator) that need to stack
  on mobile. Narrow single-button actions (Sync now / Rescan all)
  keep inline behavior.

### Added — Remote access via Tailscale (allow-listed hosts)

The dashboard still binds `127.0.0.1` only, but `auth.ts` now accepts
an explicit allowlist of external Host/Origin headers via the
`VIBECODEDASH_ALLOWED_HOSTS` env var. Comma-separated, case-insensitive,
port-stripped on match.

```bash
VIBECODEDASH_ALLOWED_HOSTS="mac.tailbeef.ts.net,100.64.0.5" bunx vibecode-dash
```

The intended setup pairs this with `tailscale serve` running on the
same host:

```bash
tailscale serve --bg --https=443 http://127.0.0.1:4317
```

The Tailscale daemon terminates TLS with a Let's Encrypt cert it
provisions automatically, then reverse-proxies to localhost. The
dashboard server stays loopback-bound; only the local proxy reaches it.
Identity is enforced at the WireGuard layer (per-device, revocable
from the Tailscale admin console).

The token + Origin checks still apply on top — the allowlist is a
relaxation of the **Host gate only**, not of authentication. A Tailnet
peer reaching the dashboard still needs the `X-Dashboard-Token`, fetched
from the ungated `/api/auth/token` endpoint on first hit.

Empty / unset env var keeps the strict loopback-only behavior (the
historical default). 25 new unit tests in `auth.test.ts` cover:
parseAllowedHosts (env parsing, IPv6 brackets, case + port stripping),
hostIsAllowed (loopback fast-path, allowlist match, missing/empty
host), originIsAllowed (https origins, wrong protocol, malformed URL),
plus 5 end-to-end middleware tests through Hono with a Tailscale-style
allowed host (GET pass, POST with Origin pass, evil Origin reject,
non-allowed Host reject, token still required).

`SECURITY.md` documents the full architecture under "Remote access via
Tailscale" with the threat model deltas (token exposure within Tailnet,
Funnel opt-in warning, lost-device revocation flow).

### Fixed — X auto-publish posts replies as replies, not standalones

The `presencePublish` worker called `xPostTweet(d.draft_body)` without
passing `replyToId`, so drafts marked as `format='comment'` or `'reply'`
were posted as standalone tweets on the user's profile instead of as a
reply to the parent thread. The `xPostTweet` wrapper already supported
`{ replyToId }` — the worker just wasn't wiring it up.

Fix: when `format` is `comment`/`reply` AND `external_thread_id` is
present (always set by the scanner for thread candidates), the worker
now passes `replyToId: d.external_thread_id` so the X API attaches
`reply.in_reply_to_tweet_id` and the post lands as a thread reply.
Audit log row reflects the distinction:

```
published   tweet id=<new>  (reply to <parent_id>)
published   tweet id=<new>
```

Drafts with format `post`/`quote` or no `external_thread_id` continue
to post standalone. The fix doesn't retroactively re-post existing
`posted` drafts — those stay where they are.

### Quality — Stricter X tweet pre-CLI filtering

The X scanner now scores every fetched tweet on a composite quality
function (`lib/tweetQuality.ts`) and drops anything below
`MIN_QUALITY_SCORE = 0.40` before reaching the Haiku scorer. The same
single API request now also pulls
`user.fields=public_metrics,verified,verified_type,description` —
zero extra read cost, full author signal for ranking.

Five components, weighted to favour the AI / indie-dev workflow this
dashboard targets:
- **Engagement velocity (35 %)** — weighted interactions per hour
  (replies × 3, retweets × 2, likes × 1). Saturates at 200 wgt/h.
- **Author reach (20 %)** — log-normalized follower count, saturates
  at 1 M.
- **Author quality (20 %)** — bio keywords (CEO/founder/researcher/
  professor/at <BigCo>) + X `verified_type` (business/government
  strong, paid Blue zero, legacy true small bump).
- **Content quality (10 %)** — text length post-URL-strip, sentence
  count, mention spam + ALL-CAPS penalties.
- **Curated authors boost (15 %)** — flat `+0.15` for handles in a
  hand-picked default list (~50 entries: AI lab leadership,
  prominent researchers, infrastructure CEOs, indie builders).
  Override per install via `settings.presence.highValueAuthorHandles`.

Tweets above the threshold are RANKED by score and capped at
`MAX_CANDIDATES_PER_SOURCE = 8` — exactly one batch worth of CLI
scoring per source. The ranking matters: when a fetch returns 30
candidates that all pass the threshold, the top 8 are guaranteed to
be the highest-quality, not just the first 8.

The outcome shape gains two counters:
- `skipped_age_window` — tweets dropped by the age gate (too fresh to
  have signal, or too old to be relevant).
- `skipped_low_quality` — tweets dropped by the quality scorer
  before any CLI call. Distinguished from `skipped_low_score` (which
  cost a Haiku call) so the UI can surface "filter saved you N
  CLI calls" honestly.

**Live measurement** on the same 9-source X-only workload, identical
sources, fresh DB state on both runs:

|                            | Engagement floor only   | Composite quality filter |
|----------------------------|-------------------------|--------------------------|
| Wall-clock                 | 265 s (4 min 25 s)      | 278 s (4 min 38 s)       |
| Tweets fetched             | 202                     | 202                      |
| Pre-CLI quality drops      | 0 (no quality filter)   | **115** (57 %)           |
| CLI scoring calls          | 10                      | 9                        |
| Candidates scored          | 40                      | **26** (–35 %)           |
| Drafts produced            | 1                       | **3** (+200 %)           |

The wall-clock looks flat because the new run produced **3× more
drafts** (3 drafts × ~30 s Sonnet drafting). At-conversion-comparable,
the funnel is ~25 % faster. The real win is the conversion ratio:
3/26 = 11.5 % drafts-per-CLI-call vs 1/40 = 2.5 % — a **4.6× higher
useful-output-per-CLI-spend**.

32 unit tests in `tweetQuality.test.ts` cover all five component
scorers, the composite, and the ranking helper (threshold filtering,
maxResults capping, custom handle overrides).

### Performance — Presence Copilot scoring

- **Batch scoring**: `scoreCandidatesBatch()` rates up to 8 candidates per
  CLI call instead of one. Persona + vault context (~2-3 k tokens) is
  built once per batch and shared, replacing N cold starts with one.
  Three-tier failure handling: whole-batch failure → fall back to
  per-candidate `scoreCandidate`; JSON parse failure → same fallback;
  partial batch (model dropped K of N) → re-score the K missing
  candidates individually and stitch back into the slot table. Wired
  into both X and Reddit scanners; dedup against existing drafts now
  happens before the batch call so duplicates never count toward batch
  input.
- **Tighter X engagement floor**: pre-CLI filter raised from
  `like ≥ 1 OR reply ≥ 1` to `like ≥ 3 OR reply ≥ 2`. Live data showed
  ~50 % of candidates with 0-2 likes never crossed the 0.70 score bar,
  burning ~15 s of CLI per item to filter what an integer comparison
  kills in microseconds.

**Live measurement** on the same 9-source X-only scan workload
(identical sources, bypassTtl, fresh DB state):

| | Before | After | Delta |
|---|---|---|---|
| Wall-clock | 1257 s (21 min) | **265 s (4 min 25 s)** | **4.7× faster** |
| CLI scoring calls | ~80 | 10 (8 batch + 2 single fallback) | ~8× fewer |
| Candidates scored | ~80 | 40 | ½ (engagement floor) |

12 unit tests added in `presenceDrafter.test.ts` covering
`extractJsonArray()` edge cases (fenced, bare, commentary-wrapped,
malformed, object-shaped, empty, over-emit, multi-block input).

### Performance — drop external shell dependencies

- **ccusage / @ccusage/codex pinned as runtime deps** (18.0.11) and
  resolved from local `node_modules/.bin` first, via
  `VIBECODEDASH_PKG_ROOT` seeded by the CLI wrapper, cwd, or the
  wrapper's own path. Falls back to `npx --yes ccusage@VERSION` only
  when not installed. ~3 s → <100 ms cold-start improvement on every
  invocation, no more network round-trip on first call after `npx`
  cache clear.
- **JSONL parsers — pure JS walker.** Replaces the
  `find -exec stat | awk | sort | head` shell pipeline with
  `listRecentJsonlFiles` (`fs/promises` recursive walker) in
  `jsonlShared.ts`. Same depth/mtime/maxFiles filters, but no shell,
  cross-platform, exit-code paths can't silently drop files. Tests
  cover the filters in `jsonlShared.test.ts`.
- **Settings hot-reload in jobs.** Scheduler ticks (project rescan,
  GitHub sync, Obsidian reindex) and the Obsidian watcher debounced
  reindex now call `loadSettings()` on every fire instead of reusing
  the boot snapshot. Editing `~/.config/vibecode-dash/settings.json`
  takes effect on the next interval — no restart needed.

### Security

- **Strict CSP + Referrer-Policy + X-Content-Type-Options** on every
  response (`default-src 'self'`, no inline script, restricted
  `connect-src` to localhost). Belt for the embedded agent UI which
  renders model markdown.
- **Markdown post-parse sanitizer.** Allowlist tags + per-tag attributes,
  drops dangerous nodes with their content (`script`, `iframe`,
  `object`, `embed`, `form`, `link`, `meta`, `base`, `style`, `math`,
  `svg`, `canvas`). Defends agent + presence views from prompt-driven
  HTML injection.
- **README asset endpoint hardened against symlinks.**
  `/api/projects/:id/asset` now `realpath()`s the resolved file, the
  project root, and every allowed root before the containment check,
  so a symlink like `docs/x.png -> /etc/passwd` cannot escape. `.svg`
  dropped from the asset MIME table — SVG can carry inline scripts.
- **Cross-platform path containment.** New `src/server/lib/pathGuards.ts`
  with an `isSubPath` based on `path.relative` (POSIX `startsWith` was
  fragile and tricked by sibling prefixes like `/tmp/root` vs
  `/tmp/root-sibling`). Replaces 4 local copies in `agent.ts`,
  `projects.ts`, `obsidianScanner.ts`, `jsonlShared.ts` + adds unit
  tests.

### Fixed

- **`Section` flex-wrap title squeeze on mobile.** When an action had
  `max-w-full overflow-x-auto`, the browser clamped its flex-basis to
  the container width, defeating `flex-wrap` — the action took ~100 %
  of the row and `min-w-0` let the title squeeze to 0. Fixed via the
  new `actionWide` opt-in (CSS-driven stack at < 640 px).
- **Mobile drawer overlay + slide-in panel.** Classes were referenced
  but never defined — the drawer relied on default block layout.
  Proper CSS added (fixed inset-0 backdrop-blur, slide-in panel with
  86vw / 320 px clamp, z-index ordering).

### Changed

- **Project list rows uniform card height.** Split into identity (left)
  + metrics (right) zones. Stack-on-mobile so every row gets exactly
  2 visual lines regardless of whether `git_branch` is set.
- **Sidebar breakpoint lowered md → sm** so the tamagochi + QUOTAS stay
  visible from 640 px instead of 768 px.

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

[Unreleased]: https://github.com/lacausecrypto/vibecode-dash/compare/v0.3.2...HEAD
[0.3.2]: https://github.com/lacausecrypto/vibecode-dash/compare/v0.3.1...v0.3.2
[0.3.1]: https://github.com/lacausecrypto/vibecode-dash/compare/v0.3.0...v0.3.1
[0.3.0]: https://github.com/lacausecrypto/vibecode-dash/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/lacausecrypto/vibecode-dash/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/lacausecrypto/vibecode-dash/releases/tag/v0.1.0
