import type { FeishuCardAction } from "../types.js"
import { buildPendingResolvedCard } from "../handler/pending-prompt-card.js"
import type { PendingPromptChoice } from "../handler/pending-prompts.js"

export const PERMISSION_LABELS: Record<string, string> = {
  once: "Allowed (once)",
  always: "Always allowed",
  reject: "Rejected",
}

export function buildInteractiveCallbackResponse(
  action: FeishuCardAction,
): Record<string, unknown> {
  const actionType = action.action?.value?.action
  const value = action.action?.value ?? {}

  if (actionType === "question_answer") {
    let answerLabel = "(unknown)"
    try {
      const parsed = JSON.parse(value.answers ?? "[]") as string[][]
      answerLabel = parsed[0]?.[0] ?? answerLabel
    } catch {}

    return {
      toast: { type: "success", content: `✅ Answered: ${answerLabel}` },
      card: {
        type: "raw",
        data: buildAnsweredQuestionCard(answerLabel),
      },
    }
  }

  if (actionType === "pending_prompt") {
    const rawChoice = value.choice ?? "cancel"
    // Old cards carried `steer` (and older ones `interrupt`); both now mean
    // "send it after this turn".
    const choice = (rawChoice === "steer" ? "queue" : rawChoice) as PendingPromptChoice
    const label =
      choice === "queue" ? "已排队…"
      : choice === "interrupt" ? "已打断，正在发送…"
      : "已取消"
    return {
      toast: { type: choice === "cancel" ? "info" : "success", content: label },
      card: { type: "raw", data: buildPendingResolvedCard(choice) },
    }
  }

  if (actionType === "opencode_restart") {
    return {
      toast: {
        type: "info",
        content:
          value.choice === "later"
            ? "好的，下一条消息时启动新版本"
            : "正在重启 opencode 服务…",
      },
    }
  }

  if (actionType === "form_submit") {
    return {
      toast: { type: "info", content: "正在提交选择…" },
    }
  }

  if (actionType === "permission_reply") {
    const reply = value.reply ?? "unknown"
    const label = PERMISSION_LABELS[reply] ?? reply
    const isRejected = reply === "reject"

    return {
      toast: {
        type: isRejected ? "warning" : "success",
        content: `${isRejected ? "❌" : "✅"} ${label}`,
      },
      card: {
        type: "raw",
        data: buildAnsweredPermissionCard(reply),
      },
    }
  }

  return {}
}

export function buildAnsweredQuestionCard(
  answerLabel?: string,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: answerLabel ? "✅ Question Answered" : "✅ Question Already Answered",
      },
      template: "green",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: answerLabel
            ? `**Answer:** ${answerLabel}`
            : "**Status:** Answered in opencode TUI.",
        },
      },
    ],
  }
}

export function buildAnsweredPermissionCard(
  reply?: string,
): Record<string, unknown> {
  const label = reply ? (PERMISSION_LABELS[reply] ?? reply) : undefined
  const isRejected = reply === "reject"

  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: label
          ? `${isRejected ? "❌" : "✅"} Permission: ${label}`
          : "✅ Permission Request Resolved",
      },
      template: label && isRejected ? "red" : "green",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: label
            ? `**Decision:** ${label}`
            : "**Status:** Already handled in opencode TUI.",
        },
      },
    ],
  }
}
