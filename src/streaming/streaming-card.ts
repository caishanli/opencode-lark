/**
 * High-level streaming card session manager.
 * Wraps CardKitClient with throttling, tool status, sub-agent buttons,
 * and full lifecycle management.
 */

import type { CardKitClient, CardKitSchema } from "../feishu/cardkit-client.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import { toFeishuMarkdown } from "../feishu/markdown.js"

export interface StreamingCardOptions {
  cardkitClient: CardKitClient
  feishuClient: FeishuApiClient
  chatId: string
}

interface CardState {
  cardId: string
  messageId: string
  sequence: number
  currentText: string
}

interface ToolStatus {
  /** Unique per tool CALL, so two calls to the same tool get separate lines. */
  key: string
  name: string
  state: "running" | "completed" | "error"
  title?: string
  /** A line is only written to the card once the call is over. */
  done: boolean
}

interface SubtaskButton {
  label: string
  actionValue: string
}

export class StreamingCardSession {
  private readonly cardkitClient: CardKitClient
  private readonly feishuClient: FeishuApiClient
  private readonly chatId: string

  private state: CardState | null = null
  private closed = false
  private queue: Promise<void> = Promise.resolve()
  private lastSentContent = ""

  private toolStatuses: ToolStatus[] = []
  /** Completed calls, in completion order — the order they are rendered in. */
  private finishedTools: ToolStatus[] = []
  private subtaskButtons: SubtaskButton[] = []
  private text = ""
  /** True once the card is closed: the final content may include the count summary. */
  private finished = false

  constructor(options: StreamingCardOptions) {
    this.cardkitClient = options.cardkitClient
    this.feishuClient = options.feishuClient
    this.chatId = options.chatId
  }

  get isActive(): boolean {
    return this.state !== null && !this.closed
  }

  /** The CardKit card id, once the card exists (useful for inspecting the card). */
  get id(): string | null {
    return this.state?.cardId ?? null
  }

  /** The content most recently written to the card. */
  get content(): string {
    return this.lastSentContent
  }

  async start(): Promise<void> {
    if (this.state) {
      return
    }

    const cardJson: CardKitSchema = {
      schema: "2.0",
      config: {
        streaming_mode: true,
        summary: { content: "[Generating...]" },
        streaming_config: {
          print_frequency_ms: { default: 200 },
          print_step: { default: 10 },
        },
      },
      body: {
        elements: [
          { tag: "markdown", content: "🛠️ Processing...", element_id: "content" },
        ],
      },
    }

    const cardId = await this.cardkitClient.createCard(cardJson)

    const result = await this.feishuClient.sendMessage(this.chatId, {
      msg_type: "interactive",
      content: JSON.stringify({ type: "card", data: { card_id: cardId } }),
    })

    const messageId = result.data?.["message_id"] as string | undefined
    if (!messageId) {
      throw new Error("sendMessage returned no message_id")
    }

    this.state = { cardId, messageId, sequence: 1, currentText: "" }
  }


  /**
   * Replace the streamed agent text shown on the card.
   * The caller is responsible for throttling; the card serializes updates.
   */
  async setText(text: string): Promise<void> {
    if (!this.state || this.closed) {
      return
    }
    this.text = text
    await this.enqueueUpdate(this.buildFullContent())
  }

  async setToolStatus(
    name: string,
    state: "running" | "completed" | "error",
    title?: string,
    callId?: string,
  ): Promise<void> {
    if (!this.state || this.closed) {
      return
    }

    // Key by the tool CALL id when available so repeated calls to the same
    // tool (e.g. three `shell` invocations) render as three separate lines.
    const key = callId ?? name
    const existing = this.toolStatuses.find((t) => t.key === key)
    if (existing) {
      existing.state = state
      if (title !== undefined) existing.title = title
    } else {
      this.toolStatuses.push({ key, name, state, title, done: false })
    }
    // A line is written only when the call is over, and it is appended in
    // completion order. That keeps the card content strictly append-only, so
    // the client never has to re-render what it already printed.
    if (state !== "running") {
      const entry = this.toolStatuses.find((t) => t.key === key)!
      entry.done = true
      if (!this.finishedTools.some((t) => t.key === key)) {
        this.finishedTools.push(entry)
      }
    }

    // Build tool status text and update the content element
    const fullContent = this.buildFullContent()
    await this.enqueueUpdate(fullContent)
  }

  async addSubtaskButton(label: string, actionValue: string): Promise<void> {
    if (!this.state || this.closed) {
      return
    }

    this.subtaskButtons.push({ label, actionValue })

    // Rebuild full content with buttons section
    const fullContent = this.buildFullContent()
    await this.enqueueUpdate(fullContent)
  }

  async close(finalText?: string): Promise<void> {
    if (!this.state || this.closed) {
      return
    }
    this.closed = true
    await this.queue
    if (finalText !== undefined) this.text = finalText
    this.finished = true
    // Final content: tool calls first, then the reply text.
    let text = this.buildFullContent()
    if (text === "🛠️ Processing..." || text.startsWith("🛠️ Running")) text = "✅ Done"
    // Only send final update if content differs from what was last sent
    if (text && text !== this.lastSentContent) {
      this.state.sequence += 1
      await this.cardkitClient.updateElement(
        this.state.cardId,
        "content",
        text,
        this.state.sequence,
      )
    }

    // Close streaming mode with tool-focused summary
    const completed = this.toolStatuses.filter(t => t.state === "completed").length
    const summary = completed > 0 ? `✅ ${completed} tool(s) used` : "Done"
    this.state.sequence += 1
    await this.cardkitClient.closeStreaming(
      this.state.cardId,
      summary,
      this.state.sequence,
    )
  }

  private async enqueueUpdate(content: string): Promise<void> {
    this.queue = this.queue.then(async () => {
      if (!this.state || this.closed) {
        return
      }
      this.state.sequence += 1
      await this.cardkitClient.updateElement(
        this.state.cardId,
        "content",
        content,
        this.state.sequence,
      )
      this.lastSentContent = content
    })
    await this.queue
  }
  private buildToolStatusText(): string {
    // Only finished calls get a line. Writing a line while the call is still
    // running and later flipping 🔄→✅ would edit the middle of the element
    // and make the client re-render the whole card.
    const done = this.finishedTools
    if (done.length === 0) {
      return ""
    }
    const icons: Record<string, string> = {
      running: "🔄",
      completed: "✅",
      error: "❌",
    }
    const lines = done.map(
      (t) => t.title ? `${icons[t.state]} ${t.name} · ${t.title}` : `${icons[t.state]} ${t.name}`,
    )
    // The count summary is rendered on the FINAL card only. While streaming it
    // would change on every call, and rewriting the top of the element makes
    // the client re-render the whole card.
    let summary = ""
    if (this.finished && done.length > 1) {
      const counts = new Map<string, number>()
      for (const t of done) {
        counts.set(t.name, (counts.get(t.name) ?? 0) + 1)
      }
      summary = "🔧 " + [...counts.entries()].map(([name, n]) => `${name} ×${n}`).join(" · ") + "\n"
    }
    return "---\n" + summary + lines.join("\n")
  }

  private buildButtonsText(): string {
    if (this.subtaskButtons.length === 0) {
      return ""
    }
    const lines = this.subtaskButtons.map(
      (b) => `🔗 [${b.label}](${b.actionValue})`,
    )
    return "\n\n---\n" + lines.join("\n")
  }

  private buildFullContent(): string {
    const toolText = this.buildToolStatusText()
    const buttonText = this.buildButtonsText()
    const head = toolText + buttonText
    if (this.text) {
      // Same order as the opencode web UI: the tool calls that happened during
      // the turn first, the reply text last. Keeping the text at the end also
      // means the content only ever grows, so the client can stream it
      // incrementally instead of re-rendering the whole card.
      const body = toFeishuMarkdown(this.text)
      return head ? head + "\n\n" + body : body
    }
    return head || this.buildProgressPlaceholder()
  }

  /** Shown while nothing has been written yet, including which tool is running. */
  private buildProgressPlaceholder(): string {
    const running = this.toolStatuses.find((t) => !t.done)
    if (running) {
      const what = running.title ? `${running.name} · ${running.title}` : running.name
      return `🛠️ Running ${what}…`
    }
    return "🛠️ Processing..."
  }
}