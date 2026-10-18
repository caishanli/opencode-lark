import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import {
  SubAgentTracker,
  type TrackedSubAgent,
  type MessageSummary,
} from "./subagent-tracker.js"
import type { SubtaskDiscovered } from "./event-processor.js"
import { createMockGateway } from "../__tests__/setup.js"

/** Advance timers by a bounded amount and flush microtasks. */
const advanceAndFlush = async (ms = 20_000) => {
  if (typeof vi.advanceTimersByTimeAsync === "function") {
    await vi.advanceTimersByTimeAsync(ms)
  } else {
    vi.advanceTimersByTime(ms)
    await Promise.resolve()
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeAction(overrides?: Partial<SubtaskDiscovered>): SubtaskDiscovered {
  return {
    type: "SubtaskDiscovered",
    sessionId: "ses-parent",
    prompt: "Fix the bug",
    description: "Investigate and fix",
    agent: "explore",
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SubAgentTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  // 1. Child found on 1st poll → discovering → active
  it("transitions discovering → active when child found on 1st poll", async () => {
    const gateway = createMockGateway({
      children: vi.fn().mockResolvedValue([{ id: "ses-child-1" }]),
    })

    const tracker = new SubAgentTracker({ opencode: gateway })
    const agent = await tracker.onSubtaskDiscovered(makeAction())

    expect(agent.status).toBe("discovering")
    expect(agent.parentSessionId).toBe("ses-parent")

    // Let the background poll resolve
    await advanceAndFlush()

    expect(agent.status).toBe("active")
    expect(agent.childSessionId).toBe("ses-child-1")
  })

  // 2. Child found on 2nd poll → retry works
  it("finds child on 2nd poll after retry", async () => {
    const children = vi.fn()
      .mockResolvedValueOnce([]) // 1st attempt: empty
      .mockResolvedValueOnce([{ id: "ses-child-2" }]) // 2nd attempt: found
    const gateway = createMockGateway({ children })

    const tracker = new SubAgentTracker({ opencode: gateway })
    const agent = await tracker.onSubtaskDiscovered(makeAction())

    // Let all timers and promises resolve (2 polls with backoff)
    for (let i = 0; i < 5; i++) await advanceAndFlush()

    expect(agent.status).toBe("active")
    expect(agent.childSessionId).toBe("ses-child-2")
    expect(children).toHaveBeenCalledTimes(2)
  })

  // 3. Child not found after 5 retries → failed
  it("status becomes failed after 5 retries with no child", async () => {
    const children = vi.fn().mockResolvedValue([]) // always empty
    const gateway = createMockGateway({ children })

    const tracker = new SubAgentTracker({ opencode: gateway })
    const agent = await tracker.onSubtaskDiscovered(makeAction())

    // Advance through all 5 retries with backoff timers
    for (let i = 0; i < 10; i++) await advanceAndFlush()

    expect(agent.status).toBe("failed")
    expect(agent.childSessionId).toBeUndefined()
    expect(children).toHaveBeenCalledTimes(5)
  })

  // 4. getChildMessages returns formatted messages
  it("getChildMessages returns formatted messages", async () => {
    const messages = vi.fn().mockResolvedValue([
      { role: "user", text: "Hello" },
      {
        role: "assistant",
        text: "Hi there",
        toolCalls: [{ name: "readFile" }, { name: "writeFile" }],
      },
    ])
    const gateway = createMockGateway({ messages })

    const tracker = new SubAgentTracker({ opencode: gateway })
    const result = await tracker.getChildMessages("ses-child-1")

    expect(result).toEqual<MessageSummary[]>([
      { role: "user", text: "Hello" },
      { role: "assistant", text: "Hi there", toolCalls: ["readFile", "writeFile"] },
    ])
    expect(messages).toHaveBeenCalledWith("ses-child-1", { limit: 20, order: "desc" })
  })

  // 5. getChildMessages with empty response → empty array
  it("getChildMessages returns empty array for empty response", async () => {
    const gateway = createMockGateway({ messages: vi.fn().mockResolvedValue([]) })

    const tracker = new SubAgentTracker({ opencode: gateway })
    const messages = await tracker.getChildMessages("ses-child-1")

    expect(messages).toEqual([])
  })

  // 6. Max depth enforcement: depth > 1 rejected
  it("rejects depth > 1 (no grandchild support)", async () => {
    const tracker = new SubAgentTracker({ opencode: createMockGateway() })

    await expect(
      tracker.onSubtaskDiscovered(makeAction(), 2),
    ).rejects.toThrow("Max sub-agent depth is 1")
  })

  // 7. Multiple sub-agents tracked simultaneously
  it("tracks multiple sub-agents simultaneously", async () => {
    let callCount = 0
    const children = vi.fn().mockImplementation(async () => {
      callCount++
      // Each sub-agent's poll finds its own child immediately
      return [{ id: `ses-child-${callCount}` }]
    })
    const gateway = createMockGateway({ children })

    const tracker = new SubAgentTracker({ opencode: gateway })

    const agent1 = await tracker.onSubtaskDiscovered(
      makeAction({ prompt: "Task 1" }),
    )
    const agent2 = await tracker.onSubtaskDiscovered(
      makeAction({ prompt: "Task 2" }),
    )

    await advanceAndFlush()

    const tracked = tracker.getTrackedSubAgents()
    expect(tracked).toHaveLength(2)
    expect(tracked[0]!.prompt).toBe("Task 1")
    expect(tracked[1]!.prompt).toBe("Task 2")
    expect(tracked[0]!.status).toBe("active")
    expect(tracked[1]!.status).toBe("active")
  })

  // 8. getTrackedSubAgents returns all tracked agents (snapshot, not reference)
  it("getTrackedSubAgents returns all agents as a copy", async () => {
    const gateway = createMockGateway()

    const tracker = new SubAgentTracker({ opencode: gateway })
    await tracker.onSubtaskDiscovered(makeAction({ prompt: "A" }))
    await tracker.onSubtaskDiscovered(makeAction({ prompt: "B" }))

    const agents = tracker.getTrackedSubAgents()
    expect(agents).toHaveLength(2)
    expect(agents[0]!.prompt).toBe("A")
    expect(agents[1]!.prompt).toBe("B")

    // Verify it's a copy
    agents.push({} as TrackedSubAgent)
    expect(tracker.getTrackedSubAgents()).toHaveLength(2)
  })

  // 9. pollChildSession asks the gateway for children of the parent session
  it("pollChildSession calls correct REST endpoint", async () => {
    const children = vi.fn().mockResolvedValue([{ id: "child-abc" }])
    const gateway = createMockGateway({ children })

    const tracker = new SubAgentTracker({ opencode: gateway })
    const result = await tracker.pollChildSession("parent-xyz")

    expect(result).toBe("child-abc")
    expect(children).toHaveBeenCalledWith("parent-xyz")
  })

  // 10. getChildMessages handles gateway failure gracefully
  it("getChildMessages returns empty array on fetch failure", async () => {
    const gateway = createMockGateway({
      messages: vi.fn().mockRejectedValue(new Error("network error")),
    })

    const tracker = new SubAgentTracker({ opencode: gateway })
    const messages = await tracker.getChildMessages("ses-child-1")

    expect(messages).toEqual([])
  })

  // 11. maxDepth capped at 1 even if higher value provided
  it("maxDepth option capped at 1", async () => {
    const tracker = new SubAgentTracker({
      opencode: createMockGateway(),
      maxDepth: 5,
    })

    // depth=1 should still work
    const agent = await tracker.onSubtaskDiscovered(makeAction(), 1)
    expect(agent).toBeDefined()

    // depth=2 should still be rejected (maxDepth capped to 1)
    await expect(
      tracker.onSubtaskDiscovered(makeAction(), 2),
    ).rejects.toThrow("Max sub-agent depth is 1")
  })

  // 12. Failed sub-agents have resolvedAt set
  it("sets resolvedAt when status becomes failed", async () => {
    const gateway = createMockGateway({ children: vi.fn().mockResolvedValue([]) }) // always empty → will fail

    const tracker = new SubAgentTracker({ opencode: gateway })
    const agent = await tracker.onSubtaskDiscovered(makeAction())

    // Advance through all retries
    for (let i = 0; i < 10; i++) await advanceAndFlush()

    expect(agent.status).toBe("failed")
    expect(agent.resolvedAt).toBeDefined()
    expect(typeof agent.resolvedAt).toBe("number")

    tracker.close()
  })

  // 13. getTrackedSubAgents filters out expired completed agents
  it("getTrackedSubAgents excludes expired completed sub-agents", async () => {
    const gateway = createMockGateway({ children: vi.fn().mockResolvedValue([]) }) // all will fail

    const tracker = new SubAgentTracker({ opencode: gateway })
    await tracker.onSubtaskDiscovered(makeAction({ prompt: "Old task" }))

    // Resolve all polls so agent becomes failed with resolvedAt
    for (let i = 0; i < 10; i++) await advanceAndFlush()

    // Verify it's tracked initially
    expect(tracker.getTrackedSubAgents()).toHaveLength(1)

    // Advance past 30-minute TTL (resolved agents use 30min)
    vi.advanceTimersByTime(30 * 60 * 1000 + 1)

    // Should be filtered out
    expect(tracker.getTrackedSubAgents()).toHaveLength(0)

    tracker.close()
  })

  // 14. Periodic cleanup evicts expired entries from tracked array
  it("periodic cleanup evicts expired completed sub-agents", async () => {
    const children = vi.fn().mockResolvedValue([]) // all will fail
    const gateway = createMockGateway({ children })

    const tracker = new SubAgentTracker({ opencode: gateway })
    await tracker.onSubtaskDiscovered(makeAction({ prompt: "Expired" }))

    // Resolve polls
    for (let i = 0; i < 10; i++) await advanceAndFlush()

    // Advance past resolved TTL + cleanup interval (30min + 10min)
    vi.advanceTimersByTime(30 * 60 * 1000 + 10 * 60 * 1000 + 1)

    // Add a fresh sub-agent to verify it's NOT evicted
    children.mockResolvedValue([{ id: "ses-fresh" }])
    await tracker.onSubtaskDiscovered(makeAction({ prompt: "Fresh" }))
    await advanceAndFlush()

    // Only the fresh one should remain
    const tracked = tracker.getTrackedSubAgents()
    expect(tracked).toHaveLength(1)
    expect(tracked[0]!.prompt).toBe("Fresh")

    tracker.close()
  })

  // 15. close() stops the cleanup interval
  it("close() stops the cleanup interval timer", () => {
    const tracker = new SubAgentTracker({ opencode: createMockGateway() })
    // Should not throw
    tracker.close()
    // Calling close again should also not throw
    tracker.close()
  })
})
