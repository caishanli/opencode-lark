[中文版](README.zh-CN.md)

# opencode-lark

> Bridge Feishu group chats to opencode TUI sessions with real-time two-way messaging.

![CI](https://github.com/guazi04/opencode-lark/actions/workflows/ci.yml/badge.svg)
![npm](https://img.shields.io/npm/v/opencode-lark.svg)
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)

---

## Features

- **Real-time bridging** — Messages sent in Feishu arrive in your opencode TUI instantly, and agent replies stream back as live-updating cards.
- **One card per turn** — The reply card is patched in place (`PATCH`), never replaced by a new message. The body is a chronological list of text runs and tool panels, like the opencode web UI.
- **A status line that says what happened** — `✅ Done · ⏱ 12.4s · 3 rounds 5 steps · 341.0k toks (💾 97.42%) · 51.7 tok/s · 🧠 339.8k (33.98%) · 💰 663.9M`. The cache hit rate is the ratio of the counters the server reports.
- **Interactive cards** — Agent questions and permission requests appear as clickable Feishu cards. Answer or approve directly from the chat — no need to switch to the TUI.
- **Slash commands in the chat** — `/help` lists every command (the bridge's and the project's opencode commands) as buttons; `/模型` opens a two level model picker (provider → model, paged, free models first); `/自动关闭` chooses when the opencode server is stopped while it is idle.
- **WebSocket connection** — Uses Feishu's long-lived WebSocket mode. No webhook polling, no public IP required.
- **SSE streaming** — Consumes the opencode SSE event stream and debounces card updates to stay within rate limits. The subscription reconnects on its own, so a restarted opencode server does not leave the bridge deaf.
- **Conversation memory** — SQLite-backed per-thread history is prepended to each message, giving the agent context across turns.
- **Session auto-discovery** — Finds and binds to the latest opencode TUI session for a working directory. Survives restarts.
- **The bridge owns the opencode process** — It starts the server when a message needs it (0.4 s) and can stop it when it has been idle for a while, so it does not hold hundreds of megabytes for nothing.
- **Graceful recovery** — Reconnects to the opencode server with exponential backoff (up to 10 attempts) on startup. A card left open by a dead process is restored with its answer and marked as interrupted.
- **Extensible channel layer** — `ChannelPlugin` interface lets you add Slack, Discord, or any other platform without touching core logic.
- **File and image support** — Handles image and file messages from Feishu (not just text). Downloads attachments to `${OPENCODE_CWD}/.opencode-lark/attachments/` and forwards the local path to opencode for analysis. 50 MB size limit, streaming download, filename sanitization included.

---

## Commands

Type them in the chat, or pick them from the `/help` card.

| Command | What it does |
|---|---|
| `/help`, `/`, `/帮助` | The command menu: every command as a button, plus the project's opencode commands (`/init`, `/review`, …) |
| `/模型`, `/model`, `/models` | Model picker — first the provider, then its models (12 per page, free models first). Picking one switches the session to it |
| `/自动关闭`, `/autostop` | When the opencode server is stopped while it is idle: never, 15, 30 or 60 minutes. Remembered across restarts |
| `/new` | Start a new opencode session and bind the chat to it |
| `/sessions` | List the opencode sessions of this project and connect to one |
| `/connect <session_id>` | Connect the chat to a session by id |
| `/abort` | Interrupt the current turn. The session and its history stay — the next message continues in the same conversation |
| `/compact`, `/压缩` | Compact the conversation: opencode summarizes the old turns and the context window shrinks. The history stays in the session |
| `/更新`, `/update` | Upgrade the opencode installation. The server is stopped afterwards, so the next message starts the new version |

---

## Architecture

```
Feishu client
    ↕  WebSocket
Feishu Open Platform
    ↕  WebSocket
opencode-lark  (this project)
    ↕  HTTP API + SSE
opencode server  (localhost:4096)
    ↕  stdin/stdout
opencode TUI
```

> `opencode serve` runs the HTTP server. Use `opencode attach` in a separate terminal to view the session in TUI.

**Inbound (Feishu → TUI):** Feishu sends a message over WebSocket. opencode-lark normalizes it, resolves the bound session, prepends conversation history, then POSTs to the opencode API. The TUI sees the message immediately.

**Outbound (TUI → Feishu):** opencode-lark subscribes to the opencode SSE stream. As the agent produces text, `TextDelta` events accumulate and a debounced card update fires. Once `SessionIdle` arrives, the final card is flushed to Feishu.

### Supported Message Types

| Message Type | Supported | Notes |
|---|---|---|
| `text` | ✅ | Plain text messages |
| `post` | ✅ | Rich text / multi-paragraph messages |
| `image` | ✅ | Photos and screenshots — downloaded and saved locally |
| `file` | ✅ | Documents, code files, etc. — downloaded and saved locally |
| `audio` / `video` / `sticker` | ❌ | Logged and skipped |

Downloaded files are saved to `${OPENCODE_CWD}/.opencode-lark/attachments/` (falls back to the system temp directory if that path isn't writable).

---

## Install

> **Note**: [Bun](https://bun.sh) is the required runtime — this project uses `bun:sqlite` which is Bun-only.

### One-shot (new machine)

```bash
curl -fsSL https://raw.githubusercontent.com/caishanli/opencode-lark/main/manage.sh | bash
```

It installs Bun and opencode when they are missing, clones the repo, installs
the dependencies, runs the setup wizard (QR code → Feishu app) and installs the
systemd user service. Reusing an existing Feishu app skips the wizard:

```bash
FEISHU_APP_ID=cli_xxx FEISHU_APP_SECRET=xxx OPENCODE_SERVER_PASSWORD=xxx bash manage.sh
```

Re-running is safe: the configuration is kept and a running service is not
restarted (use `scripts/restart-when-idle.sh` after changing code).

| Command | What it does |
|---|---|
| `manage.sh` *(default)* | install/update everything; on **Ubuntu** it also enables boot start (systemd user + `loginctl enable-linger`) |
| `manage.sh config` | re-run the Feishu setup (new app or new credentials); the old app's config is removed |
| `manage.sh update` | `git pull`, `bun install`, then restart the service once the running turn is idle |
| `manage.sh remove [--purge]` | stop and remove the service; `--purge` also deletes the configuration and `data/` |
| `manage.sh help` | show the commands |

The QR flow creates the app with the bot scopes and the `card.action.trigger`
callback already provisioned; after saving the credentials the installer reads
them back from Feishu and reports anything that is missing.

### Manual

```bash
# Global install
npm install -g opencode-lark
# or
bun add -g opencode-lark
```

Or clone and run from source:

```bash
git clone https://github.com/guazi04/opencode-lark.git
cd opencode-lark
bun install
```

---

## Quick Start

Get up and running in 5 minutes. You'll need a Feishu Open Platform app with bot capability — see [Feishu App Setup](#feishu-app-setup) below for the detailed walkthrough if you haven't created one yet.

### Prerequisites

- **[Bun](https://bun.sh)** (required runtime — this project uses `bun:sqlite` which is Bun-only)
- **[opencode](https://opencode.ai)** v2 running locally, with Basic auth enabled
- A **Feishu Open Platform app** with credentials (see [Feishu App Setup](#feishu-app-setup))

> **Bun on `PATH`.** Bun usually installs to `~/.bun/bin`. If `bun` is not found,
> add it to your shell profile:
> ```bash
> export BUN_INSTALL="$HOME/.bun"
> export PATH="$BUN_INSTALL/bin:$PATH"
> ```
> The npm scripts (`npm start`, `npm test`) go through `scripts/run.sh`, which
> finds bun in `~/.bun/bin` even when it is not on `PATH` — so they work in
> non-interactive shells (CI, Docker, systemd) too.

### Steps

**1. Install**

```bash
bun add -g opencode-lark
# or: npm install -g opencode-lark
```

**2. Start opencode server**

```bash
OPENCODE_SERVER_PORT=4096 opencode serve
```

**3. Start opencode-lark**

In a second terminal:

```bash
opencode-lark
```

On first run with no configuration, an interactive setup wizard guides you through:
- **Scanning a QR code to create the Feishu app automatically** (recommended) — a
  terminal QR code is shown; scan it with the Feishu mobile app and the App ID /
  App Secret are written for you. Falls back to manual entry if you skip or the
  scan times out.
- Entering your Feishu App ID and App Secret (masked input)
- Validating the opencode server connection (with Basic auth)
- Saving credentials to a `.env` file

The service starts automatically after setup completes.

> **Tip**: To re-run the wizard later, use `opencode-lark init`.
>
> To configure manually instead, create a `.env` file with `FEISHU_APP_ID` and `FEISHU_APP_SECRET` before starting.

**4. Send a test message**

Send any message to your Feishu bot. On first contact it auto-discovers the latest TUI session and replies:

> Connected to session: ses_xxxxx

After that, Feishu and the TUI share a live two-way channel. To attach the TUI:
```bash
opencode attach http://127.0.0.1:4096 --session {session_id}
```
The `session_id` is shown in opencode-lark's startup logs (e.g. `Bound to TUI session: ... → ses_xxxxx`).

---

### Run as a background service

To keep the bridge running (and to survive logout/reboot), install it as a
systemd **user** service:

```bash
mkdir -p ~/.config/systemd/user ~/.local/state/opencode-lark
sed -e "s#__REPO__#$PWD#" -e "s#__BUN__#$(command -v bun)#" \
    -e "s#__STATE__#$HOME/.local/state#" \
    packaging/opencode-lark.service > ~/.config/systemd/user/opencode-lark.service

systemctl --user daemon-reload
systemctl --user enable --now opencode-lark
loginctl enable-linger "$USER"   # keep it running after logout
```

The service does not carry credentials: the app loads them itself from
`~/.config/opencode-lark/.env.<appId>` on startup. Logs go to
`~/.local/state/opencode-lark/bridge.log`.

```bash
systemctl --user status opencode-lark
systemctl --user restart opencode-lark
```

> **After changing the code**, restart it with the idle-aware helper — a plain
> `systemctl --user restart` in the middle of a running turn kills the event
> stream and leaves the reply card stuck on "interrupted":
> ```bash
> scripts/restart-when-idle.sh [session_id]
> ```
> It waits until the session is idle, then restarts.

## Feishu App Setup

### 1. Create an Internal App

1. Open [Feishu Open Platform](https://open.feishu.cn/app)
2. Click **Create App** → **Create Internal App**
3. Fill in app name and description, then confirm

### 2. Enable Bot Capability

Navigate to **App Features → Bot** and enable the bot capability.

### 3. Get Credentials

Navigate to **Credentials & Basic Info** to find:

- **App ID** → set as `FEISHU_APP_ID`
- **App Secret** → set as `FEISHU_APP_SECRET`

You'll need these in Step 6 to configure opencode-lark.

### 4. Configure Permissions

Navigate to **Development Config → Permissions & Scopes** and add the following:

| Permission | Scope Identifier | Purpose | Required |
|---|---|---|---|
| 获取与发送单聊、群组消息 | `im:message` | Send messages & update cards | ✅ |
| 获取用户发给机器人的单聊消息 | `im:message.p2p_msg:readonly` | Receive direct messages | ✅ |
| 获取群组中所有消息 | `im:message.group_msg` | Receive all group messages | ✅ |
| 获取群组中 @机器人的消息 | `im:message.group_at_msg:readonly` | Receive group messages that @mention the bot | ✅ |
| 获取与上传图片或文件资源 | `im:resource` | Handle message attachments | ✅ |
| 创建并发布卡片 | `cardkit:card:write` | Render interactive cards (questions, permissions) | ✅ |

### 5. Publish the App

Navigate to **App Release → Version Management & Release**, create a version and submit for review. After approval, add the bot to your workspace.

> **Note**: Internal apps in trial status can be used by app administrators immediately without review for testing.

### 6. Configure & Start opencode-lark

Before configuring event subscriptions, start opencode-lark so Feishu can detect the WebSocket connection.

1. Install and configure:
   ```bash
   # Install globally
   bun add -g opencode-lark
   # or: npm install -g opencode-lark

   # Or run from source
   # git clone https://github.com/guazi04/opencode-lark.git
   # cd opencode-lark && bun install
   ```

2. Start opencode server in one terminal:
   ```bash
   OPENCODE_SERVER_PORT=4096 opencode serve
   ```

3. Start opencode-lark in another terminal:
   ```bash
   opencode-lark
   ```
   The interactive setup wizard will guide you through entering credentials and validating the server connection. If running from source: `bun run dev`

   Keep this running while you configure event subscriptions in the next step.

> **Tip**: To see messages in real-time in the TUI, open a third terminal and attach to the session:
> ```bash
> opencode attach http://127.0.0.1:4096 --session {session_id}
> ```
> The `session_id` is shown in opencode-lark's startup logs (e.g. `Bound to TUI session: ... → ses_xxxxx`).

### 7. Subscribe to Events

Navigate to **Development Config → Event Subscriptions** and:

1. Select **Long Connection** (WebSocket) mode — no public IP required
2. Add the following event:

| Event Name | Event Identifier | Purpose | Required |
|---|---|---|---|
| 接收消息 | `im.message.receive_v1` | Receive all user messages | ✅ |

> ⚠️ **Important**: opencode-lark must be running (Step 6) before you can save Long Connection mode. If you see "应用未建立长连接", go back to Step 6 and ensure the app is running.

### 8. Subscribe to Callbacks (Interactive Cards)

Navigate to **Development Config → Event Subscriptions → Callback Subscription** (回调订阅) — this is a **separate section** from Event Subscription above.

1. Select **Long Connection** (WebSocket) mode
2. Add the following callback:

| Callback Name | Callback Identifier | Purpose | Required |
|---|---|---|---|
| 卡片回传交互 | `card.action.trigger` | Receive card button clicks (question answers, permission replies) | ✅ |

> ⚠️ **Important**: This is required for interactive cards (questions & permissions). Without it, clicking card buttons shows error `200340`.
>
> Event Subscription and Callback Subscription are **two separate settings**. You must configure both.

### Troubleshooting

| Symptom | Likely Cause | Fix |
|---|---|---|
| Bot doesn't receive messages | WebSocket not enabled or wrong subscription | Check event subscription, ensure Long Connection mode is selected |
| "Invalid App ID or Secret" | Wrong credentials in .env | Double-check App ID and App Secret from Step 3 |
| Messages received but no reply | opencode server not running | Ensure opencode server is running: `OPENCODE_SERVER_PORT=4096 opencode serve` |
| Card not updating in real-time | Rate limit or debounce delay | Normal behavior — updates are debounced to stay within Feishu rate limits |
| Error `200340` when clicking card buttons | Callback subscription not configured | Go to **Callback Subscription** (回调订阅) → select Long Connection → add `card.action.trigger` |
| "应用未建立长连接" when saving Long Connection mode | App not running — Feishu requires an active WebSocket connection before saving | Start opencode-lark first (Step 6), then save the setting in Feishu console |

---

## Configuration

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FEISHU_APP_ID` | yes | | Feishu App ID |
| `FEISHU_APP_SECRET` | yes | | Feishu App Secret |
| `OPENCODE_SERVER_URL` | no | `http://localhost:4096` | opencode server URL (v2 serves the API under `/api`) |
| `OPENCODE_SERVER_USERNAME` | no | `opencode` | Basic-auth username for the opencode server |
| `OPENCODE_SERVER_PASSWORD` | **yes** (opencode v2) | | Basic-auth password for the opencode server. Without it the server answers `401` and opencode-lark reports the server as unreachable |
| `FEISHU_WEBHOOK_PORT` | no | `3001` | HTTP webhook fallback port (only needed if not using WebSocket for card callbacks) |
| `OPENCODE_CWD` | no | `process.cwd()` | Override session discovery directory |
| `FEISHU_VERIFICATION_TOKEN` | no | | Event subscription verification token |
| `FEISHU_ENCRYPT_KEY` | no | | Event encryption key |

### JSONC Config

`opencode-lark.jsonc` (gitignored; copy from `opencode-lark.example.jsonc`):
(also supports `opencode-feishu.jsonc` for backward compatibility)

```jsonc
// opencode-lark.jsonc
{
  "feishu": {
    "appId": "${FEISHU_APP_ID}",
    "appSecret": "${FEISHU_APP_SECRET}",
    "verificationToken": "${FEISHU_VERIFICATION_TOKEN}",
    "webhookPort": 3001,
    "encryptKey": "${FEISHU_ENCRYPT_KEY}"
  },
  // Default opencode agent name. This should match an agent configured in your opencode setup.
  // Common values: "build", "claude", "code" — check your opencode config for available agents.
  "defaultAgent": "build",
  "dataDir": "./data",
  "progress": {
    "debounceMs": 500,
    "maxDebounceMs": 3000
  },
  // The opencode server the bridge talks to. The bridge starts it when it is
  // needed and can stop it when it has been idle for a while.
  "opencode": {
    "url": "http://127.0.0.1:5096",
    "username": "opencode",
    "password": "",
    // "server": {
    //   "command": "opencode",
    //   "args": ["serve", "--port", "5096", "--hostname", "0.0.0.0"],
    //   // How long the server may sit idle before it is stopped (ms).
    //   // 0 = never (the default). /自动关闭 changes it at runtime.
    //   "idleTimeoutMs": 1800000
    // }
  },
  "messageDebounceMs": 10000,  // Debounce timer for batching rapid multi-message inputs (text=immediate, media=buffer)
  // Append a "[Lark] …" signature to the messages forwarded to opencode, so
  // the agent knows the message came from Feishu and where to put its files.
  // Off by default — turn it on while developing.
  // "larkSignature": true
}
```

Supports `${ENV_VAR}` interpolation and JSONC comments. If no config file is found, the app builds a default config from `.env` values directly.

---

## Known limitations

- **Question ("ask the user") cards are disabled on opencode v2.0.29.** That
  server exposes no `/api/question/*` endpoints and emits no question events
  (it uses `form.*` instead). opencode-lark logs one warning at startup and
  skips the card. Permission cards keep working.
- **Feishu cards cannot render GFM tables or `#` headings.** Agent output is
  rewritten before it is put on the card: tables become nested lists, headings
  become bold lines, task checkboxes and blockquotes are converted, and fenced
  code blocks are left untouched.

---

## Lark MCP Tools

opencode-lark pairs with [lark-openapi-mcp](https://github.com/larksuite/lark-openapi-mcp) to give the opencode agent direct access to Feishu's cloud document ecosystem — read/write docs, upload files, query Bitable tables, and search the wiki, all from within a single conversation.

### Supported Capabilities

| Category | Capabilities |
|----------|-------------|
| **Docs** (docx) | Create doc, write Markdown, read Markdown, get raw text content, search docs, import file as doc |
| **Drive** | Upload local file to cloud drive, download file from cloud drive |
| **Bitable** | Create Bitable app, manage tables, list fields, record CRUD |
| **Messaging** (im) | List chats the bot belongs to, get chat members |
| **Wiki** | Search wiki nodes, get node details |

### Required User Scopes

When calling tools with `user_access_token` (i.e. `useUAT: true`), enable the following scopes in **Permissions & Scopes** in the Feishu Open Platform console:

| Scope | Purpose |
|-------|---------|
| `drive:drive` | Cloud drive read/write |
| `docx:document` | Document read/write |
| `bitable:app` | Bitable CRUD |
| `im:chat:readonly` | Query chat/group info |
| `wiki:wiki:readonly` | Wiki search and read |

### Configuration

Add a `lark-mcp` entry to the `mcp` section of your opencode config (`~/.config/opencode/config.json`):

```jsonc
{
  "mcp": {
    "lark-mcp": {
      "type": "local",
      "command": ["node", "/path/to/lark-openapi-mcp/dist/cli.js", "mcp", "-a", "${FEISHU_APP_ID}", "-s", "${FEISHU_APP_SECRET}", "--oauth", "--token-mode", "user_access_token", "-l", "zh"],
      "enabled": true
    }
  }
}
```

> **Note**: Pass `--token-mode user_access_token` to call tools on behalf of a user (required for drive uploads, wiki operations, etc.). Replace `/path/to/lark-openapi-mcp` with the actual install path after cloning/installing the package.

---

## Project Structure

```
src/
├── index.ts         # Entry point, 9-phase startup + graceful shutdown
├── types.ts         # Shared type definitions
├── channel/         # ChannelPlugin interface, ChannelManager, FeishuPlugin
├── feishu/          # Feishu REST client, WebSocket, message dedup
├── handler/         # MessageHandler (inbound pipeline) + StreamingBridge (SSE → cards)
├── session/         # TUI session discovery, thread→session mapping, progress cards
├── streaming/       # EventProcessor (SSE parsing), SessionObserver, SubAgentTracker
├── cron/            # CronService (scheduled jobs) + HeartbeatService
├── utils/           # Config loader, logger, SQLite init, EventListenerMap
```

---

## Development

```bash
bun run dev          # Watch mode, auto-restart on changes
bun run start        # Production mode
bun run test:run     # Run all tests (vitest)
bun run build        # Compile TypeScript to dist/
```

> **Note:** Use `bun run test:run` rather than `bun test`. The latter picks up both `src/` and `dist/` test files; `vitest` is configured to scope to `src/` only.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines on issues, pull requests, and code style.

---

## License

[MIT](LICENSE) © 2026 opencode-lark contributors
