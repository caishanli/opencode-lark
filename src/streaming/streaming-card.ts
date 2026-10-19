/**
 * High-level streaming card session manager.
 *
 * The card is built out of independent elements:
 *   - "head"     — a status line (what is running / the tool counts)
 *   - one element per entry (a finished tool call, or a run of assistant text)
 *
 * Elements are only ever APPENDED, so the visual order is the chronological
 * order of the events (like the opencode web UI) and updating one entry never
 * forces the client to re-render the others.
 *
 * The entry format follows Hermes' reference implementation: a tool line is
 * "<icon> <tool> · <preview>", where the preview is the tool's primary
 * argument, single-lined and tail-truncated; consecutive identical lines are
 * collapsed into "<line> (×N)".
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
}

/** A finished tool call rendered as its own card element. */
interface ToolEntry {
  kind: "tool"
  elementId: string
  line: string
  /** How many identical consecutive calls this line stands for. */
  count: number
}

/** A run of assistant text rendered as its own card element. */
interface TextEntry {
  kind: "text"
  elementId: string
  /** Offset of this run inside the full assistant text. */
  start: number
  text: string
}

type Entry = ToolEntry | TextEntry

interface ToolStatus {
  /** Unique per tool CALL, so two calls to the same tool get separate lines. */
  key: string
  name: string
  state: "running" | "completed" | "error"
  title?: string
}

/** Cards are limited to 200 elements; leave room for the head and the tail. */
const MAX_ELEMENTS = 180

const ICONS: Record<ToolStatus["state"], string> = {
  running: "🔄",
  completed: "✅",
  error: "❌",
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
  private entries: Entry[] = []
  private nextElementId = 1
  private headContent = "🛠️ Processing…"
  /** Length of the full assistant text seen so far. */
  private fullTextLength = 0
  /** Offset in the full text where the next run of text starts. */
  private textStart = 0

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
    const body = this.entries
      .map((e) => (e.kind === "tool" ? e.line : e.text))
      .filter((s) => s.length > 0)
      .join("\n")
    return this.headContent ? (body ? this.headContent + "\n" + body : this.headContent) : body
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
        elements: [{ tag: "markdown", content: this.headContent, element_id: "head" }],
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

    this.state = { cardId, messageId, sequence: 1 }
  }

  /**
   * Replace the streamed agent text.
   *
   * `fullText` is the complete assistant text so far. The card keeps it in
   * one element per run of text: while the assistant keeps talking the same
   * element is updated in place, and a tool call in between starts a new one.
   */
  async setText(fullText: string): Promise<void> {
    if (!this.state || this.closed) {
      return
    }
    this.fullTextLength = fullText.length

    const last = this.entries[this.entries.length - 1]
    if (last && last.kind === "text") {
      const text = fullText.slice(last.start)
      if (text === last.text) return
      last.text = text
      await this.updateElement(last.elementId, toFeishuMarkdown(text))
      return
    }

    // A new run of text: append an element for it. It starts where the text
    // left off before the tool call that interrupted the previous run.
    if (this.entries.length >= MAX_ELEMENTS) return
    const elementId = `seg${this.nextElementId++}`
    const text = fullText.slice(this.textStart)
    const entry: TextEntry = { kind: "text", elementId, start: this.textStart, text }
    this.entries.push(entry)
    await this.appendElement(entry)
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
      this.toolStatuses.push({ key, name, state, title })
    }

    if (state === "running") {
      // Still in flight: only the head line changes.
      await this.updateHead(this.buildHead())
      return
    }

    // Finished: append a line for this call, collapsing consecutive identical
    // ones into "<line> (×N)" the way Hermes does. The title comes from the
    // stored entry — the completion event carries no input, so the preview we
    // learned while it was running has to be reused.
    const stored = this.toolStatuses.find((t) => t.key === key)!
    const line = this.formatToolLine(name, state, stored.title)
    const last = this.entries[this.entries.length - 1]
    if (last && last.kind === "tool" && last.line.split(" (×")[0] === line) {
      last.count += 1
      const merged = last.count > 1 ? `${line} (×${last.count})` : line
      last.line = merged
      await this.updateElement(last.elementId, merged)
    } else {
      if (this.entries.length >= MAX_ELEMENTS) return
      const elementId = `seg${this.nextElementId++}`
      const entry: ToolEntry = { kind: "tool", elementId, line, count: 1 }
      this.entries.push(entry)
      await this.appendElement(entry)
    }

    // The current run of text ends here: the next run starts after it.
    this.textStart = this.fullTextLength

    await this.updateHead(this.buildHead())
  }

  async addSubtaskButton(label: string, actionValue: string): Promise<void> {
    if (!this.state || this.closed) {
      return
    }
    if (this.entries.length >= MAX_ELEMENTS) return

    const elementId = `seg${this.nextElementId++}`
    const line = `🔗 [${label}](${actionValue})`
    const entry: ToolEntry = { kind: "tool", elementId, line, count: 1 }
    this.entries.push(entry)
    await this.appendElement(entry)
  }

  async close(finalText?: string): Promise<void> {
    if (!this.state || this.closed) {
      return
    }
    this.closed = true
    await this.queue

    if (finalText !== undefined) {
      const last = this.entries[this.entries.length - 1]
      if (last && last.kind === "text") {
        const text = finalText.slice(last.start)
        if (text !== last.text) {
          last.text = text
          await this.updateElement(last.elementId, toFeishuMarkdown(text))
        }
      }
    }

    await this.updateHead(this.buildHead(true))

    const completed = this.toolStatuses.filter((t) => t.state === "completed").length
    const summary = completed > 0 ? `✅ ${completed} tool(s) used` : "Done"
    this.state.sequence += 1
    await this.cardkitClient.closeStreaming(
      this.state.cardId,
      summary,
      this.state.sequence,
    )
  }

  // ── internals ──

  private formatToolLine(
    name: string,
    state: "running" | "completed" | "error",
    title?: string,
  ): string {
    const icon = ICONS[state]
    return title ? `${icon} ${name} · ${title}` : `${icon} ${name}`
  }

  /** The head line: what is running, and how many tool calls have finished. */
  private buildHead(final = false): string {
    const parts: string[] = []
    const counts = new Map<string, number>()
    for (const t of this.toolStatuses) {
      if (t.state === "running") continue
      counts.set(t.name, (counts.get(t.name) ?? 0) + 1)
    }
    if (counts.size > 0) {
      parts.push(
        "🔧 " + [...counts.entries()].map(([name, n]) => `${name} ×${n}`).join(" · "),
      )
    }
    const running = this.toolStatuses.find((t) => t.state === "running")
    if (running) {
      parts.push(`🔄 ${running.name}${running.title ? " · " + running.title : ""}`)
    }
    if (parts.length === 0) {
      return final ? "✅ Done" : "🛠️ Processing…"
    }
    return parts.join(" · ")
  }

  private async appendElement(entry: Entry): Promise<void> {
    const content = entry.kind === "tool" ? entry.line : toFeishuMarkdown(entry.text)
    await this.enqueue(async () => {
      if (!this.state) return
      this.state.sequence += 1
      await this.cardkitClient.appendElements(
        this.state.cardId,
        [{ tag: "markdown", content, element_id: entry.elementId }],
        this.state.sequence,
      )
      this.lastSentContent = this.content
    })
  }

  private async updateElement(elementId: string, content: string): Promise<void> {
    await this.enqueue(async () => {
      if (!this.state) return
      this.state.sequence += 1
      await this.cardkitClient.updateElement(
        this.state.cardId,
        elementId,
        content,
        this.state.sequence,
      )
      this.lastSentContent = this.content
    })
  }

  private async updateHead(content: string): Promise<void> {
    if (content === this.headContent) return
    this.headContent = content
    await this.updateElement("head", content)
  }

  private async enqueue(fn: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(fn)
    await this.queue
  }
}
