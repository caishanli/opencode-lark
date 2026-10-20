import { describe, it, expect, vi, beforeEach } from "vitest"
import { existsSync, readFileSync, rmSync } from "node:fs"
import { StreamingCardSession, closeAllStreamingCards } from "./streaming-card.js"
import { createMockFeishuClient } from "../__tests__/setup.js"

function createStartedSession() {
  const feishuClient = createMockFeishuClient()
  ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
    code: 0,
    msg: "ok",
    data: { message_id: "msg_456" },
  })
  ;(feishuClient.updateMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, msg: "ok" })

  const session = new StreamingCardSession({ feishuClient, chatId: "chat_789" })
  return { session, feishuClient }
}

/** The card JSON most recently sent to Feishu. */
function lastCard(feishuClient: any): any {
  const updates = feishuClient.updateMessage.mock.calls
  if (updates.length > 0) {
    return JSON.parse(updates[updates.length - 1][1])
  }
  const sends = feishuClient.sendMessage.mock.calls
  return JSON.parse(sends[sends.length - 1][1].content)
}

function elements(feishuClient: any): any[] {
  return lastCard(feishuClient).body.elements
}

describe("StreamingCardSession", () => {
  let feishuClient: any

  beforeEach(() => {
    feishuClient = createMockFeishuClient()
    ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0, msg: "ok", data: { message_id: "msg_456" },
    })
  })

  it("creates one interactive message and updates it in place", async () => {
    const { session, feishuClient: fc } = createStartedSession()
    await session.start()
    await session.setText("hello")

    expect(fc.sendMessage).toHaveBeenCalledTimes(1)
    const sent = fc.sendMessage.mock.calls[0][1]
    expect(sent.msg_type).toBe("interactive")
    expect(JSON.parse(sent.content).schema).toBe("2.0")
    // the text went into the same message, not a new one
    expect(fc.updateMessage).toHaveBeenCalledWith("msg_456", expect.any(String))
    expect(fc.sendMessage).toHaveBeenCalledTimes(1)
  })

  it("keeps the real usage when a live estimate arrives later", async () => {
    const { session, feishuClient: fc } = createStartedSession()
    await session.start()
    await session.setUsage("耗时 59.4s · 6211 tokens(缓存 99.04%) · 132.4 tok/s · 上下文 131k")

    // a text delta after the usage event would push the live estimate
    await session.setEstimate("≈ 98.2 tok/s")

    // the card is still running, so the line reads "⏳ 运行中… · <usage>"
    const status = elements(fc).find((el: any) => el.tag === "markdown" && el.content.includes("tok/s"))
    expect(status?.content).toContain("6211 tokens")
    expect(status?.content).not.toContain("≈")
  })

  it("drops the live estimate when the turn ends without a usage report", async () => {
    const { session, feishuClient: fc } = createStartedSession()
    await session.start()
    await session.setEstimate("≈ 98.2 tok/s")
    await session.close("done")

    const status = elements(fc).find((el: any) => el.tag === "markdown" && el.content.includes("已完成"))
    expect(status?.content).toBe("✅ 已完成")
  })

  it("knows when a tool is still running", async () => {
    const { session, feishuClient: fc } = createStartedSession()
    await session.start()
    expect(session.hasRunningTool()).toBe(false)
    await session.setToolStatus("question", "running", "ask", "call-1")
    expect(session.hasRunningTool()).toBe(true)
    await session.setToolStatus("question", "completed", undefined, "call-1")
    expect(session.hasRunningTool()).toBe(false)
  })

  it("renders a text block as a markdown element", async () => {
    const { session, feishuClient: fc } = createStartedSession()
    await session.start()
    await session.setText("the answer")
    const els = elements(fc)
    expect(els[0]).toEqual({ tag: "markdown", content: "the answer" })
  })

  it("renders tool calls as a collapsible panel with the count in the header", async () => {
    const { session, feishuClient: fc } = createStartedSession()
    await session.start()
    await session.setToolStatus("shell", "completed", "uname -a", "c1")
    await session.setToolStatus("shell", "completed", "node -v", "c2")

    const panel = elements(fc)[0]
    expect(panel.tag).toBe("collapsible_panel")
    expect(panel.header.title.content).toBe("🛠️ 工具 (2)")
    expect(panel.elements[0].content).toBe(
      "- ✅ shell · uname -a\n- ✅ shell · node -v",
    )
  })

  it("keeps the preview learned while the call was running", async () => {
    const { session, feishuClient: fc } = createStartedSession()
    await session.start()
    await session.setToolStatus("shell", "running", "uname -a", "c1")
    await session.setToolStatus("shell", "completed", undefined, "c1")
    expect(elements(fc)[0].elements[0].content).toBe("- ✅ shell · uname -a")
  })

  it("expands the latest tool panel while running and collapses on completion", async () => {
    const { session, feishuClient: fc } = createStartedSession()
    await session.start()
    await session.setToolStatus("shell", "running", "uname -a", "c1")
    expect(elements(fc)[0].expanded).toBe(true)

    await session.setText("done")
    await session.close("done")
    expect(elements(fc)[0].expanded).toBe(false)
  })

  it("groups consecutive tool calls but splits them when text interrupts", async () => {
    const { session, feishuClient: fc } = createStartedSession()
    await session.start()
    await session.setToolStatus("shell", "completed", "uname -a", "c1")
    await session.setToolStatus("shell", "completed", "node -v", "c2")
    await session.setText("and now some text")
    await session.setToolStatus("shell", "completed", "df -h /", "c3")

    const els = elements(fc)
    const panels = els.filter((e) => e.tag === "collapsible_panel")
    const texts = els.filter((e) => e.tag === "markdown" && !e.content.startsWith("⏳"))
    expect(panels).toHaveLength(2)
    expect(panels[0].header.title.content).toBe("🛠️ 工具 (2)")
    expect(panels[1].header.title.content).toBe("🛠️ 工具 (1)")
    // chronological: first tool block, then the text, then the second tool block
    const order = els.map((e) =>
      e.tag === "collapsible_panel" ? "tools" : e.content.startsWith("⏳") ? "status" : "text",
    )
    expect(order).toEqual(["tools", "text", "tools", "status"])
    expect(texts.length).toBeGreaterThan(0)
  })

  it("a text run after a tool call holds only its own text (no repeated prefix)", async () => {
    // Regression: each text block used to hold the WHOLE turn text, so the
    // reply appeared once per tool call, as a growing prefix.
    const { session, feishuClient: fc } = createStartedSession()
    await session.start()
    await session.setText("first part")
    await session.setToolStatus("shell", "completed", "uname -a", "c1")
    await session.setText("first partsecond part")
    await session.setToolStatus("shell", "completed", "node -v", "c2")
    await session.setText("first partsecond partthird part")

    const texts = elements(fc)
      .filter((e) => e.tag === "markdown")
      .map((e) => e.content)
      .filter((c) => !c.startsWith("⏳") && !c.startsWith("✅"))
    expect(texts).toEqual(["first part", "second part", "third part"])
  })

  it("shows the token/rate summary next to the status line", async () => {
    const { session, feishuClient: fc } = createStartedSession()
    await session.start()
    await session.setUsage("1.2k tokens · 340 tok/s")
    await session.close("done")

    const els = elements(fc)
    const last = els[els.length - 1]
    expect(last.content).toContain("✅ 已完成")
    expect(last.content).toContain("1.2k tokens")
    expect(last.content).toContain("340 tok/s")
  })

  it("adds a status line that completes when the turn ends", async () => {
    const { session, feishuClient: fc } = createStartedSession()
    await session.start()
    expect(elements(fc).at(-1).content).toBe("⏳ 运行中…")

    await session.close("the final answer")
    const els = elements(fc)
    expect(els.at(-1).content).toBe("✅ 已完成")
    expect(els[0].content).toBe("the final answer")
  })

  it("close() is idempotent", async () => {
    const { session, feishuClient: fc } = createStartedSession()
    await session.start()
    await session.close()
    await session.close()
    const updates = fc.updateMessage.mock.calls.length
    await session.close()
    expect(fc.updateMessage.mock.calls.length).toBe(updates)
  })
})

describe("closeAllStreamingCards", () => {
  it("closes a card left open by an interrupted turn", async () => {
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0, msg: "ok", data: { message_id: "msg_456" },
    })
    ;(feishuClient.updateMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, msg: "ok" })
    const session = new StreamingCardSession({ feishuClient, chatId: "chat_789" })
    await session.start()
    await session.setText("partial answer")

    await closeAllStreamingCards("interrupted")

    const updates = (feishuClient.updateMessage as ReturnType<typeof vi.fn>).mock.calls
    const last = JSON.parse(updates[updates.length - 1][1])
    const status = last.body.elements[last.body.elements.length - 1]
    expect(status.content).toContain("已中断")
  })
})

describe("StreamingCardSession — a failed update must not poison the queue", () => {
  it("keeps working after one failed card update", async () => {
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0, msg: "ok", data: { message_id: "msg_456" },
    })
    const update = feishuClient.updateMessage as ReturnType<typeof vi.fn>
    update.mockRejectedValueOnce(new Error("boom")).mockResolvedValue({ code: 0, msg: "ok" })

    const session = new StreamingCardSession({ feishuClient, chatId: "chat_789" })
    await session.start()

    // The failure is reported to the caller...
    await expect(session.setText("first")).rejects.toThrow("boom")
    // ...but the queue is still usable, so the card can still be finished.
    await session.setText("second")
    await session.close("done")

    const contents = update.mock.calls.map((c: any) => String(c[1]))
    expect(contents.some((c) => c.includes("second"))).toBe(true)
    expect(contents.some((c) => c.includes("done"))).toBe(true)
  })
})

describe("StreamingCardSession — usage that arrives before the card exists", () => {
  it("keeps the usage line and shows it once the card is created", async () => {
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0, msg: "ok", data: { message_id: "msg_456" },
    })
    const session = new StreamingCardSession({ feishuClient, chatId: "chat_789" })

    // usage arrives before the card was created
    await session.setUsage("1.2k tokens · 340 tok/s")
    await session.start()

    // the first content goes out with the message itself, later ones via update
    const sent = (feishuClient.sendMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((c: any) => String(c[1].content))
    const updated = (feishuClient.updateMessage as ReturnType<typeof vi.fn>).mock.calls
      .map((c: any) => String(c[1]))
    const contents = [...sent, ...updated]
    expect(contents.some((c) => c.includes("1.2k tokens"))).toBe(true)
  })
})

describe("StreamingCardSession — the open card state file", () => {
  it("keeps one entry per chat and only removes its own", async () => {
    const file = "/tmp/opencode/state-test.json"
    rmSync(file, { force: true })

    const make = async (chatId: string, messageId: string) => {
      const feishuClient = createMockFeishuClient()
      ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
        code: 0, msg: "ok", data: { message_id: messageId },
      })
      const session = new StreamingCardSession({ feishuClient, chatId, stateFile: file })
      await session.start()
      return session
    }

    const a = await make("chat-a", "msg_a")
    const b = await make("chat-b", "msg_b")
    const state = JSON.parse(readFileSync(file, "utf-8"))
    expect(state["chat-a"].messageId).toBe("msg_a")
    expect(state["chat-b"].messageId).toBe("msg_b")

    // Closing one chat must not drop the other chat's entry — a late close
    // of a finished turn used to wipe the entry of the running one, which
    // left cards stuck on "running" after a restart.
    await a.close("done", "completed")
    expect(JSON.parse(readFileSync(file, "utf-8"))["chat-b"].messageId).toBe("msg_b")

    await b.close("done", "completed")
    expect(existsSync(file)).toBe(false)
  })
})

describe("StreamingCardSession — the state entry survives a failed final update", () => {
  it("keeps the card listed so the next process can close it", async () => {
    const file = "/tmp/opencode/state-fail-test.json"
    rmSync(file, { force: true })
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0, msg: "ok", data: { message_id: "msg_x" },
    })
    ;(feishuClient.updateMessage as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("feishu is down"),
    )
    const session = new StreamingCardSession({ feishuClient, chatId: "chat-x", stateFile: file })
    await session.start()
    expect(existsSync(file)).toBe(true)

    await expect(session.close("bye", "interrupted")).rejects.toThrow("feishu is down")
    // The card is still listed: the next process must be able to close it.
    expect(JSON.parse(readFileSync(file, "utf-8"))["chat-x"].messageId).toBe("msg_x")
  })

  it("remembers the answer so a restarted process can restore the card", async () => {
    const file = "/tmp/opencode/state-restore-test.json"
    rmSync(file, { force: true })
    const feishuClient = createMockFeishuClient()
    ;(feishuClient.sendMessage as ReturnType<typeof vi.fn>).mockResolvedValue({
      code: 0, msg: "ok", data: { message_id: "msg_r" },
    })
    ;(feishuClient.updateMessage as ReturnType<typeof vi.fn>).mockResolvedValue({ code: 0, msg: "ok" })
    const session = new StreamingCardSession({ feishuClient, chatId: "chat-r", stateFile: file })
    await session.start()
    await session.setText("the answer so far")
    session.persistState()

    const remembered = JSON.parse(readFileSync(file, "utf-8"))["chat-r"]
    expect(remembered.messageId).toBe("msg_r")
    expect(remembered.blocks[0].text).toBe("the answer so far")

    // A new process picks the card up and closes it as interrupted — the
    // answer stays on the card.
    const restored = StreamingCardSession.restore({
      feishuClient,
      chatId: "chat-r",
      stateFile: file,
      state: remembered,
    })
    await restored.close(undefined, "interrupted")

    const card = JSON.parse((feishuClient.updateMessage as any).mock.calls.at(-1)[1])
    const text = JSON.stringify(card)
    expect(text).toContain("the answer so far")
    expect(text).toContain("已中断")
    // the state file is cleaned up
    expect(existsSync(file)).toBe(false)
  })
})
