Ce projet implémente le plan décrit dans plan.md.
Stack : Bun + Hono + React + Vite + Tailwind + SQLite.
Respecte strictement l'arborescence du §11.
Ne démarre jamais le serveur sur autre chose que 127.0.0.1.
Les secrets passent par macOS Keychain, pas par .env.
Pour la couche agent (Phase 2+), utiliser exclusivement les CLI (`claude`, `codex`), pas de SDK.
