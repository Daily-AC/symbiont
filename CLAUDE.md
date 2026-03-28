# Symbiont — Development Guide

Human-AI symbiosis platform: Feishu bot frontend, Claude Code brain, persistent memory.

## Commands

- `npm run dev` — start in development mode (watch + reload)
- `npm test` — run test suite
- `docker compose up -d` — start all services via Docker

## Architecture

```
src/
├── core/           # SymbiontCore, lifecycle, config loading
├── interface/      # Feishu plugin, message handlers, card builders
├── api/            # MCP gateway, external API routes
├── memory/         # MemoryDB, recall, consolidation, vector search
├── persona/        # Persona loader, trait engine, prompt assembly
└── user/           # User profile, preferences, relationship state

persona-example/    # Template for creating new persona packs
persona-packs/      # Active persona packs (gitignored, user-provided)
```

## Code Style

- TypeScript with `.ts` imports (explicit extensions)
- No build step — runs directly via tsx/ts-node
- Prefer explicit over clever
- MCP tools prefixed with `symbiont_` (e.g., `symbiont_recall`, `symbiont_schedule`)
- One export per file for core components; barrel exports in `index.ts`
