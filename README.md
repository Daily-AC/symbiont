# 🌿 Symbiont

**Human-AI symbiosis platform powered by Claude Code**

Symbiont is an open-source platform that turns Claude Code into a living companion — one that remembers you, grows with you, and works alongside you through your favorite messaging apps.

---

## Why Symbiont?

This is not another chatbot.

- **Memory** — Persistent, structured memory that evolves across conversations. Your AI actually remembers what matters.
- **Personality** — Swappable Persona Packs define how your AI thinks, speaks, and behaves. Make it yours.
- **Autonomy** — Scheduled tasks, background workers, and proactive behaviors. It doesn't just respond — it acts.
- **Integration** — Native Feishu (Lark) support with MCP gateway for extending to any service.
- **Growth** — Memory consolidation, pattern recognition, and relationship deepening over time.

---

## Quick Start

### Docker (recommended)

```bash
git clone https://github.com/Daily-AC/symbiont.git
cd symbiont
cp .env.example .env        # edit with your tokens
docker compose up -d
```

### Native

```bash
git clone https://github.com/Daily-AC/symbiont.git
cd symbiont
npm install
cp .env.example .env        # edit with your tokens
npm run dev
```

---

## Architecture

```
                    ┌─────────────┐
                    │  Feishu Bot  │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │   Router    │
                    └──────┬──────┘
                           │
                    ┌──────▼──────┐
                    │  CC Broker  │◄──── MCP Gateway
                    └──────┬──────┘
                           │
              ┌────────────┼────────────┐
              │            │            │
        ┌─────▼─────┐ ┌───▼───┐ ┌─────▼─────┐
        │ MemoryDB  │ │ Cron  │ │  Workers  │
        └───────────┘ └───────┘ └───────────┘
```

---

## Core Components

| Component | Description |
|---|---|
| **SymbiontCore** | Central orchestrator — boots all subsystems, manages lifecycle |
| **Router** | Message routing layer — dispatches incoming events to handlers |
| **CCBroker** | Claude Code process manager — spawns, monitors, and communicates with CC |
| **MemoryDB** | Persistent memory store — hippocampus-inspired recall and consolidation |
| **CronScheduler** | Time-based task scheduler — proactive behaviors and maintenance jobs |
| **WorkerManager** | Background worker pool — long-running tasks and async operations |
| **MCP Gateway** | Model Context Protocol bridge — exposes tools to CC via MCP |
| **FeishuPlugin** | Feishu/Lark integration — message handling, cards, and bot lifecycle |

---

## Persona Packs

Persona Packs define the personality, knowledge, and behavior of your Symbiont instance.

```
persona-packs/
├── xiaoxi/              # Example: "小希" persona
│   ├── persona.json     # Identity, traits, speaking style
│   ├── system.md        # System prompt template
│   ├── memory-seeds/    # Initial memories and knowledge
│   └── cron-tasks/      # Persona-specific scheduled tasks
└── your-persona/        # Create your own!
```

### Create Your Own

1. Copy `persona-example/` to `persona-packs/your-name/`
2. Edit `persona.json` with your AI's identity and traits
3. Write a `system.md` that defines how it should think and speak
4. Add memory seeds for domain knowledge
5. Set `PERSONA_PACK=your-name` in `.env`

---

## Configuration

See [`.env.example`](.env.example) for all available configuration options, including:

- Claude Code API settings
- Feishu app credentials
- Memory database configuration
- Persona pack selection
- Cron job definitions

---

## For AI Agents

If you are an AI agent working on this codebase, see [`CLAUDE.md`](CLAUDE.md) for development conventions, project structure, and code style guidelines.

---

## License

[MIT](LICENSE) — use it, fork it, make it yours.

---

> *"The best AI isn't the smartest one. It's the one that understands you."*
