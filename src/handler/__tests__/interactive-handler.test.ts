import { describe, it, expect, beforeEach, vi } from "vitest"
import { createInteractiveHandler } from "../interactive-handler.js"
import { createMockLogger } from "../../__tests__/setup.js"
import { createMockGateway } from "../../__tests__/setup.js"
import type { FeishuCardAction } from "../../types.js"

function createMockInteractiveCardRegistry() {
  return {
    beginDispatch: vi.fn(),
    failDispatch: vi.fn(),
    track: vi.fn(),
    markFeishuResolving: vi.fn(),
    clearFeishuResolving: vi.fn(),
    untrack: vi.fn(),
    list: vi.fn().mockReturnValue([]),
    close: vi.fn(),
  }
}

function makeGateway(overrides: {
  replyQuestion?: any
  replyPermission?: any
  getForm?: any
  replyForm?: any
} = {}) {
  return {
    replyQuestion: overrides.replyQuestion ?? vi.fn().mockResolvedValue(undefined),
    replyPermission: overrides.replyPermission ?? vi.fn().mockResolvedValue(undefined),
    getForm: overrides.getForm ?? vi.fn().mockResolvedValue(null),
    replyForm: overrides.replyForm ?? vi.fn().mockResolvedValue(undefined),
  } as any
}

const SAMPLE_FORM = {
  id: "frm_1",
  sessionID: "ses-1",
  title: "Questions",
  fields: [
    {
      key: "q0",
      type: "string",
      title: "Choice",
      description: "Pick one",
      options: [{ value: "A", label: "A" }],
      custom: true,
    },
  ],
}

describe("createInteractiveHandler", () => {
  let mockLogger: ReturnType<typeof createMockLogger>
  let mockInteractiveCardRegistry: ReturnType<typeof createMockInteractiveCardRegistry>

  beforeEach(() => {
    mockLogger = createMockLogger()
    mockInteractiveCardRegistry = createMockInteractiveCardRegistry()
    vi.clearAllMocks()
  })

  describe("question_answer action", () => {
    it("successfully answers a question", async () => {
      const opencode = makeGateway()
      const handler = createInteractiveHandler({
        opencode,
        logger: mockLogger,
        interactiveCardRegistry: mockInteractiveCardRegistry,
      })

      const answers = JSON.stringify([["first", "second"]])
      const action: FeishuCardAction = {
        action: {
          tag: "button",
          value: {
            action: "question_answer",
            requestId: "req-123",
            sessionId: "ses-1",
            answers,
          },
        },
        open_message_id: "msg-1",
        open_chat_id: "chat-1",
        operator: { open_id: "ou-1" },
      }

      await handler(action)

      expect(opencode.replyQuestion).toHaveBeenCalledWith("ses-1", "req-123", [["first", "second"]])
      expect(mockInteractiveCardRegistry.untrack).toHaveBeenCalledWith("question", "req-123")
    })

    it("warns on missing requestId", async () => {
      const opencode = makeGateway()
      const handler = createInteractiveHandler({ opencode, logger: mockLogger, interactiveCardRegistry: mockInteractiveCardRegistry })
      const action: FeishuCardAction = {
        action: { tag: "button", value: { action: "question_answer", answers: "[]" } },
        open_message_id: "msg-1", open_chat_id: "chat-1", operator: { open_id: "ou-1" },
      }
      await handler(action)
      expect(opencode.replyQuestion).not.toHaveBeenCalled()
      expect(mockLogger.warn).toHaveBeenCalled()
    })

    it("warns on missing sessionId", async () => {
      const opencode = makeGateway()
      const handler = createInteractiveHandler({ opencode, logger: mockLogger, interactiveCardRegistry: mockInteractiveCardRegistry })
      const action: FeishuCardAction = {
        action: { tag: "button", value: { action: "question_answer", requestId: "r1", answers: "[]" } },
        open_message_id: "msg-1", open_chat_id: "chat-1", operator: { open_id: "ou-1" },
      }
      await handler(action)
      expect(opencode.replyQuestion).not.toHaveBeenCalled()
      expect(mockLogger.warn).toHaveBeenCalled()
    })

    it("handles reply failure", async () => {
      const opencode = makeGateway({ replyQuestion: vi.fn().mockRejectedValue(new Error("fail")) })
      const handler = createInteractiveHandler({ opencode, logger: mockLogger, interactiveCardRegistry: mockInteractiveCardRegistry })
      const answers = JSON.stringify([["a"]])
      const action: FeishuCardAction = {
        action: { tag: "button", value: { action: "question_answer", requestId: "r1", sessionId: "s1", answers } },
        open_message_id: "msg-1", open_chat_id: "chat-1", operator: { open_id: "ou-1" },
      }
      await handler(action)
      expect(mockInteractiveCardRegistry.clearFeishuResolving).toHaveBeenCalledWith("question", "r1")
      expect(mockLogger.warn).toHaveBeenCalled()
    })
  })

  describe("permission_reply action", () => {
    it("successfully replies permission", async () => {
      const opencode = makeGateway()
      const handler = createInteractiveHandler({ opencode, logger: mockLogger, interactiveCardRegistry: mockInteractiveCardRegistry })
      const action: FeishuCardAction = {
        action: { tag: "button", value: { action: "permission_reply", requestId: "p1", sessionId: "s1", reply: "once" } },
        open_message_id: "msg-1", open_chat_id: "chat-1", operator: { open_id: "ou-1" },
      }
      await handler(action)
      expect(opencode.replyPermission).toHaveBeenCalledWith("s1", "p1", "once")
      expect(mockInteractiveCardRegistry.untrack).toHaveBeenCalledWith("permission", "p1")
    })

    it("warns on missing sessionId", async () => {
      const opencode = makeGateway()
      const handler = createInteractiveHandler({ opencode, logger: mockLogger, interactiveCardRegistry: mockInteractiveCardRegistry })
      const action: FeishuCardAction = {
        action: { tag: "button", value: { action: "permission_reply", requestId: "p1", reply: "once" } },
        open_message_id: "msg-1", open_chat_id: "chat-1", operator: { open_id: "ou-1" },
      }
      await handler(action)
      expect(opencode.replyPermission).not.toHaveBeenCalled()
      expect(mockLogger.warn).toHaveBeenCalled()
    })

    it("handles reply failure", async () => {
      const opencode = makeGateway({ replyPermission: vi.fn().mockRejectedValue(new Error("fail")) })
      const handler = createInteractiveHandler({ opencode, logger: mockLogger, interactiveCardRegistry: mockInteractiveCardRegistry })
      const action: FeishuCardAction = {
        action: { tag: "button", value: { action: "permission_reply", requestId: "p1", sessionId: "s1", reply: "reject" } },
        open_message_id: "msg-1", open_chat_id: "chat-1", operator: { open_id: "ou-1" },
      }
      await handler(action)
      expect(mockInteractiveCardRegistry.clearFeishuResolving).toHaveBeenCalledWith("permission", "p1")
      expect(mockLogger.warn).toHaveBeenCalled()
    })
  })

  it("tells the user when the server cannot answer a question (404)", async () => {
    const replyMessage = vi.fn().mockResolvedValue({ code: 0, msg: "ok" })
    const opencode = makeGateway({
      replyQuestion: vi.fn().mockRejectedValue(new Error("replyQuestion failed: HTTP 404: NotFoundError")),
    })
    const handler = createInteractiveHandler({
      opencode,
      logger: mockLogger,
      interactiveCardRegistry: mockInteractiveCardRegistry,
      feishuClient: { replyMessage } as any,
    })
    const action: FeishuCardAction = {
      action: { tag: "button", value: { action: "question_answer", requestId: "r1", sessionId: "s1", answers: "[]" } },
      open_message_id: "msg-1", open_chat_id: "chat-1", operator: { open_id: "ou-1" },
    }
    await handler(action)
    expect(replyMessage).toHaveBeenCalledWith(
      "msg-1",
      expect.objectContaining({ msg_type: "text" }),
    )
    const body = JSON.parse((replyMessage as any).mock.calls[0][1].content)
    expect(body.text).toContain("不支持")
  })

  it("ignores unknown actions", async () => {
    const opencode = makeGateway()
    const handler = createInteractiveHandler({ opencode, logger: mockLogger, interactiveCardRegistry: mockInteractiveCardRegistry })
    const action: FeishuCardAction = {
      action: { tag: "button", value: { action: "something_else" } },
      open_message_id: "msg-1", open_chat_id: "chat-1", operator: { open_id: "ou-1" },
    }
    await handler(action)
    expect(opencode.replyQuestion).not.toHaveBeenCalled()
    expect(opencode.replyPermission).not.toHaveBeenCalled()
  })

  it("ignores action with no value", async () => {
    const opencode = makeGateway()
    const handler = createInteractiveHandler({ opencode, logger: mockLogger, interactiveCardRegistry: mockInteractiveCardRegistry })
    const action: FeishuCardAction = {
      action: { tag: "button" } as any,
      open_message_id: "msg-1", open_chat_id: "chat-1", operator: { open_id: "ou-1" },
    }
    await handler(action)
    expect(opencode.replyQuestion).not.toHaveBeenCalled()
    expect(opencode.replyPermission).not.toHaveBeenCalled()
  })
})

describe("createInteractiveHandler: form_submit", () => {
  let mockLogger: ReturnType<typeof createMockLogger>
  let mockInteractiveCardRegistry: ReturnType<typeof createMockInteractiveCardRegistry>

  beforeEach(() => {
    mockLogger = createMockLogger()
    mockInteractiveCardRegistry = createMockInteractiveCardRegistry()
    vi.clearAllMocks()
  })

  function actionOf(formValue: Record<string, unknown>): FeishuCardAction {
    return {
      action: {
        tag: "button",
        value: { action: "form_submit", sessionId: "ses-1", formId: "frm_1" },
        form_value: formValue,
      },
      open_message_id: "msg-1", open_chat_id: "chat-1", operator: { open_id: "ou-1" },
    }
  }

  it("submits the selected option", async () => {
    const opencode = makeGateway({ getForm: vi.fn().mockResolvedValue(SAMPLE_FORM) })
    const handler = createInteractiveHandler({ opencode, logger: mockLogger, interactiveCardRegistry: mockInteractiveCardRegistry })

    await handler(actionOf({ q0: "A" }))

    expect(opencode.replyForm).toHaveBeenCalledWith("ses-1", "frm_1", { q0: "A" })
    expect(mockInteractiveCardRegistry.clearFeishuResolving).toHaveBeenCalledWith("question", "frm_1")
  })

  it("prefers a typed answer over the dropdown", async () => {
    const opencode = makeGateway({ getForm: vi.fn().mockResolvedValue(SAMPLE_FORM) })
    const handler = createInteractiveHandler({ opencode, logger: mockLogger, interactiveCardRegistry: mockInteractiveCardRegistry })

    await handler(actionOf({ q0: "A", q0__other: "custom" }))

    expect(opencode.replyForm).toHaveBeenCalledWith("ses-1", "frm_1", { q0: "custom" })
  })

  it("asks for a choice instead of submitting an empty answer", async () => {
    const opencode = makeGateway({ getForm: vi.fn().mockResolvedValue(SAMPLE_FORM) })
    const replyMessage = vi.fn().mockResolvedValue({ code: 0 })
    const handler = createInteractiveHandler({
      opencode,
      logger: mockLogger,
      interactiveCardRegistry: mockInteractiveCardRegistry,
      feishuClient: { replyMessage } as any,
    })

    await handler(actionOf({}))

    expect(opencode.replyForm).not.toHaveBeenCalled()
    expect(replyMessage).toHaveBeenCalled()
  })

  it("reports a form that is no longer pending", async () => {
    const opencode = makeGateway({ getForm: vi.fn().mockResolvedValue(null) })
    const replyMessage = vi.fn().mockResolvedValue({ code: 0 })
    const handler = createInteractiveHandler({
      opencode,
      logger: mockLogger,
      interactiveCardRegistry: mockInteractiveCardRegistry,
      feishuClient: { replyMessage } as any,
    })

    await handler(actionOf({ q0: "A" }))

    expect(opencode.replyForm).not.toHaveBeenCalled()
    const text = JSON.parse((replyMessage as any).mock.calls[0][1].content).text
    expect(text).toContain("已经结束")
  })

  it("clears the resolving state when the reply fails", async () => {
    const opencode = makeGateway({
      getForm: vi.fn().mockResolvedValue(SAMPLE_FORM),
      replyForm: vi.fn().mockRejectedValue(new Error("Expected string array for form field: q0")),
    })
    const handler = createInteractiveHandler({ opencode, logger: mockLogger, interactiveCardRegistry: mockInteractiveCardRegistry })

    await handler(actionOf({ q0: "A" }))

    expect(mockInteractiveCardRegistry.clearFeishuResolving).toHaveBeenCalledWith("question", "frm_1")
    expect(mockLogger.warn).toHaveBeenCalledWith(expect.stringContaining("Form reply request failed"))
  })
})
