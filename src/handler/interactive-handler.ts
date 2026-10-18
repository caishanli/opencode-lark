/**
 * Interactive card action handler.
 * Handles question answers and permission replies from Feishu card button clicks,
 * forwarding responses back to the opencode server.
 */

import type { Logger } from "../utils/logger.js"
import type { FeishuCardAction } from "../types.js"
import type { InteractiveCardRegistry } from "../feishu/interactive-card-registry.js"
import type { OpencodeGateway } from "../opencode/gateway.js"

// ── Types ──

export interface InteractiveHandlerDeps {
  opencode: OpencodeGateway
  logger: Logger
  interactiveCardRegistry?: InteractiveCardRegistry
}

// ── Factory ──

export function createInteractiveHandler(deps: InteractiveHandlerDeps) {
  const { opencode, logger } = deps

  return async (action: FeishuCardAction): Promise<void> => {
    const actionValue = action.action?.value
    if (!actionValue) return

    const actionType = actionValue.action

    if (actionType === "question_answer") {
      await handleQuestionAnswer(actionValue as Record<string, string>)
      return
    }

    if (actionType === "permission_reply") {
      await handlePermissionReply(actionValue as Record<string, string>)
      return
    }
  }

  async function handleQuestionAnswer(
    value: Record<string, string>,
  ): Promise<void> {
    const { requestId, answers, sessionId } = value
    if (!requestId || !answers) {
      logger.warn("Missing requestId or answers in question_answer action")
      return
    }
    if (!sessionId) {
      logger.warn("Question card missing sessionId; cannot reply on v2")
      return
    }

    let parsedAnswers: string[][]
    try {
      parsedAnswers = JSON.parse(answers) as string[][]
    } catch {
      logger.warn(`Failed to parse question answers: ${answers}`)
      return
    }

    try {
      deps.interactiveCardRegistry?.markFeishuResolving("question", requestId)
      await opencode.replyQuestion(sessionId, requestId, parsedAnswers)
      deps.interactiveCardRegistry?.untrack("question", requestId)
      logger.info(`Question ${requestId} answered: ${parsedAnswers[0]?.[0] ?? ""}`)
    } catch (err) {
      deps.interactiveCardRegistry?.clearFeishuResolving("question", requestId)
      logger.warn(`Question reply request failed: ${err}`)
    }
  }

  async function handlePermissionReply(
    value: Record<string, string>,
  ): Promise<void> {
    const { requestId, reply, sessionId } = value
    if (!requestId || !reply) {
      logger.warn("Missing requestId or reply in permission_reply action")
      return
    }
    if (!sessionId) {
      logger.warn("Permission card missing sessionId; cannot reply on v2")
      return
    }

    try {
      deps.interactiveCardRegistry?.markFeishuResolving("permission", requestId)
      await opencode.replyPermission(sessionId, requestId, reply as "once" | "always" | "reject")
      deps.interactiveCardRegistry?.untrack("permission", requestId)
      const labelMap: Record<string, string> = {
        once: "Allowed (once)",
        always: "Always allowed",
        reject: "Rejected",
      }
      logger.info(`Permission ${requestId}: ${labelMap[reply] ?? reply}`)
    } catch (err) {
      deps.interactiveCardRegistry?.clearFeishuResolving("permission", requestId)
      logger.warn(`Permission reply request failed: ${err}`)
    }
  }
}