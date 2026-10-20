import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import type { EventListenerMap } from "../utils/event-listeners.js"
import { createStreamingBridge, type StreamingBridgeDeps } from "./streaming-integration.js"
import { EventProcessor } from "../streaming/event-processor.js"
import { createMockLogger, createMockFeishuClient, waitFor } from "../__tests__/setup.js"
import type { CardKitClient } from "../feishu/cardkit-client.js"
import type { SubAgentTracker } from "../streaming/subagent-tracker.js"
import { ExpiringSet } from "../utils/expiring-set.js"

function createMockInteractiveCardRegistry() {
  const cards = new Map<string, {
    requestId: string
    kind: "question" | "permission"
    chatId: string
    messageId: string
    trackedAt: number
    state: "dispatching" | "sent" | "resolving_feishu"
  }>()

  return {
    beginDispatch: vi.fn((kind: "question" | "permission", requestId: string) => {
      const key = `${kind}:${requestId}`
      if (cards.has(key)) return false
      cards.set(key, {
        requestId,
        kind,
        chatId: "",
        messageId: "",
        trackedAt: Date.now(),
        state: "dispatching",
      })
      return true
    }),
    failDispatch: vi.fn((kind: "question" | "permission", requestId: string) => {
      const key = `${kind}:${requestId}`
      const current = cards.get(key)
      if (!current || current.state !== "dispatching") return false
      cards.delete(key)
      return true
    }),
    track: vi.fn((card: {
      requestId: string
      kind: "question" | "permission"
      chatId: string
      messageId: string
    }) => {
      cards.set(`${card.kind}:${card.requestId}`, {
        ...card,
        trackedAt: Date.now(),
        state: "sent",
      })
    }),
    markFeishuResolving: vi.fn((kind: "question" | "permission", requestId: string) => {
      const key = `${kind}:${requestId}`
      const current = cards.get(key)
      if (!current || current.state !== "sent") return
      cards.set(key, { ...current, state: "resolving_feishu" })
    }),
    clearFeishuResolving: vi.fn((kind: "question" | "permission", requestId: string) => {
      const key = `${kind}:${requestId}`
      const current = cards.get(key)
      if (!current || current.state !== "resolving_feishu") return
      cards.set(key, { ...current, state: "sent" })
    }),
    untrack: vi.fn((kind: "question" | "permission", requestId: string) => cards.delete(`${kind}:${requestId}`)),
    list: vi.fn(() => Array.from(cards.values())),
    close: vi.fn(() => cards.clear()),
  }
}

/** The card content the bridge last wrote to Feishu. */
function cardContent(feishuClient: any): string {
  const updates = feishuClient.updateMessage?.mock.calls ?? []
  const source = updates.length > 0
    ? updates[updates.length - 1][1]
    : (feishuClient.sendMessage?.mock.calls ?? []).at(-1)?.[1]?.content
  if (!source) return ""
  try {
    const card = JSON.parse(source)
    return (card.body?.elements ?? [])
      .map((e: any) => e.content ?? (e.elements ?? []).map((x: any) => x.content).join("\n"))
      .join("\n")
  } catch {
    return String(source)
  }
}


function createMockSubAgentTracker() {
  return {
    onSubtaskDiscovered: vi.fn().mockResolvedValue({
      parentSessionId: "ses-1",
      childSessionId: "child-ses-1",
      prompt: "do something",
      description: "A subtask",
      agent: "code",
      status: "discovering",
    }),
    pollChildSession: vi.fn(),
    getChildMessages: vi.fn(),
    getTrackedSubAgents: vi.fn().mockReturnValue([]),
  } as unknown as SubAgentTracker
}

const createdSeenInteractiveIds: ExpiringSet<string>[] = []

function makeDeps(overrides: Partial<StreamingBridgeDeps> = {}): StreamingBridgeDeps {
  const seenInteractiveIds = new ExpiringSet<string>(30 * 60 * 1000, 2 * 60 * 1000)
  createdSeenInteractiveIds.push(seenInteractiveIds)

  return {
    feishuClient: createMockFeishuClient(),
    subAgentTracker: createMockSubAgentTracker(),
    logger: createMockLogger(),
    seenInteractiveIds,
    interactiveCardRegistry: createMockInteractiveCardRegistry(),
    ...overrides,
  }
}

const mockSendMessage = () => Promise.resolve('{"parts":[{"type":"text","text":"mock response"}]}')

describe("createStreamingBridge", () => {
  const ownedSessions = new Set<string>(["ses-1"])
  let eventListeners: EventListenerMap
  let eventProcessor: EventProcessor

  beforeEach(() => {
    vi.restoreAllMocks()
    eventListeners = new Map()
    eventProcessor = new EventProcessor({ ownedSessions })
  })

  afterEach(() => {
    for (const seenSet of createdSeenInteractiveIds.splice(0)) {
      seenSet.close()
    }
  })

  it("tracks question cards sent from the streaming bridge", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          msg: "ok",
          data: { message_id: "msg-question" },
        }),
        replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const handlePromise = bridge.handleMessage(
      "chat-1",
      "ses-1",
      eventListeners,
      eventProcessor,
      mockSendMessage,
      vi.fn(),
      "msg_original",
      null,
    )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!
    listener({
      type: "question.asked",
      properties: {
        sessionID: "ses-1",
        id: "q-bridge",
        questions: [
          {
            question: "Choose",
            header: "Choice",
            options: [{ label: "A", description: "Option A" }],
          },
        ],
      },
    })
    await Promise.resolve()

    expect(deps.interactiveCardRegistry?.list()).toEqual([
      expect.objectContaining({
        requestId: "q-bridge",
        kind: "question",
        messageId: "msg-question",
      }),
    ])

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })
    await handlePromise
  })

  it("creates a streaming card and registers listener", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
        replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    ;[...eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlePromise

    expect(deps.feishuClient.replyMessage).toHaveBeenCalledWith(
      "msg_original",
      expect.objectContaining({ msg_type: "interactive" }),
    )

    const callArgs = (deps.feishuClient.replyMessage as any).mock.calls[0]
    const card = JSON.parse(callArgs?.[1]?.content as string)
    expect(card.config?.wide_screen_mode).toBe(true)
    expect(card).not.toHaveProperty("header")
    expect(card.elements?.[0]?.tag).toBe("markdown")
    expect(card.elements?.[0]?.content).toBe("（无回复）")
    expect(onComplete).toHaveBeenCalledWith("（无回复）")
  })

  it("accumulates TextDelta and buffers text locally", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Hello" },
        delta: "Hello ",
      },
    })

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Hello World" },
        delta: "World",
      },
    })

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    expect(onComplete).toHaveBeenCalledWith("Hello World")
  })

  it("handles ToolStateChange by calling setToolStatus", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "tool",
          tool: "bash",
          state: { status: "running", title: "List files" },
        },
      },
    })

    await new Promise((r) => setTimeout(r, 10))

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise
    expect((deps.feishuClient as any).updateMessage).toHaveBeenCalled()
  })

  it("handles SubtaskDiscovered by sending separate card via sendMessage", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "subtask",
          prompt: "research topic",
          description: "Research the topic",
          agent: "researcher",
        },
      },
    })

    await new Promise((r) => setTimeout(r, 10))

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    expect((deps.subAgentTracker as any).onSubtaskDiscovered).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "SubtaskDiscovered",
        description: "Research the topic",
      }),
    )

    const sendCalls = (deps.feishuClient.sendMessage as any).mock.calls
    const subtaskCardCall = sendCalls.find(
      (call: unknown[]) =>
        call[0] === "chat-1" &&
        typeof (call[1] as Record<string, unknown>)?.content === "string" &&
        ((call[1] as Record<string, unknown>).content as string).includes("Research the topic"),
    )
    expect(subtaskCardCall).toBeDefined()
    const body1 = subtaskCardCall![1] as { msg_type: string; content: string }
    expect(body1.msg_type).toBe("interactive")
    const cardContent = JSON.parse(body1.content)
    expect(cardContent.header.template).toBe("indigo")
  })

  it("removes listener on SessionIdle", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    ;[...eventListeners.get("ses-1")!].forEach((fn) => {
      fn({
        type: "session.status",
        properties: { sessionID: "ses-1", status: { type: "idle" } },
      })
    })

    await handlePromise

    expect(eventListeners.size).toBe(0)
  })

  it("throws when card.start() fails (for fallback in caller)", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockRejectedValue(new Error("Feishu API down")),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    // Inject ToolStateChange to trigger card creation, which will attempt sendMessage and fail
    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "tool",
          tool: "bash",
          state: { status: "running", title: "List files" },
        },
      },
    })

    // Small delay to let async card.start() attempt
    await new Promise((r) => setTimeout(r, 50))

    // Now complete the session
    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    // The bridge should gracefully handle the sendMessage failure from card.start()
    // and still resolve (not reject)
    await handlePromise

    // Verify the handler completed with a response despite card.start() failure
    expect(onComplete).toHaveBeenCalledWith("（无回复）")
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("card start for tool failed"),
    )
    expect(eventListeners.size).toBe(0)
  })

  it("calls close() on the card when SessionIdle received", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
        replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    // Inject ToolStateChange to trigger card creation
    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "tool",
          tool: "bash",
          state: { status: "running", title: "List files" },
        },
      },
    })

    // Small delay to let async card.start() resolve
    await new Promise((r) => setTimeout(r, 10))

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    expect((deps.feishuClient as any).updateMessage).toHaveBeenCalled()
  })

  it("logs info when streaming card starts", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
        replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    // Inject ToolStateChange to trigger card creation
    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "tool",
          tool: "bash",
          state: { status: "running", title: "List files" },
        },
      },
    })

    // Small delay to let async card.start() resolve and log
    await new Promise((r) => setTimeout(r, 10))

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Streaming card started"),
    )
  })

  it("puts the token usage, rate and cache hit rate on the card", async () => {
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu })
    const bridge = createStreamingBridge(deps)

    const handlePromise = bridge.handleMessage(
      "chat-1", "ses-1", eventListeners, eventProcessor, mockSendMessage, vi.fn(), "msg_original", null,
    )
    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const emit = (ev: unknown) => {
      // the listener set is gone once the turn has been closed
      ;[...(eventListeners.get("ses-1") ?? [])].forEach((fn) => fn(ev))
    }

    emit({ type: "session.text.delta", data: { sessionID: "ses-1", assistantMessageID: "m-1", delta: "hello" } })
    emit({
      type: "session.usage.updated",
      data: {
        sessionID: "ses-1",
        cost: 0.25,
        tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 3000, write: 0 } },
      },
    })
    emit({ type: "session.execution.succeeded", data: { sessionID: "ses-1" } })

    await handlePromise

    const content = cardContent(mockFeishu)
    // "tokens" = what the model generated (output + reasoning), not the context
    expect(content).toContain("100 tokens")
    expect(content).toContain("tok/s")
    expect(content).toContain("上下文 4.0k")
    expect(content).toContain("缓存 75%")
  })

  it("reports the turn's usage delta, not the session's cumulative total", async () => {
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
    }
    // The session already used a lot before this turn started.
    const opencode = {
      getSession: vi.fn().mockResolvedValue({
        tokens: { input: 900, output: 90, reasoning: 0, cache: { read: 2900, write: 0 } },
      }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu, opencode } as any)
    const bridge = createStreamingBridge(deps)

    const handlePromise = bridge.handleMessage(
      "chat-1", "ses-1", eventListeners, eventProcessor, mockSendMessage, vi.fn(), "msg_original", null,
    )
    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const emit = (ev: unknown) => {
      // the listener set is gone once the turn has been closed
      ;[...(eventListeners.get("ses-1") ?? [])].forEach((fn) => fn(ev))
    }

    emit({ type: "session.text.delta", data: { sessionID: "ses-1", assistantMessageID: "m-1", delta: "hello" } })
    // Cumulative usage at the END of the turn (baseline was 900/90/2900).
    emit({
      type: "session.usage.updated",
      data: {
        sessionID: "ses-1",
        tokens: { input: 1000, output: 100, reasoning: 0, cache: { read: 3000, write: 0 } },
      },
    })
    emit({ type: "session.execution.succeeded", data: { sessionID: "ses-1" } })

    await handlePromise

    const content = cardContent(mockFeishu)
    // delta = input 100 + output 10 + cache.read 100
    expect(content).toContain("10 tokens")      // generated only
    expect(content).toContain("上下文 200")      // input + cache read
    expect(content).toContain("缓存 50%")
    // the cumulative numbers must not show up
    expect(content).not.toContain("4.1k")
    expect(content).not.toContain("4.0k")
  })

  it("times the rate against model time (step span), not the whole turn", async () => {
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu })
    const bridge = createStreamingBridge(deps)

    const handlePromise = bridge.handleMessage(
      "chat-1", "ses-1", eventListeners, eventProcessor, mockSendMessage, vi.fn(), "msg_original", null,
    )
    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const emit = (ev: unknown) => {
      // the listener set is gone once the turn has been closed
      ;[...(eventListeners.get("ses-1") ?? [])].forEach((fn) => fn(ev))
    }

    emit({ type: "session.text.delta", data: { sessionID: "ses-1", assistantMessageID: "m-1", delta: "hello" } })
    // one model call
    emit({ type: "session.step.started", data: { sessionID: "ses-1", assistantMessageID: "m-1" } })
    await new Promise((r) => setTimeout(r, 25))
    emit({ type: "session.step.ended", data: { sessionID: "ses-1", assistantMessageID: "m-1" } })
    // ...and time spent outside the model call (tool time) must not count
    await new Promise((r) => setTimeout(r, 60))
    emit({
      type: "session.usage.updated",
      data: { sessionID: "ses-1", tokens: { input: 10, output: 100, reasoning: 0, cache: { read: 0, write: 0 } } },
    })
    emit({ type: "session.execution.succeeded", data: { sessionID: "ses-1" } })

    await handlePromise

    const content = cardContent(mockFeishu)
    // the LLM-time part is present because step events were seen
    expect(content).toMatch(/LLM [\d.]+s/)
    expect(content).toContain("100 tokens")
    expect(content).toContain("tok/s")
  })

  it("closes the turn on session.execution.succeeded", async () => {
    // Measured on opencode v2.0.32: a turn ends with
    //   session.step.ended (finish:"stop") → session.usage.updated →
    //   session.execution.succeeded
    // The usage event fires after EVERY step, so it must not end the turn.
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu })
    const bridge = createStreamingBridge(deps)

    const handlePromise = bridge.handleMessage(
      "chat-1", "ses-1", eventListeners, eventProcessor, mockSendMessage, vi.fn(), "msg_original", null,
    )
    await waitFor(() => { expect(eventListeners.size).toBe(1) })
    const emit = (ev: unknown) => {
      ;[...(eventListeners.get("ses-1") ?? [])].forEach((fn) => fn(ev))
    }

    emit({ type: "session.text.delta", data: { sessionID: "ses-1", assistantMessageID: "m-1", delta: "the answer" } })
    emit({
      type: "session.usage.updated",
      data: { sessionID: "ses-1", tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } },
    })
    emit({ type: "session.execution.succeeded", data: { sessionID: "ses-1" } })
    await handlePromise

    const contents = (mockFeishu.updateMessage as any).mock.calls.map((c: any) => String(c[1]))
    expect(contents.some((c) => c.includes("已完成"))).toBe(true)
    expect(contents.some((c) => c.includes("the answer"))).toBe(true)
  })

  it("keeps the card open across the steps of a multi-step turn", async () => {
    // Regression: the usage event fires after every step. Closing the card
    // there cut the reply off after the first tool call — the card showed
    // "✅ 已完成" with a fraction of the answer.
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu })
    const bridge = createStreamingBridge(deps)

    const handlePromise = bridge.handleMessage(
      "chat-1", "ses-1", eventListeners, eventProcessor, mockSendMessage, vi.fn(), "msg_original", null,
    )
    await waitFor(() => { expect(eventListeners.size).toBe(1) })
    const emit = (ev: unknown) => {
      ;[...(eventListeners.get("ses-1") ?? [])].forEach((fn) => fn(ev))
    }

    // step 1: some text, a tool call, usage
    emit({ type: "session.text.delta", data: { sessionID: "ses-1", assistantMessageID: "m-1", delta: "第一步" } })
    emit({
      type: "session.tool.input.started",
      data: { sessionID: "ses-1", id: "call_1", name: "shell" },
    })
    emit({
      type: "session.tool.called",
      data: { sessionID: "ses-1", id: "call_1", name: "shell" },
    })
    emit({
      type: "session.usage.updated",
      data: { sessionID: "ses-1", tokens: { input: 10, output: 20, reasoning: 0, cache: { read: 0, write: 0 } } },
    })

    // the card must still be open: no "已完成" yet
    const midTurn = (mockFeishu.updateMessage as any).mock.calls.map((c: any) => String(c[1]))
    expect(midTurn.some((c) => c.includes("已完成"))).toBe(false)

    // step 2: the rest of the answer, then the turn ends
    emit({ type: "session.text.delta", data: { sessionID: "ses-1", assistantMessageID: "m-2", delta: "第二步" } })
    emit({
      type: "session.usage.updated",
      data: { sessionID: "ses-1", tokens: { input: 20, output: 40, reasoning: 0, cache: { read: 0, write: 0 } } },
    })
    emit({ type: "session.execution.succeeded", data: { sessionID: "ses-1" } })
    await handlePromise

    const contents = (mockFeishu.updateMessage as any).mock.calls.map((c: any) => String(c[1]))
    const final = contents[contents.length - 1]
    expect(final).toContain("第一步")
    expect(final).toContain("第二步")
    expect(final).toContain("已完成")
  })

  it("ignores text from an execution that already ran in a previous turn", async () => {
    // A turn that was still running when the next message arrived keeps
    // emitting text; that leftover must not land in the new turn's card.
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu })
    const bridge = createStreamingBridge(deps)

    const run = async (assistantMessageId: string, delta: string) => {
      const p = bridge.handleMessage(
        "chat-1", "ses-1", eventListeners, eventProcessor, mockSendMessage, vi.fn(), "msg_original", null,
      )
      await waitFor(() => { expect(eventListeners.size).toBe(1) })
      const listener = [...eventListeners.get("ses-1")!][0]!
      listener({
        type: "session.text.delta",
        data: { sessionID: "ses-1", assistantMessageID: assistantMessageId, delta },
      })
      listener({ type: "session.execution.succeeded", data: { sessionID: "ses-1" } })
      await p
    }

    // first turn: the assistant message id is consumed
    await run("msg-old", "old text")
    // second turn: the same (leftover) assistant message id must be ignored
    await run("msg-old", "LEFTOVER")

    const contents = (mockFeishu.updateMessage as any).mock.calls.map((c: any) => String(c[1]))
    expect(contents.some((c) => c.includes("LEFTOVER"))).toBe(false)
  })

  it("claims every assistant message id, so the observer does not forward it", async () => {
    // The session observer watches the same events. If it is not told that
    // the bridge delivers this turn, it posts a second, static copy of the
    // answer — without the status line, so no tok/s.
    const markOwned = vi.fn()
    const claimSession = vi.fn()
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
    }
    const deps = makeDeps({
      feishuClient: mockFeishu,
      observer: { markOwned, claimSession },
    })
    const bridge = createStreamingBridge(deps)

    const p = bridge.handleMessage(
      "chat-1", "ses-1", eventListeners, eventProcessor, mockSendMessage, vi.fn(), "msg_original", null,
    )
    await waitFor(() => { expect(eventListeners.size).toBe(1) })
    const listener = [...eventListeners.get("ses-1")!][0]!
    listener({
      type: "session.text.delta",
      data: { sessionID: "ses-1", assistantMessageID: "msg-a", delta: "hello" },
    })
    listener({ type: "session.execution.succeeded", data: { sessionID: "ses-1" } })
    await p

    expect(markOwned).toHaveBeenCalledWith("msg-a")
    expect(claimSession).toHaveBeenCalledWith("ses-1")
  })

  it("closes the card when the turn-end event never arrives", async () => {
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({ code: 0, data: { message_id: "msg_456" } }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu, idleCloseMs: 60 } as any)
    const bridge = createStreamingBridge(deps)

    void bridge.handleMessage(
      "chat-1", "ses-1", eventListeners, eventProcessor, mockSendMessage, vi.fn(), "msg_original", null,
    )
    await waitFor(() => { expect(eventListeners.size).toBe(1) })
    const listener = [...eventListeners.get("ses-1")!][0]!
    listener({
      type: "session.text.delta",
      data: { sessionID: "ses-1", assistantMessageID: "msg-x", delta: "partial" },
    })

    // no session.execution.succeeded ever arrives
    await new Promise((r) => setTimeout(r, 250))

    const contents = (mockFeishu.updateMessage as any).mock.calls.map((c: any) => String(c[1]))
    expect(contents.some((c) => c.includes("已完成"))).toBe(true)
  })

  it("serialises turns per chat: a second message waits for the first to finish", async () => {
    const deps = makeDeps()
    const bridge = createStreamingBridge(deps)
    const post = vi.fn().mockResolvedValue("{}")

    const first = bridge.handleMessage(
      "chat-1", "ses-1", eventListeners, eventProcessor, post, vi.fn(), "msg-1", null,
    )
    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })
    expect(post).toHaveBeenCalledTimes(1)

    // A second message for the same chat must not start a parallel turn.
    const second = bridge.handleMessage(
      "chat-1", "ses-1", eventListeners, eventProcessor, post, vi.fn(), "msg-2", null,
    )
    await new Promise((r) => setTimeout(r, 30))
    expect(post).toHaveBeenCalledTimes(1)

    // Finishing the first turn lets the second one start.
    ;[...eventListeners.get("ses-1")!].forEach((fn) => {
      fn({ type: "session.execution.succeeded", data: { sessionID: "ses-1" } })
    })
    await first
    await waitFor(() => {
      expect(post).toHaveBeenCalledTimes(2)
    })

    ;[...eventListeners.get("ses-1")!].forEach((fn) => {
      fn({ type: "session.execution.succeeded", data: { sessionID: "ses-1" } })
    })
    await second
  })

  it("still completes even if the card update throws", async () => {
    const deps = makeDeps({
      feishuClient: {
        ...createMockFeishuClient(),
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          data: { message_id: "msg_456" },
        }),
        updateMessage: vi.fn().mockRejectedValue(new Error("update fail")),
        replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
      },
    })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    // Inject ToolStateChange to trigger card creation
    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "tool",
          tool: "bash",
          state: { status: "running", title: "List files" },
        },
      },
    })

    // Small delay to let async card.start() resolve
    await new Promise((r) => setTimeout(r, 10))

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    expect(onComplete).toHaveBeenCalledWith("（无回复）")
    expect(deps.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("card.close() failed"),
    )
  })

  // ── New tests ──

  it("text delta buffers text and sends as replyMessage on idle", async () => {
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({
        code: 0,
        data: { message_id: "msg_456" },
      }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Hello" },
        delta: "Hello ",
      },
    })

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Hello World" },
        delta: "World",
      },
    })

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    // The reply now streams into the card instead of being posted as a separate card.
    expect(mockFeishu.replyMessage).not.toHaveBeenCalled()
    expect(cardContent(mockFeishu)).toContain("Hello World")
    expect(onComplete).toHaveBeenCalledWith("Hello World")
  })

  it("SubtaskDiscovered sends separate card instead of button", async () => {
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({
        code: 0,
        data: { message_id: "msg_456" },
      }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: {
          sessionID: "ses-1",
          messageID: "m-1",
          type: "subtask",
          prompt: "research topic",
          description: "Research the topic",
          agent: "researcher",
        },
      },
    })

    // Wait for async tracker + sendMessage
    await new Promise((r) => setTimeout(r, 50))

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    const sendCalls = mockFeishu.sendMessage.mock.calls
    const subtaskCall = sendCalls.find(
      (call: unknown[]) =>
        call[0] === "chat-1" &&
        typeof (call[1] as Record<string, unknown>)?.content === "string" &&
        ((call[1] as Record<string, unknown>).content as string).includes("Research the topic"),
    )
    expect(subtaskCall).toBeDefined()
    const body = subtaskCall![1] as { msg_type: string; content: string }
    expect(body.msg_type).toBe("interactive")
    const parsed = JSON.parse(body.content)
    expect(parsed.header.template).toBe("indigo")
    expect(parsed.elements[1].actions[0].text.content).toBe("🔍 View Details")
    expect(parsed.elements[1].actions[0].value.childSessionId).toBe("child-ses-1")
  })

  it("text buffer truncates at 100KB", async () => {
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({
        code: 0,
        data: { message_id: "msg_456" },
      }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
          "chat-1",
          "ses-1",
          eventListeners,
          eventProcessor,
          mockSendMessage,
          onComplete,
          "msg_original",
          null,
        )

    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    const bigText = "x".repeat(110_000)
    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: bigText },
        delta: bigText,
      },
    })

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    // The reply streams into the card, so no separate reply card is posted.
    expect(mockFeishu.replyMessage).not.toHaveBeenCalled()
    const content = cardContent(mockFeishu)
    expect(content).toContain("…(内容过长，已截断)")
    expect(content.length).toBeLessThan(110_000)
  })

  it("sends text as reply and calls deleteReaction when reactionId present", async () => {
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({
        code: 0,
        data: { message_id: "msg_456" },
      }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
      deleteReaction: vi.fn().mockResolvedValue({ code: 0 }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
      "chat-1",
      "ses-1",
      eventListeners,
      eventProcessor,
      mockSendMessage,
      onComplete,
      "msg_original",
      "reaction_123",
    )
    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    // Reasoning delta (should be ignored)
    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "reasoning" },
        delta: "Let me think...",
      },
    })
    // Text delta
    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Hello World" },
        delta: "Hello World",
      },
    })

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    // Text now streams into the card rather than being posted as a separate reply.
    expect(mockFeishu.replyMessage).not.toHaveBeenCalled()
    expect(cardContent(mockFeishu)).toContain("Hello World")
    // deleteReaction called with correct args
    expect(mockFeishu.deleteReaction).toHaveBeenCalledWith("msg_original", "reaction_123")
  })

  it("sends text as reply and calls deleteReaction when no reasoning content", async () => {
    const mockFeishu = {
      ...createMockFeishuClient(),
      sendMessage: vi.fn().mockResolvedValue({
        code: 0,
        data: { message_id: "msg_456" },
      }),
      replyMessage: vi.fn().mockResolvedValue({ code: 0 }),
      deleteReaction: vi.fn().mockResolvedValue({ code: 0 }),
    }
    const deps = makeDeps({ feishuClient: mockFeishu })
    const bridge = createStreamingBridge(deps)

    const onComplete = vi.fn()
    const handlePromise = bridge.handleMessage(
      "chat-1",
      "ses-1",
      eventListeners,
      eventProcessor,
      mockSendMessage,
      onComplete,
      "msg_original",
      "reaction_123",
    )
    await waitFor(() => {
      expect(eventListeners.size).toBe(1)
    })

    const listener = [...eventListeners.get("ses-1")!][0]!

    listener({
      type: "message.part.updated",
      properties: {
        part: { sessionID: "ses-1", messageID: "m-1", type: "text", text: "Hello World" },
        delta: "Hello World",
      },
    })

    listener({
      type: "session.status",
      properties: { sessionID: "ses-1", status: { type: "idle" } },
    })

    await handlePromise

    // Text now streams into the card rather than being posted as a separate reply.
    expect(mockFeishu.replyMessage).not.toHaveBeenCalled()
    expect(cardContent(mockFeishu)).toContain("Hello World")
    // deleteReaction called
    expect(mockFeishu.deleteReaction).toHaveBeenCalledWith("msg_original", "reaction_123")
  })
})
