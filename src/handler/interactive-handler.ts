/**
 * Interactive card action handler.
 * Handles question answers and permission replies from Feishu card button clicks,
 * forwarding responses back to the opencode server.
 */

import type { Logger } from "../utils/logger.js"
import type { FeishuCardAction } from "../types.js"
import type { InteractiveCardRegistry } from "../feishu/interactive-card-registry.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { OpencodeGateway } from "../opencode/gateway.js"
import { formAnswer } from "./form-card.js"

// ── Types ──

export interface InteractiveHandlerDeps {
  opencode: OpencodeGateway
  logger: Logger
  interactiveCardRegistry?: InteractiveCardRegistry
  /** Used to tell the user when the opencode server cannot answer a question. */
  feishuClient?: Pick<FeishuApiClient, "replyMessage">
}

// ── Factory ──

export function createInteractiveHandler(deps: InteractiveHandlerDeps) {
  const { opencode, logger } = deps

  /** Tell the user why the click did nothing (opencode v2.0.29 has no
   *  /api/question endpoints, so a question cannot be answered from Feishu). */
  const notifyUser = async (
    action: FeishuCardAction,
    text: string,
  ): Promise<void> => {
    const client = deps.feishuClient
    if (!client) return
    try {
      await client.replyMessage(action.open_message_id, {
        msg_type: "text",
        content: JSON.stringify({ text }),
      })
    } catch (err) {
      logger.warn(`Failed to notify user: ${err}`)
    }
  }

  return async (action: FeishuCardAction): Promise<void> => {
    const actionValue = action.action?.value
    if (!actionValue) return

    const actionType = actionValue.action

    if (actionType === "question_answer") {
      await handleQuestionAnswer(actionValue as Record<string, string>, action)
      return
    }

    if (actionType === "form_submit") {
      await handleFormSubmit(actionValue as Record<string, string>, action)
      return
    }

    if (actionType === "permission_reply") {
      await handlePermissionReply(actionValue as Record<string, string>, action)
      return
    }
  }

  async function handleFormSubmit(
    value: Record<string, string>,
    action: FeishuCardAction,
  ): Promise<void> {
    const { sessionId, formId } = value
    if (!sessionId || !formId) {
      logger.warn("Missing sessionId or formId in form_submit action")
      return
    }

    let form
    try {
      form = await opencode.getForm(sessionId, formId)
    } catch (err) {
      logger.warn(`Form lookup failed: ${err}`)
      await notifyUser(action, `读取问题失败：${err instanceof Error ? err.message : String(err)}`)
      return
    }
    if (!form) {
      await notifyUser(action, "这个问题已经结束（可能在 TUI 里回答或已取消）。")
      return
    }

    const answer =
      value.field && value.choice
        ? { [value.field]: value.choice }
        : formAnswer(form, action.action.form_value ?? {})
    if (Object.keys(answer).length === 0) {
      await notifyUser(action, "还没有选择任何选项。")
      return
    }

    try {
      deps.interactiveCardRegistry?.markFeishuResolving("question", formId)
      await opencode.replyForm(sessionId, formId, answer)
      // Leave the card tracked: the poller sees the form disappear and turns
      // it into the answered card. Clearing (not untracking) lets it do so.
      deps.interactiveCardRegistry?.clearFeishuResolving("question", formId)
      logger.info(`Form ${formId} answered: ${JSON.stringify(answer)}`)
    } catch (err) {
      deps.interactiveCardRegistry?.clearFeishuResolving("question", formId)
      logger.warn(`Form reply request failed: ${err}`)
      const message = err instanceof Error ? err.message : String(err)
      await notifyUser(action, `提交选择失败：${message}`)
    }
  }

  async function handleQuestionAnswer(
    value: Record<string, string>,
    action: FeishuCardAction,
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
      const message = err instanceof Error ? err.message : String(err)
      await notifyUser(
        action,
        /404/.test(message)
          ? "当前 opencode 版本不支持从飞书回答提问（服务端没有 /api/question 接口）。请在 TUI 里回答。"
          : `回答提问失败：${message}`,
      )
    }
  }

  async function handlePermissionReply(
    value: Record<string, string>,
    action: FeishuCardAction,
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
      const message = err instanceof Error ? err.message : String(err)
      await notifyUser(action, `权限操作失败：${message}`)
    }
  }
}