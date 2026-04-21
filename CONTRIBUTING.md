# Contributing

Thanks for looking at vibecode-dash. It's a solo-dev tool built for solo devs, so the bar for a patch is "does it keep the thing local-first, CLI-first, and readable?" — not "does it match our 12-page style guide."

## Ground rules

- **Local-first.** If your change introduces a network call to a SaaS, an account, telemetry, or any remote state, it probably won't land. Exceptions: talking to GitHub's API (the app already does), hitting public package registries for the Competitor Radar.
- **CLI over SDK.** Provider integrations (Claude, Codex, future LLMs) are done by spawning the official CLI — not by importing their SDK. This is a hard constraint, not a preference. See [CLAUDE.md](CLAUDE.md).
- **127.0.0.1 only.** Never change the bind address or add a way to expose the server publicly.
- **No secrets in the repo.** Keyring for runtime, `.env.example` for hints. The `data/` directory is user state and stays gitignored (except `.gitkeep` and `settings.example.json`).

## Dev loop

```bash
bun install
bun run migrate         # apply SQLite migrations
bun run dev             # :4317 client + :4318 server, hot reload both
```

Before you open a PR:

```bash
bun run lint            # biome check
bun run typecheck       # tsc --noEmit
bun test                # bun:test
```

All three must pass. CI will run them anyway.

## Project layout

```
src/
├─ client/         React app (Vite)
│  ├─ lib/         API client, i18n, shortcuts
│  ├─ locales/     fr/en/es dicts
│  └─ …            page components
├─ server/         Hono app (Bun)
│  ├─ routes/      one file per domain
│  ├─ lib/         platform, keychain, auth, pricing, i18n, …
│  ├─ scanners/    projects, obsidian, github
│  ├─ wrappers/    ccusage, claude/codex JSONL parsers, agent CLI
│  ├─ jobs/        scheduler, obsidianWatcher
│  ├─ db/          migrations + bun:sqlite bootstrap
│  └─ __tests__/   bun:test suites
└─ shared/         types shared client ↔ server
```

A new feature usually touches: a route file, maybe a scanner/wrapper/lib module, a shared type, a page in `client/`, and a migration if schema changes.

## Migrations

- Never edit an applied migration — add a new one.
- Filename convention: `NNNN_description.sql` (4-digit, zero-padded).
- Applied via `bun run migrate` (idempotent; tracked in `schema_migrations`).

## Style

- **Biome** handles formatting + linting. Run `bunx biome check --write <files>` to autofix.
- **TypeScript strict**. `any` requires a one-line comment explaining why. `unknown` + Zod at I/O boundaries.
- **Comments**: default to no comment. Add one when the WHY is non-obvious (hidden constraint, workaround). Don't narrate the code.
- **Errors at boundaries**: validate with Zod at route entry and when reading files written by external processes (LLM CLIs, `ccusage`). Trust your own code.
- **i18n**: any user-facing string goes in `src/client/locales/{fr,en,es}.ts`. Keys must match across the three files.
- **Server logging**: `console.log` / `console.warn` is fine for now. If you add something spammy, gate it behind `process.env.DEBUG`.

## Tests

- Use `bun:test`. Test files live in `src/server/__tests__/` (server) or colocated (client, when they exist).
- Prefer unit tests over e2e. If you need to test a route, use `Hono.request()` in-process (see [`auth.test.ts`](src/server/__tests__/auth.test.ts) for an example) — don't spin up a real server.
- OS-specific integration tests are opt-in via env var, not run by default. Pattern: `describe.skipIf(!process.env.MY_INTEGRATION)(...)`.

## Commits & PRs

- Small, focused commits. One logical change per commit.
- Subject line: imperative, lowercase, no trailing period. `fix: origin check accepts ipv6 brackets`, not `Fixed the Origin Check.`.
- PR description: the *why*, not the *what* (the diff says what). Link the issue it fixes, if any.
- Don't bundle a refactor with a bug fix — two PRs.

## Adding a new platform / keyring backend

If you want to add a new OS:

1. Extend `SupportedPlatform` in [`src/server/lib/platform.ts`](src/server/lib/platform.ts) and return sensible defaults for `defaultProjectsRoot`, `defaultVaultPath`, `defaultClaudeConfigDir`, `appDataDir`.
2. Add a `SecretStore` implementation in [`src/server/lib/keychain.ts`](src/server/lib/keychain.ts) and wire it in `pickBackend()`.
3. Add tests for the new backend (fake-backend dispatch is always runnable; integration tests gated by env var).
4. Update the platform table in [README.md](README.md) and [SECURITY.md](SECURITY.md).

## Adding a new route

1. Create `src/server/routes/your-feature.ts` exporting `registerYourFeatureRoutes(app)`.
2. Register it in `src/server/routes/index.ts`.
3. Validate the request body with Zod in the handler.
4. Add the route to `src/client/lib/api.ts` callers if the UI needs it.
5. Add a test.

The auth middleware applies to `/api/*` automatically — no extra work to gate a new route.

## Not accepted

- Telemetry or analytics (even opt-in for v0.x).
- Replacing CLI integrations with SDKs.
- Changes that require a SaaS account to run the dashboard.
- `--no-verify` commits, amending pushed commits, disabling lint/type rules globally to "unblock" a PR.

## License

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE).
