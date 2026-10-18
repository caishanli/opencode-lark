import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { createInteractivePoller } from "../interactive-poller.js"
import { ExpiringSet } from "../../utils/expiring-set.js"
import { interactiveCardKey } from "../../feishu/interactive-card-registry.js"
import { createMockGateway } from "../../__tests__/setup.js"

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
        const key = `${card.kind}:${card.requestId}`
        cards.set(key, { ...card, trackedAt: Date.now(), state: "sent" })
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

const advanceTimers = async (ms: number) => {
  if (typeof vi.advanceTimersByTimeAsync === "function") {
    await vi.advanceTimersByTimeAsync(ms)
  } else {
    vi.advanceTimersByTime(ms)
    await new Promise(r => setImmediate(r))
  }
}

function createMockLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  }
}

// Shapes below mirror the gateway contract:
//   QuestionRequest  = { id, sessionID, questions: [{ question, header, options, multiple?, custom? }] }
//   PermissionRequest = { id, sessionID, action, resources, save?, metadata? }
const SAMPLE_QUESTION = {
  id: "q_1",
  sessionID: "ses_abc",
  questions: [
    { question: "Pick one", header: "Choice", options: [{ label: "A", description: "Option A" }] },
  ],
}

const SAMPLE_PERMISSION = {
  id: "p_1",
  sessionID: "ses_abc",
  action: "file_edit",
  resources: ["/src/foo.ts"],
  metadata: { tool: "edit" },
}

describe("interactive-poller", () => {
  const createdSeenInteractiveIds: ExpiringSet<string>[] = []

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
    for (const seenSet of createdSeenInteractiveIds.splice(0)) {
      seenSet.close()
    }
  })

  function createDeps(overrides: Record<string, unknown> = {}) {
    const seenInteractiveIds = new ExpiringSet<string>(30 * 60 * 1000, 2 * 60 * 1000)
    createdSeenInteractiveIds.push(seenInteractiveIds)

    return {
      opencode: createMockGateway(),
      feishuClient: {
        sendMessage: vi.fn().mockResolvedValue({
          code: 0,
          msg: "ok",
          data: { message_id: "msg_1" },
        }),
        updateMessage: vi.fn().mockResolvedValue({ code: 0, msg: "ok" }),
      },
      logger: createMockLogger(),
      getChatForSession: vi.fn().mockReturnValue("chat_123"),
      seenInteractiveIds,
      interactiveCardRegistry: createMockInteractiveCardRegistry(),
      ...overrides,
    }
  }

  // ── Lifecycle ──

  describe("start/stop lifecycle", () => {
    it("start() logs and begins polling", () => {
      const deps = createDeps()
      const poller = createInteractivePoller(deps)
      poller.start()

      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Interactive poller started"),
      )
    })

    it("start() runs first poll immediately", async () => {
      const deps = createDeps()
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.opencode.listQuestions).toHaveBeenCalled()
      expect(deps.opencode.listPermissions).toHaveBeenCalled()
    })

    it("start() when already started is a no-op", () => {
      const deps = createDeps()
      const poller = createInteractivePoller(deps)
      poller.start()
      poller.start()

      const startCalls = (deps.logger.info as ReturnType<typeof vi.fn>).mock.calls
        .filter((c: string[]) => c[0].includes("started"))
      expect(startCalls).toHaveLength(1)
    })

    it("stop() clears interval and logs", () => {
      const deps = createDeps()
      const poller = createInteractivePoller(deps)
      poller.start()
      poller.stop()

      expect(deps.logger.info).toHaveBeenCalledWith("Interactive poller stopped")
    })

    it("stop() when not started is safe", () => {
      const deps = createDeps()
      const poller = createInteractivePoller(deps)
      expect(() => poller.stop()).not.toThrow()
      expect(deps.logger.info).toHaveBeenCalledWith("Interactive poller stopped")
    })
  })

  // ── Question polling ──

  describe("pollQuestions", () => {
    it("sends card for pending question", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listQuestions: vi.fn().mockResolvedValue([SAMPLE_QUESTION]),
        }),
      })
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
        "chat_123",
        expect.objectContaining({ msg_type: "interactive" }),
      )
      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("pending question q_1"),
      )
    })

    it("deduplicates already-seen question IDs", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listQuestions: vi.fn().mockResolvedValue([SAMPLE_QUESTION]),
        }),
      })
      deps.seenInteractiveIds.add(interactiveCardKey("question", "q_1"))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("skips question when no chatId for session", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listQuestions: vi.fn().mockResolvedValue([SAMPLE_QUESTION]),
        }),
        getChatForSession: vi.fn().mockReturnValue(undefined),
      })
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("skips question missing required fields", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listQuestions: vi.fn().mockResolvedValue([
            { id: "", sessionID: "ses_abc", questions: [] },
            { id: "q_2", sessionID: "", questions: [] },
            { id: "q_3", sessionID: "ses_abc", questions: "not_array" },
          ]),
        }),
      })
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("handles non-ok question response degrading to an empty list", async () => {
      // The gateway maps any non-ok HTTP response (404/500) to [] rather than
      // rejecting, so this must be expressed as a RESOLVING [].
      const deps = createDeps({
        opencode: createMockGateway({
          listQuestions: vi.fn().mockResolvedValue([]),
        }),
      })
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("handles listQuestions network failure", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listQuestions: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
        }),
      })
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("handles non-array question response", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listQuestions: vi.fn().mockResolvedValue({ not: "array" }),
        }),
      })
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("handles malformed question response", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listQuestions: vi.fn().mockRejectedValue(new Error("parse error")),
        }),
      })
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("logs warning when sendMessage fails for question", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listQuestions: vi.fn().mockResolvedValue([SAMPLE_QUESTION]),
        }),
      })
      deps.feishuClient.sendMessage.mockRejectedValue(new Error("send failed"))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(10)

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Poller question card send failed"),
      )
    })
  })

  // ── Permission polling ──

  describe("pollPermissions", () => {
    it("sends card for pending permission", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listPermissions: vi.fn().mockResolvedValue([SAMPLE_PERMISSION]),
        }),
      })
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).toHaveBeenCalledWith(
        "chat_123",
        expect.objectContaining({ msg_type: "interactive" }),
      )
      expect(deps.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("pending permission p_1"),
      )
    })

    it("deduplicates already-seen permission IDs", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listPermissions: vi.fn().mockResolvedValue([SAMPLE_PERMISSION]),
        }),
      })
      deps.seenInteractiveIds.add(interactiveCardKey("permission", "p_1"))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("skips permission when no chatId for session", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listPermissions: vi.fn().mockResolvedValue([SAMPLE_PERMISSION]),
        }),
        getChatForSession: vi.fn().mockReturnValue(undefined),
      })
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("skips permission missing id or sessionID", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listPermissions: vi.fn().mockResolvedValue([
            { id: "", sessionID: "ses_abc", action: "bash", resources: [], metadata: {} },
            { id: "p_2", sessionID: "", action: "bash", resources: [], metadata: {} },
          ]),
        }),
      })
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("handles non-ok permission response degrading to an empty list", async () => {
      // Non-ok HTTP responses degrade to [] in the gateway, not a rejection.
      const deps = createDeps({
        opencode: createMockGateway({
          listPermissions: vi.fn().mockResolvedValue([]),
        }),
      })
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("handles listPermissions network failure", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listPermissions: vi.fn().mockRejectedValue(new Error("ECONNREFUSED")),
        }),
      })
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("handles non-array permission response", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listPermissions: vi.fn().mockResolvedValue({ not: "array" }),
        }),
      })
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.feishuClient.sendMessage).not.toHaveBeenCalled()
    })

    it("uses joined resources as permission title", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listPermissions: vi.fn().mockResolvedValue([
            { ...SAMPLE_PERMISSION, resources: ["/src/a.ts", "/src/b.ts"] },
          ]),
        }),
      })
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      const calls = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls
      expect(calls.length).toBe(1)
      const card = JSON.parse(calls[0][1].content)
      // Real buildPermissionCard puts action.title in elements[0].text.content
      expect(card.elements[0].text.content).toBe("/src/a.ts, /src/b.ts")
    })

    it("falls back to action when resources empty", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listPermissions: vi.fn().mockResolvedValue([
            { ...SAMPLE_PERMISSION, resources: [] },
          ]),
        }),
      })
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      const calls = (deps.feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls
      expect(calls.length).toBe(1)
      const card = JSON.parse(calls[0][1].content)
      expect(card.elements[0].text.content).toBe("file_edit")
    })

    it("logs warning when sendMessage fails for permission", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listPermissions: vi.fn().mockResolvedValue([SAMPLE_PERMISSION]),
        }),
      })
      deps.feishuClient.sendMessage.mockRejectedValue(new Error("send failed"))
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(10)

      expect(deps.logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Poller permission card send failed"),
      )
    })
  })

  // ── Cross-cutting ──

  describe("cross-cutting", () => {
    it("adds processed IDs to seenInteractiveIds", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listQuestions: vi.fn().mockResolvedValue([SAMPLE_QUESTION]),
          listPermissions: vi.fn().mockResolvedValue([SAMPLE_PERMISSION]),
        }),
      })
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)

      expect(deps.seenInteractiveIds.has(interactiveCardKey("question", "q_1"))).toBe(true)
      expect(deps.seenInteractiveIds.has(interactiveCardKey("permission", "p_1"))).toBe(true)
    })

    it("polls again after 3s interval", async () => {
      const deps = createDeps()
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)
      const callsAfterFirst = (deps.opencode.listQuestions as ReturnType<typeof vi.fn>).mock.calls.length

      await advanceTimers(3000)
      expect((deps.opencode.listQuestions as ReturnType<typeof vi.fn>).mock.calls.length)
        .toBeGreaterThan(callsAfterFirst)

      poller.stop()
    })

    it("stop prevents further polling", async () => {
      const deps = createDeps()
      const poller = createInteractivePoller(deps)
      poller.start()
      await advanceTimers(0)
      poller.stop()

      const callsAtStop = (deps.opencode.listQuestions as ReturnType<typeof vi.fn>).mock.calls.length
      await advanceTimers(10000)
      expect((deps.opencode.listQuestions as ReturnType<typeof vi.fn>).mock.calls.length)
        .toBe(callsAtStop)
    })

    it("updates tracked question cards once answered in TUI", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listQuestions: vi.fn().mockResolvedValue([SAMPLE_QUESTION]),
        }),
      })
      const poller = createInteractivePoller(deps)

      poller.start()
      await advanceTimers(0)

      deps.opencode.listQuestions.mockResolvedValue([])
      await advanceTimers(3000)

      expect(deps.feishuClient.updateMessage).toHaveBeenCalledWith(
        "msg_1",
        expect.any(String),
      )
      const updatedCard = JSON.parse(
        (deps.feishuClient.updateMessage as ReturnType<typeof vi.fn>).mock.calls[0][1],
      )
      expect(updatedCard.header.title.content).toContain("Already Answered")
      expect(updatedCard.elements[0].text.content).toContain("opencode TUI")
    })

    it("does not overwrite cards while a Feishu reply is resolving", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listQuestions: vi.fn().mockResolvedValue([SAMPLE_QUESTION]),
        }),
      })
      const poller = createInteractivePoller(deps)

      poller.start()
      await advanceTimers(0)

      deps.interactiveCardRegistry.markFeishuResolving("question", "q_1")
      deps.opencode.listQuestions.mockResolvedValue([])
      await advanceTimers(3000)

      expect(deps.feishuClient.updateMessage).not.toHaveBeenCalled()
    })

    it("updates tracked permission cards once handled in TUI", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listPermissions: vi.fn().mockResolvedValue([SAMPLE_PERMISSION]),
        }),
      })
      const poller = createInteractivePoller(deps)

      poller.start()
      await advanceTimers(0)

      deps.opencode.listPermissions.mockResolvedValue([])
      await advanceTimers(3000)

      expect(deps.feishuClient.updateMessage).toHaveBeenCalledWith(
        "msg_1",
        expect.any(String),
      )
      const updatedCard = JSON.parse(
        (deps.feishuClient.updateMessage as ReturnType<typeof vi.fn>).mock.calls[0][1],
      )
      expect(updatedCard.header.title.content).toContain("Resolved")
      expect(updatedCard.elements[0].text.content).toContain("opencode TUI")
    })

    it("does not resolve question cards when the question endpoint failed", async () => {
      const deps = createDeps({
        opencode: createMockGateway({
          listQuestions: vi.fn().mockResolvedValue([SAMPLE_QUESTION]),
        }),
      })
      const poller = createInteractivePoller(deps)

      poller.start()
      await advanceTimers(0)

      deps.opencode.listQuestions.mockRejectedValue(new Error("ECONNREFUSED"))
      await advanceTimers(3000)

      expect(deps.feishuClient.updateMessage).not.toHaveBeenCalled()
    })
  })
})
