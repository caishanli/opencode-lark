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

function makeGateway(overrides: { replyQuestion?: any; replyPermission?: any } = {}) {
  return {
    replyQuestion: overrides.replyQuestion ?? vi.fn().mockResolvedValue(undefined),
    replyPermission: overrides.replyPermission ?? vi.fn().mockResolvedValue(undefined),
  } as any
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
