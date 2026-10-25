/**
 * Slash command handler for Feishu → opencode bridge.
 *
 * Intercepts messages starting with "/" and routes them to
 * the appropriate opencode API endpoint instead of sending
 * them as plain text to the AI agent.
 */

import type { SessionManager } from "../session/session-manager.js"
import type { StreamingBridge } from "./streaming-integration.js"
import type { EventProcessor } from "../streaming/event-processor.js"
import { addListener, removeListener, type EventListenerMap } from "../utils/event-listeners.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { Logger } from "../utils/logger.js"
import type { AgentInfo, ModelInfo, OpencodeGateway } from "../opencode/gateway.js"
import { eventPayload } from "../opencode/events.js"
import { toFeishuMarkdown } from "../feishu/markdown.js"
import { formatTokens } from "../streaming/usage.js"
import { startUpgradeProgress } from "../opencode/upgrade-progress.js"
import {
  buildUpgradeFailedCard,
  buildUpgradeNoopCard,
  buildUpgradeProgressCard,
  buildUpgradeRestartCard,
  formatUpgradeProgress,
} from "./upgrade-card.js"
import { ReplyModeStore, type ReplyMode } from "./reply-mode.js"

// ── Dependency injection interface ──

export interface CommandHandlerDeps {
  opencode: OpencodeGateway
  sessionManager: SessionManager
  feishuClient: FeishuApiClient
  logger: Logger
  /** Used to run opencode's own commands and stream the answer into a card. */
  streamingBridge?: StreamingBridge
  eventListeners?: EventListenerMap
  eventProcessor?: EventProcessor
  /** Makes sure the opencode server is running — it may have been stopped
   *  while it was idle. */
  ensureServer?: () => Promise<void>
  /** The server supervisor — its idle stop can be switched on and off. */
  supervisor?: {
    isIdleWatchEnabled(): boolean
    setIdleWatchEnabled(enabled: boolean): void
    idleTimeoutMinutes(): number
    setIdleTimeoutMinutes(minutes: number): void
    /** Stop the server (it is started again on demand). */
    stop?(): Promise<void>
    /** Upgrade the opencode installation. */
    upgradeOpencode?(target?: string): Promise<{ success: boolean; output: string }>
  }
  /** Per-chat reply detail, set by /回复 and read by the streaming bridge. */
  replyModes?: ReplyModeStore
}

// ── Types ──

export type CommandHandler = (
  feishuKey: string,
  chatId: string,
  messageId: string,
  commandText: string,
  options?: CommandHandlerOptions,
) => Promise<boolean>

export interface CommandHandlerOptions {
  /**
   * The model menu card this command came from. The menu is then updated
   * in place instead of sending a new card.
   */
  menuId?: string
}

interface Session {
  id: string
  title?: string
  time?: { created: number; updated: number }
  summary?: { additions: number; deletions: number; files: number }
  /** The project the session belongs to — sessions are per directory. */
  directory?: string
  location?: { directory?: string }
}

// ── Card builders ──

function formatRelativeTime(timestamp: number): string {
  const now = Date.now()
  const diffMs = Math.max(0, now - timestamp)
  const diffMin = Math.floor(diffMs / 60_000)

  if (diffMin < 1) return "刚刚"
  if (diffMin < 60) return `${diffMin}分钟前`

  const diffHr = Math.floor(diffMin / 60)
  if (diffHr < 24) return `${diffHr}小时前`

  const diffDay = Math.floor(diffHr / 24)
  return `${diffDay}天前`
}

function truncateTitle(title: string, maxChars = 30): string {
  const trimmed = title.trim()
  if (trimmed.length <= maxChars) return trimmed
  if (maxChars <= 3) return trimmed.slice(0, maxChars)
  return trimmed.slice(0, maxChars - 3) + "..."
}

/**
 * Level 1 of the session menu: the projects, with how many sessions each
 * one has.
 */
function buildProjectsCard(
  sessions: Session[],
  menuId = "",
  feishuKey = "",
  notice?: string,
): Record<string, unknown> {
  const byProject = new Map<string, Session[]>()
  for (const session of sessions) {
    // A session without a directory (the server does not always report one)
    // still has to show up somewhere.
    const dir = session.location?.directory ?? session.directory ?? "（未知项目）"
    const list = byProject.get(dir) ?? []
    list.push(session)
    byProject.set(dir, list)
  }

  const projects = [...byProject.entries()].sort((a, b) => b[1].length - a[1].length)
  const total = sessions.length
  const head = notice
    ? `${notice}\n**第 1 步：选择项目**（共 ${total} 个会话，${projects.length} 个项目）`
    : `**第 1 步：选择项目**（共 ${total} 个会话，${projects.length} 个项目）`

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "📂 选择项目" },
      template: "blue",
    },
    elements: [
      { tag: "markdown", content: head },
      ...projects.map(([dir, own]) => {
        const name = dir.startsWith("（") ? dir : (dir.split("/").filter(Boolean).at(-1) ?? dir)
        return {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: { tag: "plain_text", content: `📁 ${truncateTitle(name)} (${own.length})` },
              value: {
                action: "session_connect",
                menu: menuId,
                command: `/sessions ${dir}`,
              },
            },
          ],
        }
      }),
      {
        tag: "markdown",
        content: "_点一个项目，再选它的会话_",
      },
    ],
  }
}

function buildSessionsCard(
  sessions: Session[],
  currentSessionId?: string,
  menuId = "",
  notice?: string,
  directory?: string,
): Record<string, unknown> {
  const recentSessions = sessions.slice(0, 20)
  const projectName = directory
    ? (directory.split("/").filter(Boolean).at(-1) ?? directory)
    : undefined
  const head = projectName
    ? `**第 2 步：${truncateTitle(projectName)} 的会话**（共 ${sessions.length} 个）`
    : "**点击连接到对应会话：**"
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: "📋 选择会话",
      },
      template: "blue",
    },
    elements: [
      {
        tag: "markdown",
        content: notice ? `${notice}\n${head}` : head,
      },
      ...recentSessions.map((s) => {
        const isCurrentSession = s.id === currentSessionId
        const title = s.title?.trim() ? truncateTitle(s.title) : "未命名会话"
        const relative = s.time?.updated
          ? formatRelativeTime(s.time.updated)
          : "未知时间"
        const filesSegment =
          typeof s.summary?.files === "number" ? `${s.summary.files}文件` : null
        const segments = [title, relative, filesSegment].filter(
          (v): v is string => typeof v === "string" && v.length > 0,
        )
        const label = `${isCurrentSession ? "▶ " : ""}${segments.join(" · ")}`
        return {
          tag: "action",
          actions: [
            {
              tag: "button",
              text: {
                tag: "plain_text",
                content: label,
              },
              value: {
                action: "session_connect",
                menu: menuId,
                command: `/connect ${s.id}`,
              },
            },
          ],
        }
      }),
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "← 返回项目列表" },
            value: {
              action: "session_connect",
              menu: menuId,
              command: "/sessions",
            },
          },
        ],
      },
    ],
  }
}

// ── Help card builder ──

function buildHelpCard(
  opencodeCommands: { name: string; description?: string }[] = [],
  menuId = "",
  notice?: string,
): Record<string, unknown> {
  return {
    config: { wide_screen_mode: true },
    header: {
      title: {
        tag: "plain_text",
        content: "⚡ 命令菜单",
      },
      template: "blue",
    },
    elements: [
      {
        tag: "markdown",
        content: notice ? `${notice}\n**选择要执行的命令：**` : "**选择要执行的命令：**",
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "🆕 新建会话" },
            type: "primary",
            value: { action: "command_execute", menu: menuId, command: "/new" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🔌 连接会话" },
            value: { action: "command_execute", menu: menuId, command: "/sessions" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "⏹ 打断当前任务" },
            type: "danger",
            value: { action: "command_execute", menu: menuId, command: "/abort" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🧠 模型菜单" },
            value: { action: "command_execute", menu: menuId, command: "/模型" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🛌 定时关闭" },
            value: { action: "command_execute", menu: menuId, command: "/自动关闭" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🗜 压缩上下文" },
            value: { action: "command_execute", menu: menuId, command: "/compact" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🔄 更新 opencode" },
            value: { action: "command_execute", menu: menuId, command: "/更新" },
          },
        ],
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "📊 状态" },
            value: { action: "command_execute", menu: menuId, command: "/状态" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🧩 模式" },
            value: { action: "command_execute", menu: menuId, command: "/模式" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "💭 思考" },
            value: { action: "command_execute", menu: menuId, command: "/思考" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "💬 回复" },
            value: { action: "command_execute", menu: menuId, command: "/回复" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "📁 项目" },
            value: { action: "command_execute", menu: menuId, command: "/项目" },
          },
        ],
      },
      {
        tag: "markdown",
        content:
          "_打字命令：`/状态` · `/模式 [build|plan]` · `/思考 [default|low|high|max]` · `/回复 [简洁|标准]` · `/clear` · `/bind <会话ID>` · `/connect <会话ID>` · `/模型 [provider] [页码]` · `/自动关闭 [不关闭|15|30|60]`_",
      },
      ...buildOpencodeCommandElements(opencodeCommands),
    ],
  }
}

/**
 * The commands opencode itself offers in this project (from /api/command).
 * They are shown as text — they are executed in the opencode TUI, not by
 * the bridge.
 */
function buildOpencodeCommandElements(
  commands: { name: string; description?: string }[],
): Record<string, unknown>[] {
  if (commands.length === 0) {
    return [
      {
        tag: "markdown",
        content: "**opencode 命令：**\n_（当前项目没有自定义命令）_",
      },
    ]
  }
  const lines = commands.map((c) => {
    const description = c.description ? ` — ${c.description}` : ""
    return `- /${c.name}${description}`
  })
  return [
    {
      tag: "markdown",
      content: `**opencode 命令：**（点击即可运行）\n${lines.join("\n")}`,
    },
    {
      tag: "action",
      actions: commands.map((c) => ({
        tag: "button",
        text: { tag: "plain_text", content: `/${c.name}` },
        value: { action: "command_execute", command: `/${c.name}` },
      })),
    },
  ]
}

/**
 * The model of the session, both as "provider/id" and as the name the user
 * knows it by.
 */
function describeCurrentModel(
  session: { model?: { id?: string; providerID?: string } } | null,
  models: ModelInfo[],
): { current: string; currentName: string; currentProvider?: string } {
  const model = session?.model
  if (!model?.id) {
    return { current: "未知", currentName: "未知", currentProvider: undefined }
  }
  const providerID = model.providerID
  const current = `${providerID ?? ""}/${model.id}`
  const found = models.find((m) => m.id === model.id && (!providerID || m.providerID === providerID))
  return {
    current,
    currentName: found?.name ?? model.id,
    currentProvider: providerID,
  }
}

/** The idle stop options: 0 = never, otherwise the minutes. */
function parseIdleStopValue(value: string): number | null {
  if (["off", "关", "关闭", "停用", "never", "不关闭", "false", "0"].includes(value)) return 0
  const minutes = Number(value.replace(/\D/g, ""))
  if (!Number.isFinite(minutes)) return null
  if (![0, 15, 30, 60].includes(minutes)) return null
  return minutes
}

function describeIdleStop(minutes: number): string {
  return minutes > 0 ? `${minutes} 分钟空闲后自动关闭` : "不自动关闭（一直开着）"
}

/**
 * Free models carry "free" in their id — ":free" on OpenRouter, "-free" on
 * the opencode provider.
 */
function isFreeModel(model: ModelInfo): boolean {
  return /free/i.test(model.id)
}

/**
 * Level 1 of the model menu: the providers, with how many models each has.
 */
function buildProviderCard(
  providers: string[],
  models: ModelInfo[],
  currentProvider: string | undefined,
  menuId: string,
  notice?: string,
  currentName?: string,
): Record<string, unknown> {
  const head = [
    currentName ? `**当前模型：** ${currentName}` : "",
    "**第 1 步：选择 provider**",
  ]
    .filter(Boolean)
    .join("\n")
  const elements: Record<string, unknown>[] = [
    {
      tag: "markdown",
      content: notice ? `${notice}\n${head}` : head,
    },
  ]

  for (let i = 0; i < providers.length; i += 3) {
    const chunk = providers.slice(i, i + 3)
    elements.push({
      tag: "action",
      actions: chunk.map((provider) => {
        const own = models.filter((m) => m.providerID === provider)
        const free = own.filter(isFreeModel).length
        const count = free > 0 && free < own.length ? `${own.length}, 免费 ${free}` : String(own.length)
        const isCurrent = provider === currentProvider
        return {
          tag: "button",
          text: {
            tag: "plain_text",
            content: isCurrent ? `✅ ${provider} (${count})` : `${provider} (${count})`,
          },
          type: isCurrent ? "primary" : "default",
          value: { action: "model_menu", menu: menuId, command: `/模型 ${provider}` },
        }
      }),
    })
  }

  elements.push({
    tag: "action",
    actions: [
      {
        tag: "button",
        text: { tag: "plain_text", content: "← 返回命令菜单" },
        value: { action: "command_execute", menu: menuId, command: "/help" },
      },
    ],
  })
  elements.push({
    tag: "markdown",
    content: "_点一个 provider 进去看它的模型；也可以 `/模型 <关键词>` 直接搜_",
  })

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "🧠 模型菜单" },
      template: "blue",
    },
    elements,
  }
}

/**
 * Level 2 of the model menu: the models of one provider, one button each,
 * with paging when there are more than a page's worth.
 */
function buildModelCard(options: {
  models: ModelInfo[]
  current: string
  title: string
  total: number
  page: number
  pages: number
  provider?: string
  menuId: string
  notice?: string
}): Record<string, unknown> {
  const { models, current, title, total, page, pages, provider, menuId, notice } = options
  const head = `**第 2 步：${title}**（共 ${total} 个，第 ${page}/${pages} 页）\n**当前模型：** ${current}`
  const elements: Record<string, unknown>[] = [
    {
      tag: "markdown",
      content: notice ? `${notice}\n${head}` : head,
    },
  ]

  for (let i = 0; i < models.length; i += 4) {
    const chunk = models.slice(i, i + 4)
    elements.push({
      tag: "action",
      actions: chunk.map((m) => {
        // The button is full width, so the name fits — only cut absurdly
        // long ones.
        const label = m.name.length > 40 ? `${m.name.slice(0, 39)}…` : m.name
        const isCurrent = `${m.providerID}/${m.id}` === current
        return {
          tag: "button",
          text: { tag: "plain_text", content: isCurrent ? `✅ ${label}` : label },
          type: isCurrent ? "primary" : "default",
          value: {
            action: "model_menu",
            menu: menuId,
            command: `/模型 ${m.providerID}|${m.id}`,
          },
        }
      }),
    })
  }

  // Back to the provider list — always available on level 2.
  const backAction = {
    tag: "button",
    text: { tag: "plain_text", content: "← 返回 provider 列表" },
    value: { action: "model_menu", menu: menuId, command: "/模型" },
  }

  if (pages > 1 && provider) {
    const actions: Record<string, unknown>[] = [backAction]
    if (page > 1) {
      actions.push({
        tag: "button",
        text: { tag: "plain_text", content: `← 上一页 (${page - 1})` },
        value: { action: "model_menu", menu: menuId, command: `/模型 ${provider} ${page - 1}` },
      })
    }
    if (page < pages) {
      actions.push({
        tag: "button",
        text: { tag: "plain_text", content: `下一页 (${page + 1}) →` },
        type: "primary",
        value: { action: "model_menu", menu: menuId, command: `/模型 ${provider} ${page + 1}` },
      })
    }
    elements.push({ tag: "action", actions })
  } else {
    elements.push({ tag: "action", actions: [backAction] })
  }

  elements.push({
    tag: "markdown",
    content: "_点模型即切换_",
  })

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "🧠 模型菜单" },
      template: "blue",
    },
    elements,
  }
}

// ── Model menu ──

/** How long a model menu card stays navigable. */
const MODEL_MENU_TTL_MS = 30 * 60 * 1000

/** Which view the menu card is showing. */
interface ModelMenuView {
  /** 1 = the provider list, 2 = the models of one provider. */
  level: 1 | 2
  /** The provider (or the search keyword) of level 2. */
  provider?: string
  page: number
}

/** The command menu card, so it can be updated in place. */
interface MenuCardEntry {
  id: string
  messageId: string
  chatId: string
  createdAt: number
}

/** The session list card, so it can be updated in place. */
interface SessionMenuEntry {
  id: string
  messageId: string
  chatId: string
  createdAt: number
  /** The title of the bound session — shown after a connection. */
  title?: string
  /** Which view the card is showing. */
  view?: SessionMenuView
}

/** The session menu has two levels: the projects, then their sessions. */
interface SessionMenuView {
  level: 1 | 2
  /** The project directory (level 2). */
  directory?: string
  page: number
}

/** The idle stop option card, so it can be updated in place. */
interface IdleStopMenuEntry {
  id: string
  messageId: string
  chatId: string
  createdAt: number
}

/** A model menu card that can be updated in place. */
interface ModelMenuEntry {
  id: string
  /** The card's own message id — this is what gets patched. */
  messageId: string
  chatId: string
  /** The key the session is bound to ("chat" or "chat:root" in a group). */
  feishuKey: string
  createdAt: number
  view: ModelMenuView
}

// ── Compaction card ──

type CompactionCardStatus = "running" | "waiting" | "done" | "failed"

interface CompactionCardState {
  status: CompactionCardStatus
  /** The handoff summary opencode wrote — the actual result of the compaction. */
  summary?: string
  /** Tokens the summarization itself used. */
  input?: number
  output?: number
  error?: string
}

/** A /compact can sit in opencode's queue for a while; warn, don't fail. */
const COMPACTION_WARN_MS = 5 * 60_000
/** After this long nothing is coming. */
const COMPACTION_GIVE_UP_MS = 30 * 60_000

/**
 * The compaction report. It is honest about the state: the request returns
 * long before the summary exists, so "running" is not "done".
 */
function buildCompactionCard(state: CompactionCardState): Record<string, unknown> {
  const titles: Record<CompactionCardStatus, string> = {
    running: "🗜 正在压缩…",
    waiting: "⏳ 压缩还没有结果",
    done: "✅ 会话已压缩",
    failed: "❌ 压缩失败",
  }
  const templates: Record<CompactionCardStatus, string> = {
    running: "blue",
    waiting: "orange",
    done: "green",
    failed: "red",
  }

  const elements: Record<string, unknown>[] = []
  if (state.status === "done") {
    const usage = `${formatTokens(state.input ?? 0)} in · ${formatTokens(state.output ?? 0)} out`
    elements.push({ tag: "markdown", content: `**${usage}**` })
    if (state.summary) {
      elements.push({
        tag: "collapsible_panel",
        expanded: false,
        background_color: "grey-50",
        border: { color: "grey", corner_radius: "8px" },
        padding: "8px 8px 8px 8px",
        header: {
          title: { tag: "plain_text", content: "📄 压缩摘要" },
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
        elements: [
          { tag: "markdown", content: toFeishuMarkdown(state.summary) },
        ],
      })
    }
  } else if (state.status === "failed") {
    elements.push({ tag: "markdown", content: state.error || "未知错误" })
  } else if (state.status === "waiting") {
    elements.push({
      tag: "markdown",
      content: "服务端还没有报告结果，压缩可能仍在排队。结果出来后会更新这张卡。",
    })
  } else {
    elements.push({
      tag: "markdown",
      content: "opencode 正在生成摘要，完成后这里会显示结果。",
    })
  }

  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: titles[state.status] },
      template: templates[state.status],
    },
    elements,
  }
}

/** opencode's failure payloads are not consistent: a message, a string, ... */
function compactionErrorMessage(error: unknown): string {
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message
    if (typeof message === "string" && message) return message
  }
  return "未知错误"
}

/** The compaction a card is waiting for. */
interface PendingCompaction {
  sessionId: string
  /** The card to patch when the result arrives. */
  cardMessageId?: string
  settled: boolean
  listener: (event: unknown) => void
  warnTimer?: ReturnType<typeof setTimeout>
  giveUpTimer?: ReturnType<typeof setTimeout>
  settle: (state: CompactionCardState) => void
}

/** A card that can be updated in place (status, mode, thinking, reply). */
interface SimpleMenuEntry {
  id: string
  messageId: string
  chatId: string
  createdAt: number
}

/** A button that hands a command back to the handler, keeping the card id. */
function menuButton(label: string, command: string, menuId: string): Record<string, unknown> {
  return {
    tag: "button",
    text: { tag: "plain_text", content: label },
    value: { action: "command_execute", menu: menuId, command },
  }
}

interface StatusCardData {
  sessionId: string
  title?: string
  directory?: string
  model?: { id?: string; providerID?: string; variant?: string } | null
  agent?: string
  running: boolean
  context?: number
  limit?: number
  tokens?: {
    input?: number
    output?: number
    reasoning?: number
    cache?: { read?: number; write?: number }
  }
}

/** /状态 — where the session lives, what it runs and how full the window is. */
function buildStatusCard(data: StatusCardData, menuId: string): Record<string, unknown> {
  const lines: string[] = []
  if (data.directory) lines.push(`**工作区**：\`${data.directory}\``)
  const title = data.title?.trim()
  lines.push(`**会话**：${title ? `${title} · ` : ""}\`${data.sessionId}\``)
  lines.push(
    data.model?.id && data.model.providerID
      ? `**模型**：\`${data.model.providerID}/${data.model.id}\` · 思考 \`${data.model.variant || "default"}\``
      : "**模型**：未知（先发一条消息或到 /模型 选一个）",
  )
  lines.push(`**模式**：${data.agent || "build"}`)
  lines.push(`**任务**：${data.running ? "🟢 运行中" : "⚪ 空闲"}`)
  if (data.context && data.context > 0) {
    const limit = data.limit && data.limit > 0 ? data.limit : undefined
    const of = limit
      ? ` / ${formatTokens(limit)}（${((data.context / limit) * 100).toFixed(2)}%）`
      : ""
    lines.push(`**上下文**：${formatTokens(data.context)}${of}`)
  }
  const tokens = data.tokens
  if (tokens) {
    lines.push(
      `**累计**：input ${formatTokens(tokens.input ?? 0)} · output ${formatTokens(tokens.output ?? 0)}` +
        ` · 缓存读 ${formatTokens(tokens.cache?.read ?? 0)}`,
    )
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: "📊 状态" }, template: "blue" },
    elements: [
      { tag: "markdown", content: lines.join("\n") },
      {
        tag: "action",
        actions: [
          menuButton("🔄 刷新", "/状态", menuId),
          menuButton("🧠 模型", "/模型", menuId),
          menuButton("🧩 模式", "/模式", menuId),
          menuButton("💭 思考", "/思考", menuId),
          menuButton("💬 回复", "/回复", menuId),
        ],
      },
    ],
  }
}

/** /模式 — the primary agents the server can run. */
function buildModeCard(
  agents: AgentInfo[],
  current: string,
  menuId: string,
  notice?: string,
): Record<string, unknown> {
  const buttons = agents.map((agent) => {
    const isCurrent = agent.id === current
    return {
      tag: "button",
      text: { tag: "plain_text", content: `${isCurrent ? "✅ " : ""}${agent.name || agent.id}` },
      type: isCurrent ? "primary" : "default",
      value: { action: "command_execute", menu: menuId, command: `/模式 ${agent.id}` },
    }
  })
  const elements: Record<string, unknown>[] = [
    {
      tag: "markdown",
      content: notice
        ? `${notice}\n**当前：${current}**`
        : `**当前：${current}**\n选一个运行模式：`,
    },
    {
      tag: "action",
      actions: buttons.length > 0 ? buttons : [menuButton("返回命令菜单", "/help", menuId)],
    },
  ]
  if (agents.length > 0) {
    elements.push({
      tag: "markdown",
      content: agents
        .map((agent) => `- \`${agent.id}\`${agent.description ? `：${agent.description}` : ""}`)
        .join("\n"),
    })
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: "🧩 运行模式" }, template: "blue" },
    elements,
  }
}

/** /思考 — the reasoning-effort variants of the current model. */
function buildThinkingCard(
  variants: Array<{ id: string; name?: string }>,
  current: string,
  menuId: string,
  notice?: string,
): Record<string, unknown> {
  const all = [{ id: "default" }, ...variants.filter((v) => v.id !== "default")]
  const buttons = all.map((variant) => {
    const isCurrent = variant.id === current
    return {
      tag: "button",
      text: {
        tag: "plain_text",
        content: `${isCurrent ? "✅ " : ""}${variant.id}`,
      },
      type: isCurrent ? "primary" : "default",
      value: { action: "command_execute", menu: menuId, command: `/思考 ${variant.id}` },
    }
  })
  const elements: Record<string, unknown>[] = [
    {
      tag: "markdown",
      content: notice
        ? `${notice}\n**当前：${current}**`
        : variants.length > 0
          ? `**当前：${current}**\n思考级别（推理强度）：`
          : "**当前模型没有可选的思考级别。**",
    },
  ]
  if (variants.length > 0) {
    elements.push({ tag: "action", actions: buttons })
    elements.push({ tag: "markdown", content: "_default 表示用模型自己的默认值_" })
  } else {
    elements.push({
      tag: "action",
      actions: [menuButton("🧠 换个模型", "/模型", menuId)],
    })
  }
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: "💭 思考级别" }, template: "blue" },
    elements,
  }
}

/** /回复 — how much of a turn the card shows. */
function buildReplyModeCard(
  current: ReplyMode,
  menuId: string,
  notice?: string,
): Record<string, unknown> {
  const options: Array<{ mode: ReplyMode; label: string }> = [
    { mode: "concise", label: "简洁" },
    { mode: "standard", label: "标准" },
  ]
  return {
    config: { wide_screen_mode: true },
    header: { title: { tag: "plain_text", content: "💬 回复详细程度" }, template: "blue" },
    elements: [
      {
        tag: "markdown",
        content: notice
          ? `${notice}\n**当前：${current === "concise" ? "简洁" : "标准"}**`
          : `**当前：${current === "concise" ? "简洁" : "标准"}**\n选一种：`,
      },
      {
        tag: "action",
        actions: options.map((option) => {
          const isCurrent = option.mode === current
          return {
            tag: "button",
            text: {
              tag: "plain_text",
              content: `${isCurrent ? "✅ " : ""}${option.label}`,
            },
            type: isCurrent ? "primary" : "default",
            value: {
              action: "command_execute",
              menu: menuId,
              command: `/回复 ${option.label}`,
            },
          }
        }),
      },
      {
        tag: "markdown",
        content:
          "_简洁：只显示回答正文，不显示工具面板和状态行。\n标准：正文 + 工具面板 + 状态行。_",
      },
    ],
  }
}

function parseReplyMode(value: string): ReplyMode | null {
  const v = value.trim().toLowerCase()
  if (!v) return null
  if (["简洁", "简短", "concise", "simple", "short"].includes(v)) return "concise"
  if (["标准", "详细", "standard", "normal"].includes(v)) return "standard"
  return null
}

// ── Factory ──

export function createCommandHandler(deps: CommandHandlerDeps): CommandHandler {
  const { opencode, sessionManager, feishuClient, logger } = deps

  // The model menu cards that can be updated in place, plus the latest one
  // per chat so that typing /模型 again refreshes the same card.
  const modelMenus = new Map<string, ModelMenuEntry>()
  const latestMenuByChat = new Map<string, string>()
  /** The idle stop option cards, per chat. */
  const idleStopMenus = new Map<string, IdleStopMenuEntry>()
  const latestIdleStopByChat = new Map<string, string>()
  /** The session list cards, per chat. */
  const sessionMenus = new Map<string, SessionMenuEntry>()
  const latestSessionMenuByChat = new Map<string, string>()
  /** The command menu cards — they turn into the session list on a click. */
  const menuCards = new Map<string, MenuCardEntry>()
  const latestMenuCardByChat = new Map<string, string>()
  /** Compactions whose result has not arrived yet, keyed by session. */
  const pendingCompactions = new Map<string, PendingCompaction>()
  /** Status / mode / thinking / reply cards, all updatable in place. */
  const simpleMenus = new Map<string, SimpleMenuEntry>()
  /** Fallback when no persistent store was injected (tests, embedded use). */
  const localReplyModes = new Map<string, ReplyMode>()

  /**
   * Answer on the menu card the user clicked, instead of sending a new
   * message. Falls back to a text reply when the card is unknown.
   */
  async function replyOnMenuCard(
    chatId: string,
    messageId: string,
    menuId: string | undefined,
    text: string,
    notice: string,
  ): Promise<void> {
    const card = findMenuCard(menuId)
    if (!card) {
      await replyText(chatId, messageId, text)
      return
    }
    const updated = buildHelpCard([], card.id, notice)
    await publishMenuCard(chatId, messageId, card, updated, card.id)
  }

  /**
   * The card a menu button belongs to. Every menu shares one registry — a
   * button in the command menu opens its menu *in that card*, so the model
   * picker and the idle stop options have to find the command menu's card.
   */
  const findMenuCard = (menuId?: string): MenuCardEntry | undefined => {
    if (!menuId) return undefined
    return (
      menuCards.get(menuId) ??
      sessionMenus.get(menuId) ??
      modelMenus.get(menuId) ??
      idleStopMenus.get(menuId) ??
      simpleMenus.get(menuId)
    )
  }

  const purgeModelMenus = (now = Date.now()): void => {
    for (const [id, entry] of modelMenus) {
      if (now - entry.createdAt > MODEL_MENU_TTL_MS) {
        modelMenus.delete(id)
        if (latestMenuByChat.get(entry.chatId) === id) latestMenuByChat.delete(entry.chatId)
      }
    }
  }

  const newMenuId = (): string =>
    `mm_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`

  async function replyText(
    _chatId: string,
    messageId: string,
    text: string,
  ): Promise<void> {
    await feishuClient.replyMessage(messageId, {
      msg_type: "text",
      content: JSON.stringify({ text }),
    })
  }

  async function handleNew(
    feishuKey: string,
    chatId: string,
    messageId: string,
    menuId?: string,
  ): Promise<void> {
    const data = await opencode.createSession({
      title: `Feishu chat ${feishuKey}`,
      directory: process.env.OPENCODE_CWD || process.cwd(),
    })

    sessionManager.deleteMapping(feishuKey)
    sessionManager.setMapping(feishuKey, data.id)
    logger.info(`/new: created session ${data.id}, bound ${feishuKey}`)
    await replyOnMenuCard(
      chatId,
      messageId,
      menuId,
      `已创建并切换到新会话: ${data.id}`,
      `✅ 已创建并切换到新会话 ${data.id}`,
    )
  }

  async function handleAbort(
    feishuKey: string,
    chatId: string,
    messageId: string,
    menuId?: string,
  ): Promise<void> {
    const mapping = sessionManager.getSession(feishuKey)
    if (!mapping) {
      await replyText(chatId, messageId, "当前没有绑定的会话。")
      return
    }

    try {
      await opencode.abort(mapping.session_id)
    } catch (e) {
      throw new Error(`Abort failed: ${e}`)
    }

    logger.info(`/abort: aborted session ${mapping.session_id}`)
    await replyOnMenuCard(
      chatId,
      messageId,
      menuId,
      `已打断当前这一轮（会话 ${mapping.session_id} 保留，可以接着聊）`,
      `⏹ 已打断当前这一轮（会话 ${mapping.session_id} 保留，可以接着聊）`,
    )
  }

  async function handleSessions(
    feishuKey: string,
    chatId: string,
    messageId: string,
    menuId?: string,
    directory?: string,
  ): Promise<void> {
    // Every session of every project — the list is for picking one by hand,
    // so it must not be limited to the directory this bridge runs in.
    const sessions = (await opencode.listAllSessions(100)) as Session[]
    if (sessions.length === 0) {
      await replyText(chatId, messageId, "暂无会话。")
      return
    }

    // The card of this chat is refreshed instead of piling up new ones.
    // A click in the command menu turns THAT card into the session list.
    const latest = latestSessionMenuByChat.get(chatId)
    const existing = menuId
      ? ((sessionMenus.get(menuId) ?? findMenuCard(menuId)) as SessionMenuEntry | undefined)
      : latest
        ? sessionMenus.get(latest)
        : undefined
    const id = existing?.id ?? menuId ?? newMenuId()

    // Level 1: the projects. Level 2: the sessions of one project.
    if (!directory) {
      const card = buildProjectsCard(sessions, id, feishuKey)
      await publishSessionCard(chatId, messageId, existing, card, id, { level: 1, page: 1 })
      return
    }

    const currentSessionId = await sessionManager.getExisting(feishuKey)
    const own = sessions.filter((s) => (s.location?.directory ?? s.directory) === directory)
    if (own.length === 0) {
      await replyText(chatId, messageId, `项目 ${directory} 下没有会话。`)
      return
    }

    if (currentSessionId) {
      const existingIndex = own.findIndex((s) => s.id === currentSessionId)
      if (existingIndex >= 0) {
        const current = own.splice(existingIndex, 1)[0]
        if (current) own.unshift(current)
      }
    }

    const card = buildSessionsCard(own, currentSessionId, id, undefined, directory)
    await publishSessionCard(chatId, messageId, existing, card, id, {
      level: 2,
      directory,
      page: 1,
    })
  }

  /** Put the session list on the chat — updating the one that is there. */
  async function publishSessionCard(
    chatId: string,
    messageId: string,
    existing: SessionMenuEntry | undefined,
    card: Record<string, unknown>,
    menuId: string,
    view?: SessionMenuView,
  ): Promise<void> {
    if (existing) {
      const res = await feishuClient.updateMessage(
        existing.messageId,
        JSON.stringify(card),
      )
      if (res.code === 0) {
        if (view) existing.view = view
        return
      }
      logger.warn(`Could not update the session card: ${res.code} ${res.msg}`)
    }
    const res = await feishuClient.replyMessage(messageId, {
      msg_type: "interactive",
      content: JSON.stringify(card),
    })
    const cardMessageId = res.data?.["message_id"] as string | undefined
    if (!cardMessageId) {
      logger.warn("The session card was sent but its message id is unknown")
      return
    }
    sessionMenus.set(menuId, {
      id: menuId,
      messageId: cardMessageId,
      chatId,
      createdAt: Date.now(),
      ...(view ? { view } : {}),
    })
    latestSessionMenuByChat.set(chatId, menuId)
    // The command menu card and the session list are the same card.
    menuCards.set(menuId, {
      id: menuId,
      messageId: cardMessageId,
      chatId,
      createdAt: Date.now(),
    })
    latestMenuCardByChat.set(chatId, menuId)
  }

  async function handleConnect(
    feishuKey: string,
    chatId: string,
    messageId: string,
    targetSessionId: string,
    menuId?: string,
  ): Promise<void> {
    const target = await opencode.getSession(targetSessionId)
    if (!target) {
      await replyText(chatId, messageId, "会话不存在。")
      return
    }

    // Unbind current mapping if exists
    sessionManager.deleteMapping(feishuKey)

    // Set new mapping
    const success = sessionManager.setMapping(feishuKey, targetSessionId)
    if (!success) {
      throw new Error("Failed to set session mapping")
    }
    logger.info(`/connect: bound ${feishuKey} to session ${targetSessionId}`)

    // The card stays where it is — it shows the session that is now bound.
    const menu = menuId
      ? ((sessionMenus.get(menuId) ?? findMenuCard(menuId)) as SessionMenuEntry | undefined)
      : undefined
    if (menu) {
      const sessions = (await opencode
        .listSessions({ directory: process.env.OPENCODE_CWD || process.cwd() })
        .catch(() => [])) as Session[]
      const current = await sessionManager.getExisting(feishuKey)
      const label = target.title?.trim() ? truncateTitle(target.title) : targetSessionId
      const card = buildSessionsCard(
        sessions.length > 0 ? sessions : [{ id: targetSessionId }],
        current ?? targetSessionId,
        menu.id,
        `✅ 已连接到 ${label}`,
      )
      await publishSessionCard(chatId, messageId, menu, card, menu.id)
      return
    }
    await replyText(chatId, messageId, `已连接到会话: ${targetSessionId}`)
  }

  async function handleHelp(
    chatId: string,
    messageId: string,
    menuId?: string,
  ): Promise<void> {
    // The opencode commands are per project — fetch them so the menu shows
    // what this project actually offers.
    let opencodeCommands: { name: string; description?: string }[] = []
    try {
      opencodeCommands = await opencode.commands()
    } catch (err) {
      logger.warn(`Could not fetch the opencode commands: ${err}`)
    }

    // The menu card is a card of its own: clicking "连接会话" turns it into
    // the session list instead of sending another card.
    const latest = latestMenuCardByChat.get(chatId)
    const existing = menuId
      ? menuCards.get(menuId)
      : latest
        ? menuCards.get(latest)
        : undefined
    const id = existing?.id ?? menuId ?? newMenuId()
    const card = buildHelpCard(opencodeCommands, id)
    await publishMenuCard(chatId, messageId, existing, card, id)
  }

  /** Put a menu card on the chat — updating the one that is there. */
  async function publishMenuCard(
    chatId: string,
    messageId: string,
    existing: MenuCardEntry | undefined,
    card: Record<string, unknown>,
    menuId: string,
  ): Promise<void> {
    if (existing) {
      const res = await feishuClient.updateMessage(
        existing.messageId,
        JSON.stringify(card),
      )
      if (res.code === 0) return
      logger.warn(`Could not update the menu card: ${res.code} ${res.msg}`)
    }
    const res = await feishuClient.replyMessage(messageId, {
      msg_type: "interactive",
      content: JSON.stringify(card),
    })
    const cardMessageId = res.data?.["message_id"] as string | undefined
    if (!cardMessageId) {
      logger.warn("The menu card was sent but its message id is unknown")
      return
    }
    menuCards.set(menuId, {
      id: menuId,
      messageId: cardMessageId,
      chatId,
      createdAt: Date.now(),
    })
    latestMenuCardByChat.set(chatId, menuId)
  }

  /**
   * Show the compaction report in the card the command came from, or in a
   * new card when it was typed as a plain message. Returns the card's
   * message id so the result can be patched into it later.
   */
  async function sendCompactionCard(
    chatId: string,
    messageId: string,
    menuId: string | undefined,
    card: Record<string, unknown>,
  ): Promise<string | undefined> {
    const existing = findMenuCard(menuId)
    if (existing) {
      const res = await feishuClient.updateMessage(
        existing.messageId,
        JSON.stringify(card),
      )
      if (res.code === 0) return existing.messageId
      logger.warn(`Could not update the menu card: ${res.code} ${res.msg}`)
    }
    const res = await feishuClient.replyMessage(messageId, {
      msg_type: "interactive",
      content: JSON.stringify(card),
    })
    const cardMessageId = res.data?.["message_id"] as string | undefined
    if (!cardMessageId) {
      logger.warn("The compaction card was sent but its message id is unknown")
    }
    return cardMessageId
  }

  /**
   * Compact the conversation: opencode summarizes the old turns and starts
   * the session over with the summary. The context window shrinks.
   *
   * The API only *queues* the compaction — it returns before the summary
   * exists. So the card opens as "running" and is patched when opencode
   * reports the outcome (`session.compaction.ended` / `.failed`).
   */
  async function handleCompact(
    feishuKey: string,
    chatId: string,
    messageId: string,
    menuId?: string,
  ): Promise<void> {
    const mapping = sessionManager.getSession(feishuKey)
    const sessionId = mapping?.session_id ?? (await sessionManager.getExisting(feishuKey))
    if (!sessionId) {
      await replyText(chatId, messageId, "当前没有绑定的会话。")
      return
    }

    // A second /compact replaces the first — do not leave a card stuck on
    // "running" forever.
    pendingCompactions.get(sessionId)?.settle({
      status: "failed",
      error: "被新的压缩请求替代",
    })

    let cardMessageId: string | undefined
    try {
      cardMessageId = await sendCompactionCard(
        chatId,
        messageId,
        menuId,
        buildCompactionCard({ status: "running" }),
      )
    } catch (err) {
      logger.warn(`Could not send the compaction card: ${err}`)
    }

    const listeners = deps.eventListeners
    const pending: PendingCompaction = {
      sessionId,
      cardMessageId,
      settled: false,
      listener: () => {},
      settle: () => {},
    }

    const patch = async (state: CompactionCardState): Promise<void> => {
      if (!cardMessageId) return
      try {
        const res = await feishuClient.updateMessage(
          cardMessageId,
          JSON.stringify(buildCompactionCard(state)),
        )
        if (res.code !== 0) {
          logger.warn(`Could not update the compaction card: ${res.code} ${res.msg}`)
        }
      } catch (err) {
        logger.warn(`Could not update the compaction card: ${err}`)
      }
    }

    const clearTimers = (): void => {
      if (pending.warnTimer) clearTimeout(pending.warnTimer)
      if (pending.giveUpTimer) clearTimeout(pending.giveUpTimer)
      pending.warnTimer = undefined
      pending.giveUpTimer = undefined
    }

    const settle = (state: CompactionCardState): void => {
      if (pending.settled) return
      pending.settled = true
      clearTimers()
      if (listeners) removeListener(listeners, sessionId, pending.listener)
      if (pendingCompactions.get(sessionId) === pending) {
        pendingCompactions.delete(sessionId)
      }
      void patch(state)
    }
    pending.settle = settle

    pending.listener = (raw: unknown): void => {
      const type = (raw as { type?: unknown } | null)?.type
      if (typeof type !== "string" || !type.startsWith("session.compaction.")) return
      const payload = (eventPayload(raw) ?? {}) as Record<string, unknown>

      if (type === "session.compaction.ended") {
        const tokens = (payload.tokens ?? {}) as Record<string, unknown>
        settle({
          status: "done",
          summary: typeof payload.text === "string" ? payload.text : "",
          input: Number(tokens.input ?? 0),
          output: Number(tokens.output ?? 0),
        })
        return
      }
      if (type === "session.compaction.failed") {
        settle({ status: "failed", error: compactionErrorMessage(payload.error) })
        return
      }
      if (type === "session.compaction.started") {
        // It really is running now — summarising a big context takes a while,
        // so only warn about it later.
        if (pending.warnTimer) clearTimeout(pending.warnTimer)
        pending.warnTimer = setTimeout(
          () => void patch({ status: "waiting" }),
          COMPACTION_WARN_MS,
        )
        pending.warnTimer.unref?.()
      }
    }

    pendingCompactions.set(sessionId, pending)
    if (listeners) addListener(listeners, sessionId, pending.listener)

    pending.warnTimer = setTimeout(
      () => void patch({ status: "waiting" }),
      COMPACTION_WARN_MS,
    )
    pending.warnTimer.unref?.()
    pending.giveUpTimer = setTimeout(() => {
      settle({
        status: "failed",
        error: `等了 ${COMPACTION_GIVE_UP_MS / 60_000} 分钟也没有收到压缩结果`,
      })
    }, COMPACTION_GIVE_UP_MS)
    pending.giveUpTimer.unref?.()

    try {
      await opencode.compactSession(sessionId)
      logger.info(`/compact: compaction queued for session ${sessionId}`)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      settle({ status: "failed", error: message })
    }
  }

  /**
   * Upgrade the opencode installation.
   *
   *   /更新          → upgrade to the latest version
   *   /更新 <版本>   → upgrade to that version
   */
  async function handleUpdate(
    chatId: string,
    messageId: string,
    menuId?: string,
    target?: string,
  ): Promise<void> {
    const existing = menuId ? menuCards.get(menuId) : undefined
    const cardId = existing?.id ?? menuId ?? newMenuId()
    const startedAt = Date.now()

    // The card is opened before the upgrade: the download takes about a
    // minute and the CLI itself only shows an "Upgrading…" spinner.
    let stopped = false
    let chain: Promise<void> = Promise.resolve()
    const push = (card: Record<string, unknown>): Promise<void> => {
      chain = chain
        .then(async () => {
          if (stopped) return
          await publishMenuCard(
            chatId,
            messageId,
            menuCards.get(cardId) ?? existing,
            card,
            cardId,
          )
        })
        .catch((err) => logger.warn(`Could not update the upgrade card: ${err}`))
      return chain
    }
    const progress = (notice: string): Promise<void> =>
      push(buildUpgradeProgressCard(notice))

    // The CLI checks the version and fetches the installer before the tarball
    // exists; do not claim to be downloading during that.
    await progress(formatUpgradeProgress({ bytes: 0, phase: "preparing" }, 0))

    const upgrade = deps.supervisor?.upgradeOpencode
    if (!upgrade) {
      await replyText(chatId, messageId, "这个命令不可用：桥没有管理 opencode 进程")
      return
    }

    let sampledVersion: string | undefined
    const stopProgress = startUpgradeProgress({
      startedAt,
      onUpdate: (sample) => {
        if (sample.version) sampledVersion = sample.version
        void progress(formatUpgradeProgress(sample, Date.now() - startedAt))
      },
    })

    /** Stop the poller and wait for the card writes that are still queued. */
    const settle = async (): Promise<void> => {
      stopped = true
      stopProgress()
      await chain
    }

    /** Replace the progress card once the upgrade is over. */
    const finish = (card: Record<string, unknown>): Promise<void> =>
      publishMenuCard(
        chatId,
        messageId,
        menuCards.get(cardId) ?? existing,
        card,
        cardId,
      )

    let result: { success: boolean; output: string }
    try {
      result = await upgrade(target || undefined)
    } catch (err) {
      await settle()
      const message = err instanceof Error ? err.message : String(err)
      await finish(buildUpgradeFailedCard(`更新失败：${message}`))
      return
    }

    await settle()
    const version =
      result.output.match(/v?\d+\.\d+\.\d+/g)?.at(-1) ?? sampledVersion ?? "最新版本"

    if (!result.success) {
      // The CLI draws a spinner with escape codes — strip them.
      const plain = result.output.replace(/\u001b\[[0-9;?]*[a-zA-Z]/g, "")
      const detail = plain
        .split("\n")
        .map((l) => l.replace(/[◒◐◓◑◍]/g, "").trim())
        .filter(Boolean)
        .slice(-2)
        .join(" ")
      await finish(buildUpgradeFailedCard(`更新失败${detail ? `：${detail}` : ""}`))
      return
    }

    // Already current: nothing changed, so neither stop the server nor offer
    // a restart.
    if (/skipped|already installed/i.test(result.output)) {
      await finish(buildUpgradeNoopCard(version))
      return
    }

    // The running server still has the old binary loaded — stop it, so the
    // restart button (or the next message) starts the new one.
    await deps.supervisor?.stop?.().catch(() => {})

    await finish(buildUpgradeRestartCard(version, Date.now() - startedAt))
  }

  /**
   * Switch the automatic stop of the opencode server on and off.
   *
   *   /自动关闭          → toggle
   *   /自动关闭 on|off   → set it
   */
  async function handleIdleStop(
    chatId: string,
    messageId: string,
    argument: string,
    menuId?: string,
  ): Promise<void> {
    const supervisor = deps.supervisor
    if (!supervisor) {
      await replyText(chatId, messageId, "这个命令不可用：桥没有管理 opencode 进程")
      return
    }

    const value = argument.trim().toLowerCase()
    const current = supervisor.idleTimeoutMinutes()

    // Without a value: show the options.
    if (!value) {
      // The card of this chat is refreshed instead of piling up new ones.
      const latest = latestIdleStopByChat.get(chatId)
      const existing = menuId
        ? idleStopMenus.get(menuId)
        : latest
          ? idleStopMenus.get(latest)
          : undefined
      const id = existing?.id ?? menuId ?? newMenuId()
      const card = buildIdleStopCard(current, id)
      await publishIdleStopCard(chatId, messageId, existing, card, id)
      return
    }

    // With a value: apply it.
    const minutes = parseIdleStopValue(value)
    if (minutes === null) {
      await replyText(chatId, messageId, "用法：/自动关闭 [不关闭|15|30|60]")
      return
    }
    supervisor.setIdleTimeoutMinutes(minutes)

    const existing = menuId ? idleStopMenus.get(menuId) : undefined
    if (existing) {
      // The card stays where it is — it shows the new setting.
      const card = buildIdleStopCard(
        supervisor.idleTimeoutMinutes(),
        existing.id,
        `✅ 已设为 ${describeIdleStop(supervisor.idleTimeoutMinutes())}`,
      )
      await publishIdleStopCard(chatId, messageId, existing, card, existing.id)
      return
    }
    await replyText(chatId, messageId, `已设为 ${describeIdleStop(minutes)}`)
  }

  /**
   * The idle stop options: never, 15, 30 or 60 minutes.
   */
  function buildIdleStopCard(
    current: number,
    menuId: string,
    notice?: string,
  ): { card: Record<string, unknown>; menuId: string } {
    const options = [0, 15, 30, 60]
    const elements: Record<string, unknown>[] = [
      {
        tag: "markdown",
        content: notice
          ? `${notice}\n**当前：${describeIdleStop(current)}**`
          : `**当前：${describeIdleStop(current)}**\n空闲多久后自动关掉 opencode：`,
      },
      {
        tag: "action",
        actions: options.map((minutes) => {
          const label = minutes === 0 ? "不关闭" : `${minutes} 分钟`
          const isCurrent = minutes === current
          return {
            tag: "button",
            text: { tag: "plain_text", content: isCurrent ? `✅ ${label}` : label },
            type: isCurrent ? "primary" : "default",
            value: {
              action: "idle_stop",
              menu: menuId,
              command: `/自动关闭 ${minutes}`,
            },
          }
        }),
      },
      {
        tag: "markdown",
        content: "_点一个就切换；关掉后 opencode 一直开着，有消息也不受影响_",
      },
    ]
    return {
      menuId,
      card: {
        config: { wide_screen_mode: true },
        header: {
          title: { tag: "plain_text", content: "🛌 自动关闭" },
          template: "blue",
        },
        elements,
      },
    }
  }

  /** Put the options card on the chat — updating the one that is there. */
  async function publishIdleStopCard(
    chatId: string,
    messageId: string,
    existing: IdleStopMenuEntry | undefined,
    built: { card: Record<string, unknown>; menuId: string },
    menuId: string,
  ): Promise<void> {
    if (existing) {
      const res = await feishuClient.updateMessage(
        existing.messageId,
        JSON.stringify(built.card),
      )
      if (res.code === 0) return
      logger.warn(`Could not update the idle stop card: ${res.code} ${res.msg}`)
    }
    const res = await feishuClient.replyMessage(messageId, {
      msg_type: "interactive",
      content: JSON.stringify(built.card),
    })
    const cardMessageId = res.data?.["message_id"] as string | undefined
    if (!cardMessageId) {
      logger.warn("The idle stop card was sent but its message id is unknown")
      return
    }
    idleStopMenus.set(menuId, {
      id: menuId,
      messageId: cardMessageId,
      chatId,
      createdAt: Date.now(),
    })
    latestIdleStopByChat.set(chatId, menuId)
  }

  /** Put a simple menu card on the chat — updating the card that is there. */
  async function publishSimpleCard(
    chatId: string,
    messageId: string,
    menuId: string | undefined,
    render: (menuId: string) => Record<string, unknown>,
  ): Promise<void> {
    // Only a click (which carries the card's menu id) updates a card in
    // place. A typed command gets a visible reply: patching a card from
    // minutes ago looks like the bot never answered.
    const existing = menuId ? simpleMenus.get(menuId) : undefined
    const id = existing?.id ?? menuId ?? newMenuId()
    const card = render(id)
    if (existing) {
      const res = await feishuClient.updateMessage(existing.messageId, JSON.stringify(card))
      if (res.code === 0) return
      logger.warn(`Could not update the menu card: ${res.code} ${res.msg}`)
    }
    const res = await feishuClient.replyMessage(messageId, {
      msg_type: "interactive",
      content: JSON.stringify(card),
    })
    const cardMessageId = res.data?.["message_id"] as string | undefined
    if (!cardMessageId) {
      logger.warn("The menu card was sent but its message id is unknown")
      return
    }
    simpleMenus.set(id, { id, messageId: cardMessageId, chatId, createdAt: Date.now() })
  }

  const boundSessionId = async (feishuKey: string): Promise<string | null> =>
    sessionManager.getSession(feishuKey)?.session_id ??
    (await sessionManager.getExisting(feishuKey)) ??
    null

  /** /状态 — the current session, model, mode, task and context. */
  async function handleStatus(
    feishuKey: string,
    chatId: string,
    messageId: string,
    menuId?: string,
  ): Promise<void> {
    const sessionId = await boundSessionId(feishuKey)
    if (!sessionId) {
      await replyText(chatId, messageId, "当前没有绑定的会话。")
      return
    }

    const session = await opencode.getSession(sessionId).catch(() => null)
    const statuses = await opencode
      .activeStatuses()
      .catch(() => ({}) as Record<string, { type: string }>)
    const model = session?.model
    let limit: number | undefined
    if (model?.providerID && model.id) {
      limit = await opencode
        .modelContextLimit(model.providerID, model.id)
        .catch(() => undefined)
    }
    // The context of the last step is the size of the window in use now.
    let context: number | undefined
    try {
      const messages = await opencode.messages(sessionId, { limit: 5, order: "desc" })
      const last = messages.find((m: any) => m?.type === "assistant" && m?.tokens)
      if (last) {
        context = (last.tokens.input ?? 0) + (last.tokens.cache?.read ?? 0)
      }
    } catch (err) {
      logger.warn(`Could not read the session usage: ${err}`)
    }

    await publishSimpleCard(chatId, messageId, menuId, (id) =>
      buildStatusCard(
        {
          sessionId,
          title: session?.title,
          directory: session?.location?.directory,
          model,
          agent: session?.agent,
          running: Boolean(statuses[sessionId]),
          context,
          limit,
          tokens: session?.tokens,
        },
        id,
      ),
    )
  }

  /** /模式 — switch the agent used for the following turns. */
  async function handleMode(
    feishuKey: string,
    chatId: string,
    messageId: string,
    argument: string,
    menuId?: string,
  ): Promise<void> {
    const sessionId = await boundSessionId(feishuKey)
    if (!sessionId) {
      await replyText(chatId, messageId, "当前没有绑定的会话。")
      return
    }
    const session = await opencode.getSession(sessionId).catch(() => null)
    const agents = (await opencode.listAgents().catch(() => [] as AgentInfo[])).filter(
      (agent) => agent.mode === "primary" && !agent.hidden,
    )
    const current = session?.agent || "build"
    const target = argument.trim()
    let selected = current
    let notice: string | undefined

    if (target) {
      const match = agents.find((agent) => agent.id === target)
      if (!match) {
        await replyText(chatId, messageId, `未知模式：${target}`)
        return
      }
      await opencode.switchAgent(sessionId, target)
      selected = target
      notice = `✅ 已切换到 ${match.name || target}`
      logger.info(`/模式: session ${sessionId} -> ${target}`)
    }

    await publishSimpleCard(chatId, messageId, menuId, (id) =>
      buildModeCard(agents, selected, id, notice),
    )
  }

  /** /思考 — switch the reasoning-effort variant of the current model. */
  async function handleThinking(
    feishuKey: string,
    chatId: string,
    messageId: string,
    argument: string,
    menuId?: string,
  ): Promise<void> {
    const sessionId = await boundSessionId(feishuKey)
    if (!sessionId) {
      await replyText(chatId, messageId, "当前没有绑定的会话。")
      return
    }
    const session = await opencode.getSession(sessionId).catch(() => null)
    const model = session?.model
    if (!model?.id || !model.providerID) {
      await replyText(chatId, messageId, "当前会话还没有模型，先发一条消息或用 /模型 选一个。")
      return
    }

    const models = await opencode.listModels().catch(() => [] as ModelInfo[])
    const info = models.find((m) => m.id === model.id && m.providerID === model.providerID)
    const variants = info?.variants ?? []
    let current = model.variant || "default"
    const target = argument.trim()
    let notice: string | undefined

    if (target) {
      if (target !== "default" && !variants.some((variant) => variant.id === target)) {
        await replyText(chatId, messageId, `未知思考级别：${target}`)
        return
      }
      await opencode.switchModel(sessionId, {
        id: model.id,
        providerID: model.providerID,
        variant: target,
      })
      current = target
      notice = `✅ 思考级别已切到 ${target}`
      logger.info(`/思考: session ${sessionId} -> ${target}`)
    }

    await publishSimpleCard(chatId, messageId, menuId, (id) =>
      buildThinkingCard(variants, current, id, notice),
    )
  }

  const replyModeFor = (chatId: string): ReplyMode =>
    deps.replyModes?.get(chatId) ?? localReplyModes.get(chatId) ?? "standard"

  /** /回复 — how much of a turn the card shows. */
  async function handleReplyMode(
    chatId: string,
    messageId: string,
    argument: string,
    menuId?: string,
  ): Promise<void> {
    let current = replyModeFor(chatId)
    const target = parseReplyMode(argument)
    let notice: string | undefined
    if (argument.trim()) {
      if (!target) {
        await replyText(chatId, messageId, "用法：/回复 [简洁|标准]")
        return
      }
      if (deps.replyModes) deps.replyModes.set(chatId, target)
      else localReplyModes.set(chatId, target)
      current = target
      notice = `✅ 已切到${target === "concise" ? "简洁" : "标准"}`
      logger.info(`/回复: chat ${chatId} -> ${target}`)
    }
    await publishSimpleCard(chatId, messageId, menuId, (id) =>
      buildReplyModeCard(current, id, notice),
    )
  }

  /**
   * Two level model menu:
   *
   *   /模型 | /model | /models → the providers
   *   /模型 <provider>      → the models of that provider
   *   /模型 <provider> <n>  → page n of that provider
   *   /模型 <provider>|<id> → switch to that model
   *   /模型 <keyword>       → search all providers
   */
  /**
   * The model menu. Every navigation updates the same card in place —
   * entering level 2, paging and switching never send a new message.
   *
   *   /模型                 → the providers
   *   /模型 <provider>      → the models of that provider
   *   /模型 <provider> <n>  → page n of that provider
   *   /模型 <provider>|<id> → switch to that model
   *   /模型 <keyword>       → search all providers
   */
  async function handleModel(
    feishuKey: string,
    chatId: string,
    messageId: string,
    argument: string,
    menuId?: string,
  ): Promise<void> {
    purgeModelMenus()

    // A card click keeps the key the menu was created with: in a group chat
    // the message key is "chat:root" while the callback only knows the chat.
    const fromCard = menuId
      ? ((modelMenus.get(menuId) ?? findMenuCard(menuId)) as ModelMenuEntry | undefined)
      : undefined
    const existing = fromCard ?? modelMenus.get(latestMenuByChat.get(chatId) ?? "")
    const key = existing?.feishuKey ?? feishuKey
    const activeId = existing?.id ?? newMenuId()

    const sessionId = await sessionManager.getExisting(key)
    if (!sessionId) {
      await replyText(chatId, messageId, "当前没有绑定的会话，先发一句话或用 /new 建一个")
      return
    }

    // A model id carries the provider, so it is encoded as "provider|id".
    if (argument.includes("|")) {
      const separator = argument.indexOf("|")
      const providerID = argument.slice(0, separator)
      const modelId = argument.slice(separator + 1)
      try {
        await opencode.switchModel(sessionId, { id: modelId, providerID })
      } catch (err) {
        logger.warn(`Could not switch the model: ${err}`)
        await replyText(chatId, messageId, `切换模型失败：${err}`)
        return
      }
      if (existing) {
        // The model list folds away — the card falls back to the provider
        // level and shows the model that is now in use.
        existing.view = { level: 1, page: 1 }
        await renderModelMenu(existing, sessionId, `✅ 已切换到 ${providerID}/${modelId}`)
        return
      }
      await replyText(chatId, messageId, `已切换模型：${providerID}/${modelId}`)
      return
    }

    let models: ModelInfo[] = []
    try {
      models = await opencode.listModels()
    } catch (err) {
      logger.warn(`Could not fetch the model list: ${err}`)
      await replyText(chatId, messageId, `获取模型列表失败：${err}`)
      return
    }

    const session = await opencode.getSession(sessionId).catch(() => null)
    const { currentName, currentProvider } = describeCurrentModel(session, models)

    const usable = models.filter((m) => m.enabled !== false)
    const providers = [...new Set(usable.map((m) => m.providerID))].sort()

    const args = argument.split(/\s+/).filter(Boolean)
    const provider = args[0]
    const page = Math.max(1, Number(args[1] ?? 1) || 1)

    // Level 1: the providers
    if (!provider) {
      const card = buildProviderCard(providers, usable, currentProvider, activeId, undefined, currentName)
      await publishModelMenu(chatId, messageId, existing, activeId, card, { level: 1, page: 1 }, key)
      return
    }

    // Level 2: the models of that provider (or a search over all of them)
    const built = buildLevel2Card(usable, providers, provider, page, currentName, activeId)
    if (!built) {
      await replyText(chatId, messageId, `没有匹配「${provider}」的模型`)
      return
    }
    await publishModelMenu(chatId, messageId, existing, activeId, built.card, built.view, key)
  }

  /**
   * The models of one provider — or a search over all of them — with the
   * free ones first and the requested page.
   */
  function buildLevel2Card(
    usable: ModelInfo[],
    providers: string[],
    provider: string,
    page: number,
    current: string,
    menuId: string,
    notice?: string,
  ): { card: Record<string, unknown>; view: ModelMenuView } | null {
    const isProvider = providers.includes(provider)
    const candidates = isProvider
      ? usable.filter((m) => m.providerID === provider)
      : usable.filter(
          (m) =>
            m.id.toLowerCase().includes(provider.toLowerCase()) ||
            m.name.toLowerCase().includes(provider.toLowerCase()),
        )

    if (candidates.length === 0) return null

    // Free models first — a provider can list hundreds, and the paid ones are
    // useless without credits. Stable sort keeps the rest in API order.
    const rank = (m: ModelInfo) => (isFreeModel(m) ? 0 : 1)
    const sorted = [...candidates].sort((a, b) => rank(a) - rank(b))

    const perPage = 12
    const pages = Math.max(1, Math.ceil(sorted.length / perPage))
    const shown = Math.min(page, pages)
    const slice = sorted.slice((shown - 1) * perPage, shown * perPage)

    return {
      card: buildModelCard({
        models: slice,
        current,
        title: isProvider ? `provider：${provider}` : `搜索「${provider}」`,
        total: sorted.length,
        page: shown,
        pages,
        provider: isProvider ? provider : undefined,
        menuId,
        notice,
      }),
      view: { level: 2, provider, page: shown },
    }
  }

  /**
   * Redraw the menu card in the view it is showing — used after a switch,
   * so the card shows the new current model.
   */
  async function renderModelMenu(
    entry: ModelMenuEntry,
    sessionId: string,
    notice?: string,
  ): Promise<void> {
    let models: ModelInfo[] = []
    try {
      models = await opencode.listModels()
    } catch (err) {
      logger.warn(`Could not fetch the model list: ${err}`)
      return
    }

    const session = await opencode.getSession(sessionId).catch(() => null)
    const { currentName, currentProvider } = describeCurrentModel(session, models)

    const usable = models.filter((m) => m.enabled !== false)
    const providers = [...new Set(usable.map((m) => m.providerID))].sort()

    if (entry.view.level === 1) {
      const card = buildProviderCard(providers, usable, currentProvider, entry.id, notice, currentName)
      await publishModelMenu(entry.chatId, entry.messageId, entry, entry.id, card, entry.view, entry.feishuKey)
      return
    }

    const provider = entry.view.provider ?? ""
    const built = buildLevel2Card(usable, providers, provider, entry.view.page, currentName, entry.id, notice)
    if (!built) return
    await publishModelMenu(entry.chatId, entry.messageId, entry, entry.id, built.card, built.view, entry.feishuKey)
  }

  /**
   * Put the card on the chat: update the menu card that is already there,
   * or send a new one and remember it for the next click.
   */
  async function publishModelMenu(
    chatId: string,
    messageId: string,
    existing: ModelMenuEntry | undefined,
    menuId: string,
    card: Record<string, unknown>,
    view: ModelMenuView,
    feishuKey: string,
  ): Promise<void> {
    if (existing) {
      const res = await feishuClient.updateMessage(existing.messageId, JSON.stringify(card))
      if (res.code === 0) {
        existing.view = view
        return
      }
      logger.warn(`Could not update the model menu card: ${res.code} ${res.msg}`)
    }

    const res = await feishuClient.replyMessage(messageId, {
      msg_type: "interactive",
      content: JSON.stringify(card),
    })
    const cardMessageId = res.data?.["message_id"] as string | undefined
    if (!cardMessageId) {
      logger.warn("The model menu card was sent but its message id is unknown")
      return
    }
    modelMenus.set(menuId, {
      id: menuId,
      messageId: cardMessageId,
      chatId,
      feishuKey,
      createdAt: Date.now(),
      view,
    })
    latestMenuByChat.set(chatId, menuId)
  }

  /**
   * Run one of opencode's own commands (the ones /api/command lists) in the
   * session bound to this chat. The answer is streamed into a card exactly
   * like a normal message.
   */
  async function runOpencodeCommand(
    feishuKey: string,
    chatId: string,
    messageId: string,
    cmd: string,
    args: string[],
  ): Promise<boolean> {
    const name = cmd.replace(/^\//, "").toLowerCase()
    if (!name) return false

    let commands: { name: string; description?: string }[] = []
    try {
      commands = await opencode.commands()
    } catch (err) {
      logger.warn(`Could not fetch the opencode commands: ${err}`)
      return false
    }
    const command = commands.find((c) => c.name.toLowerCase() === name)
    if (!command) return false

    if (!deps.streamingBridge || !deps.eventListeners || !deps.eventProcessor) {
      await replyText(chatId, messageId, `opencode 命令 /${command.name} 需要桥的流式通道才能运行`)
      return true
    }

    const sessionId = await sessionManager.getOrCreate(feishuKey)
    const arguments_ = args.join(" ")
    logger.info(`Running opencode command /${command.name} in session ${sessionId}`)
    await deps.streamingBridge.handleMessage(
      chatId,
      sessionId,
      deps.eventListeners,
      deps.eventProcessor,
      async () => {
        await opencode.sendCommand(sessionId, {
          command: command.name,
          arguments: arguments_ || undefined,
        })
        return ""
      },
      () => {},
      messageId,
      null,
    )
    return true
  }

  return async function handleCommand(
    feishuKey: string,
    chatId: string,
    messageId: string,
    commandText: string,
    options?: CommandHandlerOptions,
  ): Promise<boolean> {
    const trimmed = commandText.trim()
    const parts = trimmed.split(/\s+/)
    const cmd = parts[0]?.toLowerCase()

    if (!cmd || !cmd.startsWith("/")) return false

    logger.info(`Slash command: ${cmd} from ${feishuKey}`)

    // The server may have been stopped while it was idle. Commands that do
    // not talk to it must not wait for it to start — waking it up took ~10 s
    // and left the 更新 card on the menu until then.
    const needsServer = ![
      "/更新", "/update",
      "/帮助", "/help", "/",
      "/自动关闭", "/autostop",
      "/回复", "/reply",
    ].includes(cmd)
    if (needsServer) {
      await deps.ensureServer?.().catch(() => {})
    }

    try {
      switch (cmd) {
        case "/new":
        case "/新建":
        case "/clear":
          await handleNew(feishuKey, chatId, messageId, options?.menuId)
          return true

        case "/状态":
        case "/status":
          await handleStatus(feishuKey, chatId, messageId, options?.menuId)
          return true

        case "/模式":
        case "/mode":
          await handleMode(
            feishuKey,
            chatId,
            messageId,
            parts.slice(1).join(" "),
            options?.menuId,
          )
          return true

        case "/思考":
        case "/thinking":
          await handleThinking(
            feishuKey,
            chatId,
            messageId,
            parts.slice(1).join(" "),
            options?.menuId,
          )
          return true

        case "/回复":
        case "/reply":
          await handleReplyMode(chatId, messageId, parts.slice(1).join(" "), options?.menuId)
          return true

        case "/项目":
        case "/project":
          await handleSessions(feishuKey, chatId, messageId, options?.menuId)
          return true

        case "/abort":
          await handleAbort(feishuKey, chatId, messageId, options?.menuId)
          return true

        case "/sessions":
          await handleSessions(
            feishuKey,
            chatId,
            messageId,
            options?.menuId,
            parts.slice(1).join(" ") || undefined,
          )
          return true

        case "/connect":
        case "/bind": {
          const targetSessionId = parts[1]
          if (!targetSessionId) {
            await replyText(chatId, messageId, `用法: ${cmd} {session_id}`)
            return true
          }
          await handleConnect(feishuKey, chatId, messageId, targetSessionId, options?.menuId)
          return true
        }

        case "/compact":
        case "/压缩":
          await handleCompact(feishuKey, chatId, messageId, options?.menuId)
          return true

        case "/更新":
        case "/update":
          await handleUpdate(chatId, messageId, options?.menuId, parts.slice(1).join(" "))
          return true

        case "/自动关闭":
        case "/autostop":
          await handleIdleStop(
            chatId,
            messageId,
            parts.slice(1).join(" "),
            options?.menuId,
          )
          return true

        case "/模型":
        case "/model":
        case "/models":
          await handleModel(feishuKey, chatId, messageId, parts.slice(1).join(" "), options?.menuId)
          return true

        case "/":
        case "/help":
        case "/帮助":
          await handleHelp(chatId, messageId, options?.menuId)
          return true

        default: {
          // Not a bridge command — maybe one of opencode's own ("/review").
          const handled = await runOpencodeCommand(feishuKey, chatId, messageId, cmd, parts.slice(1))
          if (handled) return true

          // A lone unknown word starting with "/" is a typo ("/models"), not
          // prose — handing it to the model would burn a whole turn on it.
          // Anything with more words after it is a normal message.
          if (parts.length === 1) {
            await replyText(
              chatId,
              messageId,
              `未知命令 ${cmd}\n用 /help 看可用命令；/模型 选模型`,
            )
            return true
          }
          return false
        }
      }
    } catch (err) {
      logger.error(`Command ${cmd} failed: ${err}`)
      try {
        await replyText(chatId, messageId, `命令执行失败: ${err}`)
      } catch (replyErr) {
        logger.error(`Failed to send error reply: ${replyErr}`)
      }
      return true
    }
  }
}
