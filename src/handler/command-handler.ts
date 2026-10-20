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
}

// ── Types ──

export type CommandHandler = (
  feishuKey: string,
  chatId: string,
  messageId: string,
  commandText: string,
) => Promise<boolean>

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

function buildSessionsCard(sessions: Session[], currentSessionId?: string): Record<string, unknown> {
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
        content: "**点击连接到对应会话：**",
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
              value: { action: "command_execute", command: `/connect ${s.id}` },
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
            text: { tag: "plain_text", content: "🛑 中止任务" },
            type: "danger",
            value: { action: "command_execute", command: "/abort" },
          },
        ],
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
 * Level 1 of the model menu: the providers, with how many models each has.
 */
function buildProviderCard(
  providers: string[],
  models: ModelInfo[],
  currentProvider?: string,
): Record<string, unknown> {
  const elements: Record<string, unknown>[] = [
    {
      tag: "markdown",
      content: "**第 1 步：选择 provider**",
    },
  ]

  for (let i = 0; i < providers.length; i += 3) {
    const chunk = providers.slice(i, i + 3)
    elements.push({
      tag: "action",
      actions: chunk.map((provider) => {
        const count = models.filter((m) => m.providerID === provider).length
        const isCurrent = provider === currentProvider
        return {
          tag: "button",
          text: {
            tag: "plain_text",
            content: isCurrent ? `✅ ${provider} (${count})` : `${provider} (${count})`,
          },
          type: isCurrent ? "primary" : "default",
          value: { action: "command_execute", command: `/模型 ${provider}` },
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
}): Record<string, unknown> {
  const { models, current, title, total, page, pages, provider } = options
  const elements: Record<string, unknown>[] = [
    {
      tag: "markdown",
      content: `**第 2 步：${title}**（共 ${total} 个，第 ${page}/${pages} 页）\n**当前模型：** ${current}`,
    },
  ]

  for (let i = 0; i < models.length; i += 4) {
    const chunk = models.slice(i, i + 4)
    elements.push({
      tag: "action",
      actions: chunk.map((m) => {
        const label = m.name.length > 16 ? `${m.name.slice(0, 15)}…` : m.name
        const isCurrent = `${m.providerID}/${m.id}` === current
        return {
          tag: "button",
          text: { tag: "plain_text", content: isCurrent ? `✅ ${label}` : label },
          type: isCurrent ? "primary" : "default",
          value: {
            action: "command_execute",
            command: `/模型 ${m.providerID}|${m.id}`,
          },
        }
      }),
    })
  }

  if (pages > 1 && provider) {
    const actions: Record<string, unknown>[] = []
    if (page > 1) {
      actions.push({
        tag: "button",
        text: { tag: "plain_text", content: `← 上一页 (${page - 1})` },
        value: { action: "command_execute", command: `/模型 ${provider} ${page - 1}` },
      })
    }
    if (page < pages) {
      actions.push({
        tag: "button",
        text: { tag: "plain_text", content: `下一页 (${page + 1}) →` },
        type: "primary",
        value: { action: "command_execute", command: `/模型 ${provider} ${page + 1}` },
      })
    }
    elements.push({ tag: "action", actions })
  }

  elements.push({
    tag: "markdown",
    content: "_点模型即切换；返回上一层：`/模型`_",
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

// ── Factory ──

export function createCommandHandler(deps: CommandHandlerDeps): CommandHandler {
  const { opencode, sessionManager, feishuClient, logger } = deps

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
    await replyText(chatId, messageId, `已中止会话: ${mapping.session_id}`)
  }

  async function handleSessions(
    feishuKey: string,
    chatId: string,
    messageId: string,
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

    const card = buildSessionsCard(sessions, currentSessionId)
    await feishuClient.replyMessage(messageId, {
      msg_type: "interactive",
      content: JSON.stringify(card),
    })
  }

  async function handleConnect(
    feishuKey: string,
    chatId: string,
    messageId: string,
    targetSessionId: string,
  ): Promise<void> {
    const existing = await opencode.getSession(targetSessionId)
    if (!existing) {
      await replyText(chatId, messageId, "会话不存在。")
      return
    }

    // Unbind current mapping if exists
    sessionManager.deleteMapping(feishuKey)

    // Set new mapping
    const success = sessionManager.setMapping(feishuKey, targetSessionId)
    if (success) {
      logger.info(`/connect: bound ${feishuKey} to session ${targetSessionId}`)
      await replyText(chatId, messageId, `已连接到会话: ${targetSessionId}`)
    } else {
      throw new Error("Failed to set session mapping")
    }
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
   * Two level model menu:
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
  ): Promise<void> {
    const sessionId = await sessionManager.getExisting(feishuKey)
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
        await replyText(chatId, messageId, `已切换模型：${providerID}/${modelId}`)
      } catch (err) {
        await replyText(chatId, messageId, `切换模型失败：${err}`)
      }
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
    const current = session?.model
      ? `${session.model.providerID ?? ""}/${session.model.id ?? ""}`
      : "未知"
    const currentProvider = session?.model?.providerID

    const args = argument.split(/\s+/).filter(Boolean)
    const provider = args[0]
    const page = Math.max(1, Number(args[1] ?? 1) || 1)

    const usable = models.filter((m) => m.enabled !== false)
    const providers = [...new Set(usable.map((m) => m.providerID))].sort()

    // Level 1: the providers
    if (!provider) {
      const card = buildProviderCard(providers, usable, currentProvider)
      await feishuClient.replyMessage(messageId, {
        msg_type: "interactive",
        content: JSON.stringify(card),
      })
      return
    }

    // Level 2: the models of that provider (or a search over all of them)
    const isProvider = providers.includes(provider)
    const candidates = isProvider
      ? usable.filter((m) => m.providerID === provider)
      : usable.filter(
          (m) =>
            m.id.toLowerCase().includes(provider.toLowerCase()) ||
            m.name.toLowerCase().includes(provider.toLowerCase()),
        )

    if (candidates.length === 0) {
      await replyText(chatId, messageId, `没有匹配「${provider}」的模型`)
      return
    }

    const perPage = 12
    const pages = Math.max(1, Math.ceil(candidates.length / perPage))
    const shown = Math.min(page, pages)
    const slice = candidates.slice((shown - 1) * perPage, shown * perPage)

    const card = buildModelCard({
      models: slice,
      current,
      title: isProvider ? `provider：${provider}` : `搜索「${provider}」`,
      total: candidates.length,
      page: shown,
      pages,
      provider: isProvider ? provider : undefined,
    })
    await feishuClient.replyMessage(messageId, {
      msg_type: "interactive",
      content: JSON.stringify(card),
    })
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
  ): Promise<boolean> {
    const trimmed = commandText.trim()
    const parts = trimmed.split(/\s+/)
    const cmd = parts[0]?.toLowerCase()

    if (!cmd || !cmd.startsWith("/")) return false

    logger.info(`Slash command: ${cmd} from ${feishuKey}`)

    try {
      switch (cmd) {
        case "/new":
          await handleNew(feishuKey, chatId, messageId)
          return true

        case "/abort":
          await handleAbort(feishuKey, chatId, messageId)
          return true

        case "/sessions":
          await handleSessions(feishuKey, chatId, messageId)
          return true

        case "/connect": {
          const targetSessionId = parts[1]
          if (!targetSessionId) {
            await replyText(chatId, messageId, "用法: /connect {session_id}")
            return true
          }
          await handleConnect(feishuKey, chatId, messageId, targetSessionId)
          return true
        }

        case "/模型":
        case "/model":
          await handleModel(feishuKey, chatId, messageId, parts.slice(1).join(" "))
          return true

        case "/":
        case "/help":
        case "/帮助":
          await handleHelp(chatId, messageId)
          return true

        default: {
          // Not a bridge command — maybe one of opencode's own ("/review").
          const handled = await runOpencodeCommand(feishuKey, chatId, messageId, cmd, parts.slice(1))
          return handled
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
