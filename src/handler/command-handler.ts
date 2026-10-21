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
import type { EventListenerMap } from "../utils/event-listeners.js"
import type { FeishuApiClient } from "../feishu/api-client.js"
import type { Logger } from "../utils/logger.js"
import type { ModelInfo, OpencodeGateway } from "../opencode/gateway.js"

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
  }
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

function buildSessionsCard(
  sessions: Session[],
  currentSessionId?: string,
  menuId = "",
  notice?: string,
): Record<string, unknown> {
  const recentSessions = sessions.slice(0, 10)
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
        content: notice
          ? `${notice}\n**点击连接到对应会话：**`
          : "**点击连接到对应会话：**",
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
    ],
  }
}

// ── Help card builder ──

function buildHelpCard(opencodeCommands: { name: string; description?: string }[] = []): Record<string, unknown> {
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
        content: "**选择要执行的命令：**",
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "🆕 新建会话" },
            type: "primary",
            value: { action: "command_execute", command: "/new" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🔌 连接会话" },
            value: { action: "command_execute", command: "/sessions" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "⏹ 打断当前任务" },
            type: "danger",
            value: { action: "command_execute", command: "/abort" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🧠 模型菜单" },
            value: { action: "command_execute", command: "/模型" },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "🛌 定时关闭" },
            value: { action: "command_execute", command: "/自动关闭" },
          },
        ],
      },
      {
        tag: "markdown",
        content: "_打字命令：`/connect <会话ID>` · `/模型 [provider] [页码]` · `/自动关闭 [不关闭|15|30|60]` · `/help`_",
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

/** The session list card, so it can be updated in place. */
interface SessionMenuEntry {
  id: string
  messageId: string
  chatId: string
  createdAt: number
  /** The title of the bound session — shown after a connection. */
  title?: string
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
  ): Promise<void> {
    const data = await opencode.createSession({
      title: `Feishu chat ${feishuKey}`,
      directory: process.env.OPENCODE_CWD || process.cwd(),
    })

    sessionManager.deleteMapping(feishuKey)
    sessionManager.setMapping(feishuKey, data.id)
    logger.info(`/new: created session ${data.id}, bound ${feishuKey}`)
    await replyText(chatId, messageId, `已创建并切换到新会话: ${data.id}`)
  }

  async function handleAbort(
    feishuKey: string,
    chatId: string,
    messageId: string,
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
    await replyText(
      chatId,
      messageId,
      `已打断当前这一轮（会话 ${mapping.session_id} 保留，可以接着聊）`,
    )
  }

  async function handleSessions(
    feishuKey: string,
    chatId: string,
    messageId: string,
    menuId?: string,
  ): Promise<void> {
    const sessions = (await opencode.listSessions({ directory: process.env.OPENCODE_CWD || process.cwd() })) as Session[]
    if (sessions.length === 0) {
      await replyText(chatId, messageId, "暂无会话。")
      return
    }

    // Get current bound session for this chat
    const currentSessionId = await sessionManager.getExisting(feishuKey)

    if (currentSessionId) {
      // Check if it's already in the list
      const existingIndex = sessions.findIndex((s) => s.id === currentSessionId)
      if (existingIndex >= 0) {
        // Move it to top
        const current = sessions.splice(existingIndex, 1)[0]
        if (current) {
          sessions.unshift(current)
        }
      } else {
        // Not in API response at all — add it manually at top
        const now = Date.now()
        sessions.unshift({ id: currentSessionId, title: "当前会话", time: { created: now, updated: now } })
      }
    }

    // The card of this chat is refreshed instead of piling up new ones.
    const latest = latestSessionMenuByChat.get(chatId)
    const existing = menuId
      ? sessionMenus.get(menuId)
      : latest
        ? sessionMenus.get(latest)
        : undefined
    const id = existing?.id ?? menuId ?? newMenuId()
    const card = buildSessionsCard(sessions, currentSessionId, id)
    await publishSessionCard(chatId, messageId, existing, card, id)
  }

  /** Put the session list on the chat — updating the one that is there. */
  async function publishSessionCard(
    chatId: string,
    messageId: string,
    existing: SessionMenuEntry | undefined,
    card: Record<string, unknown>,
    menuId: string,
  ): Promise<void> {
    if (existing) {
      const res = await feishuClient.updateMessage(
        existing.messageId,
        JSON.stringify(card),
      )
      if (res.code === 0) return
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
    })
    latestSessionMenuByChat.set(chatId, menuId)
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
    const menu = menuId ? sessionMenus.get(menuId) : undefined
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
    _chatId: string,
    messageId: string,
  ): Promise<void> {
    // The opencode commands are per project — fetch them so the menu shows
    // what this project actually offers.
    let opencodeCommands: { name: string; description?: string }[] = []
    try {
      opencodeCommands = await opencode.commands()
    } catch (err) {
      logger.warn(`Could not fetch the opencode commands: ${err}`)
    }
    const card = buildHelpCard(opencodeCommands)
    await feishuClient.replyMessage(messageId, {
      msg_type: "interactive",
      content: JSON.stringify(card),
    })
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
    const fromCard = menuId ? modelMenus.get(menuId) : undefined
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

    // The server may have been stopped while it was idle.
    await deps.ensureServer?.().catch(() => {})

    try {
      switch (cmd) {
        case "/new":
          await handleNew(feishuKey, chatId, messageId)
          return true

        case "/abort":
          await handleAbort(feishuKey, chatId, messageId)
          return true

        case "/sessions":
          await handleSessions(feishuKey, chatId, messageId, options?.menuId)
          return true

        case "/connect": {
          const targetSessionId = parts[1]
          if (!targetSessionId) {
            await replyText(chatId, messageId, "用法: /connect {session_id}")
            return true
          }
          await handleConnect(feishuKey, chatId, messageId, targetSessionId, options?.menuId)
          return true
        }

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
          await handleHelp(chatId, messageId)
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
