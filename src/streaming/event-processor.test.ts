import { describe, it, expect } from "vitest"
import {
  EventProcessor,
  type ProcessedAction,
  type TextDelta,
  type ToolStateChange,
  type SubtaskDiscovered,
  type SessionIdle,
} from "./event-processor.js"

function makeProcessor(sessions: string[] = ["ses-1"]) {
  return new EventProcessor({ ownedSessions: new Set(sessions) })
}

describe("EventProcessor", () => {
  describe("TextDelta", () => {
    it("extracts text delta from message.part.updated (text part)", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "text",
            text: "Hello world",
          },
          delta: "world",
        },
      })

      expect(result).toEqual<TextDelta>({
        type: "TextDelta",
        sessionId: "ses-1",
        text: "world",
      })
    })

    it("returns null when delta is empty string", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: { sessionID: "ses-1", messageID: "msg-1", type: "text", text: "" },
          delta: "",
        },
      })

      expect(result).toBeNull()
    })

    it("returns null when delta is missing", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: { sessionID: "ses-1", messageID: "msg-1", type: "text", text: "hi" },
        },
      })

      expect(result).toBeNull()
    })
  })

  describe("TextDelta from message.part.delta", () => {
    it("extracts text delta from message.part.delta event", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.delta",
        properties: {
          sessionID: "ses-1",
          messageID: "msg-1",
          partID: "prt-1",
          field: "text",
          delta: "pong ",
        },
      })

      expect(result).toEqual<TextDelta>({
        type: "TextDelta",
        sessionId: "ses-1",
        text: "pong ",
      })
    })

    it("returns null for non-text field deltas", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.delta",
        properties: {
          sessionID: "ses-1",
          messageID: "msg-1",
          partID: "prt-1",
          field: "reasoning",
          delta: "thinking...",
        },
      })

      expect(result).toBeNull()
    })

    it("returns null for empty delta", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.delta",
        properties: {
          sessionID: "ses-1",
          messageID: "msg-1",
          partID: "prt-1",
          field: "text",
          delta: "",
        },
      })

      expect(result).toBeNull()
    })

    it("returns null for unowned sessions", () => {
      const proc = makeProcessor(["ses-1"])
      const result = proc.processEvent({
        type: "message.part.delta",
        properties: {
          sessionID: "ses-OTHER",
          messageID: "msg-1",
          partID: "prt-1",
          field: "text",
          delta: "hello",
        },
      })

      expect(result).toBeNull()
    })
  })

  describe("ToolStateChange", () => {
    it("extracts tool state change from message.part.updated (tool part)", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: { status: "running", input: {}, time: { start: 1 } },
          },
        },
      })

      expect(result).toEqual<ToolStateChange>({
        type: "ToolStateChange",
        sessionId: "ses-1",
        toolName: "bash",
        state: "running",
        input: {},
      })
    })

    it("includes error field when tool state is error", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "edit",
            state: {
              status: "error",
              input: {},
              error: "permission denied",
              time: { start: 1, end: 2 },
            },
          },
        },
      })

      expect(result).toEqual<ToolStateChange>({
        type: "ToolStateChange",
        sessionId: "ses-1",
        toolName: "edit",
        state: "error",
        input: {},
        error: "permission denied",
      })
    })

    it("extracts title from running state with title", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "read",
            state: { status: "running", input: {}, title: "Read src/index.ts" },
          },
        },
      })
      expect(result).toEqual({
        type: "ToolStateChange",
        sessionId: "ses-1",
        toolName: "read",
        state: "running",
        input: {},
        title: "Read src/index.ts",
      })
    })

    it("extracts title from completed state", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: { status: "completed", input: {}, output: "OK", title: "Run tests" },
          },
        },
      })
      expect(result).toEqual({
        type: "ToolStateChange",
        sessionId: "ses-1",
        toolName: "bash",
        state: "completed",
        input: {},
        output: "OK",
        title: "Run tests",
      })
    })

    it("has no title when running state lacks title field", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: { status: "running", input: {} },
          },
        },
      })
      expect(result).toEqual({
        type: "ToolStateChange",
        sessionId: "ses-1",
        toolName: "bash",
        state: "running",
        input: {},
      })
      // Specifically check title is NOT present
      expect(result).not.toHaveProperty("title")
    })

    it("has no title when state is pending", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "read",
            state: { status: "pending", raw: "{}" },
          },
        },
      })
      expect(result).toEqual({
        type: "ToolStateChange",
        sessionId: "ses-1",
        toolName: "read",
        state: "pending",
      })
      expect(result).not.toHaveProperty("title")
    })

    it("extracts input and output from completed tool state", () => {
      const proc = makeProcessor()
      const testInput = { filePath: "/path/to/file", limit: 100 }
      const testOutput = "File contents here"
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "read",
            state: {
              status: "completed",
              input: testInput,
              output: testOutput,
              title: "Read file",
            },
          },
        },
      })
      expect(result).toEqual({
        type: "ToolStateChange",
        sessionId: "ses-1",
        toolName: "read",
        state: "completed",
        input: testInput,
        output: testOutput,
        title: "Read file",
      })
    })

    it("extracts input but not output from running tool state", () => {
      const proc = makeProcessor()
      const testInput = { command: "echo hello" }
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: {
              status: "running",
              input: testInput,
              title: "Run command",
            },
          },
        },
      })
      expect(result).toEqual({
        type: "ToolStateChange",
        sessionId: "ses-1",
        toolName: "bash",
        state: "running",
        input: testInput,
        title: "Run command",
      })
      // Ensure output is not present
      expect(result).not.toHaveProperty("output")
    })

    it("handles events without input/output for backward compat", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "tool",
            callID: "call-1",
            tool: "bash",
            state: { status: "pending" },
          },
        },
      })
      expect(result).toEqual({
        type: "ToolStateChange",
        sessionId: "ses-1",
        toolName: "bash",
        state: "pending",
      })
      // Ensure neither input nor output is present
      expect(result).not.toHaveProperty("input")
      expect(result).not.toHaveProperty("output")
    })
  })

  describe("SubtaskDiscovered", () => {
    it("extracts subtask from message.part.updated (subtask part)", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "subtask",
            prompt: "Fix the tests",
            description: "Run and fix failing tests",
            agent: "build",
          },
        },
      })

      expect(result).toEqual<SubtaskDiscovered>({
        type: "SubtaskDiscovered",
        sessionId: "ses-1",
        prompt: "Fix the tests",
        description: "Run and fix failing tests",
        agent: "build",
      })
    })
  })


  describe("SessionIdle", () => {
    it("extracts SessionIdle from session.status with idle type", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "session.status",
        properties: {
          sessionID: "ses-1",
          status: { type: "idle" },
        },
      })

      expect(result).toEqual<SessionIdle>({
        type: "SessionIdle",
        sessionId: "ses-1",
      })
    })
  })

  describe("SessionIdle from session.idle event", () => {
    it("extracts SessionIdle from session.idle event type", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "session.idle",
        properties: {
          sessionID: "ses-1",
        },
      })

      expect(result).toEqual<SessionIdle>({
        type: "SessionIdle",
        sessionId: "ses-1",
      })
    })

    it("returns null for session.idle from unowned session", () => {
      const proc = makeProcessor(["ses-1"])
      const result = proc.processEvent({
        type: "session.idle",
        properties: {
          sessionID: "ses-OTHER",
        },
      })

      expect(result).toBeNull()
    })
  })

  describe("filtering and error handling", () => {
    it("returns null for unknown event types", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "file.edited",
        properties: { file: "foo.ts" },
      })

      expect(result).toBeNull()
    })

    it("returns null for events from unowned sessions", () => {
      const proc = makeProcessor(["ses-1"])
      const result = proc.processEvent({
        type: "session.status",
        properties: {
          sessionID: "ses-OTHER",
          status: { type: "busy" },
        },
      })

      expect(result).toBeNull()
    })

    it("returns null for malformed events (no crash)", () => {
      const proc = makeProcessor()

      expect(proc.processEvent(null)).toBeNull()
      expect(proc.processEvent(undefined)).toBeNull()
      expect(proc.processEvent(42)).toBeNull()
      expect(proc.processEvent("garbage")).toBeNull()
      expect(proc.processEvent({ type: "session.status" })).toBeNull()
      expect(proc.processEvent({ type: "message.part.updated" })).toBeNull()
      expect(
        proc.processEvent({
          type: "message.part.updated",
          properties: { part: null },
        }),
      ).toBeNull()
    })

    it("returns null for session.status with retry type", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "session.status",
        properties: {
          sessionID: "ses-1",
          status: { type: "retry", attempt: 1, message: "retrying", next: 5000 },
        },
      })

      expect(result).toBeNull()
    })

    it("returns null for unhandled part types (e.g. step-start)", () => {
      const proc = makeProcessor()
      const result = proc.processEvent({
        type: "message.part.updated",
        properties: {
          part: {
            sessionID: "ses-1",
            messageID: "msg-1",
            type: "step-start",
          },
        },
      })

      expect(result).toBeNull()
    })
  })
})

describe("EventProcessor — real v2.0.29 event names", () => {
  it("extracts TextDelta from session.text.delta (captured from live server)", () => {
    const proc = makeProcessor()
    const result = proc.processEvent({
      type: "session.text.delta",
      data: {
        sessionID: "ses-1",
        assistantMessageID: "msg-1",
        ordinal: 0,
        delta: "hello world",
      },
    })
    expect(result).toEqual<TextDelta>({ type: "TextDelta", sessionId: "ses-1", text: "hello world" })
  })

  it("extracts TextDelta from session.text.delta carried under properties too", () => {
    const proc = makeProcessor()
    const result = proc.processEvent({
      type: "session.text.delta",
      properties: { sessionID: "ses-1", delta: "hi" },
    })
    expect(result).toEqual<TextDelta>({ type: "TextDelta", sessionId: "ses-1", text: "hi" })
  })

  it("ignores session.text.delta for unowned sessions", () => {
    const proc = makeProcessor(["ses-other"])
    expect(proc.processEvent({ type: "session.text.delta", data: { sessionID: "ses-1", delta: "x" } })).toBeNull()
  })

  // Payload shapes below are copied verbatim from a live capture on v2.0.29.
  const liveInputStarted = (id: string, name: string) => ({
    type: "session.tool.input.started",
    data: { sessionID: "ses-1", assistantMessageID: "msg-1", id, name },
  })
  const liveCalled = (id: string, input: Record<string, unknown> = {}) => ({
    type: "session.tool.called",
    data: { sessionID: "ses-1", assistantMessageID: "msg-1", id, input, executed: false },
  })

  it("maps session.tool.called to a running ToolStateChange using the name from input.started", () => {
    const proc = makeProcessor()
    proc.processEvent(liveInputStarted("call_1", "shell"))
    const result = proc.processEvent(liveCalled("call_1", { command: "uname -a" }))
    expect(result).toMatchObject<ToolStateChange>({
      type: "ToolStateChange",
      sessionId: "ses-1",
      toolName: "shell",
      state: "running",
      input: { command: "uname -a" },
    })
  })

  it("maps session.tool.success to completed, remembering the tool name", () => {
    const proc = makeProcessor()
    proc.processEvent(liveInputStarted("call_1", "shell"))
    proc.processEvent(liveCalled("call_1"))
    const result = proc.processEvent({ type: "session.tool.success", data: { sessionID: "ses-1", id: "call_1" } })
    expect(result).toMatchObject<ToolStateChange>({
      type: "ToolStateChange",
      sessionId: "ses-1",
      toolName: "shell",
      state: "completed",
    })
  })

  it("maps session.tool.failed to error", () => {
    const proc = makeProcessor()
    proc.processEvent(liveInputStarted("call_9", "read"))
    proc.processEvent(liveCalled("call_9"))
    const result = proc.processEvent({ type: "session.tool.failed", data: { sessionID: "ses-1", id: "call_9", error: "boom" } })
    expect(result).toMatchObject<ToolStateChange>({
      type: "ToolStateChange",
      sessionId: "ses-1",
      toolName: "read",
      state: "error",
    })
  })

  it("distinguishes two different tools by their call id", () => {
    const proc = makeProcessor()
    proc.processEvent(liveInputStarted("call_a", "shell"))
    proc.processEvent(liveInputStarted("call_b", "read"))
    const a = proc.processEvent(liveCalled("call_a"))
    const b = proc.processEvent(liveCalled("call_b"))
    expect((a as ToolStateChange).toolName).toBe("shell")
    expect((b as ToolStateChange).toolName).toBe("read")
  })
})

describe("EventProcessor — v2 turn-end signals (captured from live server)", () => {
  it("treats session.execution.succeeded as SessionIdle (no session.idle is emitted)", () => {
    const proc = makeProcessor()
    const result = proc.processEvent({
      type: "session.execution.succeeded",
      data: { sessionID: "ses-1" },
    })
    expect(result).toEqual<SessionIdle>({ type: "SessionIdle", sessionId: "ses-1" })
  })

  it("treats session.execution.failed and .interrupted as SessionIdle", () => {
    const proc = makeProcessor()
    expect(proc.processEvent({ type: "session.execution.failed", data: { sessionID: "ses-1" } }))
      .toEqual<SessionIdle>({ type: "SessionIdle", sessionId: "ses-1" })
    expect(proc.processEvent({ type: "session.execution.interrupted", data: { sessionID: "ses-1" } }))
      .toEqual<SessionIdle>({ type: "SessionIdle", sessionId: "ses-1" })
  })

  it("does not treat session.execution.started as idle", () => {
    const proc = makeProcessor()
    expect(proc.processEvent({ type: "session.execution.started", data: { sessionID: "ses-1" } })).toBeNull()
  })

  it("ignores turn-end events for unowned sessions", () => {
    const proc = makeProcessor(["ses-other"])
    expect(proc.processEvent({ type: "session.execution.succeeded", data: { sessionID: "ses-1" } })).toBeNull()
  })
})

describe("EventProcessor — tool identity for per-call rendering", () => {
  it("carries the call id and derives a readable title from input.command", () => {
    const proc = makeProcessor()
    proc.processEvent({ type: "session.tool.input.started", data: { sessionID: "ses-1", id: "call_1", name: "shell" } })
    const result = proc.processEvent({
      type: "session.tool.called",
      data: { sessionID: "ses-1", id: "call_1", input: { command: "uname -a" }, executed: false },
    }) as ToolStateChange
    expect(result.callId).toBe("call_1")
    expect(result.title).toBe("uname -a")
  })

  it("keeps the call id on success/failure so the right line is updated", () => {
    const proc = makeProcessor()
    proc.processEvent({ type: "session.tool.input.started", data: { sessionID: "ses-1", id: "call_7", name: "read" } })
    proc.processEvent({ type: "session.tool.called", data: { sessionID: "ses-1", id: "call_7", input: {} } })
    const done = proc.processEvent({ type: "session.tool.success", data: { sessionID: "ses-1", id: "call_7" } }) as ToolStateChange
    expect(done.callId).toBe("call_7")
    expect(done.toolName).toBe("read")
  })
})
