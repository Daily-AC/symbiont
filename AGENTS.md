# Symbiont Deployment Guide (for AI Agents)

Symbiont is a personal AI companion platform powered by Claude Code CLI. It connects to Feishu (Lark) as its chat interface and maintains persistent memory, persona, and cron-driven autonomous behaviors across sessions.

---

## 1. Prerequisites

| Requirement | Version | Check Command |
|---|---|---|
| Node.js | >= 22.0.0 | `node --version` |
| npm | >= 10 | `npm --version` |
| Claude Code CLI | latest | `claude --version` |
| Docker + Compose | (optional) | `docker compose version` |
| Git | any | `git --version` |

Claude Code CLI must be authenticated. Run `claude` interactively once to complete OAuth if needed.

---

## 2. Quick Start (Docker)

### 2.1 Clone and configure

```bash
git clone https://github.com/Daily-AC/symbiont.git
cd symbiont
cp .env.example .env
```

Edit `.env` with your values (see Section 7 for all variables):

```bash
# Required: Feishu bot credentials
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

# Required: Dashboard access token
SYMBIONT_DASHBOARD_TOKEN=your-secret-token
```

### 2.2 Build and start

```bash
docker compose up -d --build
```

### 2.3 Verify

```bash
# Check container is running
docker ps --filter name=symbiont --format "table {{.Names}}\t{{.Status}}"
# Expected: symbiont   Up X seconds

# Check health endpoint
curl -s http://localhost:18080/health | head -c 200
# Expected: JSON with {"status":"ok", ...}

# Check logs for startup
docker logs symbiont --tail 20
# Expected: lines showing "Health server listening on 18080" and Feishu client init
```

### 2.4 Persistent data

Data is stored in `./data/` (mounted as a volume). Back up this directory to preserve memory and event history.

---

## 3. Quick Start (Native)

### 3.1 Clone and install

```bash
git clone https://github.com/Daily-AC/symbiont.git
cd symbiont
npm install
```

### 3.2 Configure

```bash
cp .env.example .env
# Edit .env — see Section 7 for all variables
```

### 3.3 Run

```bash
node --experimental-strip-types src/index.ts
```

### 3.4 Verify

```bash
curl -s http://localhost:18080/health | head -c 200
# Expected: JSON with {"status":"ok", ...}
```

### 3.5 Run tests

```bash
node --experimental-strip-types --test tests/*.test.ts
```

### 3.6 systemd service (Linux)

Create `/etc/systemd/system/symbiont.service`:

```ini
[Unit]
Description=Symbiont AI Companion
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/path/to/symbiont
ExecStart=/usr/bin/node --experimental-strip-types src/index.ts
Restart=on-failure
RestartSec=5
EnvironmentFile=/path/to/symbiont/.env

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable symbiont
sudo systemctl start symbiont

# Verify
systemctl status symbiont
# Expected: Active: active (running)
```

---

## 4. Feishu Bot Setup

### 4.1 Create a Feishu app

1. Go to [Feishu Open Platform](https://open.feishu.cn/) and log in.
2. Click **Create Custom App**.
3. Fill in app name (e.g., "Echo") and description.
4. Note the **App ID** and **App Secret** from the Credentials page.

### 4.2 Add bot capability

1. In your app settings, go to **Features** > **Bot**.
2. Enable the bot capability.
3. Set the bot name and avatar.

### 4.3 Configure event subscription

1. Go to **Events & Callbacks** > **Event Configuration**.
2. Set the **Request URL** to: `http://YOUR_SERVER_IP:18090/feishu/event` (or your public URL).
3. Subscribe to these events:
   - `im.message.receive_v1` (receive messages)
   - `application.bot.menu_v6` (bot menu actions, optional)

### 4.4 Configure permissions

Under **Permissions & Scopes**, add:
- `im:message` (send messages)
- `im:message.group_at_msg` (receive group @ messages)
- `im:message.p2p_msg` (receive P2P messages)
- `im:chat` (access chat info)
- `im:resource` (download media resources)

### 4.5 Set environment variables

```bash
FEISHU_APP_ID=cli_xxxxxxxxxxxx
FEISHU_APP_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### 4.6 Publish the app

1. Go to **App Release** > **Version Management**.
2. Create a new version and submit for review.
3. Once approved (or in dev mode), the bot is active.

### 4.7 Add bot to a chat

1. Open a Feishu group chat.
2. Click **Settings** > **Bots** > **Add Bot**.
3. Search for your bot name and add it.
4. Send a message mentioning the bot (e.g., `@Echo hello`) to verify.

Expected: The bot replies within a few seconds. Check server logs if no response.

---

## 5. Creating Your Persona

A persona defines your companion's identity, voice, and behavior.

### 5.1 Copy the example

```bash
cp -r persona-example my-persona
```

### 5.2 Directory structure

```
my-persona/
  manifest.yaml        # Name, version, permissions, MCP config
  soul/
    01-identity.md     # Who the persona is, core beliefs
    02-bonds.md        # How it builds relationships
    03-principles.md   # Operating principles
  voice/
    style.md           # Tone, rhythm, what to avoid
  memory/              # Auto-populated by the system
```

### 5.3 Edit manifest.yaml

```yaml
name: my-companion
version: "1.0.0"
description: My custom AI companion

permissions:
  writable:
    - voice/
    - memory/
  protected:
    - soul/
    - manifest.yaml

mcp:
  tools:
    - "*"

skills:
  include:
    - "*"
```

### 5.4 Edit soul files

**soul/01-identity.md** — Define who the persona is:
- Name, emoji, core beliefs
- Modes of operation (work mode vs. chat mode)

**soul/02-bonds.md** — Define relationship dynamics:
- How trust is built
- Boundaries and expectations

**soul/03-principles.md** — Define operating rules:
- Action bias, memory importance, question style

### 5.5 Edit voice/style.md

Define tone, rhythm, and communication anti-patterns.

### 5.6 Edit user profile

```bash
# Edit the user profile so your companion knows about you
vim user/profile.md
```

### 5.7 Activate your persona

Set the environment variable and restart:

```bash
# In .env
SYMBIONT_PERSONA_DIR=my-persona

# Restart
docker restart symbiont
# or: systemctl restart symbiont
```

Verify:

```bash
curl -s http://localhost:18080/health | grep -o '"persona":"[^"]*"'
# Expected: "persona":"my-companion"
```

---

## 6. Environment Variables

| Variable | Required | Default | Description |
|---|---|---|---|
| `FEISHU_APP_ID` | Yes | — | Feishu app ID from open platform |
| `FEISHU_APP_SECRET` | Yes | — | Feishu app secret |
| `SYMBIONT_DASHBOARD_TOKEN` | Yes | — | Token for dashboard/API auth |
| `SYMBIONT_PERSONA_DIR` | No | `persona-example` | Persona pack directory name |
| `SYMBIONT_BOT_NAME` | No | `Echo` | Bot display name in messages |
| `SYMBIONT_CRON_CHAT_ID` | No | — | Feishu chat ID for cron notifications |
| `SYMBIONT_DEBUG` | No | `false` | Enable debug logging |
| `SYMBIONT_CC_MODE` | No | `ws` | CC communication mode (`ws` or `print`) |
| `FEISHU_OWNER_OPEN_ID` | No | — | Your Feishu open_id (for calendar) |
| `CLAUDE_PATH` | No | `claude` | Path to Claude CLI binary |
| `EMBEDDING_URL` | No | — | Embedding service URL for vector search |

---

## 7. Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Symbiont                          │
│                                                     │
│  ┌──────────┐   ┌──────────┐   ┌────────────────┐  │
│  │ Feishu   │   │ Terminal  │   │ Dashboard      │  │
│  │ :18090   │   │ (stdin)   │   │ :18080         │  │
│  └────┬─────┘   └────┬─────┘   └───────┬────────┘  │
│       │              │                  │           │
│       └──────┬───────┘                  │           │
│              ▼                          │           │
│  ┌───────────────────┐   ┌──────────────┴────────┐  │
│  │     Router        │   │   REST API / SSE      │  │
│  │  (message routing)│   │   (memory, events)    │  │
│  └────────┬──────────┘   └───────────────────────┘  │
│           ▼                                         │
│  ┌────────────────┐  ┌────────────┐  ┌───────────┐  │
│  │  CC Broker      │  │   Cron     │  │  MCP      │  │
│  │  (Claude Code   │  │ Scheduler  │  │ Gateway   │  │
│  │   processes)    │  │            │  │           │  │
│  └───────┬────────┘  └────────────┘  └───────────┘  │
│          ▼                                          │
│  ┌────────────────────────────────────────────────┐  │
│  │              Memory Layer                      │  │
│  │  SQLite DB · Embeddings · Recall · Decay       │  │
│  └────────────────────────────────────────────────┘  │
│                                                     │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │  Persona     │  │  User        │  │  Event     │  │
│  │  Loader      │  │  Loader      │  │  Store     │  │
│  └─────────────┘  └──────────────┘  └────────────┘  │
└─────────────────────────────────────────────────────┘
          │
          ▼
   ┌──────────────┐
   │ Claude Code  │
   │ CLI (claude) │
   └──────────────┘
```

**Key components:**
- **Feishu Interface** (:18090) — receives Feishu webhook events, sends replies via Feishu API
- **Dashboard/Health** (:18080) — web dashboard, REST API, health check, SSE events
- **Router** — routes incoming messages to CC sessions
- **CC Broker** — manages Claude Code CLI child processes (spawn, queue, lifecycle)
- **Memory Layer** — SQLite-backed persistent memory with embedding search, recall, decay, and settler
- **Cron Scheduler** — autonomous scheduled tasks (memory decay, heartbeat, cognition scan)
- **MCP Gateway** — exposes Symbiont tools to Claude Code via Model Context Protocol
- **Persona Loader** — loads soul/voice/manifest from persona pack directory
- **Event Store** — append-only event log for observability

---

## 8. Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Bot not responding in Feishu | Event subscription URL unreachable | Verify `http://YOUR_IP:18090/feishu/event` is accessible from the internet. Check firewall rules: `curl -v http://YOUR_IP:18090/health` |
| Feishu returns 401 | Wrong App ID or App Secret | Double-check `FEISHU_APP_ID` and `FEISHU_APP_SECRET` in `.env`. Restart after changes. |
| Claude Code won't start | CLI not installed or not authenticated | Run `claude --version` inside the container/host. Run `claude` interactively to complete OAuth. Check `CLAUDE_PATH` if using non-default location. |
| Empty memory search results | No embedding service configured | Set `EMBEDDING_URL` to a running embedding server. Without it, vector recall is disabled (keyword search still works). |
| Dashboard returns 403 | Wrong or missing dashboard token | Verify `SYMBIONT_DASHBOARD_TOKEN` matches what you use to log in at `/login`. |
| Container exits immediately | Missing required env vars | Run `docker logs symbiont` to see the error. Ensure `FEISHU_APP_ID` and `FEISHU_APP_SECRET` are set. |
| Messages duplicated | Dedup window too short or restart during processing | Check logs for dedup warnings. This is usually transient after a restart. |
| Cron jobs not firing | System clock or timezone mismatch | Verify system time: `date -u`. Cron uses UTC internally. |
| `better-sqlite3` build fails | Missing build tools | Install: `apt-get install python3 make g++` (Docker image handles this). On macOS: `xcode-select --install`. |
| Port already in use | Another process on 18080/18090 | `lsof -i :18080` to find the process. Change ports or stop the conflicting service. |
