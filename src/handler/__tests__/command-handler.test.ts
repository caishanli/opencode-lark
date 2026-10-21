import { describe, it, expect, beforeEach, vi } from "vitest"
import { createCommandHandler, type CommandHandlerDeps } from "../command-handler.js"
import { createMockLogger, createMockFeishuClient } from "../../__tests__/setup.js"
import { createMockGateway } from "../../__tests__/setup.js"
import type { SessionManager } from "../../session/session-manager.js"
import type { SessionMapping } from "../../types.js"

function createMockSessionManager(
  mapping: SessionMapping | null = null,
): SessionManager {
  return {
    getOrCreate: vi.fn().mockResolvedValue(mapping?.session_id ?? "ses-new"),
    getSession: vi.fn().mockReturnValue(mapping),
    getExisting: vi.fn().mockResolvedValue(mapping?.session_id),
    deleteMapping: vi.fn().mockReturnValue(true),
    setMapping: vi.fn().mockReturnValue(true),
    cleanup: vi.fn().mockReturnValue(0),
    validateAndCleanupStale: vi.fn().mockResolvedValue(0),
  }
}

const DEFAULT_MAPPING: SessionMapping = {
  feishu_key: "chat-1",
  session_id: "ses-123",
  agent: "build",
  created_at: Date.now(),
  last_active: Date.now(),
  is_bound: 1,
}

describe("createCommandHandler", () => {
  let mockLogger: ReturnType<typeof createMockLogger>
  let mockFeishuClient: ReturnType<typeof createMockFeishuClient>
  let mockSessionManager: SessionManager
  let mockGateway: ReturnType<typeof createMockGateway>

  beforeEach(() => {
    mockLogger = createMockLogger()
    mockFeishuClient = createMockFeishuClient()
    mockSessionManager = createMockSessionManager(DEFAULT_MAPPING)
    mockGateway = createMockGateway()
    vi.clearAllMocks()
  })

  function createHandler(
    sm?: SessionManager,
    gateway = mockGateway,
    overrides: Partial<CommandHandlerDeps> = {},
  ) {
    return createCommandHandler({
      opencode: gateway,
      sessionManager: sm ?? mockSessionManager,
      feishuClient: mockFeishuClient,
      logger: mockLogger,
      ...overrides,
    })
  }

  describe("/new", () => {
    it("creates a new session and binds to it via setMapping", async () => {
      mockGateway.createSession.mockResolvedValueOnce({ id: "ses-new" })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/new")

      expect(result).toBe(true)
      expect(mockGateway.createSession).toHaveBeenCalledWith({
        title: "Feishu chat chat-1",
        directory: process.env.OPENCODE_CWD || process.cwd(),
      })
      expect(mockSessionManager.deleteMapping).toHaveBeenCalledWith("chat-1")
      expect(mockSessionManager.setMapping).toHaveBeenCalledWith("chat-1", "ses-new")
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "已创建并切换到新会话: ses-new" }),
      })
    })

    it("replies with error when session creation fails", async () => {
      mockGateway.createSession.mockRejectedValueOnce(new Error("createSession failed"))
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/new")

      expect(result).toBe(true)
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: expect.stringContaining("命令执行失败"),
      })
    })
  })

  describe("/abort", () => {
    it("aborts the current session", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/abort")

      expect(result).toBe(true)
      expect(mockGateway.abort).toHaveBeenCalledWith("ses-123")
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "已中止会话: ses-123" }),
      })
    })

    it("replies when no session is bound", async () => {
      const sm = createMockSessionManager(null)
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler(sm)
      const result = await handler("chat-1", "chat-1", "msg-1", "/abort")

      expect(result).toBe(true)
      expect(mockGateway.abort).not.toHaveBeenCalled()
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "当前没有绑定的会话。" }),
      })
    })
  })

  describe("/sessions", () => {
    it("sends interactive card with session buttons", async () => {
      vi.useFakeTimers()
      const now = new Date("2026-03-14T12:00:00.000Z")
      vi.setSystemTime(now)

      mockGateway.listSessions.mockResolvedValueOnce([
        {
          id: "ses-1",
          title: "Analysis report SSE timeout error",
          time: {
            created: now.getTime() - 10_000,
            updated: now.getTime() - 3 * 60 * 60 * 1000,
          },
          summary: { additions: 1, deletions: 2, files: 363 },
        },
        {
          id: "ses-2",
          time: {
            created: now.getTime() - 20_000,
            updated: now.getTime() - 2 * 60 * 1000,
          },
        },
      ])
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/sessions")

      expect(result).toBe(true)
      expect(mockGateway.listSessions).toHaveBeenCalledWith({
        directory: process.env.OPENCODE_CWD || process.cwd(),
      })
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "interactive",
        content: expect.any(String),
      })
      // Verify card structure
      const callArgs = (mockFeishuClient.replyMessage as any).mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      expect(content).toHaveProperty("config")
      expect(content).toHaveProperty("header")
      expect(content).toHaveProperty("elements")
      expect(content.header?.title?.content).toContain("选择会话")
      // Verify buttons are created for each session
      const actionElements = content.elements?.filter((e: any) => e.tag === "action")
      // 2 from API + 1 current session (ses-123) not in API list → prepended
      expect(actionElements).toHaveLength(3)

      const buttonTexts = actionElements.map((el: any) => el.actions?.[0]?.text?.content)
      expect(buttonTexts[0]).toBe("▶ 当前会话 · 刚刚")
      expect(buttonTexts[1]).toBe("Analysis report SSE timeout... · 3小时前 · 363文件")
      expect(buttonTexts[2]).toBe("未命名会话 · 2分钟前")

      for (const t of buttonTexts) {
        expect(t).not.toContain("ses-")
      }

      vi.useRealTimers()
    })

    it("pins the current session to the top when it is present in the list", async () => {
      vi.useFakeTimers()
      const now = new Date("2026-03-14T12:00:00.000Z")
      vi.setSystemTime(now)

      mockGateway.listSessions.mockResolvedValueOnce([
        { id: "ses-1", title: "First", time: { created: now.getTime(), updated: now.getTime() } },
        { id: "ses-123", title: "Current", time: { created: now.getTime(), updated: now.getTime() } },
        { id: "ses-2", title: "Second", time: { created: now.getTime(), updated: now.getTime() } },
      ])
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/sessions")

      expect(result).toBe(true)
      const callArgs = (mockFeishuClient.replyMessage as any).mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      const actionElements = content.elements?.filter((e: any) => e.tag === "action")
      expect(actionElements).toHaveLength(3)
      const buttonTexts = actionElements.map((el: any) => el.actions?.[0]?.text?.content)
      // Current session moved to the top and marked with ▶ (existing entry, not duplicated)
      expect(buttonTexts[0]).toBe("▶ Current · 刚刚")
      expect(buttonTexts[1]).toBe("First · 刚刚")
      expect(buttonTexts[2]).toBe("Second · 刚刚")

      vi.useRealTimers()
    })

    it("replies with text when no sessions exist", async () => {
      mockGateway.listSessions.mockResolvedValueOnce([])
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/sessions")

      expect(result).toBe(true)
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "暂无会话。" }),
      })
    })
  })

  describe("/connect", () => {
    it("connects to a valid session", async () => {
      mockGateway.getSession.mockResolvedValueOnce({ id: "ses-456" })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/connect ses-456")

      expect(result).toBe(true)
      // Gateway validates the session exists
      expect(mockGateway.getSession).toHaveBeenCalledWith("ses-456")
      // deleteMapping called
      expect(mockSessionManager.deleteMapping).toHaveBeenCalledWith("chat-1")
      // setMapping called
      expect(mockSessionManager.setMapping).toHaveBeenCalledWith("chat-1", "ses-456")
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "已连接到会话: ses-456" }),
      })
    })

    it("replies when session does not exist", async () => {
      mockGateway.getSession.mockResolvedValueOnce(null)
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/connect ses-invalid")

      expect(result).toBe(true)
      expect(mockGateway.getSession).toHaveBeenCalledWith("ses-invalid")
      expect(mockSessionManager.setMapping).not.toHaveBeenCalled()
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "会话不存在。" }),
      })
    })

    it("replies with usage when session_id is missing", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/connect")

      expect(result).toBe(true)
      expect(mockGateway.getSession).not.toHaveBeenCalled()
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: JSON.stringify({ text: "用法: /connect {session_id}" }),
      })
    })
  })


  describe("/help and /", () => {
    it("/help sends interactive card", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/help")

      expect(result).toBe(true)
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "interactive",
        content: expect.any(String),
      })
      // Verify the card has full structure: config, header, elements
      const callArgs = (mockFeishuClient.replyMessage as any).mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      expect(content).toHaveProperty("config")
      expect(content).toHaveProperty("header")
      expect(content).toHaveProperty("elements")
      expect(content.header?.title?.content).toContain("命令菜单")
      // every bridge command has a button
      const commands = content.elements
        .filter((el: any) => el.tag === "action")
        .flatMap((el: any) => el.actions)
        .map((b: any) => b.value.command)
      expect(commands).toContain("/new")
      expect(commands).toContain("/sessions")
      expect(commands).toContain("/abort")
      expect(commands).toContain("/模型")
      expect(commands).toContain("/自动关闭")
    })

    it("/help lists the commands opencode offers in this project", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })
      ;(mockGateway.commands as ReturnType<typeof vi.fn>).mockResolvedValue([
        { name: "init", description: "guided AGENTS.md setup" },
        { name: "review", description: "review changes" },
      ])

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/help")

      expect(result).toBe(true)
      const callArgs = (mockFeishuClient.replyMessage as any).mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      const markdown = content.elements
        .filter((el: any) => el.tag === "markdown")
        .map((el: any) => el.content)
        .join("\n")
      expect(markdown).toContain("/init")
      expect(markdown).toContain("guided AGENTS.md setup")
      expect(markdown).toContain("/review")
    })

    it("/帮助 is an alias for /help", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/帮助")

      expect(result).toBe(true)
      const callArgs = (mockFeishuClient.replyMessage as any).mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      expect(content.header?.title?.content).toContain("命令菜单")
    })

    it("/help still works when opencode's command list is unavailable", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })
      ;(mockGateway.commands as ReturnType<typeof vi.fn>).mockRejectedValue(
        new Error("boom"),
      )

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/help")

      expect(result).toBe(true)
      const callArgs = (mockFeishuClient.replyMessage as any).mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      expect(content.header?.title?.content).toContain("命令菜单")
    })

    it("runs an opencode command through the bridge", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })
      ;(mockGateway.commands as ReturnType<typeof vi.fn>).mockResolvedValue([
        { name: "review", description: "review changes" },
      ])
      const handleMessage = vi.fn().mockResolvedValue(undefined)
      const handler = createHandler(undefined, mockGateway)
      // the handler needs the bridge for opencode commands
      const withBridge = createCommandHandler({
        opencode: mockGateway,
        sessionManager: mockSessionManager,
        feishuClient: mockFeishuClient,
        logger: mockLogger,
        streamingBridge: { handleMessage } as never,
        eventListeners: new Map(),
        eventProcessor: {} as never,
      })

      const result = await withBridge("chat-1", "chat-1", "msg-1", "/review HEAD~1")
      expect(result).toBe(true)
      expect(handleMessage).toHaveBeenCalled()
      // the command is sent to opencode, the answer streams into a card
      const sendMessage = handleMessage.mock.calls[0][4] as () => Promise<string>
      await sendMessage()
      expect(mockGateway.sendCommand).toHaveBeenCalledWith(
        expect.any(String),
        { command: "review", arguments: "HEAD~1" },
      )
      void handler
    })

    it("answers an unknown lone command instead of sending it to the model", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })
      ;(mockGateway.commands as ReturnType<typeof vi.fn>).mockResolvedValue([
        { name: "review", description: "review changes" },
      ])

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/nonsense")

      // answered here — a typo must not burn a whole turn on the model
      expect(result).toBe(true)
      expect(mockFeishuClient.replyMessage).toHaveBeenCalled()
    })

    it("/自动关闭 shows the options", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({
        code: 0,
        msg: "ok",
        data: { message_id: "card-1" },
      })
      const supervisor = {
        isIdleWatchEnabled: vi.fn(() => true),
        setIdleWatchEnabled: vi.fn(),
        idleTimeoutMinutes: vi.fn(() => 30),
        setIdleTimeoutMinutes: vi.fn(),
      }
      const handler = createHandler(undefined, mockGateway, { supervisor } as any)

      const result = await handler("chat-1", "chat-1", "msg-1", "/自动关闭")

      expect(result).toBe(true)
      const call = (mockFeishuClient.replyMessage as any).mock.calls[0]
      const content = JSON.parse(call[1].content)
      expect(content.header?.title?.content).toContain("自动关闭")
      const buttons = content.elements
        .filter((el: any) => el.tag === "action")
        .flatMap((el: any) => el.actions)
      expect(buttons.map((b: any) => b.text.content)).toEqual([
        "不关闭",
        "15 分钟",
        "✅ 30 分钟",
        "60 分钟",
      ])
      expect(buttons[1].value.command).toBe("/自动关闭 15")
    })

    it("/自动关闭 15 sets the timeout", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })
      const supervisor = {
        isIdleWatchEnabled: vi.fn(() => true),
        setIdleWatchEnabled: vi.fn(),
        idleTimeoutMinutes: vi.fn(() => 30),
        setIdleTimeoutMinutes: vi.fn(),
      }
      const handler = createHandler(undefined, mockGateway, { supervisor } as any)

      const result = await handler("chat-1", "chat-1", "msg-1", "/自动关闭 15")

      expect(result).toBe(true)
      expect(supervisor.setIdleTimeoutMinutes).toHaveBeenCalledWith(15)
      const call = (mockFeishuClient.replyMessage as any).mock.calls[0]
      expect(JSON.parse(call[1].content).text).toContain("15 分钟")
    })

    it("/自动关闭 0 never stops the server", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })
      const supervisor = {
        isIdleWatchEnabled: vi.fn(() => true),
        setIdleWatchEnabled: vi.fn(),
        idleTimeoutMinutes: vi.fn(() => 30),
        setIdleTimeoutMinutes: vi.fn(),
      }
      const handler = createHandler(undefined, mockGateway, { supervisor } as any)

      await handler("chat-1", "chat-1", "msg-1", "/自动关闭 off")

      expect(supervisor.setIdleTimeoutMinutes).toHaveBeenCalledWith(0)
    })

    it("/models is an alias of /模型", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })
      ;(mockGateway.listModels as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "flash-free", providerID: "opencode", name: "Flash Free" },
      ])
      mockSessionManager.getExisting = vi.fn().mockResolvedValue("ses-1")
      mockGateway.getSession = vi.fn().mockResolvedValue({ id: "ses-1", model: {} })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/models")

      expect(result).toBe(true)
      const callArgs = (mockFeishuClient.replyMessage as any).mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      expect(content.header?.title?.content).toContain("模型菜单")
      // level 1 shows providers, not models
      const buttons = content.elements
        .filter((el: any) => el.tag === "action")
        .flatMap((el: any) => el.actions)
      expect(buttons[0].value.command).toBe("/模型 opencode")
    })

    it("an unknown lone slash command gets a hint, not a prompt", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/mudel")

      expect(result).toBe(true)
      // JSON.stringify would swallow the matcher, so parse what was sent
      const call = (mockFeishuClient.replyMessage as any).mock.calls[0]
      expect(call?.[0]).toBe("msg-1")
      expect(call?.[1]?.msg_type).toBe("text")
      expect(JSON.parse(call?.[1]?.content).text).toContain("/mudel")
      // nothing was sent to the model
      expect(mockGateway.sendPrompt).not.toHaveBeenCalled()
    })

    it("a slash followed by words still goes to the model", async () => {
      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/fix the file /etc/hosts")

      expect(result).toBe(false)
    })

    it("/模型 shows the providers first", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })
      ;(mockGateway.listModels as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "flash-free", providerID: "opencode", name: "Flash Free" },
        { id: "other", providerID: "openrouter", name: "Other" },
      ])
      mockSessionManager.getExisting = vi.fn().mockResolvedValue("ses-1")
      mockGateway.getSession = vi.fn().mockResolvedValue({
        id: "ses-1",
        model: { id: "flash-free", providerID: "opencode" },
      })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/模型")

      expect(result).toBe(true)
      const callArgs = (mockFeishuClient.replyMessage as any).mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      const buttons = content.elements
        .filter((el: any) => el.tag === "action")
        .flatMap((el: any) => el.actions)
      // one button per provider, not per model
      expect(buttons.length).toBe(2)
      expect(buttons[0].value.command).toBe("/模型 opencode")
    })

    it("/模型 <provider> lists that provider's models with paging", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })
      ;(mockGateway.listModels as ReturnType<typeof vi.fn>).mockResolvedValue(
        Array.from({ length: 25 }, (_, i) => ({
          id: `m${i}`,
          providerID: "opencode",
          name: `Model ${i}`,
        })),
      )
      mockSessionManager.getExisting = vi.fn().mockResolvedValue("ses-1")
      mockGateway.getSession = vi.fn().mockResolvedValue({ id: "ses-1", model: {} })

      const handler = createHandler()
      await handler("chat-1", "chat-1", "msg-1", "/模型 opencode")

      const callArgs = (mockFeishuClient.replyMessage as any).mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      const buttons = content.elements
        .filter((el: any) => el.tag === "action")
        .flatMap((el: any) => el.actions)
      // 12 models per page + "back" + "next page"
      expect(buttons.length).toBe(14)
      const next = buttons.find((b: any) => b.text.content.includes("下一页"))
      expect(next.value.command).toBe("/模型 opencode 2")
      const back = buttons.find((b: any) => b.text.content.includes("返回"))
      expect(back.value.command).toBe("/模型")
    })

    it("the menu card is patched in place, not sent again", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({
        code: 0,
        msg: "ok",
        data: { message_id: "card-1" },
      })
      mockFeishuClient.updateMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })
      ;(mockGateway.listModels as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "flash-free", providerID: "opencode", name: "Flash Free" },
        { id: "other", providerID: "openrouter", name: "Other" },
      ])
      mockSessionManager.getExisting = vi.fn().mockResolvedValue("ses-1")
      mockGateway.getSession = vi.fn().mockResolvedValue({ id: "ses-1", model: {} })

      const handler = createHandler()
      // the user types /模型 — a card is sent
      await handler("chat-1", "chat-1", "msg-1", "/模型")
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledTimes(1)

      // the menu id the buttons carry
      const card = JSON.parse((mockFeishuClient.replyMessage as any).mock.calls[0][1].content)
      const button = card.elements
        .filter((el: any) => el.tag === "action")
        .flatMap((el: any) => el.actions)[0]
      expect(button.value.action).toBe("model_menu")
      const menuId = button.value.menu

      // the user clicks the provider — the same card is patched
      await handler("chat-1", "chat-1", "msg-1", "/模型 openrouter", { menuId })

      expect(mockFeishuClient.replyMessage).toHaveBeenCalledTimes(1)
      expect(mockFeishuClient.updateMessage).toHaveBeenCalledTimes(1)
      const [patchedId, patchedContent] = (mockFeishuClient.updateMessage as any).mock.calls[0]
      expect(patchedId).toBe("card-1")
      const patched = JSON.parse(patchedContent)
      expect(patched.elements[0].content).toContain("第 2 步")
    })

    it("a switch from the card updates the card instead of replying", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({
        code: 0,
        msg: "ok",
        data: { message_id: "card-1" },
      })
      mockFeishuClient.updateMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })
      ;(mockGateway.listModels as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "flash-free", providerID: "opencode", name: "Flash Free" },
      ])
      mockSessionManager.getExisting = vi.fn().mockResolvedValue("ses-1")
      mockGateway.getSession = vi.fn().mockResolvedValue({
        id: "ses-1",
        model: { id: "flash-free", providerID: "opencode" },
      })

      const handler = createHandler()
      await handler("chat-1", "chat-1", "msg-1", "/模型")
      const card = JSON.parse((mockFeishuClient.replyMessage as any).mock.calls[0][1].content)
      const menuId = card.elements
        .filter((el: any) => el.tag === "action")
        .flatMap((el: any) => el.actions)[0].value.menu

      await handler("chat-1", "chat-1", "msg-1", "/模型 opencode|flash-free", { menuId })

      expect(mockGateway.switchModel).toHaveBeenCalledWith("ses-1", {
        id: "flash-free",
        providerID: "opencode",
      })
      // no new message — the card was patched
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledTimes(1)
      expect(mockFeishuClient.updateMessage).toHaveBeenCalledTimes(1)
      const patched = JSON.parse((mockFeishuClient.updateMessage as any).mock.calls[0][1])
      expect(patched.elements[0].content).toContain("已切换到")
      // the card shows the model by name
      expect(patched.elements[0].content).toContain("Flash Free")
      // the model list folded away — the provider list is back
      expect(patched.elements[0].content).toContain("第 1 步")
      const buttons = patched.elements
        .filter((el: any) => el.tag === "action")
        .flatMap((el: any) => el.actions)
      expect(buttons[0].value.command).toBe("/模型 opencode")
    })

    it("sorts the free models of a provider first", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })
      // the paid ones come first from the API — that must not be the order
      // the user sees
      ;(mockGateway.listModels as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "paid-1", providerID: "openrouter", name: "Paid 1" },
        { id: "paid-2", providerID: "openrouter", name: "Paid 2" },
        { id: "model:free", providerID: "openrouter", name: "Free Model" },
        { id: "another:free", providerID: "openrouter", name: "Another Free" },
      ])
      mockSessionManager.getExisting = vi.fn().mockResolvedValue("ses-1")
      mockGateway.getSession = vi.fn().mockResolvedValue({ id: "ses-1", model: {} })

      const handler = createHandler()
      await handler("chat-1", "chat-1", "msg-1", "/模型 openrouter")

      const callArgs = (mockFeishuClient.replyMessage as any).mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      const buttons = content.elements
        .filter((el: any) => el.tag === "action")
        .flatMap((el: any) => el.actions)
        .filter((b: any) => b.value.command.includes("|"))
      expect(buttons.map((b: any) => b.text.content)).toEqual([
        "Free Model",
        "Another Free",
        "Paid 1",
        "Paid 2",
      ])
    })

    it("counts the free models on the provider button", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })
      ;(mockGateway.listModels as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "paid-1", providerID: "openrouter", name: "Paid 1" },
        { id: "model:free", providerID: "openrouter", name: "Free Model" },
        { id: "only-free", providerID: "opencode", name: "Only Free" },
      ])
      mockSessionManager.getExisting = vi.fn().mockResolvedValue("ses-1")
      mockGateway.getSession = vi.fn().mockResolvedValue({ id: "ses-1", model: {} })

      const handler = createHandler()
      await handler("chat-1", "chat-1", "msg-1", "/模型")

      const callArgs = (mockFeishuClient.replyMessage as any).mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      const labels = content.elements
        .filter((el: any) => el.tag === "action")
        .flatMap((el: any) => el.actions)
        .map((b: any) => b.text.content)
      expect(labels).toContain("openrouter (2, 免费 1)")
      // all free → no clutter
      expect(labels).toContain("opencode (1)")
    })

    it("/模型 <provider> <page> shows the next page", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })
      ;(mockGateway.listModels as ReturnType<typeof vi.fn>).mockResolvedValue(
        Array.from({ length: 25 }, (_, i) => ({
          id: `m${i}`,
          providerID: "opencode",
          name: `Model ${i}`,
        })),
      )
      mockSessionManager.getExisting = vi.fn().mockResolvedValue("ses-1")
      mockGateway.getSession = vi.fn().mockResolvedValue({ id: "ses-1", model: {} })

      const handler = createHandler()
      await handler("chat-1", "chat-1", "msg-1", "/模型 opencode 2")

      const callArgs = (mockFeishuClient.replyMessage as any).mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      const markdown = content.elements.find((el: any) => el.tag === "markdown")
      expect(markdown.content).toContain("第 2/3 页")
      const buttons = content.elements
        .filter((el: any) => el.tag === "action")
        .flatMap((el: any) => el.actions)
      const prev = buttons.find((b: any) => b.text.content.includes("上一页"))
      expect(prev.value.command).toBe("/模型 opencode 1")
    })

    it("/模型 <provider|id> switches the model", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })
      mockSessionManager.getExisting = vi.fn().mockResolvedValue("ses-1")

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/模型 opencode|flash-free")

      expect(result).toBe(true)
      expect(mockGateway.switchModel).toHaveBeenCalledWith("ses-1", {
        id: "flash-free",
        providerID: "opencode",
      })
    })

    it("/ alone sends interactive card", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/")

      expect(result).toBe(true)
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "interactive",
        content: expect.any(String),
      })
      // Verify the card has full structure
      const callArgs = (mockFeishuClient.replyMessage as any).mock.calls[0]
      const content = JSON.parse(callArgs?.[1]?.content as string)
      expect(content).toHaveProperty("config")
      expect(content).toHaveProperty("header")
      expect(content).toHaveProperty("elements")
    })
  })

  describe("unknown command", () => {
    it("returns true for an unrecognized command without touching any session", async () => {
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })
      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/unknown")

      expect(result).toBe(true)
      expect(mockGateway.listSessions).not.toHaveBeenCalled()
      expect(mockGateway.getSession).not.toHaveBeenCalled()
      expect(mockGateway.createSession).not.toHaveBeenCalled()
      expect(mockGateway.abort).not.toHaveBeenCalled()
      expect(mockFeishuClient.replyMessage).toHaveBeenCalled()
    })

    it("returns false for non-slash text", async () => {
      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "hello")

      expect(result).toBe(false)
    })
  })

  describe("error handling", () => {
    it("catches errors and replies with error message", async () => {
      mockGateway.createSession.mockRejectedValueOnce(new Error("Network error"))
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/new")

      expect(result).toBe(true)
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("/new failed"),
      )
      expect(mockFeishuClient.replyMessage).toHaveBeenCalledWith("msg-1", {
        msg_type: "text",
        content: expect.stringContaining("命令执行失败"),
      })
    })

    it("does not crash when error reply also fails", async () => {
      mockGateway.createSession.mockRejectedValueOnce(new Error("Network error"))
      mockFeishuClient.replyMessage = vi.fn().mockRejectedValue(new Error("Reply failed"))

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/new")

      expect(result).toBe(true)
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Failed to send error reply"),
      )
    })
  })

  describe("case insensitivity", () => {
    it("handles /NEW as /new", async () => {
      mockGateway.createSession.mockResolvedValueOnce({ id: "ses-new" })
      mockFeishuClient.replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })

      const handler = createHandler()
      const result = await handler("chat-1", "chat-1", "msg-1", "/NEW")

      expect(result).toBe(true)
      expect(mockSessionManager.deleteMapping).toHaveBeenCalledWith("chat-1")
    })
  })
})
