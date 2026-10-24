/**
 * Streaming reply card.
 *
 * The card is a normal Feishu interactive message that is updated in place
 * (PATCH /im/v1/messages/{id}) — no CardKit, no streaming-mode card. This
 * mirrors the ZCode reference implementation:
 *
 *   - the card body is a list of BLOCKS in chronological order: a "message"
 *     block for a run of assistant text, and a "tools" block for a run of
 *     tool calls (consecutive calls share one block, a message in between
 *     starts a new one — exactly how the opencode web UI groups them);
 *   - a "tools" block renders as a collapsible panel whose header carries
 *     the count ("🛠️ 工具 (3)") and whose body lists one line per call
 *     ("- ✅ shell · uname -a"). While the turn is running only the most
 *     recent panel is expanded; on completion they collapse;
 *   - a status line closes the card ("⏳ 运行中…" / "✅ 已完成").
 *
 * Feishu rejects cards with more than 200 components, so the card owns a
 * conservative budget of 180 elements: when the next block would overflow it,
 * the current card is sealed (kept in the conversation) and the remaining
 * blocks continue in a new card.
 */

import type { FeishuApiClient } from "../feishu/api-client.js"
import { toFeishuMarkdown } from "../feishu/markdown.js"
import { createLogger } from "../utils/logger.js"
import { readFileSync, rmSync, writeFileSync } from "node:fs"

const logger = createLogger("streaming-card")

export interface StreamingCardOptions {
  feishuClient: FeishuApiClient
  chatId: string
  /** File used to remember the open card, so a restarted process can close it
   *  instead of leaving it stuck on "running". */
  stateFile?: string
  /** Text only: no tool panels, no status line. */
  concise?: boolean
}

/** A run of assistant text. */
interface MessageBlock {
  kind: "message"
  /** Offset of this run inside the full assistant text of the turn. */
  start: number
  /** Only the text of this run (not the whole turn). */
  text: string
}

/** A run of tool calls. */
interface ToolsBlock {
  kind: "tools"
  calls: ToolCall[]
}

type Block = MessageBlock | ToolsBlock

interface ToolCall {
  key: string
  name: string
  state: "running" | "completed" | "error"
  title?: string
}

/**
 * What the bridge remembers about a card that is still open, so a restarted
 * process can restore the answer instead of wiping the card.
 */
export interface OpenCardState {
  messageId: string
  /** The card's blocks (text runs and tool panels). */
  blocks?: Block[]
  /** The status line the card was showing. */
  usage?: string
  hasRealUsage?: boolean
}

const ELEMENT_BUDGET = 180
/** How often the open-card state file is refreshed while a turn runs. */
const STATE_WRITE_INTERVAL_MS = 2_000

const TOOL_ICONS: Record<ToolCall["state"], string> = {
  running: "🔄",
  completed: "✅",
  error: "❌",
}

/** Every card that is currently open, so a shutdown can close them all. */
const openCards = new Set<StreamingCardSession>()

/**
 * Close every open card, e.g. when the process is shutting down.
 * Without this a card whose turn was interrupted (restart, crash, lost SSE)
 * stays stuck on "running" forever.
 */
export async function closeAllStreamingCards(
  status: "error" | "interrupted" = "interrupted",
  /** Used to close cards that are only known through the state file. */
  fallback?: { feishuClient: FeishuApiClient; stateFile?: string },
): Promise<number> {
  const cards = [...openCards]
  const results = await Promise.allSettled(cards.map((c) => c.close(undefined, status)))
  const failed = results.filter((r) => r.status === "rejected").length
  if (failed > 0) logger.warn(`${failed} card(s) could not be closed`)
  let closed = cards.length

  // A card can be missing from the registry (the turn was taken over, the
  // process was interrupted) while the state file still lists it. Close it
  // from the state file, with the answer it remembered.
  if (fallback?.stateFile) {
    closed += await closeRememberedCards(fallback.feishuClient, fallback.stateFile, status)
  }
  return closed
}

/** Close the cards listed in the state file that are not open in memory. */
async function closeRememberedCards(
  feishuClient: FeishuApiClient,
  stateFile: string,
  status: "error" | "interrupted",
): Promise<number> {
  let open: Record<string, OpenCardState>
  try {
    const raw = readFileSync(stateFile, "utf-8").trim()
    if (!raw) return 0
    const parsed = JSON.parse(raw) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0
    open = parsed as Record<string, OpenCardState>
  } catch {
    return 0
  }

  let closed = 0
  for (const [chatId, entry] of Object.entries(open)) {
    const state = typeof entry === "string" ? { messageId: entry } : entry
    if (!state?.messageId) continue
    const card = StreamingCardSession.restore({ feishuClient, chatId, stateFile, state })
    try {
      await card.close(undefined, status)
      closed += 1
      logger.info(`Closed the card left open by a previous process: ${state.messageId}`)
    } catch (err) {
      logger.warn(`Could not close the card ${state.messageId}: ${err}`)
    }
  }
  return closed
}

export class StreamingCardSession {
  private readonly feishuClient: FeishuApiClient
  private readonly chatId: string
  private readonly stateFile?: string
  /** Text only: tool panels and the status line are not rendered. */
  private readonly concise: boolean

  private messageId: string | null = null
  private closed = false
  private queue: Promise<void> = Promise.resolve()
  private lastSentContent = ""
  /** When the open-card state file was last written. */
  private lastStateWrite = 0

  private blocks: Block[] = []
  /** Token/rate summary shown in the status line. */
  private usageText = ""
  /** True once the server reported a real usage — the live estimate must
   *  never replace it. */
  private hasRealUsage = false
  /** How many characters of the turn's text have been assigned to a block. */
  private assignedLength = 0
  /** Number of blocks already delivered in a sealed card. */
  private sealedBlockCount = 0
  private status: "running" | "completed" | "error" | "interrupted" = "running"

  constructor(options: StreamingCardOptions) {
    this.feishuClient = options.feishuClient
    this.chatId = options.chatId
    this.stateFile = options.stateFile
    this.concise = options.concise === true
  }

  get isActive(): boolean {
    return this.messageId !== null && !this.closed
  }

  /** The Feishu message id of the card (useful for inspecting it). */
  get id(): string | null {
    return this.messageId
  }

  /** The card content most recently sent. */
  get content(): string {
    return this.lastSentContent
  }

  /** A readable, line-per-element summary of the card (for logs). */
  describe(): string {
    const parts: string[] = []
    for (const block of this.blocks) {
      if (block.kind === "message") {
        const text = block.text.trim()
        if (text) parts.push(`[text] ${text.slice(0, 120).replace(/\n/g, " ")}`)
        continue
      }
      const lines = block.calls.map((c) => this.formatSummary(c))
      parts.push(`[tools x${lines.length}] ${lines.join(" ; ")}`)
    }
    parts.push(`[status] ${this.statusLine()}`)
    return parts.join("\n")
  }

  /**
   * Rebuild a card session from a remembered state, so a card that was left
   * open by a previous process can be closed with its answer intact.
   */
  static restore(options: {
    feishuClient: FeishuApiClient
    chatId: string
    stateFile?: string
    state: OpenCardState
  }): StreamingCardSession {
    const session = new StreamingCardSession({
      feishuClient: options.feishuClient,
      chatId: options.chatId,
      stateFile: options.stateFile,
    })
    session.messageId = options.state.messageId
    session.blocks = (options.state.blocks ?? []).map((b) =>
      b.kind === "message"
        ? { kind: "message", start: b.start, text: b.text }
        : { kind: "tools", calls: b.calls.map((c) => ({ ...c })) },
    )
    const last = session.blocks[session.blocks.length - 1]
    session.assignedLength =
      last && last.kind === "message" ? last.start + last.text.length : 0
    session.usageText = options.state.usage ?? ""
    session.hasRealUsage = options.state.hasRealUsage ?? false
    return session
  }

  async start(): Promise<void> {
    if (this.messageId) {
      return
    }
    openCards.add(this)
    await this.sync()
  }

  /**
   * Replace the streamed agent text.
   *
   * `fullText` is the complete assistant text so far. Consecutive text goes
   * into one message block; a tool call in between starts a new one, so the
   * card reads in the same order as the opencode web UI.
   */
  async setText(fullText: string): Promise<void> {
    if (!this.messageId || this.closed) {
      return
    }
    const last = this.blocks[this.blocks.length - 1]
    if (last && last.kind === "message") {
      // Same run of text: grow this block, but keep only its own slice.
      const text = fullText.slice(last.start)
      if (text === last.text) return
      last.text = text
      this.assignedLength = fullText.length
    } else {
      // A tool call interrupted the previous run: start a new text block that
      // holds ONLY the text since then — not the whole turn again.
      const start = this.assignedLength
      const text = fullText.slice(start)
      if (!text) return
      this.assignedLength = fullText.length
      this.blocks.push({ kind: "message", start, text })
    }
    await this.sync()
  }

  /** Show a token/rate summary next to the status line. */
  /** The real usage the server reported for the last step. */
  async setUsage(text: string): Promise<void> {
    await this.applyUsage(text, true)
  }

  /**
   * The live "≈ N tok/s" estimate. It never replaces a real usage line:
   * the text of a step can arrive after the usage event of that step, and
   * the estimate would then wipe the real numbers off the card.
   */
  async setEstimate(text: string): Promise<void> {
    if (this.hasRealUsage) return
    await this.applyUsage(text, false)
  }

  private async applyUsage(text: string, real: boolean): Promise<void> {
    if (this.closed) return
    // Record it even if the card has no message id yet: the usage event can
    // arrive before the card is created, and the line must not be lost.
    if (text === this.usageText) return
    this.usageText = text
    if (real) this.hasRealUsage = true
    if (!this.messageId) return
    await this.sync()
  }

  /** True while a tool call is still marked as running. */
  hasRunningTool(): boolean {
    return this.blocks.some(
      (b) => b.kind === "tools" && b.calls.some((c) => c.state === "running"),
    )
  }

  async setToolStatus(
    name: string,
    state: "running" | "completed" | "error",
    title?: string,
    callId?: string,
  ): Promise<void> {
    if (this.concise) return
    if (!this.messageId || this.closed) {
      return
    }
    const key = callId ?? name
    const last = this.blocks[this.blocks.length - 1]
    const existing = last && last.kind === "tools" ? last.calls.find((c) => c.key === key) : undefined
    if (existing) {
      existing.state = state
      if (title !== undefined) existing.title = title
    } else {
      const call: ToolCall = { key, name, state, title }
      if (last && last.kind === "tools") {
        last.calls.push(call)
      } else {
        this.blocks.push({ kind: "tools", calls: [call] })
      }
    }
    await this.sync()
  }

  async addSubtaskButton(label: string, actionValue: string): Promise<void> {
    if (!this.messageId || this.closed) {
      return
    }
    const line = `🔗 [${label}](${actionValue})`
    const last = this.blocks[this.blocks.length - 1]
    if (last && last.kind === "message") {
      last.text = last.text ? `${last.text}\n${line}` : line
    } else {
      this.blocks.push({ kind: "message", start: this.assignedLength, text: line })
    }
    await this.sync()
  }

  async close(finalText?: string, status?: "completed" | "error" | "interrupted"): Promise<void> {
    if (!this.messageId || this.closed) {
      return
    }
    this.closed = true
    openCards.delete(this)
    await this.queue

    if (finalText !== undefined) {
      const last = this.blocks[this.blocks.length - 1]
      if (last && last.kind === "message") {
        last.text = finalText.slice(last.start)
      } else {
        // No text block yet (e.g. the reply only arrived at the end).
        const start = this.assignedLength
        this.blocks.push({ kind: "message", start, text: finalText.slice(start) })
      }
    }
    this.status = status ?? "completed"
    // The live "≈ N tok/s" is only an estimate; when the turn ends without a
    // usage report (interrupted, error) it would be the only number on the
    // card and it means nothing. A real usage line is kept — it has the
    // tokens, the cache hit rate and the context of the last step.
    if (!this.hasRealUsage) this.usageText = ""
    try {
      await this.sync()
      // Only forget the card once it really carries the final state — if the
      // update did not land, the next process has to be able to close it.
      this.forgetOpenCard()
    } catch (err) {
      // The state entry is kept on purpose: the next process has to be able
      // to close this card. The error is passed on so the caller can fall
      // back to posting the answer as a plain reply.
      logger.warn(
        `Could not write the final card state: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
      throw err
    }
  }

  // ── internals ──

  private formatSummary(call: ToolCall): string {
    const icon = TOOL_ICONS[call.state]
    return call.title ? `- ${icon} ${call.name} · ${call.title}` : `- ${icon} ${call.name}`
  }

  private buildToolPanel(block: ToolsBlock, isLatest: boolean): Record<string, unknown> | null {
    const summaries = block.calls.map((c) => this.formatSummary(c)).filter((s) => s.length > 0)
    if (summaries.length === 0) {
      return null
    }
    return {
      tag: "collapsible_panel",
      expanded: this.status === "running" && isLatest,
      background_color: "grey-50",
      border: { color: "grey", corner_radius: "8px" },
      padding: "8px 8px 8px 8px",
      header: {
        title: { tag: "plain_text", content: `🛠️ 工具 (${summaries.length})` },
        vertical_align: "center",
        padding: "8px 8px 8px 8px",
        icon: {
          tag: "standard_icon",
          token: "down-small-ccm_outlined",
          color: "grey",
          size: "16px 16px",
        },
        icon_position: "right",
        icon_expanded_angle: -180,
      },
      elements: [{ tag: "markdown", content: summaries.join("\n") }],
    }
  }

  private buildCard(blocks: Block[], sealed: boolean): Record<string, unknown> {
    const elements: Record<string, unknown>[] = []
    const lastToolsIndex = blocks.reduce(
      (last, b, i) => (b.kind === "tools" ? i : last),
      -1,
    )
    for (const [index, block] of blocks.entries()) {
      if (block.kind === "message") {
        const text = block.text.trim()
        if (text) {
          elements.push({ tag: "markdown", content: toFeishuMarkdown(text) })
        }
        continue
      }
      if (this.concise) continue
      const panel = this.buildToolPanel(block, index === lastToolsIndex)
      if (panel) elements.push(panel)
    }
    if (elements.length === 0) {
      elements.push({ tag: "markdown", content: " " })
    }
    if (!sealed && !this.concise) {
      elements.push({ tag: "markdown", content: this.statusLine() })
    }
    return {
      schema: "2.0",
      config: { wide_screen_mode: true },
      body: { elements },
    }
  }

  private rememberOpenCard(messageId: string): void {
    if (!this.stateFile) return
    try {
      // One entry per chat: a turn that is still closing must not wipe the
      // entry of the turn that is already running (that is what left cards
      // stuck on "running" after a restart).
      const open = this.readOpenCards()
      open[this.chatId] = this.stateOf(messageId)
      writeFileSync(this.stateFile, JSON.stringify(open))
    } catch (err) {
      // Not fatal — but a silent failure here means a card left open by a
      // crashed process is never closed, so it must be visible.
      logger.warn(
        `Could not remember the open card (${this.stateFile}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  private forgetOpenCard(): void {
    if (!this.stateFile) return
    try {
      const open = this.readOpenCards()
      if (open[this.chatId]?.messageId === this.messageId) {
        delete open[this.chatId]
      }
      if (Object.keys(open).length === 0) {
        rmSync(this.stateFile, { force: true })
      } else {
        writeFileSync(this.stateFile, JSON.stringify(open))
      }
    } catch (err) {
      logger.warn(
        `Could not forget the open card (${this.stateFile}): ` +
          `${err instanceof Error ? err.message : String(err)}`,
      )
    }
  }

  /** The state to remember for this card: the answer has to survive a
   *  restart, otherwise the next process can only wipe the card. */
  private stateOf(messageId: string): OpenCardState {
    return {
      messageId,
      blocks: this.blocks.map((b) =>
        b.kind === "message"
          ? { kind: "message", start: b.start, text: b.text }
          : {
              kind: "tools",
              calls: b.calls.map((c) => ({ ...c })),
            },
      ),
      ...(this.usageText ? { usage: this.usageText } : {}),
      ...(this.hasRealUsage ? { hasRealUsage: true } : {}),
    }
  }

  /** Write the remembered state now, so a restart can restore the card. */
  persistState(): void {
    if (!this.messageId) return
    this.lastStateWrite = Date.now()
    this.rememberOpenCard(this.messageId)
  }

  /** The state of the open card — used to restore it after a restart. */
  get state(): OpenCardState | null {
    if (!this.messageId) return null
    return this.stateOf(this.messageId)
  }

  /** The cards that are currently open, per chat. */
  private readOpenCards(): Record<string, OpenCardState> {
    if (!this.stateFile) return {}
    try {
      const raw = readFileSync(this.stateFile, "utf-8").trim()
      if (!raw) return {}
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const out: Record<string, OpenCardState> = {}
        for (const [chatId, value] of Object.entries(parsed as Record<string, unknown>)) {
          // The old format was a plain message id.
          if (typeof value === "string") {
            out[chatId] = { messageId: value }
            continue
          }
          if (!value || typeof value !== "object") continue
          const entry = value as Partial<OpenCardState>
          if (typeof entry.messageId !== "string") continue
          out[chatId] = {
            messageId: entry.messageId,
            ...(Array.isArray(entry.blocks) ? { blocks: entry.blocks } : {}),
            ...(typeof entry.usage === "string" ? { usage: entry.usage } : {}),
            ...(entry.hasRealUsage ? { hasRealUsage: true } : {}),
          }
        }
        return out
      }
    } catch {
      // a broken state file is not worth failing over
    }
    return {}
  }

  private baseStatus(): string {
    return this.status === "completed" ? "✅ 已完成"
      : this.status === "interrupted" ? "⚠️ 已中断（服务重启、连接断开或长时间无响应）"
      : this.status === "error" ? "❌ 失败"
      : "⏳ 运行中…"
  }

  private statusLine(): string {
    return this.usageText
      ? `${this.baseStatus()} · ${this.usageText}`
      : this.baseStatus()
  }

  private countElements(card: Record<string, unknown>): number {
    let total = 0
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) {
        value.forEach(walk)
        return
      }
      if (!value || typeof value !== "object") return
      const record = value as Record<string, unknown>
      if (typeof record.tag === "string") total += 1
      Object.values(record).forEach(walk)
    }
    walk(card)
    return total
  }

  /** Split blocks so the rendered card stays inside the element budget. */
  private splitToBudget(blocks: Block[]): { fitting: Block[]; overflow: Block[] } {
    const card = this.buildCard(blocks, false)
    if (this.countElements(card) <= ELEMENT_BUDGET) {
      return { fitting: blocks, overflow: [] }
    }
    // Keep the largest prefix that fits; the rest continues in a new card.
    for (let take = blocks.length - 1; take > 0; take--) {
      const candidate = this.buildCard(blocks.slice(0, take), true)
      if (this.countElements(candidate) <= ELEMENT_BUDGET) {
        return { fitting: blocks.slice(0, take), overflow: blocks.slice(take) }
      }
    }
    return { fitting: [], overflow: blocks }
  }

  private async sync(): Promise<void> {
    await this.enqueue(async () => {
      const active = this.blocks.slice(this.sealedBlockCount)
      const { fitting, overflow } = this.splitToBudget(active)

      if (overflow.length > 0) {
        // Seal the current card with what fits, then continue in a new one.
        const sealedCard = this.buildCard(fitting, true)
        await this.feishuClient.updateMessage(
          this.messageId!,
          JSON.stringify(sealedCard),
        )
        this.lastSentContent = JSON.stringify(sealedCard)
        this.sealedBlockCount += fitting.length
        const nextCard = this.buildCard(this.blocks.slice(this.sealedBlockCount), false)
        const res = await this.feishuClient.sendMessage(this.chatId, {
          msg_type: "interactive",
          content: JSON.stringify(nextCard),
        })
        this.messageId = (res.data?.["message_id"] as string | undefined) ?? this.messageId
        this.lastSentContent = JSON.stringify(nextCard)
        return
      }

      const card = this.buildCard(active, false)
      const content = JSON.stringify(card)
      if (this.messageId) {
        await this.feishuClient.updateMessage(this.messageId, content)
      } else {
        const res = await this.feishuClient.sendMessage(this.chatId, {
          msg_type: "interactive",
          content,
        })
        this.messageId = (res.data?.["message_id"] as string | undefined) ?? null
        if (this.messageId) this.rememberOpenCard(this.messageId)
      }
      this.lastSentContent = content
      // Keep the remembered state fresh: if the process dies, the next one
      // can restore the answer instead of wiping the card.
      const now = Date.now()
      if (this.messageId && now - this.lastStateWrite > STATE_WRITE_INTERVAL_MS) {
        this.lastStateWrite = now
        this.rememberOpenCard(this.messageId)
      }
    })
  }

  private async enqueue(fn: () => Promise<void>): Promise<void> {
    // A failed update must not poison the queue — otherwise every later
    // update becomes a silent no-op and the card never reaches its final
    // state. The failure is still reported to the caller (so start() can
    // fail loudly) while the chain stays usable for the next write.
    const next = this.queue.catch(() => {}).then(fn)
    this.queue = next.catch(() => {})
    try {
      await next
    } catch (err) {
      logger.warn(
        `Card update failed: ${err instanceof Error ? err.message : String(err)}`,
      )
      throw err
    }
  }
}
