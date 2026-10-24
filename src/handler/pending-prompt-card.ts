/**
 * The card shown when a message arrives while the previous turn is still
 * running: interrupt, queue, or drop it.
 */

import type { PendingPrompt, PendingPromptChoice } from "./pending-prompts.js"

function text(content: string): Record<string, unknown> {
  return { tag: "plain_text", content }
}

function button(
  label: string,
  type: "primary" | "default" | "danger",
  pending: PendingPrompt,
  choice: PendingPromptChoice,
): Record<string, unknown> {
  return {
    tag: "button",
    text: text(label),
    type,
    value: { action: "pending_prompt", pendingId: pending.id, choice },
  }
}

export function buildPendingPromptCard(pending: PendingPrompt): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: text("⏳ 上一条还在执行"),
      template: "orange",
    },
    elements: [
      {
        tag: "markdown",
        content: `**新消息**\n> ${pending.preview.replace(/\n/g, "\n> ")}`,
      },
      {
        tag: "markdown",
        content: "这条消息怎么处理？",
      },
      {
        tag: "action",
        actions: [
          button("⚡ 打断并发送", "primary", pending, "interrupt"),
          button("⏳ 排队执行", "default", pending, "queue"),
          button("✖ 取消", "danger", pending, "cancel"),
        ],
      },
    ],
  }
}

const RESULT_TEXT: Record<PendingPromptChoice, string> = {
  interrupt: "已打断上一轮，正在发送新消息。",
  queue: "已排队，等这一轮结束后执行。",
  cancel: "已取消这条消息。",
}

export function buildPendingResolvedCard(choice: PendingPromptChoice): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: text(choice === "cancel" ? "✖ 已取消" : "✅ 已处理"),
      template: choice === "cancel" ? "grey" : "green",
    },
    elements: [{ tag: "markdown", content: RESULT_TEXT[choice] }],
  }
}
