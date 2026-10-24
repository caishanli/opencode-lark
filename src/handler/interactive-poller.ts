// ═══════════════════════════════════════════
// Interactive Poller
// Polls opencode for pending forms/permissions
// as a reliable fallback when SSE events don't arrive.
// ═══════════════════════════════════════════

import type { FeishuApiClient } from "../feishu/api-client.js"
import type { Logger } from "../utils/logger.js"
import type { FormInfo, OpencodeGateway } from "../opencode/gateway.js"
import type { PermissionRequested } from "../streaming/event-processor.js"
import { buildPermissionCard } from "./streaming-integration.js"
import { buildAnsweredFormCard, buildFormCard } from "./form-card.js"
import type { ExpiringSet } from "../utils/expiring-set.js"
import type { InteractiveCardRegistry } from "../feishu/interactive-card-registry.js"
import {
  extractFeishuMessageId,
  interactiveCardKey,
} from "../feishu/interactive-card-registry.js"
import { buildAnsweredPermissionCard } from "../feishu/interactive-card-response.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InteractivePollerDeps {
  opencode: OpencodeGateway
  feishuClient: Pick<FeishuApiClient, "sendMessage" | "updateMessage">
  logger: Logger
  getChatForSession: (sessionId: string) => string | undefined
  /** Shared dedup set — IDs added here are also checked by SSE handlers */
  seenInteractiveIds: ExpiringSet<string>
  interactiveCardRegistry?: InteractiveCardRegistry
}

export interface InteractivePoller {
  start(): void
  stop(): void
}

/** Shape returned by GET /api/form (opencode 2.1+). */
type PendingForm = FormInfo

/** Shape returned by gateway listPermissions */
interface PendingPermission {
  id: string
  sessionID: string
  action: string
  resources: string[]
  metadata: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 3_000
const FETCH_TIMEOUT_MS = 5_000

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createInteractivePoller(
  deps: InteractivePollerDeps,
): InteractivePoller {
  const { opencode, feishuClient, logger, getChatForSession, seenInteractiveIds } = deps
  let timer: ReturnType<typeof setInterval> | null = null

  async function poll(): Promise<void> {
    try {
      const [pendingForms, pendingPermissions] = await Promise.all([
        pollForms(),
        pollPermissions(),
      ])
      await resolveAnsweredCards(pendingForms, pendingPermissions)
    } catch {
      // Individual poll methods handle their own errors
    }
  }

  async function pollForms(): Promise<Set<string> | null> {
    let forms: unknown
    try {
      forms = await opencode.listForms()
    } catch {
      return null
    }
    if (!Array.isArray(forms)) return null

    const pendingIds = new Set<string>()

    for (const form of forms as PendingForm[]) {
      if (!form.id || !form.sessionID || !Array.isArray(form.fields)) continue
      pendingIds.add(form.id)
      const cardKey = interactiveCardKey("question", form.id)
      if (seenInteractiveIds.has(cardKey)) continue

      const chatId = getChatForSession(form.sessionID)
      if (!chatId) continue
      if (deps.interactiveCardRegistry && !deps.interactiveCardRegistry.beginDispatch("question", form.id)) continue

      logger.info(
        `Poller: pending form ${form.id} for session ${form.sessionID}`,
      )

      const card = buildFormCard(form)
      feishuClient
        .sendMessage(chatId, {
          msg_type: "interactive",
          content: JSON.stringify(card),
        })
        .then((response) => {
          const messageId = extractFeishuMessageId(response)
          if (!messageId) {
            deps.interactiveCardRegistry?.failDispatch("question", form.id)
            return
          }
          seenInteractiveIds.add(cardKey)
          deps.interactiveCardRegistry?.track({
            requestId: form.id,
            kind: "question",
            chatId,
            messageId,
          })
        })
        .catch((err) => {
          deps.interactiveCardRegistry?.failDispatch("question", form.id)
          logger.warn(`Poller form card send failed: ${err}`)
        })
    }

    return pendingIds
  }

  async function pollPermissions(): Promise<Set<string> | null> {
    let permissions: unknown
    try {
      permissions = await opencode.listPermissions()
    } catch {
      return null
    }
    if (!Array.isArray(permissions)) return null

    const pendingIds = new Set<string>()

    for (const p of permissions as PendingPermission[]) {
      if (!p.id || !p.sessionID) continue
      pendingIds.add(p.id)
      const cardKey = interactiveCardKey("permission", p.id)
      if (seenInteractiveIds.has(cardKey)) continue

      const chatId = getChatForSession(p.sessionID)
      if (!chatId) continue
      if (deps.interactiveCardRegistry && !deps.interactiveCardRegistry.beginDispatch("permission", p.id)) continue

      logger.info(
        `Poller: pending permission ${p.id} for session ${p.sessionID}`,
      )

      const patternList = Array.isArray(p.resources)
        ? p.resources.filter((s): s is string => typeof s === "string")
        : []

      const action: PermissionRequested = {
        type: "PermissionRequested",
        sessionId: p.sessionID,
        requestId: p.id,
        permissionType: p.action ?? "unknown",
        title: patternList.length > 0 ? patternList.join(", ") : (p.action ?? "Permission"),
        metadata: p.metadata ?? {},
      }
      const card = buildPermissionCard(action)
      feishuClient
        .sendMessage(chatId, {
          msg_type: "interactive",
          content: JSON.stringify(card),
        })
        .then((response) => {
          const messageId = extractFeishuMessageId(response)
          if (!messageId) {
            deps.interactiveCardRegistry?.failDispatch("permission", p.id)
            return
          }
          seenInteractiveIds.add(cardKey)
          deps.interactiveCardRegistry?.track({
            requestId: p.id,
            kind: "permission",
            chatId,
            messageId,
          })
        })
        .catch((err) => {
          deps.interactiveCardRegistry?.failDispatch("permission", p.id)
          logger.warn(`Poller permission card send failed: ${err}`)
        })
    }

    return pendingIds
  }

  async function resolveAnsweredCards(
    pendingQuestions: Set<string> | null,
    pendingPermissions: Set<string> | null,
  ): Promise<void> {
    const trackedCards = deps.interactiveCardRegistry?.list() ?? []
    if (trackedCards.length === 0) return

    for (const card of trackedCards) {
      if (card.state !== "sent") continue
      if (card.kind === "question") {
        if (!pendingQuestions || pendingQuestions.has(card.requestId)) continue
      } else if (!pendingPermissions || pendingPermissions.has(card.requestId)) {
        continue
      }

      const resolvedCard = card.kind === "question"
        ? buildAnsweredFormCard()
        : buildAnsweredPermissionCard()

      try {
        const response = await feishuClient.updateMessage(
          card.messageId,
          JSON.stringify(resolvedCard),
        )
        if (response.code === 0) {
          deps.interactiveCardRegistry?.untrack(card.kind, card.requestId)
          logger.info(
            `Poller: marked ${card.kind} ${card.requestId} as answered in TUI`,
          )
        }
      } catch (err) {
        logger.warn(
          `Poller ${card.kind} card update failed for ${card.requestId}: ${err}`,
        )
      }
    }
  }

  return {
    start() {
      if (timer) return
      timer = setInterval(() => {
        poll()
      }, POLL_INTERVAL_MS)
      logger.info(`Interactive poller started (interval=${POLL_INTERVAL_MS}ms)`)
      // Run first poll immediately
      poll()
    },

    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      logger.info("Interactive poller stopped")
    },
  }
}
