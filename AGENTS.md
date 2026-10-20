# AGENTS.md — opencode-lark

Architecture guide for contributors. Covers module layout, key abstractions, data flow, and how to extend the system.

## What This Project Does

`opencode-lark` bridges Feishu group chats with opencode TUI sessions. Messages sent in Feishu flow into opencode as if typed in the terminal. Agent replies stream back to Feishu — `StreamingBridge` accumulates `TextDelta` events and updates one Feishu interactive message in place (with serialized delivery to avoid rate limits). The card body is a chronological list of blocks — text runs and tool panels — following the ZCode reference implementation.

```
Feishu client
    ↕  WebSocket (long-lived)
Feishu Open Platform
    ↕  WebSocket / Webhook
opencode-lark  (this project)
    ↕  HTTP API + SSE
opencode server  (localhost:4096)
    ↕  stdin/stdout
opencode TUI
```

---

## Module Map

```
src/
├── index.ts         Entry point, 9-phase startup + graceful shutdown
├── types.ts         Shared type definitions
├── channel/         ChannelPlugin interface, ChannelManager, FeishuPlugin
├── cli/             Setup wizard + Feishu QR onboarding (device-code flow)
├── feishu/          Feishu REST client, WebSocket, message dedup, markdown adapter
├── handler/         MessageHandler (inbound pipeline) + StreamingBridge (SSE → cards)
├── opencode/        OpencodeGateway (the only opencode access point) + event payload helper
├── session/         TUI session discovery, thread→session mapping, progress cards
├── streaming/       EventProcessor (SSE parsing), SessionObserver, SubAgentTracker
├── cron/            CronService (scheduled jobs) + HeartbeatService
└── utils/           Config loader, logger, SQLite init, EventListenerMap, paths helper
```

---

## Key Abstractions

### ChannelPlugin (`src/channel/types.ts`)

The core extension contract. Any chat platform (Slack, Discord, etc.) implements this interface to plug into `ChannelManager`.

```typescript
interface ChannelPlugin {
  id: ChannelId           // e.g. "feishu"
  meta: ChannelMeta       // label + description
  config: ChannelConfigAdapter      // list accounts, resolve credentials
  gateway?: ChannelGatewayAdapter   // start/stop connections
  messaging?: ChannelMessagingAdapter  // normalize inbound, format outbound
  outbound?: ChannelOutboundAdapter    // sendText, sendCard
  streaming?: ChannelStreamingAdapter  // createStreamingSession, coalesceUpdates
  threading?: ChannelThreadingAdapter  // resolveThread, mapSession, getSession
}
```

All adapters except `config` are optional. Implement only what your channel needs.

### OpencodeGateway (`src/opencode/gateway.ts`)

The **only** place in the codebase that talks to the opencode server. Every
consumer takes an injected `OpencodeGateway` and never builds a URL or calls
`fetch` for opencode. It wraps `@opencode-ai/sdk`'s `client.v2.*` namespace
(opencode v2 serves its API under `/api` and requires Basic auth).

```typescript
interface OpencodeGateway {
  listSessions(query?): Promise<SessionRef[]>
  getSession(id): Promise<SessionRef | null>     // null on 404
  createSession(body?): Promise<SessionRef>
  children(parentSessionID): Promise<SessionRef[]>
  messages(id, query?): Promise<any[]>
  sendPrompt(id, {text, files?}, opts?): Promise<void>
  abort(id): Promise<void>
  activeStatuses(): Promise<Record<string, {type: string}>>
  listPermissions(): Promise<PermissionRequest[]>
  replyPermission(sessionID, requestID, reply, message?): Promise<void>
  listQuestions(): Promise<QuestionRequest[]>   // 404 → []
  replyQuestion(sessionID, requestID, answers): Promise<void>
  commands(): Promise<CommandRef[]>
  subscribeEvents(signal?): AsyncIterable<OpencodeEvent>
  ping(): Promise<void>
}
```

**The SDK's own types do not match the server.** Never trust them:

- Path parameters are passed **flat** (`{ sessionID }`), not `{ path: { sessionID } }`.
- Undeclared params are **silently dropped** — use the `$body_*` / `$query_*`
  escape hatches (`$body_text`, `$body_decision`, `$query_parentID`, …).
- The SDK does **not** throw on 4xx; it returns `{ error, response }`. Every
  method must check `res.error` (see `throwIfError` / `httpStatus` in the
  gateway) or a `401` will look like "no data".
- The response is the SDK's `{ data, request, response }` wrapping the server
  body `{ data }` — so the payload is `res.data.data`.

### eventPayload (`src/opencode/events.ts`)

opencode v2 carries SSE payloads under `data`; v1 used `properties`, and the
SDK's own types are inconsistent about it. `eventPayload(event)` reads
`data ?? properties` and every event handler goes through it.

### EventProcessor (`src/streaming/event-processor.ts`)

Consumes the raw SSE stream from opencode and emits structured events: `TextDelta`, `SessionIdle`, `ToolStateChange`, `SubtaskDiscovered`, `QuestionAsked`, `PermissionRequested`. Other services subscribe via `EventListenerMap`.

### SessionManager (`src/session/session-manager.ts`)

Discovers live opencode TUI sessions for a working directory. Binds a Feishu thread key (chat ID + thread ID) to a specific session ID, persisting the mapping in SQLite so it survives restarts.

### StreamingBridge (`src/handler/streaming-integration.ts`)

Buffers `TextDelta` events and updates a single Feishu interactive message in place (serialized to avoid rate limits). The card body is a chronological list of blocks: a text run becomes a markdown element, a run of tool calls becomes a `collapsible_panel` whose header carries the count (`🛠️ 工具 (3)`) and whose body lists one line per call. The card is closed **with** the final text when `SessionIdle` fires — no separate reply card is posted.

---

## Data Flow

### Inbound (Feishu → opencode)

```
Feishu WebSocket
  → FeishuPlugin.gateway.startAccount()
    → raw event received
      → ChannelMessagingAdapter.normalizeInbound()
        → MessageHandler
          1. MessageDedup: skip if already seen
          2. SessionManager: resolve or discover session
          3. Inject Lark context signature (first message per session)
          4. gateway.sendPrompt(sessionID, { text, files })
          5. Register SSE listener for this session
          6. ProgressTracker: show "thinking..." reaction/card in Feishu

### Outbound (opencode → Feishu)

```
opencode SSE stream (/api/event)
  → gateway.subscribeEvents() → EventProcessor: parse raw event → typed event
    → SessionObserver: fan-out to registered listeners
      → StreamingBridge
          TextDelta  → accumulate text, queued in-place card update (throttled)
          ToolStateChange → per-call status line + grouped count summary
          SessionIdle → close the card WITH the final text
```
---

## Startup Phases (`src/index.ts`)

1. Load config (`opencode-lark.jsonc` or env vars)
2. Connect to opencode server (construct `OpencodeGateway`, exponential-backoff retry via `gateway.ping()`, max 10 attempts)
3. Init SQLite database
4. Create shared services (SessionManager, EventProcessor, StreamingBridge)
5. Subscribe to opencode SSE event stream (`gateway.subscribeEvents(signal)`)
6. Instantiate FeishuPlugin + register with ChannelManager
7. Start channels (WebSocket) + webhook server (card action callbacks)
8. Start optional CronService + HeartbeatService
9. Register SIGTERM/SIGINT handlers for graceful shutdown
---

## Gotchas

- **The opencode event names are not what the SDK claims.** On v2.0.29+ the real
  ones are `session.text.delta`, `session.tool.input.started`,
  `session.tool.called`, `session.tool.success/failed` and
  `session.execution.succeeded/failed/interrupted`. The SDK's `session.next.*`
  names do **not** occur in the server binary. The server also does not emit
  `session.idle` at the end of a normal turn — `session.execution.succeeded` is
  the turn-end signal, and `EventProcessor` maps it to `SessionIdle`.
- **A turn is many steps, and `session.usage.updated` fires per step.** It is
  *not* the turn boundary — closing the card on it truncates the reply after
  the first tool call. Close on `session.execution.succeeded`. See
  `src/streaming/AGENTS.md` for the measured event sequence.
- **Tool call ids live in `data.id`, the tool name in `data.name`** (only on
  `session.tool.input.started`). `session.tool.called` carries no tool name.
- **Feishu card markdown cannot render tables or `#` headings.**
  `toFeishuMarkdown()` (`src/feishu/markdown.ts`) rewrites agent output before
  it goes on a card.
- **The SDK does not throw on 4xx.** A wrong `OPENCODE_SERVER_PASSWORD` looks
  like "the server returned no data" unless the gateway checks `res.error`.
- **opencode v2.0.29 has no question endpoints** (`/api/question/*` → 404) and
  no question events; the question card is disabled and one warning is logged.
- **`bun` may not be on `PATH`.** The npm scripts go through `scripts/run.sh`,
  which resolves bun from `~/.bun/bin` as a fallback.
---

## Extension Points

### Adding a New Channel

1. Create `src/channel/{platform}/` directory.
2. Implement `ChannelPlugin` from `src/channel/types.ts`. Start with `config` (required), then add `gateway`, `messaging`, `outbound` as needed.
3. In `src/index.ts` Phase 6, instantiate your plugin and call `channelManager.register(yourPlugin)`.
4. `ChannelManager.startAll()` will call `gateway.startAccount()` for each configured account automatically.
### Adding a Cron Job


1. Open `src/cron/cron-service.ts`.
2. Add your job definition to the cron config schema in `src/types.ts`.
3. Register the new job inside `CronService.start()` with a cron expression and handler function.
4. Enable it in `opencode-lark.jsonc` under the `cron` key.

### Adding a Heartbeat Check

`src/cron/heartbeat.ts` pings the opencode server and optionally posts a status message to a Feishu chat. Extend `HeartbeatService` to check additional endpoints or post richer status cards via `FeishuApiClient`.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `FEISHU_APP_ID` | yes | | Feishu App ID |
| `FEISHU_APP_SECRET` | yes | | Feishu App Secret |
| `OPENCODE_SERVER_URL` | no | `http://localhost:4096` | opencode server URL (v2 serves the API under `/api`) |
| `OPENCODE_SERVER_USERNAME` | no | `opencode` | Basic-auth username for the opencode server |
| `OPENCODE_SERVER_PASSWORD` | yes (opencode v2) | | Basic-auth password for the opencode server |
| `FEISHU_WEBHOOK_PORT` | no | `3001` | Card action callback port |
| `OPENCODE_CWD` | no | `process.cwd()` | Override session discovery directory |

See `.env.example` and `opencode-lark.example.jsonc` for full reference.
