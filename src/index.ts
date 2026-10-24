/**
 * OhMyOpenclaw — Feishu channel integration for opencode.
 *
 * Standalone process entry point:
 *   0. Load .env + interactive setup wizard (first run)
 *   1. Load config
 *   1. Load config
 *   2. Connect to existing opencode server (createOpencodeClient)
 *   3. Initialize SQLite database
 *   4. Create shared services (session, memory, event processor, etc.)
 *   5. Create FeishuPlugin + ChannelManager
 *   6. Subscribe to opencode events (SSE)
 *   7. Route incoming messages via message handler
 *   8. Optionally start CronService + HeartbeatService
 *   9. Graceful shutdown
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import path from "node:path"
import { createOpencodeGateway } from "./opencode/gateway.js"
import { eventPayload } from "./opencode/events.js"
import { loadConfig } from "./utils/config.js"
import { initDatabase } from "./utils/db.js"
import { createLogger } from "./utils/logger.js"
import type { EventListenerMap } from "./utils/event-listeners.js"
import type { FeishuCardAction } from "./types.js"
import { createFeishuApiClient } from "./feishu/api-client.js"
import { MessageDedup } from "./feishu/message-dedup.js"
import { createSessionManager } from "./session/session-manager.js"
import { createProgressTracker } from "./session/progress-tracker.js"
import { EventProcessor } from "./streaming/event-processor.js"
import { SubAgentTracker } from "./streaming/subagent-tracker.js"
import { createMessageHandler } from "./handler/message-handler.js"
import { createStreamingBridge } from "./handler/streaming-integration.js"
import { createServerSupervisor } from "./opencode/server-supervisor.js"
import {
  closeAllStreamingCards,
  StreamingCardSession,
  type OpenCardState,
} from "./streaming/streaming-card.js"
import { createCommandHandler } from "./handler/command-handler.js"
import { ReplyModeStore } from "./handler/reply-mode.js"
import { createPendingPromptStore } from "./handler/pending-prompts.js"
import { buildUpgradeRestartResultCard } from "./handler/upgrade-card.js"
import { createOutboundMediaHandler } from "./handler/outbound-media.js"
import { createSessionObserver } from "./streaming/session-observer.js"
import { addListener, removeListener } from "./utils/event-listeners.js"
import { ExpiringSet } from "./utils/expiring-set.js"
import { createSubAgentCardHandler } from "./streaming/subagent-card.js"
import { createInteractiveHandler } from "./handler/interactive-handler.js"
import { createInteractivePoller } from "./handler/interactive-poller.js"
import { createInteractiveCardRegistry } from "./feishu/interactive-card-registry.js"
import { createFeishuGateway } from "./feishu/webhook-server.js"
import { FeishuPlugin } from "./channel/feishu/feishu-plugin.js"
import { ChannelManager } from "./channel/manager.js"
import { CronService } from "./cron/cron-service.js"
import { HeartbeatService } from "./cron/heartbeat.js"
import { loadEnvFile } from "./utils/env-loader.js"
import { needsSetup, runSetupWizard, pickConfig } from "./cli/setup-wizard.js"

const logger = createLogger("opencode-lark")

async function main(): Promise<void> {
  // ═══════════════════════════════════════════
  // Phase 0: Config Selection
  // ═══════════════════════════════════════════
  const forceInit = process.argv.includes("init")

  if (forceInit) {
    await runSetupWizard()
    process.stdout.write("\n配置完成。启动服务：systemctl --user start opencode-lark\n")
    // `init` only configures; starting the bridge is the service's job.
    process.exit(0)
  } else {
    const configPath = await pickConfig()
    if (configPath) {
      loadEnvFile(configPath)
    } else if (await needsSetup()) {
      await runSetupWizard()
    }
    // If needsSetup() is false (env vars already set externally), proceed without loading file
  }

  // ═══════════════════════════════════════════
  // Phase 1: Load Config
  // ═══════════════════════════════════════════
  logger.info("Phase 1: Loading config...")
  const config = await loadConfig()

  if (!config.feishu.appId || !config.feishu.appSecret) {
    logger.error(
      "Feishu credentials missing. Run `opencode-lark init` to configure, " +
      "or set FEISHU_APP_ID and FEISHU_APP_SECRET environment variables.",
    )
    process.exit(1)
  }

  // ═══════════════════════════════════════════
  // Phase 2: Connect to Opencode Server
  // ═══════════════════════════════════════════
  logger.info("Phase 2: Connecting to opencode server...")
  const serverUrl = (
    process.env.OPENCODE_SERVER_URL ?? "http://localhost:4096"
  ).replace("localhost", "127.0.0.1")
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode"
  const password = process.env.OPENCODE_SERVER_PASSWORD ?? ""
  if (!password) {
    logger.warn(
      "OPENCODE_SERVER_PASSWORD is not set. opencode v2 requires Basic auth; " +
        "set it in .env or run `opencode-lark init`.",
    )
  }
  logger.info(`Connecting to opencode server at ${serverUrl}`)
  const gateway = createOpencodeGateway({
    baseUrl: serverUrl,
    username,
    password,
    directory: config.opencode?.cwd || process.env.OPENCODE_CWD || process.cwd(),
    logger,
  })

  // The bridge owns the server process: it starts it when it is needed and
  // stops it when it has been idle for a while.
  const serverPort = (() => {
    try {
      return new URL(serverUrl).port || "4096"
    } catch {
      return "4096"
    }
  })()
  const supervisor = createServerSupervisor({
    command: config.opencode?.server?.command ?? "opencode",
    args:
      config.opencode?.server?.args ?? ["serve", "--port", serverPort, "--hostname", "0.0.0.0"],
    pidFile: path.join(config.dataDir, "opencode-server.pid"),
    stateFile: path.join(config.dataDir, "autostop.json"),
    // The server is not stopped automatically unless it is asked for
    // (/自动关闭 15 | 30 | 60).
    idleTimeoutMs: config.opencode?.server?.idleTimeoutMs ?? 0,
    opencode: gateway,
    logger,
  })

  /**
   * Makes sure the opencode server is running. The server is stopped while
   * it is idle, so every path that talks to it has to wake it up first.
   */
  const ensureServer = async (): Promise<void> => {
    if (await supervisor.isRunning()) return
    logger.info("The opencode server is down — starting it")
    const up = await supervisor.ensureRunning()
    if (!up) {
      logger.warn("The opencode server could not be started")
    }
  }

  // The server may be down (it was stopped while idle) — start it instead of
  // giving up. A failure here is not fatal: the supervisor retries when the
  // first message arrives.
  const serverReady = await supervisor.ensureRunning()
  if (serverReady) {
    logger.info("Opencode server ready")
  } else {
    logger.warn("The opencode server is not answering — it will be started on demand")
  }
  // Warm the model limits, so the first card of the first turn already knows
  // the context window of the model.
  void gateway.warmModelLimits().catch(() => {})

  // ═══════════════════════════════════════════
  // Phase 3: Database Init
  // ═══════════════════════════════════════════
  logger.info("Phase 3: Initializing database...")
  const db = initDatabase(config.dataDir)

  // ═══════════════════════════════════════════
  // Phase 4: Create Shared Services
  // ═══════════════════════════════════════════
  logger.info("Phase 4: Creating shared services...")

  const feishuClient = createFeishuApiClient({
    appId: config.feishu.appId,
    appSecret: config.feishu.appSecret,
  })

  // Fetch bot's own open_id for @mention filtering in group chats
  let botOpenId: string | undefined
  try {
    const botInfo = await feishuClient.getBotInfo()
    botOpenId = botInfo.open_id || undefined
    logger.info(`Bot identity: ${botInfo.app_name} (${botInfo.open_id})`)
  } catch (err) {
    logger.warn(`Failed to fetch bot info — group @mention filtering disabled: ${err}`)
  }

  // The restart script is killed together with the old service's cgroup, so it
  // can only announce the *start* of a restart. The marker it leaves behind is
  // the new process's cue to post the "done" half.
  const restartMarker = path.join(config.dataDir, "restart-pending.json")
  if (existsSync(restartMarker)) {
    try {
      const pending = JSON.parse(readFileSync(restartMarker, "utf-8")) as {
        chatId?: unknown
        startedAt?: unknown
      }
      rmSync(restartMarker, { force: true })
      if (typeof pending.chatId === "string" && pending.chatId) {
        const seconds =
          typeof pending.startedAt === "number"
            ? Math.max(0, Math.round((Date.now() - pending.startedAt) / 1000))
            : undefined
        feishuClient
          .sendMessage(pending.chatId, {
            msg_type: "text",
            content: JSON.stringify({
              text: `✅ opencode-lark 已重启完成${seconds !== undefined ? `（${seconds}s）` : ""}`,
            }),
          })
          .catch((err) => logger.warn(`Could not announce the restart: ${err}`))
      }
    } catch (err) {
      logger.warn(`Could not read the restart marker: ${err}`)
    }
  }


  const sessionManager = createSessionManager({
    opencode: gateway,
    db: db.sessions,
    defaultAgent: config.defaultAgent,
  })

  // Validate stored session mappings against the running opencode server
  logger.info("Phase 4b: Validating stored session mappings...")
  try {
    const cleaned = await sessionManager.validateAndCleanupStale()
    if (cleaned > 0) {
      logger.info(`Phase 4b: Removed ${cleaned} stale session mapping(s)`)
    }
  } catch (err) {
    logger.warn(`Phase 4b: Session mapping validation failed (non-fatal): ${err}`)
  }


  const dedup = new MessageDedup({ db: db.sessions, ttlMs: 60_000 })

  const progressTracker = createProgressTracker({ feishuClient })

  const ownedSessions = new Set<string>()
  const eventListeners: EventListenerMap = new Map()
  const seenInteractiveIds = new ExpiringSet<string>(30 * 60 * 1000, 2 * 60 * 1000)
  const interactiveCardRegistry = createInteractiveCardRegistry()

  const eventProcessor = new EventProcessor({ ownedSessions, logger })

  const subAgentTracker = new SubAgentTracker({ opencode: gateway })

  const outboundMedia = createOutboundMediaHandler({
    feishuClient,
    logger,
  })

  const cardStateFile = path.join(config.dataDir, "open-card.json")
  logger.info(`Open card state file: ${path.resolve(cardStateFile)}`)
  const replyModes = new ReplyModeStore(path.join(config.dataDir, "reply-mode.json"))
  const pendingPrompts = createPendingPromptStore()

  // A card left open by a previous process (crash, restart) would stay on
  // "running" for ever: close it before starting a new one. The state file
  // remembers the answer, so the card keeps its text and only the status
  // line says that the turn was interrupted.
  try {
    if (existsSync(cardStateFile)) {
      const stale = JSON.parse(readFileSync(cardStateFile, "utf-8")) as unknown
      const openCards: Record<string, OpenCardState> = {}
      if (stale && typeof stale === "object" && !Array.isArray(stale)) {
        for (const [chatId, value] of Object.entries(stale as Record<string, unknown>)) {
          if (typeof value === "string") {
            openCards[chatId] = { messageId: value }
            continue
          }
          const entry = value as Partial<OpenCardState> | null
          if (entry && typeof entry.messageId === "string") {
            openCards[chatId] = entry as OpenCardState
          }
        }
      }
      for (const [chatId, state] of Object.entries(openCards)) {
        const card = StreamingCardSession.restore({
          feishuClient,
          chatId,
          stateFile: cardStateFile,
          state,
        })
        await card.close(undefined, "interrupted")
        logger.info(
          `Closed the card left open by the previous process: ${state.messageId} (chat ${chatId})`,
        )
      }
      rmSync(cardStateFile, { force: true })
    }
  } catch (err) {
    logger.warn(`Failed to close a stale card: ${err}`)
  }

  const observer = createSessionObserver({
    feishuClient,
    eventProcessor,
    addListener: (sessionId, fn) => addListener(eventListeners, sessionId, fn),
    removeListener: (sessionId, fn) => removeListener(eventListeners, sessionId, fn),
    logger,
    seenInteractiveIds,
    interactiveCardRegistry,
  })

  // The bridge tells the observer which turns it delivers itself, so the same
  // answer is never posted twice (once as the live card, once as a static
  // copy without the status line).
  const streamingBridge = createStreamingBridge({
    opencode: gateway,
    cardStateFile,
    feishuClient,
    subAgentTracker,
    logger,
    seenInteractiveIds,
    interactiveCardRegistry,
    outboundMedia,
    observer,
    replyMode: (chatId) => replyModes.get(chatId),
  })


  const commandHandler = createCommandHandler({
    opencode: gateway,
    sessionManager,
    feishuClient,
    logger,
    // opencode's own commands are run through the bridge, so their answer
    // is streamed into a card like a normal message.
    streamingBridge,
    eventListeners,
    eventProcessor,
    ensureServer,
    supervisor,
    replyModes,
  })

  const { handleMessage, dispose: disposeDebouncer } = createMessageHandler({
    opencode: gateway,
    sessionManager,
    dedup,
    eventProcessor,
    feishuClient,
    progressTracker,
    eventListeners,
    ownedSessions,
    logger,
    streamingBridge,
    observer,
    commandHandler,
    botOpenId,
    outboundMedia,
    debounceMs: config.messageDebounceMs,
    ensureServer,
    larkSignature: config.larkSignature,
    pendingPrompts,
    onChatSeen: (chatId) => {
      try {
        writeFileSync(
          path.join(config.dataDir, "notify-chat.json"),
          JSON.stringify({ chatId }),
        )
      } catch (err) {
        logger.warn(`Could not remember the notify chat: ${err}`)
      }
    },
  })

  // Create card action handlers
  const subAgentCardHandler = createSubAgentCardHandler({
    subAgentTracker,
    feishuClient,
    logger,
  })

  const interactiveHandler = createInteractiveHandler({
    opencode: gateway,
    logger,
    interactiveCardRegistry,
    feishuClient,
  })

  const interactivePoller = createInteractivePoller({
    opencode: gateway,
    feishuClient,
    logger,
    getChatForSession: (sessionId) => observer.getChatForSession(sessionId),
    seenInteractiveIds,
    interactiveCardRegistry,
  })
  interactivePoller.start()

  const handleCardAction = async (action: FeishuCardAction) => {
    const actionType = action.action?.value?.action
    if (actionType === "view_subagent") {
      return subAgentCardHandler(action)
    }
    if (
      actionType === "question_answer" ||
      actionType === "permission_reply" ||
      actionType === "form_submit"
    ) {
      return interactiveHandler(action)
    }
    if (actionType === "opencode_restart") {
      const choice = action.action?.value?.choice
      const version = String(action.action?.value?.version ?? "")
      const messageId = action.open_message_id
      // The callback has already returned a toast; the card is patched once
      // the server is up (or immediately, for "later").
      void (async () => {
        try {
          if (choice === "later") {
            await feishuClient.updateMessage(
              messageId,
              JSON.stringify(buildUpgradeRestartResultCard("later", version)),
            )
            return
          }
          // The upgrade already stopped the old process; start the new one
          // unless a later message already did.
          const up = (await supervisor.isRunning()) || (await supervisor.ensureRunning())
          await feishuClient.updateMessage(
            messageId,
            JSON.stringify(buildUpgradeRestartResultCard(up ? "now" : "failed", version)),
          )
        } catch (err) {
          logger.warn(`Could not restart opencode after the update: ${err}`)
        }
      })()
      return
    }
    if (actionType === "pending_prompt") {
      const pendingId = action.action.value.pendingId
      const rawChoice = action.action.value.choice
      if (!pendingId) return
      const pending = pendingPrompts.take(pendingId)
      if (!pending) {
        logger.warn("The pending prompt expired before the choice arrived")
        return
      }
      // Old cards carried `steer`; it now means "send after this turn".
      const choice = rawChoice === "steer" ? "queue" : rawChoice
      if (choice === "queue" || choice === "interrupt" || choice === "cancel") {
        void pending.onChoose(choice).catch((err) =>
          logger.warn(`Pending prompt delivery failed: ${err}`),
        )
      }
      return
    }
    // A button that carries a menu id navigates inside the card it was drawn
    // on — the card is patched in place, never replaced by a new message.
    const menuId = action.action?.value?.menu
    if (menuId) {
      const cmd = action.action?.value?.command
      if (cmd) {
        await commandHandler(
          action.open_chat_id,
          action.open_chat_id,
          action.open_message_id,
          cmd,
          { menuId },
        )
      }
      return
    }
    if (actionType === "command_execute") {
      const cmd = action.action?.value?.command
      if (cmd) {
        const chatId = action.open_chat_id
        const messageId = action.open_message_id
        // For card callbacks, use chatId as feishuKey (best-effort for p2p)
        await commandHandler(chatId, chatId, messageId, cmd)
      }
      return
    }
    logger.warn(`Unknown card action type: ${actionType}`)
  }

  // Stop the server when it has been idle for a while — it holds several
  // hundred megabytes and the sessions live in the database. The switch
  // (/自动关闭) can turn this off.
  supervisor.startIdleWatch()

  // ═══════════════════════════════════════════
  // Phase 5: Subscribe to Opencode Events (SSE)
  // ═══════════════════════════════════════════
  logger.info("Phase 5: Subscribing to opencode events...")

  const sseAbort = new AbortController()
  ;(async () => {
    // The server can be stopped while it is idle and started again on
    // demand, so the subscription has to survive a disconnect: without a
    // reconnect the bridge would never see another event.
    while (!sseAbort.signal.aborted) {
      try {
        logger.info("SSE event stream connected")
        for await (const event of gateway.subscribeEvents(sseAbort.signal)) {
          const eventType = event?.type
          const payload = eventPayload(event)
          const sessionID =
            (typeof payload?.sessionID === "string" ? payload.sessionID : undefined) ??
            (payload?.part && typeof payload.part === "object"
              ? (payload.part as Record<string, unknown>).sessionID
              : undefined)
          if (eventType) {
            logger.debug(`SSE: ${eventType} session=${sessionID ?? "n/a"}`)
          }

          // Targeted dispatch: send only to matching session's listeners
          if (sessionID && typeof sessionID === "string") {
            const listeners = eventListeners.get(sessionID)
            if (listeners) {
              for (const listener of listeners) {
                try {
                  listener(event)
                } catch (err) {
                  logger.warn(`Event listener for ${sessionID} threw: ${err}`)
                }
              }
            }
          } else {
            // No sessionID — broadcast to all (fallback for non-session events)
            for (const [key, listeners] of eventListeners.entries()) {
              for (const listener of listeners) {
                try {
                  listener(event)
                } catch (err) {
                  logger.warn(`Event listener for ${key} threw: ${err}`)
                }
              }
            }
          }
        }
        logger.warn("SSE event stream ended")
      } catch (err) {
        logger.warn(`SSE subscription failed: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (sseAbort.signal.aborted) break
      // Wait for the server to be back — it may have been stopped while it
      // was idle, and it is started again when a message arrives.
      await supervisor.whenRunning().catch(() => {})
      await new Promise((r) => setTimeout(r, 250))
    }
  })()

  // ═══════════════════════════════════════════
  // Phase 6: Create FeishuPlugin + ChannelManager
  // ═══════════════════════════════════════════
  logger.info("Phase 6: Creating channel manager...")

  const feishuPlugin = new FeishuPlugin({
    appConfig: config,
    feishuClient,
    logger,
    onMessage: handleMessage,
    onCardAction: handleCardAction,
  })

  const channelManager = new ChannelManager({ logger })
  channelManager.register(feishuPlugin)

  // ═══════════════════════════════════════════
  // Phase 7: Start Channels + Webhook Server
  // ═══════════════════════════════════════════
  logger.info("Phase 7: Starting channels...")

  const abortController = new AbortController()
  await channelManager.startAll(abortController.signal)

  // Start webhook server for card action callbacks
  logger.info("Phase 7b: Starting webhook server for card actions...")
  const webhookPort = parseInt(process.env.FEISHU_WEBHOOK_PORT ?? "3001", 10)
  const webhookServer = await createFeishuGateway({
    port: webhookPort,
    verificationToken: config.feishu.verificationToken ?? "",
    onMessage: handleMessage,
    onCardAction: handleCardAction,
    dedup,
  })
  logger.info(`Webhook server started on port ${webhookPort}`)

  // ═══════════════════════════════════════════
  // Phase 8: Optional Services (Cron + Heartbeat)
  // ═══════════════════════════════════════════
  let cronService: CronService | undefined
  let heartbeatService: HeartbeatService | undefined

  if (config.cron) {
    logger.info("Starting cron service...")
    cronService = new CronService({
      config: config.cron,
      sessionManager,
      feishuClient,
      opencode: gateway,
      logger,
      ensureServer,
    })
    cronService.start()
  }

  if (config.heartbeat) {
    logger.info("Starting heartbeat service...")
    heartbeatService = new HeartbeatService({
      intervalMs: config.heartbeat.intervalMs,
      opencode: gateway,
      feishuClient,
      statusChatId: config.heartbeat.statusChatId,
      logger,
      // A server that was stopped for being idle is not a failure.
      isServerExpectedDown: () => supervisor.isStoppedOnPurpose(),
    })
    heartbeatService.start()
  }

  // ═══════════════════════════════════════════
  // Graceful Shutdown
  // ═══════════════════════════════════════════
  function shutdown(signal: string) {
    return async () => {
      logger.info(`${signal} received, shutting down...`)
      // Close the open cards FIRST: their final update is the only thing
      // that would be lost if the process disappears right now. (The state
      // file keeps a card listed until its final update landed, so a
      // failed update is picked up by the next process.)
      const closed = await closeAllStreamingCards("interrupted", {
        feishuClient,
        stateFile: cardStateFile,
      })
      logger.info(`Closed ${closed} open card(s)`)
      supervisor.stopIdleWatch()
      // The idle watch dies with the process, so the server is stopped here
      // when nothing is running — unless a session is still in flight.
      try {
        const active = await gateway.activeStatuses()
        if (Object.keys(active).length === 0) {
          await supervisor.stop()
        } else {
          logger.info("Leaving the opencode server running — a session is still active")
        }
      } catch (err) {
        logger.warn(`Could not check whether the server is idle: ${err}`)
      }
      abortController.abort()
      sseAbort.abort()
      await channelManager.stopAll()
      await webhookServer.close()
      cronService?.stop()
      heartbeatService?.stop()
      interactivePoller.stop()
      observer.stop()
      disposeDebouncer()
      subAgentTracker.close()
      interactiveCardRegistry.close()
      seenInteractiveIds.close()
      dedup.close()
      db.close()
      process.exit(0)
    }
  }

  process.on("SIGTERM", shutdown("SIGTERM"))
  process.on("SIGINT", shutdown("SIGINT"))

  logger.info("OhMyOpenclaw started — channels active")
}

main().catch((err) => {
  logger.error("Fatal error:", err)
  process.exit(1)
})
