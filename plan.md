# Dashboard Projets LLM

Document de cadrage importé depuis la conversation du 2026-04-18.

## Résumé

- Runtime: Bun 1.x
- Backend: Hono (bind 127.0.0.1)
- Frontend: React + Vite + Tailwind
- DB: SQLite (data/db.sqlite)
- Secrets: macOS Keychain
- Cible MVP: scanner projets locaux + sync GitHub + usage ccusage + UI Overview/Projects/GitHub/Usage.
- Décision agent: mode CLI uniquement (`claude` + `codex`), sans SDK.

## Roadmap

1. Phase 1: fondations techniques + scanner projets + pages de base
2. Phase 2: Obsidian + Agent panel
3. Phase 3: Competitor Radar + Divergence Engine
4. Phase 4: polish + packaging Tauri

## État actuel (implémenté)

- Scaffold complet Bun/Hono/React/Vite/Tailwind
- Schéma SQLite + migration
- Scanner projets locaux (type, git, score santé, LoC)
- API routes: health, settings, projects, github, usage
- Wrapper Keychain + wrapper ccusage
- Frontend minimal fonctionnel avec navigation et pages de base
- Phase 2 (étendu): scanner Obsidian + API `/api/obsidian/*` + page Vault + Agent CLI sessions persistantes + quick commands + AgentDock + analytics JSONL direct (`by-project`, `by-model`, `hour-distribution`, `tool-usage`) + intégration Codex/GPT (`@ccusage/codex`, endpoints `/api/usage/codex/*`, `/api/usage/daily-combined`) + overview GitHub/Usage/Obsidian
- Phase 3: Competitor Radar + Divergence Engine (migration 0006, `src/server/lib/radar.ts`, `src/server/routes/radar.ts`, page `/radar`, drawer dans `/projects/:id`). MVP CLI-first : scan concurrents via `claude --read-only` avec WebSearch/WebFetch, génération d'insights typés (`market_gap` | `overlap` | `vault_echo`) consommant projet + concurrents + notes vault. Pas de scheduler auto (tout on-demand), pas d'embeddings (FTS5 suffit pour le MVP).

Le plan détaillé reste la version fournie dans le message initial.
