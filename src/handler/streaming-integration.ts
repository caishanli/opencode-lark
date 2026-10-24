
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { SubAgentTracker } from "../streaming/subagent-tracker.js"
import type { Logger } from "../utils/logger.js"
import type { EventProcessor } from "../streaming/event-processor.js"
import type { QuestionAsked, PermissionRequested } from "../streaming/event-processor.js"
import type { EventListenerMap } from "../utils/event-listeners.js"
import { addListener, removeListener } from "../utils/event-listeners.js"
import { StreamingCardSession } from "../streaming/streaming-card.js"
import { toFeishuMarkdown } from "../feishu/markdown.js"
import { cacheHitRate, formatPercent, formatRate, formatTokens, totalTokens } from "../streaming/usage.js"
import type { OpencodeGateway } from "../opencode/gateway.js"
import type { OutboundMediaHandler } from "./outbound-media.js"
import type { ExpiringSet } from "../utils/expiring-set.js"
import type { InteractiveCardRegistry } from "../feishu/interactive-card-registry.js"
import {
  extractFeishuMessageId,
  interactiveCardKey,
} from "../feishu/interactive-card-registry.js"

// ── Types ──

export interface StreamingBridgeDeps {
  /** Used to read the session's cumulative usage before the turn, so the turn's
   *  own usage delta can be computed. */
  opencode?: OpencodeGateway
  /** How long a turn may stay silent before the card is closed anyway. */
  idleCloseMs?: number
  /** Where the open card is remembered, so a restarted process can close it. */
  cardStateFile?: string
  /** The session observer — told which turns the bridge delivers itself, so
   *  it does not forward the same answer a second time as a static card. */
  observer?: {
    markOwned(messageId: string): void
    claimSession?(sessionId: string): void
  }
  feishuClient: FeishuApiClient
  subAgentTracker: SubAgentTracker
  logger: Logger
  seenInteractiveIds: ExpiringSet<string>
  interactiveCardRegistry?: InteractiveCardRegistry
  outboundMedia?: OutboundMediaHandler
  /** The reply detail for this chat (`/回复`) — concise hides the tool panels
   *  and the status line. */
  replyMode?: (chatId: string) => "standard" | "concise"
}

export interface StreamingBridge {
  handleMessage(
    chatId: string,
    sessionId: string,
    eventListeners: EventListenerMap,
    eventProcessor: EventProcessor,
    sendMessage: () => Promise<string>,
    onComplete: (text: string) => void,
    messageId: string,
    reactionId: string | null,
  ): Promise<void>
}

// ── Constants ──


const FIRST_EVENT_TIMEOUT_MS = 5 * 60 * 1_000 // 5 minutes — long tasks may take minutes before first SSE event
const IDLE_CLOSE_MS = 120_000 // close a card whose turn-end event never arrived

// ── Factory ──

export function createStreamingBridge(
  deps: StreamingBridgeDeps,
): StreamingBridge {
  const { feishuClient, subAgentTracker, logger, seenInteractiveIds } = deps
  /** In-flight turn per chat, so turns never overlap for the same conversation. */
  const chatTurns = new Map<string, Promise<void>>()
  /**
   * Assistant message ids whose text was already delivered in some turn. An
   * execution that was still running when the next message arrived keeps
   * emitting events; its text would otherwise be appended to the new turn's
   * card (the reply shows up twice).
   *
   * This set holds ids from ALL turns — the per-turn set below decides
   * whether a delta continues the current turn's text or is a leftover.
   */
  const deliveredAssistantMessageIds = new Set<string>()
  const idleCloseMs = deps.idleCloseMs ?? IDLE_CLOSE_MS

  async function runTurn(
    chatId: string,
    sessionId: string,
    eventListeners: EventListenerMap,
    eventProcessor: EventProcessor,
    sendMessage: () => Promise<string>,
    onComplete: (text: string) => void,
    messageId: string,
    reactionId: string | null,
  ): Promise<void> {
    let card: StreamingCardSession | null = null
    let cardStartPromise: Promise<void> | null = null
    /** When this turn started, for the token rate. */
    // The turn starts when the message is handed to opencode — the total
    // duration covers everything, not just the model time.
    let turnStartedAt = Date.now()
    /** The session's cumulative usage before this turn. opencode reports usage
     *  cumulatively for the whole session, so the turn's own usage is the
     *  difference between the end-of-turn total and this baseline. */
    let usageBaseline = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    // The previous cumulative usage report. opencode reports the usage after
    // every STEP, so the difference between two reports is one step — and
    // the context of the last step is the size of the context window right
    // now. Summing the whole turn instead would count the context once per
    // step and report far more tokens than the model can even hold.
    let previousUsage: typeof usageBaseline | null = null
    /** Time actually spent in model calls (step.started -> step.ended). Tool
     *  time between steps is NOT part of it. */
    let llmMs = 0
    // The model of this turn and its context window — the card shows how
    // much of the window is in use.
    let turnModel: { id: string; providerID: string } | undefined
    let turnContextLimit: number | undefined
    let lastUsage: {
      context: number
      /** Every token the turn consumed: input + cache + output + reasoning. */
      total: number
      /** Every token the session consumed since it was created. */
      sessionTotal: number
      rate: number
      hit: string
      cost: string
      turnMs: number
      /** How many times the agent wrote in this turn. */
      rounds: number
      /** How many model calls the turn took. */
      steps: number
    } | null = null

    /**
     * The status line: how much was generated, how fast, how much of the
     * context window is in use.
     */
    const usageLine = (): string | null => {
      if (!lastUsage) return null
      const { context, total, sessionTotal, rate, hit, cost, turnMs, rounds, steps } = lastUsage
      // Same shorthand as the opencode status bar: a clock for time, a
      // database for the stored (session) tokens — and a spelled-out label
      // for the cache, because any icon there just invited a guess.
      const hitPart = ` · hit ${hit}%`
      const timePart = turnMs > 0 ? `⏱ ${(turnMs / 1000).toFixed(1)}s · ` : ""
      const limit = turnContextLimit
      const used =
        limit && limit > 0 && context > 0 ? ` (${formatPercent(context / limit)}%)` : ""
      const contextPart = context > 0 ? ` · ctx ${formatTokens(context)}${used}` : ""
      // What the whole session has consumed so far — labelled 总, because the
      // turn's own total above is only a part of it.
      const sessionPart = sessionTotal > 0 ? ` · 总 ${formatTokens(sessionTotal)} tok` : ""
      // How much work the agent did: the rounds it wrote in and the model
      // calls it took.
      const workPart = steps > 0 ? `${rounds} 轮 ${steps} 步 · ` : ""
      return (
        `${timePart}${workPart}${formatTokens(total)} tok${hitPart} · ` +
        `${formatRate(rate)} tok/s${contextPart}${sessionPart}${cost}`
      )
    }
    let stepStartedAt = 0
    /** How many model calls this turn took. */
    let stepCount = 0

    const ensureCard = (): void => {
      if (card || cardStartPromise) return
      card = new StreamingCardSession({
        feishuClient,
        chatId,
        stateFile: deps.cardStateFile,
        concise: deps.replyMode?.(chatId) === "concise",
      })
      cardStartPromise = card.start().then(() => {
        logger.info(
          `Streaming card started for session ${sessionId} in chat ${chatId} (cardId=${card!.id})`,
        )
      })
    }

    // The bridge owns this session from now on: the observer must not post a
    // second copy of the answer.
    deps.observer?.claimSession?.(sessionId)

    // Assistant message ids whose text belongs to THIS turn. A delta of one
    // of them is a continuation, not a leftover from an earlier execution.
    const turnAssistantMessageIds = new Set<string>()

    return new Promise<void>((resolve, reject) => {
      let textBuffer = ""
      let gotFirstEvent = false
      let settled = false
      let idleTimer: ReturnType<typeof setTimeout> | null = null
      let syncResponseBody = ""
      const clearReaction = async (): Promise<void> => {
        if (!reactionId) return
        try {
          await feishuClient.deleteReaction(messageId, reactionId)
        } catch (err) {
          logger.warn(`deleteReaction failed: ${err}`)
        }
      }
      const sendFinalResponse = async (text: string): Promise<void> => {
        const card = buildFinalResponseCard(text)
        await feishuClient.replyMessage(messageId, {
          msg_type: "interactive",
          content: JSON.stringify(card),
        })
        await clearReaction()
      }

      /**
       * The card only has a message id once start() resolved, so any card
       * write has to wait for it — otherwise it is silently dropped.
       */
      const writeToCard = (fn: (c: StreamingCardSession) => void): void => {
        if (!card) return
        const started = cardStartPromise ?? Promise.resolve()
        void started.then(() => fn(card!)).catch(() => {})
      }

      const publishUsage = (): void => {
        const line = usageLine()
        if (line) writeToCard((c) => void c.setUsage(line))
      }

      const TEXT_PUSH_INTERVAL_MS = 350
      let lastTextPush = 0
      let textPushTimer: ReturnType<typeof setTimeout> | null = null
      /** Tools currently running. A silent turn with one is not a dead turn:
       *  a long command emits no events until it finishes. */
      const runningToolIds = new Set<string>()
      let toolWaitMs = 0
      /** Even a wedged tool must not pin the card for ever. */
      const MAX_TOOL_WAIT_MS = 30 * 60_000

      const armIdleTimer = (): void => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          if (settled) return
          if (runningToolIds.size > 0 && toolWaitMs < MAX_TOOL_WAIT_MS) {
            toolWaitMs += idleCloseMs
            logger.info(
              `No events for ${idleCloseMs}ms, but ${runningToolIds.size} tool(s) still running — waiting`,
            )
            armIdleTimer()
            return
          }
          logger.warn(
            `No opencode events for ${idleCloseMs}ms — closing the card as interrupted`,
          )
          // The turn did not report an end: mark it interrupted, not
          // succeeded, so the status line tells the truth.
          myListener({
            type: "session.execution.interrupted",
            data: { sessionID: sessionId, reason: "inactivity" },
          })
        }, idleCloseMs)
        idleTimer.unref?.()
      }

      /** Push the accumulated agent text onto the card, throttled to avoid rate limits. */
      const pushText = (force = false): void => {
        if (!card || !cardStartPromise) return
        const flush = () => {
          textPushTimer = null
          lastTextPush = Date.now()
          cardStartPromise!
            .then(() => card!.setText(textBuffer))
            .then(() => logger.info(`Card text push: ${textBuffer.length} chars`))
            .catch((err) => logger.warn(`card.setText failed: ${err}`))
        }
        const elapsed = Date.now() - lastTextPush
        if (force || elapsed >= TEXT_PUSH_INTERVAL_MS) {
          flush()
        } else if (!textPushTimer) {
          textPushTimer = setTimeout(flush, TEXT_PUSH_INTERVAL_MS - elapsed)
        }
      }

      // Named listener reference — stored for removeListener calls
      const myListener = (rawEvent: unknown): void => {
        const action = eventProcessor.processEvent(rawEvent)
        if (!action) return
        if (action.sessionId !== sessionId) return

        gotFirstEvent = true
        // Safety net: if the turn-end event never arrives (lost, or swallowed
        // by an overlapping execution) the card must not stay on "running".
        // The timer re-arms itself while a tool is running (see armIdleTimer).
        toolWaitMs = 0
        armIdleTimer()

        switch (action.type) {
          case "TextDelta": {
            // Skip text belonging to an execution that already ran (leftover
            // from a turn that was still running when this one started).
            if (action.assistantMessageId) {
              // The bridge owns this turn: tell the observer, so it never
              // forwards the same text as a second (static) card.
              deps.observer?.markOwned(action.assistantMessageId)
              // A leftover from an earlier turn (its execution was still
              // running when this turn started) must be dropped — but the
              // deltas of the CURRENT turn share one assistant message id,
              // so only ids from a PREVIOUS turn are leftovers. Without that
              // distinction every delta but the first one was dropped and
              // the card showed only the first few characters of each run.
              const alreadyDelivered = deliveredAssistantMessageIds.has(action.assistantMessageId)
              if (alreadyDelivered && !turnAssistantMessageIds.has(action.assistantMessageId)) {
                break
              }
              turnAssistantMessageIds.add(action.assistantMessageId)
              deliveredAssistantMessageIds.add(action.assistantMessageId)
            }
            if (!turnStartedAt) turnStartedAt = Date.now()
            textBuffer += action.text
            if (textBuffer.length > 102_400) {
              textBuffer = textBuffer.slice(0, 102_400) + "\n\n…(内容过长，已截断)"
            }
            // Show the reply as it is generated (throttled).
            ensureCard()
            pushText()
            // Live rate estimate from the generated text (~4 chars per token).
            const elapsed = (Date.now() - turnStartedAt) / 1000
            if (elapsed >= 1) {
              const approx = Math.ceil(textBuffer.length / 4)
              writeToCard((c) => void c.setEstimate(`≈ ${formatRate(approx / elapsed)} tok/s`))
            }
            break
          }

          case "ModelCall": {
            if (action.phase === "started") {
              stepStartedAt = Date.now()
              stepCount += 1
              if (action.model && action.model.id) {
                turnModel = action.model
                // The window limit is fetched in the background: the usage
                // event of this step may arrive before it is known.
                if (!turnContextLimit) {
                  void deps.opencode
                    ?.modelContextLimit(action.model.providerID, action.model.id)
                    .then((limit) => {
                      if (!limit) return
                      turnContextLimit = limit
                      publishUsage()
                    })
                    .catch((err) => logger.warn(`Could not fetch the model limit: ${err}`))
                }
              }
            } else if (stepStartedAt) {
              llmMs += Date.now() - stepStartedAt
              stepStartedAt = 0
            }
            break
          }

          case "TokenUsage": {
            // opencode reports the session's CUMULATIVE usage, so take the delta
            // against the baseline captured before this turn.
            const now = action.tokens
            const base = usageBaseline
            const delta = {
              input: Math.max(0, (now.input ?? 0) - (base.input ?? 0)),
              output: Math.max(0, (now.output ?? 0) - (base.output ?? 0)),
              reasoning: Math.max(0, (now.reasoning ?? 0) - (base.reasoning ?? 0)),
              cache: {
                read: Math.max(0, (now.cache?.read ?? 0) - (base.cache?.read ?? 0)),
                write: Math.max(0, (now.cache?.write ?? 0) - (base.cache?.write ?? 0)),
              },
            }
            // "tokens" and the rate describe what the model GENERATED this
            // turn. The context tokens (input + cache read) are reported
            // separately: re-reading a cached context is nearly free, so
            // counting it towards tok/s would report cache throughput, not
            // generation speed.
            const generated = (delta.output ?? 0) + (delta.reasoning ?? 0)
            // The context of the LAST step = the context window as it is now.
            const stepBase = previousUsage ?? usageBaseline
            const stepDelta = {
              input: Math.max(0, (now.input ?? 0) - (stepBase.input ?? 0)),
              cache: {
                read: Math.max(0, (now.cache?.read ?? 0) - (stepBase.cache?.read ?? 0)),
              },
            }
            previousUsage = {
              input: now.input ?? 0,
              output: now.output ?? 0,
              reasoning: now.reasoning ?? 0,
              cache: { read: now.cache?.read ?? 0, write: now.cache?.write ?? 0 },
            }
            const context = stepDelta.input + stepDelta.cache.read
            // turnStartedAt is only set once the first text arrives; before
            // that the turn duration is unknown (not "since 1970").
            const turnMs = turnStartedAt ? Date.now() - turnStartedAt : 0
            // The rate is per second of MODEL time. If no step events were seen
            // (older server), fall back to the whole turn.
            const modelMs = llmMs > 0 ? llmMs : turnMs
            const rate = modelMs > 0 ? generated / (modelMs / 1000) : 0
            // The hit rate comes from the counters the server reports — not
            // from the difference between two reports. The difference is the
            // LAST step, and every step re-reads (almost) the whole context,
            // so it always looks like a 99% hit.
            const hit = formatPercent(cacheHitRate(now))
            const cost = action.cost !== undefined && action.cost > 0 ? ` · $${action.cost.toFixed(4)}` : ""
            logger.info(
              `Turn usage: generated=${generated} context=${context} cacheHit=${hit}% ` +
              `model=${(modelMs / 1000).toFixed(1)}s ` +
              `turn=${turnMs > 0 ? `${(turnMs / 1000).toFixed(1)}s` : "n/a"} ` +
              `(last step: input=${stepDelta.input} cacheRead=${stepDelta.cache.read})`,
            )
            // Everything the turn consumed: the context it read (fresh +
            // cached) and what it generated.
            const total =
              delta.input +
              delta.output +
              delta.reasoning +
              delta.cache.read +
              delta.cache.write
            // The usage report itself is cumulative for the whole session.
            const sessionTotal =
              (now.input ?? 0) +
              (now.output ?? 0) +
              (now.reasoning ?? 0) +
              (now.cache?.read ?? 0) +
              (now.cache?.write ?? 0)
            lastUsage = {
              context,
              total,
              sessionTotal,
              rate,
              hit,
              cost,
              turnMs,
              // Every text run of the agent is a round — the turn itself
              // always counts as one, even when the text never arrived.
              rounds: Math.max(1, turnAssistantMessageIds.size),
              // How many model calls the turn took — at least one, like the
              // rounds.
              steps: Math.max(1, stepCount),
            }
            publishUsage()
            // `session.usage.updated` fires after EVERY step, not once per
            // turn — closing the card here cut the reply off after the first
            // tool call. The turn ends with `session.execution.succeeded`.
            break
          }



          case "ToolStateChange":
            // In concise mode the tool calls stay out of the card; don't
            // create an empty card just to report them.
            if (deps.replyMode?.(chatId) !== "concise") ensureCard()
            {
              const toolKey = action.callId ?? action.toolName
              if (action.state === "running") runningToolIds.add(toolKey)
              else runningToolIds.delete(toolKey)
            }
            logger.info(
              `Tool status: ${action.toolName} -> ${action.state}` +
              (action.title ? ` · ${action.title}` : "") +
              (action.callId ? ` [${action.callId}]` : ""),
            )
            if (cardStartPromise) {
              cardStartPromise.then(() => {
                card!
                  .setToolStatus(
                    action.toolName,
                    action.state as "running" | "completed" | "error",
                    action.title,
                    action.callId,
                  )
                  .catch((err) => {
                    logger.warn(`setToolStatus failed: ${err}`)
                  })
              }).catch((err) => {
                logger.warn(`card start for tool failed: ${err}`)
              })
            }
            break

          case "SubtaskDiscovered": {
            subAgentTracker
              .onSubtaskDiscovered(action)
              .then((tracked) => {
                const childSessionId = tracked.childSessionId ?? action.sessionId
                // Build and send a separate card for this sub-agent
                const cardData = buildSubAgentNotificationCard(
                  action.description,
                  action.agent ?? "sub-agent",
                  childSessionId,
                )
                return feishuClient.sendMessage(chatId, {
                  msg_type: "interactive",
                  content: JSON.stringify(cardData),
                })
              })
              .catch((err) => {
                logger.warn(`SubtaskDiscovered handling failed: ${err}`)
              })
            break
          }

          case "QuestionAsked": {
            const cardKey = interactiveCardKey("question", action.requestId)
            if (seenInteractiveIds.has(cardKey)) break
            if (deps.interactiveCardRegistry && !deps.interactiveCardRegistry.beginDispatch("question", action.requestId)) {
              break
            }
            logger.info(`Question event received in bridge for session ${sessionId}, requestId=${action.requestId}`)
            const questionCard = buildQuestionCard(action)
            feishuClient.sendMessage(chatId, {
              msg_type: "interactive",
              content: JSON.stringify(questionCard),
            }).then((response) => {
              const messageId = extractFeishuMessageId(response)
              if (!messageId) {
                deps.interactiveCardRegistry?.failDispatch("question", action.requestId)
                return
              }
              seenInteractiveIds.add(cardKey)
              deps.interactiveCardRegistry?.track({
                requestId: action.requestId,
                kind: "question",
                chatId,
                messageId,
              })
            }).catch((err) => {
              deps.interactiveCardRegistry?.failDispatch("question", action.requestId)
              logger.warn(`Question card send failed: ${err}`)
            })
            break
          }

          case "PermissionRequested": {
            const cardKey = interactiveCardKey("permission", action.requestId)
            if (seenInteractiveIds.has(cardKey)) break
            if (deps.interactiveCardRegistry && !deps.interactiveCardRegistry.beginDispatch("permission", action.requestId)) {
              break
            }
            logger.info(`Permission event received in bridge for session ${sessionId}, requestId=${action.requestId}`)
            const permissionCard = buildPermissionCard(action)
            feishuClient.sendMessage(chatId, {
              msg_type: "interactive",
              content: JSON.stringify(permissionCard),
            }).then((response) => {
              const messageId = extractFeishuMessageId(response)
              if (!messageId) {
                deps.interactiveCardRegistry?.failDispatch("permission", action.requestId)
                return
              }
              seenInteractiveIds.add(cardKey)
              deps.interactiveCardRegistry?.track({
                requestId: action.requestId,
                kind: "permission",
                chatId,
                messageId,
              })
            }).catch((err) => {
              deps.interactiveCardRegistry?.failDispatch("permission", action.requestId)
              logger.warn(`Permission card send failed: ${err}`)
            })
            break
          }

          case "SessionIdle": {
            if (settled) return
            settled = true
            clearTimeout(firstEventTimer)
            if (idleTimer) clearTimeout(idleTimer)
            removeListener(eventListeners, sessionId, myListener)
            // A failed turn used to end with no text and the card claimed
            // "（无回复）" + "✅ 已完成". The failure reason is in the event;
            // show it (and mark the card failed) instead of inventing an
            // empty success.
            const failed = action.outcome === "failed"
            const interrupted = action.outcome === "interrupted"
            const responseText =
              textBuffer.trim() ||
              (failed
                ? `❌ 本轮失败：${action.error || "未知错误"}`
                : interrupted
                  ? "⚠️ 本轮已中断"
                  : "（无回复）")
            if (failed) {
              logger.warn(`Turn failed: ${action.error ?? "unknown error"}`)
            }
            const hadCard = card !== null
            // Whether a tool is still marked running only affects the log:
            // the close status follows what the server said. A turn that
            // succeeded while a tool looked running lost that tool event;
            // calling the whole turn interrupted would be worse. The
            // watchdog (below) reports `interrupted` explicitly.
            const closeStatus = failed ? "error" : interrupted ? "interrupted" : "completed"
            const closeCard = card
              ? (cardStartPromise ?? Promise.resolve()).then(() => {
                  if (card!.hasRunningTool()) {
                    logger.warn("Closing the card with a tool still marked running")
                  }
                  return card!.close(responseText, closeStatus)
                })
              : Promise.resolve()
            closeCard
              .catch((err) => {
                // Never lose the answer because the card could not be closed.
                logger.warn(`card.close() failed: ${err instanceof Error ? err.message : String(err)}`)
              })
              .then(async () => {
                if (card) {
                  logger.info(
                    `Card layout (messageId=${card.id}):\n${card.describe()}`,
                  )
                }
                // The answer is already on the streaming card; only post a separate
                // reply card when there was no streaming card at all.
                if (hadCard) {
                  await clearReaction()
                } else {
                  try {
                    await sendFinalResponse(responseText)
                  } catch (err) {
                    logger.warn(`sendFinalResponse failed: ${err}`)
                  }
                }
                if (deps.outboundMedia) {
                  try {
                    await deps.outboundMedia.sendDetectedFiles(chatId, responseText)
                  } catch (err) {
                    logger.warn(`outboundMedia.sendDetectedFiles failed: ${err}`)
                  }
                }
                onComplete(responseText)
                resolve()
              })
              .catch(async (err) => {
                logger.warn(`card.close() failed: ${err}`)
                try {
                  await sendFinalResponse(responseText)
                } catch (replyErr) {
                  logger.warn(`sendFinalResponse failed after card.close error: ${replyErr}`)
                }
                if (deps.outboundMedia) {
                  try {
                    await deps.outboundMedia.sendDetectedFiles(chatId, responseText)
                  } catch (mediaErr) {
                    logger.warn(`outboundMedia.sendDetectedFiles failed: ${mediaErr}`)
                  }
                }
                onComplete(responseText)
                resolve()
              })
            break
          }

          default:
            break
        }
      }

      const firstEventTimer = setTimeout(async () => {
        if (gotFirstEvent || settled) return
        settled = true
        removeListener(eventListeners, sessionId, myListener)
        logger.warn(
          `No SSE events received within ${FIRST_EVENT_TIMEOUT_MS}ms for ${sessionId}, falling back to sync response`,
        )
        const fallbackText = parseSyncResponse(syncResponseBody, logger)
        const hadCard = card !== null
        try {
          if (card) await card.close(fallbackText)
        } catch (err) {
          logger.warn(`card.close() in timeout fallback failed: ${err}`)
        }
        // Send fallback text as a reply only when there was no streaming card.
        if (!hadCard) {
          try {
            await sendFinalResponse(fallbackText)
          } catch (err) {
            logger.warn(`sendFinalResponse in timeout fallback failed: ${err}`)
          }
        } else {
          await clearReaction()
        }
        if (deps.outboundMedia) {
          try {
            await deps.outboundMedia.sendDetectedFiles(chatId, fallbackText)
          } catch (mediaErr) {
            logger.warn(`outboundMedia.sendDetectedFiles in timeout fallback failed: ${mediaErr}`)
          }
        }
        onComplete(fallbackText)
        resolve()
      }, FIRST_EVENT_TIMEOUT_MS)

      // Register event listener BEFORE the POST to avoid race condition
      addListener(eventListeners, sessionId, myListener)


      // Capture the session's cumulative usage BEFORE the turn starts, so the
      // turn's own usage can be derived from the end-of-turn report.
      void (async () => {
        try {
          const snapshot = await deps.opencode?.getSession(sessionId)
          const t = (snapshot as unknown as { tokens?: typeof usageBaseline })?.tokens
          if (t) usageBaseline = { ...t, cache: { ...t.cache } }
        } catch {
          // No baseline -> the usage line falls back to the raw totals.
        }
        sendMessage()
        .then((responseBody) => {
          syncResponseBody = responseBody
          logger.info(
            `POST completed for session ${sessionId} (${responseBody.length} bytes)`,
          )
        })
        .catch((err) => {
          if (settled) return
          // If SSE events have been flowing, the POST timeout is expected
          // (e.g. agent blocked on question/permission). Keep the listener alive.
          if (gotFirstEvent) {
            logger.info(`POST timed out for session ${sessionId} but SSE events are flowing — keeping listener active`)
            return
          }
          settled = true
          clearTimeout(firstEventTimer)
          removeListener(eventListeners, sessionId, myListener)
          if (card) card.close().catch(() => {})
          reject(err)
        })
        })()
    })
  }

  return {
    async handleMessage(
      chatId: string,
      sessionId: string,
      eventListeners: EventListenerMap,
      eventProcessor: EventProcessor,
      sendMessage: () => Promise<string>,
      onComplete: (text: string) => void,
      messageId: string,
      reactionId: string | null,
    ): Promise<void> {
      // One turn at a time per chat. A message that arrives while a turn is
      // still running waits for it instead of starting a parallel turn: two
      // parallel turns on the same session would each collect the same
      // session events, and both cards would show the same text.
      const previous = chatTurns.get(chatId)
      const queued = (
        previous ? previous.catch(() => {}) : Promise.resolve()
      ).then(() =>
        runTurn(chatId, sessionId, eventListeners, eventProcessor, sendMessage, onComplete, messageId, reactionId),
      )
      chatTurns.set(chatId, queued)
      try {
        await queued
      } finally {
        if (chatTurns.get(chatId) === queued) chatTurns.delete(chatId)
      }
    },
  }
}

// ── Helpers ──

function parseSyncResponse(rawText: string, logger: Logger): string {
  if (!rawText.trim()) return "（无回复）"
  try {
    const data = JSON.parse(rawText) as {
      parts?: Array<{ type: string; text?: string }>
    }
    return (
      data.parts
        ?.filter((p) => p.type === "text" && p.text)
        .map((p) => p.text ?? "")
        .join("\n")
        .trim() || "（无回复）"
    )
  } catch (e) {
    logger.warn(`Failed to parse sync response: ${e}`)
    return rawText.trim() || "（无回复）"
  }
}

export function buildFinalResponseCard(text: string): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    elements: [
      {
        tag: "markdown",
        content: toFeishuMarkdown(text),
      },
    ],
  }
}

function buildSubAgentNotificationCard(
  description: string,
  agent: string,
  childSessionId: string,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `🤖 ${agent}` },
      template: "indigo",
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: description },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "🔍 View Details" },
            type: "primary",
            value: { action: "view_subagent", childSessionId },
          },
        ],
      },
    ],
  }
}

export function buildQuestionCard(
  action: QuestionAsked,
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = []

  // Render each question (support multi-question requests)
  for (let qi = 0; qi < action.questions.length; qi++) {
    const question = action.questions[qi]!
    if (qi > 0) {
      elements.push({ tag: "hr" })
    }
    elements.push({
      tag: "div",
      text: { tag: "lark_md", content: question.question },
    })
    elements.push({
      tag: "action",
      actions: question.options.map((opt, idx) => ({
        tag: "button",
        text: { tag: "plain_text", content: opt.label },
        type: idx === 0 ? "primary" : "default",
        value: {
          action: "question_answer",
          requestId: action.requestId,
          sessionId: action.sessionId,
          answers: JSON.stringify([[opt.label]]),
        },
      })),
    })
  }

  const header = action.questions[0]?.header ?? "Question"

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `❓ ${header}` },
      template: "orange",
    },
    elements,
  }
}

export function buildPermissionCard(
  action: PermissionRequested,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: `🔐 Permission: ${action.permissionType}` },
      template: "yellow",
    },
    elements: [
      {
        tag: "div",
        text: { tag: "lark_md", content: action.title },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "✅ Allow Once" },
            type: "primary",
            value: { action: "permission_reply", requestId: action.requestId, sessionId: action.sessionId, reply: "once" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "✅ Always Allow" },
            type: "default",
            value: { action: "permission_reply", requestId: action.requestId, sessionId: action.sessionId, reply: "always" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "❌ Reject" },
            type: "danger",
            value: { action: "permission_reply", requestId: action.requestId, sessionId: action.sessionId, reply: "reject" },
          },
        ],
      },
    ],
  }
}
