import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { EventListenerMap } from "../utils/event-listeners.js"
import { createMessageHandler, type HandlerDeps } from "./message-handler.js"
import { EventProcessor } from "../streaming/event-processor.js"
import { createMockLogger, createMockFeishuClient, waitFor } from "../__tests__/setup.js"
import { createMockGateway } from "../__tests__/setup.js"
import { createSessionObserver } from "../streaming/session-observer.js"
import { ExpiringSet } from "../utils/expiring-set.js"

const advanceTimers = async (ms: number) => {
  if (typeof vi.advanceTimersByTimeAsync === "function") {
    await vi.advanceTimersByTimeAsync(ms)
  } else {
    vi.advanceTimersByTime(ms)
    await new Promise(r => setImmediate(r))
  }
}

import type { FeishuMessageEvent } from "../types.js"
import { FileTooLargeError } from "../feishu/api-client.js"

function makeEvent(overrides: Partial<FeishuMessageEvent> = {}): FeishuMessageEvent {
  return {
    event_id: "evt-1",
    event_type: "im.message.receive_v1",
    chat_id: "chat-1",
    chat_type: "p2p",
    message_id: "msg-1",
    sender: {
      sender_id: { open_id: "ou-1" },
      sender_type: "user",
      tenant_key: "tk-1",
    },
    message: {
      message_type: "text",
      content: JSON.stringify({ text: "Hello" }),
    },
    ...overrides,
  }
}

function makeDeps(overrides: Partial<HandlerDeps> = {}): HandlerDeps {
  const ownedSessions = new Set<string>()
  const eventListeners: EventListenerMap = new Map()

  return {
    opencode: createMockGateway(),
    sessionManager: {
      getOrCreate: vi.fn().mockResolvedValue("ses-1"),
      getExisting: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockReturnValue(null),
      deleteMapping: vi.fn().mockReturnValue(true),
      setMapping: vi.fn().mockReturnValue(true),
      cleanup: vi.fn().mockReturnValue(0),
      validateAndCleanupStale: vi.fn().mockResolvedValue(0),
    },
    dedup: {
      isDuplicate: vi.fn().mockReturnValue(false),
      isDuplicateMessage: vi.fn().mockReturnValue(false),
      close: vi.fn(),
    } as any,
    eventProcessor: new EventProcessor({ ownedSessions }),
    feishuClient: createMockFeishuClient(),
    progressTracker: {
      sendThinking: vi.fn().mockResolvedValue("thinking-msg-1"),
      updateWithResponse: vi.fn().mockResolvedValue(undefined),
      updateWithError: vi.fn().mockResolvedValue(undefined),
    },
    eventListeners,
    ownedSessions,
    logger: createMockLogger(),
    ...overrides,
  }
}

/**
 * Returns the payload passed to the gateway's sendPrompt.
 * Defaults to the most recent call; pass an explicit index for earlier calls.
 */
function sentPrompt(
  opencode: any,
  index = -1,
): { text: string; files?: Array<{ uri: string; name?: string }> } {
  const calls = opencode.sendPrompt.mock.calls
  const call = index < 0 ? calls[calls.length + index] : calls[index]
  return { text: "", ...(call?.[1] ?? {}) }
}

describe("createMessageHandler", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("skips duplicate events", async () => {
    const deps = makeDeps({
      dedup: { isDuplicate: vi.fn().mockReturnValue(true), close: vi.fn() } as any,
    })
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(makeEvent())

    expect(deps.sessionManager.getOrCreate).not.toHaveBeenCalled()
  })

  it("skips unsupported message types with clear log", async () => {
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(
      makeEvent({ message: { message_type: "audio", content: "" } }),
    )

    expect(deps.sessionManager.getOrCreate).not.toHaveBeenCalled()
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Unsupported message type: audio"),
    )
  })

  it("handles post message type — extracts text from rich content", async () => {
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const postContent = JSON.stringify({
      zh_cn: {
        title: "Post Title",
        content: [
          [
            { tag: "text", text: "Line 1 text" },
            { tag: "a", href: "https://example.com", text: "link" },
          ],
          [
            { tag: "text", text: "Line 2" },
          ],
        ],
      },
    })

    const handlerPromise = handler(
      makeEvent({ message: { message_type: "post", content: postContent } }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    expect(deps.progressTracker.updateWithResponse).toHaveBeenCalled()
  })

  it("handles post message with multiple paragraphs", async () => {
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const postContent = JSON.stringify({
      en_us: {
        content: [
          [{ tag: "text", text: "Paragraph 1" }],
          [{ tag: "text", text: "Paragraph 2" }],
          [{ tag: "text", text: "Paragraph 3" }],
        ],
      },
    })

    const handlerPromise = handler(
      makeEvent({ message: { message_type: "post", content: postContent } }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    const listener = [...deps.eventListeners.get("ses-1")!][0]!

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlerPromise

    expect(deps.progressTracker.updateWithResponse).toHaveBeenCalled()
  })

  it("handles post message with empty content gracefully", async () => {
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    // Empty post content
    const postContent = JSON.stringify({})

    await handler(
      makeEvent({ message: { message_type: "post", content: postContent } }),
    )

    // Should skip because extracted text is empty
    expect(deps.sessionManager.getOrCreate).not.toHaveBeenCalled()
  })

  it("handles flat post format (WebSocket)", async () => {
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const postContent = JSON.stringify({
      title: "",
      content: [
        [
          { tag: "text", text: "1. ", style: [] },
          { tag: "text", text: "first item" },
        ],
        [
          { tag: "text", text: "2. ", style: [] },
          { tag: "text", text: "second item" },
        ],
      ],
    })

    const handlerPromise = handler(
      makeEvent({ message: { message_type: "post", content: postContent } }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    // Verify sendPrompt was called with the extracted text
    const prompt = sentPrompt(deps.opencode)
    expect(prompt.text).toContain("1. first item")
    expect(prompt.text).toContain("2. second item")
    expect(prompt.files).toBeUndefined()
  })

  it("ignores a redelivered message (same message_id, new event_id)", async () => {
    // Feishu's long connection redelivers events with a NEW event_id, so the
    // event_id check misses it. The message_id is the stable identity.
    const isDuplicateMessage = vi.fn().mockReturnValueOnce(false).mockReturnValue(true)
    const deps = makeDeps({
      dedup: {
        isDuplicate: vi.fn().mockReturnValue(false),
        isDuplicateMessage,
        close: vi.fn(),
      } as any,
    })
    const { handleMessage: handler } = createMessageHandler(deps)

    // first delivery
    void handler(makeEvent({ event_id: "evt-1", message_id: "msg-redelivered" }))
    await waitFor(() => {
      expect(deps.opencode.sendPrompt).toHaveBeenCalledTimes(1)
    })
    // redelivery: different event_id, same message
    void handler(makeEvent({ event_id: "evt-2", message_id: "msg-redelivered" }))
    await new Promise((r) => setTimeout(r, 50))

    expect(isDuplicateMessage).toHaveBeenCalledTimes(2)
    expect(deps.opencode.sendPrompt).toHaveBeenCalledTimes(1)
  })

  it("resolves text message mention placeholders and strips the bot mention", async () => {
    const deps = makeDeps({ botOpenId: "bot-1" })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(
      makeEvent({
        chat_type: "group",
        message: {
          message_type: "text",
          content: JSON.stringify({ text: "@_user_1 please ask @_user_2 to review" }),
        },
        mentions: [
          { id: { open_id: "bot-1" }, name: "Opencode Bot", key: "@_user_1" },
          { id: { open_id: "ou-alice" }, name: "Alice", key: "@_user_2" },
        ],
      }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    const postedText = sentPrompt(deps.opencode).text
    expect(postedText).toContain("please ask @Alice to review")
    expect(postedText).not.toContain("@_user_1")
    expect(postedText).not.toContain("@_user_2")
    expect(postedText).not.toContain("@Opencode Bot")
  })

  it("resolves post message mention placeholders and strips the bot mention", async () => {
    const deps = makeDeps({ botOpenId: "bot-1" })
    const { handleMessage: handler } = createMessageHandler(deps)

    const postContent = JSON.stringify({
      content: [
        [
          { tag: "text", text: "@_user_1 please sync with @_user_2" },
        ],
      ],
    })

    const handlerPromise = handler(
      makeEvent({
        chat_type: "group",
        message: { message_type: "post", content: postContent },
        mentions: [
          { id: { open_id: "bot-1" }, name: "Opencode Bot", key: "@_user_1" },
          { id: { open_id: "ou-bob" }, name: "Bob", key: "@_user_2" },
        ],
      }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    const postedText = sentPrompt(deps.opencode).text
    expect(postedText).toContain("please sync with @Bob")
    expect(postedText).not.toContain("@_user_1")
    expect(postedText).not.toContain("@_user_2")
    expect(postedText).not.toContain("@Opencode Bot")
  })

  it("skips empty text messages", async () => {
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(
      makeEvent({ message: { message_type: "text", content: JSON.stringify({ text: "  " }) } }),
    )

    expect(deps.sessionManager.getOrCreate).not.toHaveBeenCalled()
  })

  it("handles POST failure with error card", async () => {
    const deps = makeDeps({
      opencode: createMockGateway({
        sendPrompt: vi.fn().mockRejectedValue(new Error("sendPrompt failed: HTTP 500")),
      }),
    })
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(makeEvent())

    expect(deps.progressTracker.updateWithError).toHaveBeenCalledWith(
      "thinking-msg-1",
      "处理请求时出错了。",
    )
  })

  it("handles POST failure without thinking card — sends direct message", async () => {
    const deps = makeDeps({
      opencode: createMockGateway({
        sendPrompt: vi.fn().mockRejectedValue(new Error("sendPrompt failed: HTTP 500")),
      }),
      progressTracker: {
        sendThinking: vi.fn().mockResolvedValue(null),
        updateWithResponse: vi.fn().mockResolvedValue(undefined),
        updateWithError: vi.fn().mockResolvedValue(undefined),
      },
    })
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(makeEvent())

    expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
      "chat-1",
      expect.objectContaining({ msg_type: "interactive" }),
    )

    const callArgs = (deps.feishuClient.sendMessage as any).mock.calls[0]
    const card = JSON.parse(callArgs?.[1]?.content as string)
    expect(card.elements?.[0]?.content).toContain("抱歉")
  })

  it("event-driven flow: collects TextDelta and responds on SessionIdle", async () => {
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())


    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    const listener = [...deps.eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      data: {
        part: { sessionID: "ses-1", messageID: "msg-1", type: "text", text: "Hello" },
        delta: "Hello ",
      },
    })

    listener({
      type: "message.part.updated",
      data: {
        part: { sessionID: "ses-1", messageID: "msg-1", type: "text", text: "Hello World" },
        delta: "World",
      },
    })

    listener({
      type: "session.status",
      data: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlerPromise

    expect(deps.progressTracker.updateWithResponse).toHaveBeenCalledWith(
      "thinking-msg-1",
      "Hello World",
    )
  })

  it("event-driven flow: removes listener after SessionIdle", async () => {
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    const listener = [...deps.eventListeners.get("ses-1")!][0]!

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlerPromise

    expect(deps.eventListeners.size).toBe(0)
  })

  it("event-driven flow: responds with default text when no TextDelta received", async () => {
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    expect(deps.progressTracker.updateWithResponse).toHaveBeenCalledWith(
      "thinking-msg-1",
      "（无回复）",
    )
  })

  it("falls back to sync mode on event-driven timeout", async () => {
    vi.useFakeTimers()

    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    // Advance microtasks under fake timers (waitFor uses setTimeout which is frozen)
    for (let i = 0; i < 20; i++) await advanceTimers(0)
    expect(deps.eventListeners.size).toBe(1)

    vi.advanceTimersByTime(5 * 60 * 1000 + 100)

    await handlerPromise

    // v2's sendPrompt returns no body, so the sync fallback reports the empty response.
    expect(deps.progressTracker.updateWithError).toHaveBeenCalledWith(
      "thinking-msg-1",
      "服务器返回了空响应。",
    )
    expect(deps.eventListeners.size).toBe(0)

  })

  it("suppresses SessionObserver forwarding while event-driven fallback owns the session", async () => {

    const feishuClient = createMockFeishuClient()
    ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

    const deps = makeDeps({ feishuClient })
    const seenInteractiveIds = new ExpiringSet<string>(60_000, 60_000)
    const observer = createSessionObserver({
      feishuClient: { sendMessage: feishuClient.sendMessage },
      eventProcessor: deps.eventProcessor,
      addListener: (sessionId, fn) => {
        const listeners = deps.eventListeners.get(sessionId)
        if (listeners) listeners.add(fn)
        else deps.eventListeners.set(sessionId, new Set([fn]))
      },
      removeListener: (sessionId, fn) => {
        const listeners = deps.eventListeners.get(sessionId)
        if (!listeners) return
        listeners.delete(fn)
        if (listeners.size === 0) deps.eventListeners.delete(sessionId)
      },
      logger: deps.logger,
      seenInteractiveIds,
    })
    const busySpy = vi.spyOn(observer, "markSessionBusy")
    const freeSpy = vi.spyOn(observer, "markSessionFree")

    const { handleMessage: handler } = createMessageHandler({ ...deps, observer })
    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.get("ses-1")?.size).toBe(3)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "message.part.updated",
        properties: {
          part: { sessionID: "ses-1", messageID: "msg-1", type: "text", text: "Hello" },
          delta: "Hello ",
        },
      })
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "message.part.updated",
        properties: {
          part: { sessionID: "ses-1", messageID: "msg-1", type: "text", text: "Hello World" },
          delta: "World",
        },
      })
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    expect(deps.progressTracker.updateWithResponse).toHaveBeenCalledWith(
      "thinking-msg-1",
      "Hello World",
    )
    expect(feishuClient.sendMessage).not.toHaveBeenCalled()
    expect(busySpy).toHaveBeenCalledWith("ses-1")
    expect(freeSpy).toHaveBeenCalledWith("ses-1")
    observer.stop()
    seenInteractiveIds.close()
  })

  it("marks observer busy/free when event-driven timeout falls back to sync", async () => {
    vi.useFakeTimers()

    const observer = {
      observe: vi.fn(),
      markOwned: vi.fn(),
      markSessionBusy: vi.fn(),
      markSessionFree: vi.fn(),
      getChatForSession: vi.fn(),
      stop: vi.fn(),
    }
    const deps = makeDeps({ observer })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    for (let i = 0; i < 20; i++) await advanceTimers(0)

    await waitFor(() => {
      expect(deps.eventListeners.get("ses-1")?.size).toBe(2)
    })

    expect(observer.markSessionBusy).toHaveBeenCalledWith("ses-1")

    await advanceTimers(5 * 60 * 1000 + 100)

    await handlerPromise

    // Sync fallback has no response body in v2 — it reports the empty response.
    expect(deps.progressTracker.updateWithError).toHaveBeenCalledWith(
      "thinking-msg-1",
      "服务器返回了空响应。",
    )
    expect(observer.markSessionFree).toHaveBeenCalledWith("ses-1")
    expect(observer.markSessionBusy.mock.invocationCallOrder[0]).toBeLessThan(
      observer.markSessionFree.mock.invocationCallOrder[0],
    )
    expect(deps.eventListeners.size).toBe(0)
  })

  it("sync fallback handles empty response body", async () => {
    vi.useFakeTimers()

    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    // Advance microtasks under fake timers (waitFor uses setTimeout which is frozen)
    for (let i = 0; i < 20; i++) await advanceTimers(0)
    expect(deps.eventListeners.size).toBe(1)

    vi.advanceTimersByTime(5 * 60 * 1000 + 100)

    await handlerPromise

    expect(deps.progressTracker.updateWithError).toHaveBeenCalledWith(
      "thinking-msg-1",
      "服务器返回了空响应。",
    )

  })

  it("adds sessionId to ownedSessions", async () => {
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.ownedSessions.has("ses-1")).toBe(true)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise
  })

  it("group chat replies to message instead of sending to chat", async () => {
    const deps = makeDeps({
      botOpenId: "bot-1",
      progressTracker: {
        sendThinking: vi.fn().mockResolvedValue(null),
        updateWithResponse: vi.fn().mockResolvedValue(undefined),
        updateWithError: vi.fn().mockResolvedValue(undefined),
      },
    })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(
      makeEvent({
        chat_type: "group",
        message_id: "group-msg-1",
        mentions: [{ id: { open_id: "bot-1" } }],
      }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "message.part.updated",
        properties: {
          part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Reply" },
          delta: "Reply",
        },
      })
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise
    
    expect(deps.feishuClient.replyMessage).toHaveBeenCalledWith(
      "group-msg-1",
      expect.objectContaining({ msg_type: "interactive" }),
    )

    const callArgs = (deps.feishuClient.replyMessage as any).mock.calls[0]
    const card = JSON.parse(callArgs?.[1]?.content as string)
    expect(card.elements?.[0]?.content).toBe("Reply")
  })


  it("processes solo group messages without @mention", async () => {
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.getChatInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: "Solo Group",
      chat_type: "group",
      user_count: 1,
    })
    const deps = makeDeps({ botOpenId: "bot-1", feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(
      makeEvent({
        chat_type: "group",
        message_id: "solo-group-msg-1",
      }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    expect(feishuClient.getChatInfo).toHaveBeenCalledWith("chat-1")
    expect(deps.sessionManager.getOrCreate).toHaveBeenCalled()
    expect(deps.logger.info).toHaveBeenCalledWith(
      "Solo group detected (chat=chat-1), processing without @mention",
    )
  })

  it("skips group messages without @mention when the group has multiple humans", async () => {
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.getChatInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: "Busy Group",
      chat_type: "group",
      user_count: 3,
    })
    const deps = makeDeps({ botOpenId: "bot-1", feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(
      makeEvent({
        chat_type: "group",
        message_id: "multi-group-msg-1",
      }),
    )

    expect(feishuClient.getChatInfo).toHaveBeenCalledWith("chat-1")
    expect(deps.sessionManager.getOrCreate).not.toHaveBeenCalled()
  })

  it("does not add the Lark signature by default", async () => {
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    const promptText = sentPrompt(deps.opencode).text
    expect(promptText).not.toContain("[Lark context]")
    expect(promptText).not.toContain("[Lark] from:")
  })

  it("includes Lark context with chat and sender info on first message", async () => {
    const deps = { ...makeDeps(), larkSignature: true }
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    // Verify sendPrompt text contains Lark context signature with sender info
    const promptText = sentPrompt(deps.opencode).text
    expect(promptText).toContain("[Lark context]")
    expect(promptText).toContain("Sender: Test User")
    expect(promptText).toContain("Save files")
  })

  it("includes lightweight Lark tag with sender on subsequent messages", async () => {
    const deps = { ...makeDeps(), larkSignature: true }
    const { handleMessage: handler } = createMessageHandler(deps)

    // First message
    const p1 = handler(makeEvent({ event_id: "evt-1" }))
    await waitFor(() => { expect(deps.eventListeners.size).toBe(1) })
    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })
    await p1

    // Second message (different event_id)
    const p2 = handler(makeEvent({ event_id: "evt-2" }))
    await waitFor(() => { expect(deps.eventListeners.size).toBe(1) })
    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })
    await p2

    // Second sendPrompt should have lightweight tag with sender name
    const sendCalls = (deps.opencode.sendPrompt as any).mock.calls
    expect(sendCalls.length).toBeGreaterThanOrEqual(2)
    const secondText = sentPrompt(deps.opencode, 1).text
    expect(secondText).toContain("[Lark] from: Test User")
    expect(secondText).not.toContain("[Lark context]")
  })

  it("includes group chat name in Lark context for group messages", async () => {
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.getChatInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
      name: "My Project Group", chat_type: "group",
      user_count: 2,
    })
    const deps = makeDeps({
      feishuClient,
      larkSignature: true,
      botOpenId: "bot-1",
      progressTracker: {
        sendThinking: vi.fn().mockResolvedValue(null),
        updateWithResponse: vi.fn().mockResolvedValue(undefined),
        updateWithError: vi.fn().mockResolvedValue(undefined),
      },
    })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(
      makeEvent({
        chat_type: "group",
        message_id: "group-msg-1",
        mentions: [{ id: { open_id: "bot-1" } }],
      }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    const promptText = sentPrompt(deps.opencode).text
    expect(promptText).toContain("Chat: My Project Group (group)")
    expect(promptText).toContain("[Lark context]")
  })

  it("does not send bind notification on any message", async () => {
    const deps = { ...makeDeps(), larkSignature: true }
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    // No bind notification should be sent (removed feature)
    const sendCalls = (deps.feishuClient.sendMessage as any).mock.calls
    const bindCalls = sendCalls.filter(
      (c: any[]) => {
        try {
          return JSON.parse(c[1]?.content)?.text?.includes("\u5df2\u8fde\u63a5 session:")
        } catch { return false }
      },
    )
    expect(bindCalls).toHaveLength(0)
  })

  it("calls observer.observe() with correct args after session resolution", async () => {
    const observer = {
      observe: vi.fn(),
      markOwned: vi.fn(),
      markSessionBusy: vi.fn(),
      markSessionFree: vi.fn(),
      getChatForSession: vi.fn(),
      stop: vi.fn(),
    }
    const deps = makeDeps({ observer })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    expect(observer.observe).toHaveBeenCalledWith("ses-1", "chat-1")
  })

  it("calls observer.markOwned() with messageId from events in event-driven path", async () => {
    const observer = {
      observe: vi.fn(),
      markOwned: vi.fn(),
      markSessionBusy: vi.fn(),
      markSessionFree: vi.fn(),
      getChatForSession: vi.fn(),
      stop: vi.fn(),
    }
    const deps = makeDeps({ observer })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    // Dispatch a v2-shaped event (payload under `data`) carrying a messageID
    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "message.part.updated",
        data: {
          part: { sessionID: "ses-1", messageID: "oc-msg-42", type: "text", text: "Hello" },
          delta: "Hello",
        },
      })
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        data: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    expect(observer.markOwned).toHaveBeenCalledWith("oc-msg-42")
  })

  it("marks ownership from a v2 event that carries assistantMessageID", async () => {
    // v2 renamed messageID -> assistantMessageID. Without this the observer
    // treats the reply as TUI-initiated and forwards it AGAIN as a second card.
    const observer = {
      observe: vi.fn(),
      markOwned: vi.fn(),
      markSessionBusy: vi.fn(),
      markSessionFree: vi.fn(),
      getChatForSession: vi.fn(),
      stop: vi.fn(),
    }
    const deps = makeDeps({ observer })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.text.delta",
        data: { sessionID: "ses-1", assistantMessageID: "oc-msg-v2", delta: "Hello" },
      })
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.execution.succeeded",
        data: { sessionID: "ses-1" },
      })
    })

    await handlerPromise

    expect(observer.markOwned).toHaveBeenCalledWith("oc-msg-v2")
  })

  it("works without observer (backward compatible)", async () => {
    const deps = makeDeps() // No observer
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    // Should complete without errors
    expect(deps.progressTracker.updateWithResponse).toHaveBeenCalled()
  })

  it("calls observer.markSessionBusy/Free when streaming bridge is used", async () => {
    const observer = {
      observe: vi.fn(),
      markOwned: vi.fn(),
      markSessionBusy: vi.fn(),
      markSessionFree: vi.fn(),
      getChatForSession: vi.fn(),
      stop: vi.fn(),
    }

    // Create a minimal streaming bridge that resolves immediately
    const streamingBridge = {
      handleMessage: vi.fn().mockImplementation(
        async (_chatId: string, _sessionId: string, _el: EventListenerMap, _ep: unknown, _send: () => Promise<string>, onComplete: (text: string) => void) => {
          onComplete("done")
        },
      ),
    }

    const feishuClient = createMockFeishuClient()
    ;(feishuClient.addReaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0, msg: "ok", data: { reaction_id: "r-1" },
    })

    const deps = makeDeps({ observer, streamingBridge, feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(makeEvent())

    expect(observer.markSessionBusy).toHaveBeenCalledWith("ses-1")
    expect(observer.markSessionFree).toHaveBeenCalledWith("ses-1")
  })

  it("includes quoted message context when parent_id is present", async () => {
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.getMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0,
      msg: "ok",
      data: {
        items: [{
          msg_type: "text",
          body: { content: JSON.stringify({ text: "original question" }) },
        }],
      },
    })
    const deps = makeDeps({ feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(
      makeEvent({ parent_id: "parent-msg-1" }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    expect(feishuClient.getMessage).toHaveBeenCalledWith("parent-msg-1")

    // Verify the prompt text contains quoted context
    const promptText = sentPrompt(deps.opencode).text
    expect(promptText).toContain("> original question")
    expect(promptText).toContain("Hello")
  })

  it("handles getMessage failure gracefully (still sends user message)", async () => {
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.getMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("API error"),
    )
    const deps = makeDeps({ feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(
      makeEvent({ parent_id: "parent-msg-1" }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    // Should still have sent the original message without quoted context
    const promptText = sentPrompt(deps.opencode).text
    expect(promptText).toContain("Hello")
    expect(promptText).not.toContain("> original question")
  })

  it("does not fetch quoted message when parent_id is absent", async () => {
    const feishuClient = createMockFeishuClient()
    const deps = makeDeps({ feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    expect(feishuClient.getMessage).not.toHaveBeenCalled()
  })

  it("handles image message — downloads it and attaches it to the prompt", async () => {
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.downloadResource as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: Buffer.from("fake-png-data"),
      filename: undefined,
    })
    const deps = makeDeps({ feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    const imageContent = JSON.stringify({ image_key: "img_abc123" })
    const handlerPromise = handler(
      makeEvent({ message: { message_type: "image", content: imageContent } }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    // Verify downloadResource was called with correct args
    expect(feishuClient.downloadResource).toHaveBeenCalledWith("msg-1", "img_abc123", "image")

    // Verify sendPrompt text contains the file reference text.
    // NOTE: message-handler never constructs a `type: "file"` part, so the
    // gateway's `files` argument stays undefined (reported as a finding).
    const prompt = sentPrompt(deps.opencode)
    expect(prompt.text).toContain("User sent an image.")
    expect(prompt.text).toContain("Saved to:")
    expect(prompt.text).toContain("Please look at this image.")
    // The image is now attached to the prompt as a file:// URL, so opencode
    // can actually look at it (a bare path is rejected by the v2 API).
    expect(prompt.files).toHaveLength(1)
    expect(prompt.files?.[0]?.uri).toMatch(/^file:\/\//)
    expect(prompt.files?.[0]?.name).toMatch(/image\.png$/)
  })

  it("handles JPEG image message — saves with .jpg extension", async () => {
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.downloadResource as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]),
      filename: undefined,
    })
    const deps = makeDeps({ feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    const imageContent = JSON.stringify({ image_key: "img_jpeg123" })
    const handlerPromise = handler(
      makeEvent({ message: { message_type: "image", content: imageContent } }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    const promptText = sentPrompt(deps.opencode).text
    expect(promptText).toMatch(/Saved to: .+image\.jpg/)
    expect(promptText).not.toMatch(/Saved to: .+image\.png/)
  })

  it("handles file message — downloads it and attaches it to the prompt", async () => {
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.downloadResource as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: Buffer.from("fake-file-data"),
      filename: undefined,
    })
    const deps = makeDeps({ feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    const fileContent = JSON.stringify({ file_key: "file_xyz789", file_name: "report.pdf" })
    const handlerPromise = handler(
      makeEvent({ message: { message_type: "file", content: fileContent } }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    // Verify downloadResource was called with correct args
    expect(feishuClient.downloadResource).toHaveBeenCalledWith("msg-1", "file_xyz789", "file")

    // Verify sendPrompt text contains the file reference text.
    const prompt = sentPrompt(deps.opencode)
    expect(prompt.text).toContain("User sent a file: report.pdf")
    expect(prompt.text).toContain("Saved to:")
    expect(prompt.text).toContain("Please review this file.")
    // The file is attached to the prompt as a file:// URL so opencode can read it.
    expect(prompt.files).toHaveLength(1)
    expect(prompt.files?.[0]?.uri).toMatch(/^file:\/\//)
  })

  it("handles file download failure — forwards error to opencode", async () => {
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.downloadResource as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Download failed"),
    )
    const deps = makeDeps({ feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    const imageContent = JSON.stringify({ image_key: "img_bad" })
    const handlerPromise = handler(
      makeEvent({ message: { message_type: "image", content: imageContent } }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    // Error should be logged
    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to handle image message"),
    )

    // Error message should be forwarded to opencode
    expect(deps.sessionManager.getOrCreate).toHaveBeenCalled()
    const promptText = sentPrompt(deps.opencode).text
    expect(promptText).toContain("download failed")
    expect(promptText).toContain("file_key: img_bad")
  })

  it("handles image message with missing image_key — forwards error", async () => {
    const deps = makeDeps()
    const { handleMessage: handler } = createMessageHandler(deps)

    const imageContent = JSON.stringify({})
    const handlerPromise = handler(
      makeEvent({ message: { message_type: "image", content: imageContent } }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    expect(deps.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to handle image message"),
    )
    // Error forwarded as text to opencode
    expect(deps.sessionManager.getOrCreate).toHaveBeenCalled()
  })

  it("handles FileTooLargeError — sends size limit message to opencode", async () => {
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.downloadResource as ReturnType<typeof vi.fn>).mockRejectedValue(
      new FileTooLargeError("big_file.zip", 60 * 1024 * 1024),
    )
    const deps = makeDeps({ feishuClient })
    const { handleMessage: handler } = createMessageHandler(deps)

    const fileContent = JSON.stringify({ file_key: "file_xyz", file_name: "big_file.zip" })
    const handlerPromise = handler(
      makeEvent({ message: { message_type: "file", content: fileContent } }),
    )

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    ;[...deps.eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlerPromise

    // Should forward specific size-limit message
    const promptText = sentPrompt(deps.opencode).text
    expect(promptText).toContain("exceeds the 50MB size limit")
    expect(promptText).toContain("big_file.zip")
  })
})

describe("createMessageHandler — debounce race condition", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    // Ensure fake timers from a previous test in this block don't leak in.
    vi.useRealTimers()
  })

  it("media1 starts init, media2 arrives → must not flush before init completes", async () => {
    // Simulate a slow addReaction call that takes significant time.
    // media2 arrives during that time. The flush must NOT fire before
    // addReaction finishes and context is set.

    let resolveReaction: ((v: unknown) => void) | undefined
    const reactionPromise = new Promise((r) => { resolveReaction = r })

    const feishuClient = createMockFeishuClient()
    ;(feishuClient.addReaction as ReturnType<typeof vi.fn>).mockReturnValue(reactionPromise)

    // Streaming bridge that captures reaction args to verify later
    const capturedArgs: Array<{ reactionMessageId: string, reactionId: string | null }> = []
    const streamingBridge = {
      handleMessage: vi.fn().mockImplementation(
        async (
          _chatId: string, _sessionId: string, _el: EventListenerMap,
          _ep: unknown, _send: () => Promise<string>,
          onComplete: (text: string) => void,
          reactionMessageId: string,
          reactionId: string | null,
        ) => {
          capturedArgs.push({ reactionMessageId, reactionId })
          onComplete("done")
        },
      ),
    }

    // Use a short debounce window with real timers
    const deps = makeDeps({
      feishuClient,
      streamingBridge,
      debounceMs: 100,
    })
    const { handleMessage: handler, dispose } = createMessageHandler(deps)

    // media1 — starts init, addReaction is pending
    const p1 = handler(makeEvent({
      event_id: "evt-img1",
      message_id: "msg-img1",
      message: { message_type: "image", content: JSON.stringify({ image_key: "img1" }) },
    }))

    // Wait a bit for image download + handler to reach addReaction await
    await new Promise(r => setTimeout(r, 50))

    // media2 arrives while addReaction is still pending
    const p2 = handler(makeEvent({
      event_id: "evt-img2",
      message_id: "msg-img2",
      message: { message_type: "image", content: JSON.stringify({ image_key: "img2" }) },
    }))

    // Wait well past the debounce window — flush must NOT fire
    await new Promise(r => setTimeout(r, 200))

    // The streaming bridge should NOT have been called yet —
    // init hasn't resolved so the timer was never started
    expect(streamingBridge.handleMessage).not.toHaveBeenCalled()

    // Now resolve the reaction — init completes, timer starts
    resolveReaction!({ data: { reaction_id: "r-1" } })

    // Wait for:
    //  - handler to resume after reaction resolves (microtasks)
    //  - debounce timer to fire (100ms real time)
    //  - handleBatchFlush to complete (async, involves mocked I/O)
    // Use a generous real-time delay, then poll for completion
    await new Promise(r => setTimeout(r, 300))
    await waitFor(() => {
      expect(streamingBridge.handleMessage).toHaveBeenCalledTimes(1)
    })

    // Verify reaction context was propagated to the streaming bridge
    expect(capturedArgs).toHaveLength(1)
    expect(capturedArgs[0]!.reactionId).toBe("r-1")
    expect(capturedArgs[0]!.reactionMessageId).toBe("msg-img1")

    await p1
    await p2
    dispose()
  })

  it("media + follow-up text → immediate flush, reaction context present", async () => {
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.addReaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { reaction_id: "r-42" },
    })

    const capturedArgs: Array<{ reactionMessageId: string, reactionId: string | null }> = []
    const streamingBridge = {
      handleMessage: vi.fn().mockImplementation(
        async (
          _chatId: string, _sessionId: string, _el: EventListenerMap,
          _ep: unknown, _send: () => Promise<string>,
          onComplete: (text: string) => void,
          reactionMessageId: string,
          reactionId: string | null,
        ) => {
          capturedArgs.push({ reactionMessageId, reactionId })
          onComplete("done")
        },
      ),
    }

    const deps = makeDeps({
      feishuClient,
      streamingBridge,
      debounceMs: 100,
    })
    const { handleMessage: handler, dispose } = createMessageHandler(deps)

    // 1. Send image first
    const p1 = handler(makeEvent({
      event_id: "evt-img",
      message_id: "msg-img",
      message: { message_type: "image", content: JSON.stringify({ image_key: "img1" }) },
    }))

    // Wait for the handler to complete init (image download + addReaction + updateContext + resolveInit)
    await p1

    // 2. Send follow-up text — should trigger immediate flush (hasPending check + flush)
    const p2 = handler(makeEvent({
      event_id: "evt-text",
      message_id: "msg-text",
      message: { message_type: "text", content: JSON.stringify({ text: "describe this" }) },
    }))

    // The streaming bridge should be called after flush
    await waitFor(() => {
      expect(streamingBridge.handleMessage).toHaveBeenCalledTimes(1)
    })

    // Verify reaction context was present (not lost due to race)
    expect(capturedArgs).toHaveLength(1)
    expect(capturedArgs[0]!.reactionId).toBe("r-42")
    expect(capturedArgs[0]!.reactionMessageId).toBe("msg-img")

    await p2
    dispose()
  })

  it("debounced event-driven timeout marks observer busy/free around sync fallback", async () => {
    vi.useFakeTimers()

    const observer = {
      observe: vi.fn(),
      markOwned: vi.fn(),
      markSessionBusy: vi.fn(),
      markSessionFree: vi.fn(),
      getChatForSession: vi.fn(),
      stop: vi.fn(),
    }

    const deps = makeDeps({ observer, debounceMs: 100 })
    const { handleMessage: handler, dispose } = createMessageHandler(deps)

    await handler(makeEvent({
      event_id: "evt-img-1",
      message_id: "msg-img-1",
      message: { message_type: "image", content: JSON.stringify({ image_key: "img-1" }) },
    }))

    for (let i = 0; i < 20; i++) await advanceTimers(0)
    await advanceTimers(100)

    await waitFor(() => {
      expect(deps.eventListeners.get("ses-1")?.size).toBe(2)
    })

    expect(observer.markSessionBusy).toHaveBeenCalledWith("ses-1")

    await advanceTimers(5 * 60 * 1000 + 100)

    await waitFor(() => {
      // v2's sendPrompt returns no body → the sync fallback reports the empty response.
      expect(deps.progressTracker.updateWithError).toHaveBeenCalledWith(
        "thinking-msg-1",
        "服务器返回了空响应。",
      )
    })

    expect(observer.markSessionFree).toHaveBeenCalledWith("ses-1")
    expect(observer.markSessionBusy.mock.invocationCallOrder[0]).toBeLessThan(
      observer.markSessionFree.mock.invocationCallOrder[0],
    )
    dispose()
  })

  it("debounced branch: 404 self-heals in handleBatchFlush and retries exactly once", async () => {
    const sendPrompt = vi.fn()
      .mockRejectedValueOnce(new Error("sendPrompt failed: HTTP 404"))
      .mockResolvedValueOnce(undefined)

    const feishuClient = createMockFeishuClient()
    ;(feishuClient.addReaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { reaction_id: "r-1" },
    })

    const sessionManager = {
      getOrCreate: vi.fn()
        .mockResolvedValueOnce("ses-stale")
        .mockResolvedValueOnce("ses-new"),
      getExisting: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockReturnValue(null),
      deleteMapping: vi.fn().mockReturnValue(true),
      setMapping: vi.fn().mockReturnValue(true),
      cleanup: vi.fn().mockReturnValue(0),
      validateAndCleanupStale: vi.fn().mockResolvedValue(0),
    }

    const bridgeCalls: string[] = []
    const streamingBridge = {
      handleMessage: vi.fn().mockImplementation(
        async (
          _chatId: string, sid: string, _el: EventListenerMap,
          _ep: unknown, sendMessage: () => Promise<string>,
          onComplete: (text: string) => void,
        ) => {
          bridgeCalls.push(sid)
          await sendMessage()
          onComplete("done")
        },
      ),
    }

    const deps = makeDeps({
      feishuClient,
      streamingBridge,
      sessionManager,
      debounceMs: 100,
      opencode: createMockGateway({ sendPrompt }),
    })
    const { handleMessage: handler, dispose } = createMessageHandler(deps)

    // Image buffers + starts init
    await handler(makeEvent({
      event_id: "evt-img-1",
      message_id: "msg-img-1",
      message: { message_type: "image", content: JSON.stringify({ image_key: "img-1" }) },
    }))

    // Follow-up text triggers an immediate flush of the batch
    const p2 = handler(makeEvent({
      event_id: "evt-text-1",
      message_id: "msg-text-1",
      message: { message_type: "text", content: JSON.stringify({ text: "go" }) },
    }))

    await waitFor(() => {
      expect(bridgeCalls).toEqual(["ses-stale", "ses-new"])
    })
    await p2

    expect(sessionManager.deleteMapping).toHaveBeenCalledWith("chat-1")
    expect(sessionManager.getOrCreate).toHaveBeenCalledTimes(2)
    expect(streamingBridge.handleMessage).toHaveBeenCalledTimes(2)
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("returned 404"),
    )
    dispose()
  })
})

describe("createMessageHandler — 404 session self-healing", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("recovers from 404 by clearing mapping and retrying with new session", async () => {
    const sendPrompt = vi.fn()
      .mockRejectedValueOnce(new Error("sendPrompt failed: HTTP 404"))
      .mockResolvedValueOnce(undefined)

    const sessionManager = {
      getOrCreate: vi.fn()
        .mockResolvedValueOnce("ses-stale")
        .mockResolvedValueOnce("ses-new"),
      getExisting: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockReturnValue(null),
      deleteMapping: vi.fn().mockReturnValue(true),
      setMapping: vi.fn().mockReturnValue(true),
      cleanup: vi.fn().mockReturnValue(0),
      validateAndCleanupStale: vi.fn().mockResolvedValue(0),
    }
    const deps = makeDeps({ sessionManager, opencode: createMockGateway({ sendPrompt }) })
    const { handleMessage: handler } = createMessageHandler(deps)

    const handlerPromise = handler(makeEvent())

    await waitFor(() => {
      expect(deps.eventListeners.size).toBe(1)
    })

    // Fire SessionIdle to complete the flow
    ;[...deps.eventListeners.entries()].forEach(([, listeners]) => {
      [...listeners].forEach((fn) => {
        fn({
          type: "session.status",
          properties: { sessionID: "ses-new", status: { type: "idle" } },
        })
      })
    })

    await handlerPromise

    // Verify: deleteMapping was called for the stale session
    expect(sessionManager.deleteMapping).toHaveBeenCalledWith("chat-1")
    // Verify: getOrCreate was called twice (initial + recovery)
    expect(sessionManager.getOrCreate).toHaveBeenCalledTimes(2)
    // Verify: 2 sendPrompt calls (original + retry)
    expect(sendPrompt).toHaveBeenCalledTimes(2)
    // Verify: self-healing logged
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("returned 404"),
    )
  })

  it("does not retry more than once on repeated 404s", async () => {
    // Both sendPrompt calls reject with 404 — should fail after one retry
    const sendPrompt = vi.fn().mockRejectedValue(new Error("sendPrompt failed: HTTP 404"))

    const sessionManager = {
      getOrCreate: vi.fn()
        .mockResolvedValueOnce("ses-stale")
        .mockResolvedValueOnce("ses-also-stale"),
      getExisting: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockReturnValue(null),
      deleteMapping: vi.fn().mockReturnValue(true),
      setMapping: vi.fn().mockReturnValue(true),
      cleanup: vi.fn().mockReturnValue(0),
      validateAndCleanupStale: vi.fn().mockResolvedValue(0),
    }
    const deps = makeDeps({ sessionManager, opencode: createMockGateway({ sendPrompt }) })
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(makeEvent())

    // Should show error after retry failure
    expect(deps.progressTracker.updateWithError).toHaveBeenCalledWith(
      "thinking-msg-1",
      "处理请求时出错了。",
    )
    // Only one retry
    expect(sessionManager.getOrCreate).toHaveBeenCalledTimes(2)
    expect(sendPrompt).toHaveBeenCalledTimes(2)
  })

  it("non-404 errors are not treated as session-gone", async () => {
    const deps = makeDeps({
      opencode: createMockGateway({
        sendPrompt: vi.fn().mockRejectedValue(new Error("sendPrompt failed: HTTP 500")),
      }),
    })
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(makeEvent())

    // Regular error handling — no deleteMapping
    expect(deps.sessionManager.deleteMapping).not.toHaveBeenCalled()
    expect(deps.progressTracker.updateWithError).toHaveBeenCalled()
  })
})

describe("createMessageHandler — streaming 404 session self-healing", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.useRealTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("streaming branch: 404 triggers session switch with new listener on new session", async () => {
    // Setup: first sendPrompt rejects with 404 (stale session), second succeeds
    const sendPrompt = vi.fn()
      .mockRejectedValueOnce(new Error("sendPrompt failed: HTTP 404"))
      .mockResolvedValueOnce(undefined)

    const sessionManager = {
      getOrCreate: vi.fn()
        .mockResolvedValueOnce("ses-stale")
        .mockResolvedValueOnce("ses-new"),
      getExisting: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockReturnValue(null),
      deleteMapping: vi.fn().mockReturnValue(true),
      setMapping: vi.fn().mockReturnValue(true),
      cleanup: vi.fn().mockReturnValue(0),
      validateAndCleanupStale: vi.fn().mockResolvedValue(0),
    }

    const observer = {
      observe: vi.fn(),
      markOwned: vi.fn(),
      markSessionBusy: vi.fn(),
      markSessionFree: vi.fn(),
      getChatForSession: vi.fn(),
      stop: vi.fn(),
    }

    // Track which sessionId the streaming bridge was called with
    const bridgeCalls: string[] = []
    const streamingBridge = {
      handleMessage: vi.fn().mockImplementation(
        async (
          _chatId: string, sid: string, _el: EventListenerMap,
          _ep: unknown, sendMessage: () => Promise<string>,
          onComplete: (text: string) => void,
        ) => {
          bridgeCalls.push(sid)
          // Call sendMessage to trigger the POST (which may throw SessionGoneError)
          await sendMessage()
          onComplete("done")
        },
      ),
    }

    const feishuClient = createMockFeishuClient()
    ;(feishuClient.addReaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0, msg: "ok", data: { reaction_id: "r-1" },
    })

    const deps = makeDeps({ sessionManager, observer, streamingBridge, feishuClient, opencode: createMockGateway({ sendPrompt }) })
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(makeEvent())

    // Verify: old session was cleaned up
    expect(sessionManager.deleteMapping).toHaveBeenCalledWith("chat-1")
    // Verify: getOrCreate called twice (initial + recovery)
    expect(sessionManager.getOrCreate).toHaveBeenCalledTimes(2)
    // Verify: streaming bridge called twice — first with stale, then with new
    expect(bridgeCalls).toEqual(["ses-stale", "ses-new"])
    // Verify: old session listener was cleaned (markSessionBusy/Free paired)
    expect(observer.markSessionBusy).toHaveBeenCalledWith("ses-stale")
    expect(observer.markSessionFree).toHaveBeenCalledWith("ses-stale")
    // Verify: new session got busy/free
    expect(observer.markSessionBusy).toHaveBeenCalledWith("ses-new")
  })

  it("streaming branch: does not retry more than once on repeated 404s", async () => {
    // Every sendPrompt rejects with 404
    const sendPrompt = vi.fn().mockRejectedValue(new Error("sendPrompt failed: HTTP 404"))

    const sessionManager = {
      getOrCreate: vi.fn()
        .mockResolvedValueOnce("ses-stale")
        .mockResolvedValueOnce("ses-also-stale"),
      getExisting: vi.fn().mockResolvedValue(undefined),
      getSession: vi.fn().mockReturnValue(null),
      deleteMapping: vi.fn().mockReturnValue(true),
      setMapping: vi.fn().mockReturnValue(true),
      cleanup: vi.fn().mockReturnValue(0),
      validateAndCleanupStale: vi.fn().mockResolvedValue(0),
    }

    const streamingBridge = {
      handleMessage: vi.fn().mockImplementation(
        async (
          _chatId: string, _sid: string, _el: EventListenerMap,
          _ep: unknown, sendMessage: () => Promise<string>,
        ) => {
          await sendMessage() // Always throws SessionGoneError
        },
      ),
    }

    const feishuClient = createMockFeishuClient()
    ;(feishuClient.addReaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0, msg: "ok", data: { reaction_id: "r-1" },
    })
    ;(feishuClient.deleteReaction as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0 })

    const deps = makeDeps({ sessionManager, streamingBridge, feishuClient, opencode: createMockGateway({ sendPrompt }) })
    const { handleMessage: handler } = createMessageHandler(deps)

    await handler(makeEvent())

    // Streaming bridge called exactly twice (initial + one retry)
    expect(streamingBridge.handleMessage).toHaveBeenCalledTimes(2)
    // deleteMapping called: once in streaming 404 recovery, potentially again in sync fallback's postWithRecovery
    expect(sessionManager.deleteMapping).toHaveBeenCalled()
    // Reaction should be cleaned up in the sync fallback path
    expect(feishuClient.deleteReaction).toHaveBeenCalled()
  })
})
