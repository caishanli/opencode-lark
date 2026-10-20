# streaming/

Parses the raw SSE stream from opencode and distributes typed events to whoever needs them. Both `streaming-card.ts` and `session-observer.ts` send messages and cards to Feishu via the `FeishuApiClient`.

## Files

### `event-processor.ts`
Parses raw SSE event objects (dispatched by `src/index.ts`) into typed action objects. It does **not** own the SSE connection — `src/index.ts` subscribes to the opencode event stream and dispatches events to per-session listeners via `EventListenerMap`. `EventProcessor.processEvent(raw)` converts a raw event into one of the following typed actions:

| Action | Meaning |
|---|---|
| `TextDelta` | A chunk of text from the agent |
| `SessionIdle` | The agent finished responding |
| `ToolStateChange` | A tool call's state changed (running, completed, error) |
| `SubtaskDiscovered` | A sub-agent task was spawned |
| `QuestionAsked` | The agent is asking the user a question |
| `PermissionRequested` | The agent is requesting permission (file edit, bash, etc.) |

`EventProcessor` is a stateful class (tracks `ownedSessions` and reasoning part IDs) but does not manage any connections or listeners itself.

### `session-observer.ts`
Manages per-session observation for forwarding TUI-initiated events to Feishu. Key API: `observe(sessionId, chatId)` registers a listener for a session, `markOwned(messageId)` marks a Feishu-initiated message to skip during forwarding, `markSessionBusy(sessionId)` / `markSessionFree(sessionId)` controls whether TextDelta/SessionIdle are forwarded (suppressed during active streaming bridge), `getChatForSession(sessionId)` returns the associated chat, and `stop()` cleans up all listeners.

Also handles a secondary path: if a message was sent from the opencode TUI directly (not via Feishu), `SessionObserver` can still forward the resulting events to any active Feishu listener for that session.

### `streaming-card.ts`
Builds and manages the live Feishu reply card during a session. The card is a normal interactive message updated in place (`PATCH /im/v1/messages/{id}`) — not a CardKit card. Its body is a chronological list of blocks: text runs and tool panels (`collapsible_panel` with the call count in the header). Uses queue-based update serialization (not debouncing). Key methods: `start()` creates the card message, `setText(fullText)` updates the current text block, `setToolStatus(name, state, title?, callId?)` records a tool call, `addSubtaskButton(label, actionValue)` adds sub-agent links, and `close(finalText?)` writes the final content.

## Design notes

The split between `EventProcessor` (parses events, stateful but passive) and `SessionObserver` (routes to Feishu chats, manages busy/free state) keeps concerns clean. If you want to add a new consumer of SSE events, register a listener in `EventListenerMap` from `src/index.ts`. If you want to react to TUI-initiated events for a specific session, use `SessionObserver.observe()`.

## Gotchas

- **A turn is a sequence of steps.** Measured on opencode v2.0.32:
  ```
  session.step.started → session.text.* → session.step.ended (finish:"tool-calls")
    → session.usage.updated → session.step.started → … → session.step.ended (finish:"stop")
    → session.usage.updated → session.execution.succeeded
  ```
  - `session.usage.updated` fires **after every step** — it is *not* a turn
    boundary. Using it to close the card cut replies off after the first tool
    call (the card showed "✅ 已完成" with a fraction of the answer).
  - The turn ends with **`session.execution.succeeded`** (it does exist on
    v2.0.32). `session.idle` is never emitted for a normal turn.
- **All deltas of one step share a single `assistantMessageID`.** Filtering
  text by "have I seen this id?" therefore drops every delta but the first.
  Leftover text from an earlier execution must be detected against a
  *per-turn* set, not against the ids seen so far.
- `SessionIdle` fires once per agent turn, not once per session lifetime. Multiple idle events are expected in a long conversation.
- **The session observer and the streaming bridge see the same events.** The
  observer forwards text the bridge already delivered as a second, static
  card (no status line → no tok/s). The bridge therefore *claims* the session
  and every assistant message id it sees; the observer must stay silent for
  claimed sessions.
- The content of an interactive card **cannot be read back** through the
  Feishu API (it returns a "please upgrade your client" placeholder). Verify
  card content with `scripts/feishu-card-selftest.ts` (real API, real bridge)
  and `scripts/check-chat-cards.ts` (a card that was never updated is a
  static duplicate).
- **A card that outlives its process is restored, not wiped.** The open-card
  state file (`data/open-card.json`) remembers the message id *and* the
  card's blocks (text runs + tool panels) + the status line, refreshed every
  two seconds while the turn runs. A process that starts up (or shuts down)
  with a card still listed rebuilds it with `StreamingCardSession.restore()`
  and closes it as "interrupted" — the answer stays on the card. Wiping the
  card to a single "interrupted" line would throw the answer away.
- `TextDelta` events can arrive very rapidly. Never write to Feishu on every delta. `streaming-card.ts` serializes updates through an async queue.
- `EventProcessor` does not manage the SSE connection. Reconnection logic lives in `src/index.ts` where the event stream is subscribed.
