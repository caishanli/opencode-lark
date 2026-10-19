
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { SubAgentTracker } from "../streaming/subagent-tracker.js"
import type { Logger } from "../utils/logger.js"
import type { EventProcessor } from "../streaming/event-processor.js"
import type { QuestionAsked, PermissionRequested } from "../streaming/event-processor.js"
import type { EventListenerMap } from "../utils/event-listeners.js"
import { addListener, removeListener } from "../utils/event-listeners.js"
import { StreamingCardSession } from "../streaming/streaming-card.js"
import { toFeishuMarkdown } from "../feishu/markdown.js"
import { cacheHitRate, formatRate, formatTokens, totalTokens } from "../streaming/usage.js"
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
  feishuClient: FeishuApiClient
  subAgentTracker: SubAgentTracker
  logger: Logger
  seenInteractiveIds: ExpiringSet<string>
  interactiveCardRegistry?: InteractiveCardRegistry
  outboundMedia?: OutboundMediaHandler
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

// ── Factory ──

export function createStreamingBridge(
  deps: StreamingBridgeDeps,
): StreamingBridge {
  const { feishuClient, subAgentTracker, logger, seenInteractiveIds } = deps
  /** In-flight turn per chat, so turns never overlap for the same conversation. */
  const chatTurns = new Map<string, Promise<void>>()

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
    let turnStartedAt = 0
    /** The session's cumulative usage before this turn. opencode reports usage
     *  cumulatively for the whole session, so the turn's own usage is the
     *  difference between the end-of-turn total and this baseline. */
    let usageBaseline = { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }

    const ensureCard = (): void => {
      if (card || cardStartPromise) return
      card = new StreamingCardSession({
        feishuClient,
        chatId,
      })
      cardStartPromise = card.start().then(() => {
        logger.info(
          `Streaming card started for session ${sessionId} in chat ${chatId} (cardId=${card!.id})`,
        )
      })
    }

    return new Promise<void>((resolve, reject) => {
      let textBuffer = ""
      let gotFirstEvent = false
      let settled = false
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

      const TEXT_PUSH_INTERVAL_MS = 350
      let lastTextPush = 0
      let textPushTimer: ReturnType<typeof setTimeout> | null = null

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

        switch (action.type) {
          case "TextDelta": {
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
              writeToCard((c) => void c.setUsage(`≈ ${formatRate(approx / elapsed)} tok/s`))
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
            const context = (delta.input ?? 0) + (delta.cache.read ?? 0)
            const elapsed = (Date.now() - turnStartedAt) / 1000
            const rate = elapsed > 0 ? generated / elapsed : 0
            const hit = Math.round(cacheHitRate(delta) * 100)
            const cost = action.cost !== undefined && action.cost > 0 ? ` · $${action.cost.toFixed(4)}` : ""
            const contextPart = context > 0 ? ` · 上下文 ${formatTokens(context)}` : ""
            const cachePart = delta.cache.read > 0 ? ` · 缓存 ${hit}%` : ""
            writeToCard((c) =>
              void c.setUsage(
                `${formatTokens(generated)} tokens · ${formatRate(rate)} tok/s${contextPart}${cachePart}${cost}`,
              ),
            )
            break
          }



          case "ToolStateChange":
            ensureCard()
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
            removeListener(eventListeners, sessionId, myListener)
            const responseText = textBuffer.trim() || "（无回复）"
            const hadCard = card !== null
            const closeCard = card
              ? (cardStartPromise ?? Promise.resolve()).then(() => card!.close(responseText))
              : Promise.resolve()
            closeCard
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
