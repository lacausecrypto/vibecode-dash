# Performance & resource footprint

This is not a synthetic benchmark — it's a measurement of what the app actually consumes on a developer laptop running it daily. Treat the numbers as a realistic order of magnitude, not a guaranteed ceiling.

## Test bench

| | |
|---|---|
| CPU | Apple Silicon (modern arm64 laptop) |
| OS | macOS 26, arm64 |
| Bun | 1.3.x |
| DB state | A few dozen projects scanned, several dozen Obsidian notes indexed via FTS5, a few weeks of LLM usage history, typical GitHub sync state. In other words: *one solo developer's steady state.* |
| Uptime when measured | server warmed up for ~45 min |

Exact row counts are left out on purpose — they describe the author's personal workload, not a reference dataset. If you want to reproduce, the "How to re-measure" script at the bottom will print the counts against *your* DB.

---

## Storage

Measured with `du -sh` on disk (APFS).

| Item | Size | Note |
|---|---|---|
| `node_modules/` | **~180 MB** | Mostly Tailwind, Vite, Biome, React type defs. Dev-only. |
| `dist/client/` | **~1.3 MB** | Minified React bundle + assets. |
| `dist/server/` | **~1.1 MB** | Single-file Bun build of the Hono server. |
| `dist/` total | **~2.4 MB** | Full production artifact. |
| `src/` | **~1.5 MB** | Source tree (~40 k LoC across ~90 files). |
| `data/db.sqlite` | **a few MB** | SQLite main file; grows on the order of ~0.1 MB per active day of use. |
| `data/db.sqlite-wal` | **a few MB** | WAL journal (truncated on checkpoint). |
| Auth token file | **65 bytes** | Outside the repo in the OS app-data dir. |

**Footprint summary for a packaged build (Phase 4, Tauri):** expect ~3–5 MB of shipped assets + whatever SQLite grows to over the user's usage (single-digit MB for typical solo devs).

---

## Memory (RAM)

Measured via `ps -o rss` on the running Hono process.

### Production-mode equivalent (server alone)

| State | RSS | Note |
|---|---|---|
| Cold start → `/api/health` ready | **~340 ms, ~60 MB RSS** | Prod bundle (`dist/server/index.js`), median of multiple runs. |
| Steady-state idle (scheduler running, watcher idle) | **50 – 70 MB** | Fluctuates with V8/JSC heap and WAL buffers. |
| After a burst of `/api/usage/*` queries | **~100 MB peak** | Drops back to ~50 MB after GC. |
| Obsidian watcher cold-indexing a few dozen notes | **transient +20 MB** | Not steady-state. |

### Dev mode (full stack running concurrently)

| Process | RSS |
|---|---|
| Hono server (`bun --hot src/server/index.ts`) | ~36 – 100 MB |
| Vite dev server | ~24 – 30 MB |
| esbuild worker | ~5 – 7 MB |
| `concurrently` wrapper | ~10 – 14 MB |
| **Dev total** | **~80 – 150 MB** |

None of the numbers approach a GB. vibecode-dash is fine on an 8 GB machine running alongside a browser and an editor.

---

## CPU

Measured as `%CPU` via `ps`, where 100 % = one logical core fully used on an Apple Silicon laptop.

| State | %CPU (server process) |
|---|---|
| Idle, no UI connected, scheduler ticking every minute | **0 – 3 %** |
| UI open, one page loaded, user scrolling | **1 – 5 %** |
| Burst: 3 `/api/*` requests in flight | **8 – 12 %** |
| Project rescan (full filesystem walk of a few dozen repos) | **peaks 30 – 50 % for ~2 s** |
| Obsidian cold index (a few dozen notes, FTS5 rebuild) | **peaks 40 – 60 % for ~1 s** |

Heavy work is bursty: scheduled scans, on-demand competitor radar runs, Obsidian reindex. Otherwise the server is nearly idle.

## API latency

Loopback, single request, no concurrency. Two columns: **first hit** (cold path / untouched query plan) and **warm** (5-run average after the endpoint has been exercised; the OS page cache and SQLite prepared-statement cache are hot).

| Endpoint | Dataset size | First hit | Warm (avg of 5) |
|---|---|---|---|
| `GET /api/health` | — | ~20 ms | **~2 ms** |
| `GET /api/projects` | a few dozen projects | ~40 ms | **~7 ms** |
| `GET /api/usage/daily-combined` | a few weeks × 2 providers | ~70 ms | **~3 ms** |
| `GET /api/github/repos` | ~10 repos | — | **~1.5 ms** |
| `GET /api/obsidian/notes?limit=10` | FTS5 over a few dozen notes | — | **~1.5 ms** |
| `GET /api/agent/sessions?limit=20` | a few dozen sessions | — | **~4 ms** |
| `GET /api/github/traffic` | ~10 repos × 14 – 40 days | ~50 ms | — |

Latencies scale roughly linearly with dataset size. No query touches more than a handful of indexed rows in the common path. The gap between first-hit and warm tells you how sensitive you are to cache eviction — in practice the dashboard never evicts its own pages (WAL mode, small working set).

---

## Minimum system requirements

These are conservative — the numbers above are what you'd actually see.

| | Minimum | Recommended |
|---|---|---|
| OS | macOS 13 / Ubuntu 22.04 / Windows 10 | latest stable |
| CPU | any 64-bit dual-core from ~2015 | any modern arm64/x64 |
| RAM | 512 MB free | 1 GB free (lets the browser tab breathe) |
| Disk | 250 MB (node_modules + data) | 500 MB (with headroom for DB growth) |
| Network | none — everything is loopback | `gh` reachable if you want GitHub sync |

---

## How to re-measure

```bash
# Storage
du -sh node_modules dist data src

# Row counts (against your DB)
bun -e "const db=new (require('bun:sqlite').Database)('data/db.sqlite','readonly'); \
  for(const t of db.query(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all()) { \
    const c=db.query(\`SELECT COUNT(*) as n FROM \"\${t.name}\"\`).get(); \
    console.log(String(c.n).padStart(10), t.name); \
  }"

# Server RSS + CPU
ps -p $(lsof -ti tcp:4318) -o pid,rss,%cpu,%mem,etime,command

# Endpoint latency (after bootstrapping the token)
TOKEN=$(curl -s http://127.0.0.1:4318/api/auth/token | jq -r .token)
curl -s -o /dev/null -w "%{time_total}s\n" \
  -H "x-dashboard-token: $TOKEN" \
  http://127.0.0.1:4318/api/projects
```

Report surprising deltas in an issue with your OS / CPU / Bun version — helps track regressions.
